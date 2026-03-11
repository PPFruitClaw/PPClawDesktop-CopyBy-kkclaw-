// Gateway 进程守护模块 — 指数退避 + 自适应频率 + 深度健康检查 + 性能监控
const EventEmitter = require('events');
const GatewayMetricsCollector = require('./utils/gateway-metrics-collector');
const GatewayHealthScorer = require('./utils/gateway-health-scorer');
const GatewayAnomalyDetector = require('./utils/gateway-anomaly-detector');

class GatewayGuardian extends EventEmitter {
    constructor(serviceManager, options = {}) {
        super();
        this.serviceManager = serviceManager;
        this.gatewayHost = options.gatewayHost
            || (serviceManager && typeof serviceManager.getGatewayHost === 'function'
                ? serviceManager.getGatewayHost()
                : 'http://127.0.0.1:18789');
        this.maxRestarts = options.maxRestarts || 10;
        this.restartWindow = options.restartWindow || 60 * 60 * 1000; // 1小时

        // 自适应轮询间隔
        this.healthyInterval = 30000;   // 健康时 30s
        this.baseInterval = 5000;       // 异常时起始 5s
        this.maxInterval = 300000;      // 退避上限 5min

        // 深度检查：每 N 次浅检查做 1 次深度检查
        this.deepCheckEvery = 6;  // 降低深度检查频率，避免误判
        this.checkCount = 0;

        // 连续重启失败后自动清理 session 的阈值
        this.sessionCleanupThreshold = 3;

        this.isRunning = false;
        this.checkTimer = null;
        this.currentInterval = this.baseInterval;
        this.consecutiveFailures = 0;
        this.consecutiveRestartFailures = 0;
        this.restartHistory = [];
        this.isRestarting = false; // 防止重复触发
        this._lastError = null;   // 最近一次错误原因
        this._hasBeenHealthy = false; // Gateway 是否曾经连接成功过

        // 新增：性能监控模块
        this.metricsCollector = new GatewayMetricsCollector();
        this.healthScorer = new GatewayHealthScorer(this.metricsCollector);
        this.anomalyDetector = new GatewayAnomalyDetector(this.metricsCollector);

        // 基线更新定时器（每 5 分钟更新一次基线）
        this.baselineUpdateInterval = 5 * 60 * 1000;
        this.baselineTimer = null;
    }

    start() {
        if (this.isRunning) return;

        console.log('[Guardian] 启动 Gateway 守护（增强监控模式）');
        this.isRunning = true;

        // 启动基线更新定时器
        this._startBaselineUpdater();

        this._check();
        this.emit('started');
    }

    stop() {
        console.log('[Guardian] 停止 Gateway 守护');
        this.isRunning = false;
        this._clearTimer();
        this._stopBaselineUpdater();
        this.emit('stopped');
    }

    _startBaselineUpdater() {
        this.baselineTimer = setInterval(() => {
            this.anomalyDetector.updateBaseline();
            console.log('[Guardian] 基线已更新');
        }, this.baselineUpdateInterval);
    }

    _stopBaselineUpdater() {
        if (this.baselineTimer) {
            clearInterval(this.baselineTimer);
            this.baselineTimer = null;
        }
    }

    // 调度下一次检查
    _scheduleNext(interval) {
        this._clearTimer();
        if (!this.isRunning) return;
        this.currentInterval = interval;
        this.checkTimer = setTimeout(() => this._check(), interval);
    }

    _clearTimer() {
        if (this.checkTimer) {
            clearTimeout(this.checkTimer);
            this.checkTimer = null;
        }
    }

    _getGatewayHost() {
        if (this.serviceManager && typeof this.serviceManager.getGatewayHost === 'function') {
            return this.serviceManager.getGatewayHost();
        }
        return this.gatewayHost;
    }

    // 核心检查循环
    async _check() {
        if (!this.isRunning) return;

        const startTime = Date.now();

        // 只使用浅检查，避免深度检查触发 LLM 请求导致误判
        const healthy = await this._ping();
        const responseTime = Date.now() - startTime;

        // 记录指标
        this.metricsCollector.recordRequest(healthy, responseTime, healthy ? null : 'ping_failed');
        this.metricsCollector.recordAvailability(healthy);

        // 检测异常（仅在 Gateway 曾经健康后才报告，避免启动阶段噪音）
        const anomalies = this.anomalyDetector.detectAnomalies();
        if (anomalies.length > 0 && this._hasBeenHealthy) {
            console.log('[Guardian] 检测到异常:', anomalies.map(a => a.message).join(', '));
            this.emit('anomalies', anomalies);
        }

        if (healthy) {
            this._onHealthy();
        } else {
            await this._onUnhealthy();
        }
    }

    // 浅检查：HTTP GET 根路径
    async _ping() {
        try {
            const gatewayHost = this._getGatewayHost();
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            const response = await fetch(gatewayHost, {
                method: 'GET',
                signal: controller.signal
            });

            clearTimeout(timeoutId);
            // 只要有 HTTP 响应就说明 Gateway 进程在线（401/403/404 也算在线）
            // 真正不可用会表现为连接异常/超时并进入 catch
            return Number.isInteger(response.status);
        } catch {
            return false;
        }
    }

    // 深度检查：实际调用 API 验证业务层没卡死
    async _deepPing() {
        try {
            const gatewayHost = this._getGatewayHost();
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const response = await fetch(`${gatewayHost}/v1/models`, {
                method: 'GET',
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            // 只要有响应就算健康（包括 404），说明 gateway 在运行
            // 只有完全无响应或超时才算异常
            if (response.status >= 200 && response.status < 500) {
                return true;
            }

            // 确认响应体可读（不是挂起状态）
            await response.text();
            return true;
        } catch {
            return false;
        }
    }

    // 健康时：重置计数，降频到 30s
    _onHealthy() {
        if (!this._hasBeenHealthy) {
            this._hasBeenHealthy = true;
            // 首次连上时重置异常检测基线，不让启动期数据污染
            this.anomalyDetector.updateBaseline();
        }
        if (this.consecutiveFailures > 0) {
            console.log('[Guardian] Gateway 已恢复');
            this.emit('recovered');
        }
        this.consecutiveFailures = 0;
        this.consecutiveRestartFailures = 0;
        this.isRestarting = false;
        // 恢复后清空重启历史，给后续异常留足重启配额
        if (this.restartHistory.length > 0) {
            this.restartHistory = [];
        }
        this._scheduleNext(this.healthyInterval);
    }

    // 不健康时：指数退避 + 自动重启 + 自动清理
    async _onUnhealthy() {
        this.consecutiveFailures++;

        // Gateway 从未连接成功过 → 首次启动阶段
        // 不报警、不触发 unhealthy 事件，但仍然需要尝试启动 Gateway
        if (!this._hasBeenHealthy) {
            // 检查 gateway 进程是否仍在启动中
            if (this.serviceManager.isGatewayStartingUp()) {
                // 进程还活着，继续等它就绪
                this._scheduleNext(this.baseInterval);
                return;
            }

            // 前 2 次失败先快速重试确认（Gateway 可能还没来得及启动）
            if (this.consecutiveFailures < 3) {
                this._scheduleNext(this.baseInterval);
                return;
            }

            // 连续 3 次检测不到 Gateway → 主动启动它（静默，不发告警事件）
            if (!this.isRestarting) {
                this.isRestarting = true;
                console.log('[Guardian] Gateway 未运行，正在首次启动...');
                const result = await this.serviceManager.startGateway();
                this.isRestarting = false;

                if (result.success) {
                    console.log('[Guardian] Gateway 首次启动成功');
                } else if (!result.stillStarting) {
                    console.log(`[Guardian] Gateway 首次启动失败: ${result.error || '未知错误'}`);
                }
            }

            this._scheduleNext(this.baseInterval);
            return;
        }

        if (this.consecutiveFailures < 3) {
            // 前两次失败：快速重试确认
            this._scheduleNext(this.baseInterval);
            return;
        }

        // 连续失败 3 次，确认异常
        const reason = `连续失败 ${this.consecutiveFailures} 次`;
        console.log(`[Guardian] Gateway 异常: ${reason}`);

        // 二次确认：与 ServiceManager 的探活结果做交叉校验，避免误判触发重启
        if (this.serviceManager && typeof this.serviceManager.checkGateway === 'function') {
            try {
                const status = await this.serviceManager.checkGateway();
                if (status?.status === 'running') {
                    console.log('[Guardian] 二次确认 Gateway 在线，跳过重启');
                    this._onHealthy();
                    return;
                }
            } catch {
                // 忽略二次确认异常，按原流程处理
            }
        }

        if (this.isRestarting) {
            // 正在重启中，用退避间隔等待
            this._scheduleNext(this._backoffInterval());
            return;
        }

        // 检查 gateway 是否仍在启动中（进程还活着，只是还没就绪）
        if (this.serviceManager.isGatewayStartingUp()) {
            console.log('[Guardian] Gateway 进程仍在启动中，跳过重启，继续等待');
            this._scheduleNext(this.baseInterval);
            return;
        }

        if (this._canRestart()) {
            this.isRestarting = true;
            this.emit('unhealthy', { reason, consecutiveFailures: this.consecutiveFailures });

            // 连续重启失败达到阈值时，先清理 session lock 再重启
            if (this.consecutiveRestartFailures >= this.sessionCleanupThreshold) {
                console.log('[Guardian] 连续重启失败，自动清理 session lock 文件');
                this._cleanupSessionLocks();
                this.consecutiveRestartFailures = 0;
                this.emit('session-cleanup', { reason: '连续重启失败触发自动清理' });
            }

            // 委托 ServiceManager 执行重启
            const result = await this.serviceManager.restartGateway();

            // 如果返回 "重启正在进行中"，不计入历史和失败
            if (result.error === '重启正在进行中') {
                this.isRestarting = false;
                console.log('[Guardian] 外部重启进行中，等待完成');
                this._scheduleNext(this.baseInterval);
                return;
            }

            this.restartHistory.push(Date.now());

            if (result.success) {
                this.consecutiveFailures = 0;
                this.consecutiveRestartFailures = 0;
                this.isRestarting = false;
                console.log('[Guardian] Gateway 重启成功');
                this.emit('restarted', {
                    restartCount: this._recentRestarts().length,
                    maxRestarts: this.maxRestarts
                });
                this._scheduleNext(this.healthyInterval);
            } else {
                this.isRestarting = false;
                // 进程还在启动中，不计入重启失败，用短间隔继续观察
                if (result.stillStarting) {
                    console.log(`[Guardian] Gateway 启动超时但进程仍在运行，继续等待`);
                    this._scheduleNext(this.baseInterval);
                } else {
                    this.consecutiveRestartFailures++;
                    this._lastError = result.error;
                    console.log(`[Guardian] Gateway 重启失败 (连续 ${this.consecutiveRestartFailures} 次): ${result.error}`);
                    this.emit('restart-failed', { error: result.error, consecutiveRestartFailures: this.consecutiveRestartFailures });
                    this._scheduleNext(this._backoffInterval());
                }
            }
        } else {
            // 达到重启上限，进入长间隔监控（不放弃）
            console.log(`[Guardian] 重启次数达上限，进入低频监控 (${this.maxInterval / 1000}s)`);
            this.emit('restart-limit-reached', { restartHistory: this.restartHistory, lastError: this._lastError });
            this._scheduleNext(this.maxInterval);
        }
    }

    // 清理 session lock 文件（防止死锁导致 gateway 启动后卡住）
    _cleanupSessionLocks() {
        try {
            const SessionLockManager = require('./utils/session-lock-manager');
            const result = SessionLockManager.cleanupStaleLocks({
                agentId: 'main',
                force: false,
                lockStaleMs: 120000
            });

            if (result.removedLocks > 0) {
                console.log(`[Guardian] 已清理 ${result.removedLocks} 个僵尸 session lock 文件`);
            }
            if (result.skippedLocks > 0) {
                console.log(`[Guardian] 保留 ${result.skippedLocks} 个活跃 session lock 文件`);
            }
        } catch (err) {
            console.log(`[Guardian] 清理 session lock 失败: ${err.message}`);
        }
    }

    // 指数退避：5s → 10s → 20s → 40s → 60s (上限)
    _backoffInterval() {
        const backoff = this.baseInterval * Math.pow(2, Math.min(this.consecutiveFailures - 3, 4));
        return Math.min(backoff, 60000);
    }

    _canRestart() {
        return this._recentRestarts().length < this.maxRestarts;
    }

    _recentRestarts() {
        const now = Date.now();
        this.restartHistory = this.restartHistory.filter(t => now - t < this.restartWindow);
        return this.restartHistory;
    }

    getStats() {
        const recent = this._recentRestarts();
        return {
            isRunning: this.isRunning,
            consecutiveFailures: this.consecutiveFailures,
            consecutiveRestartFailures: this.consecutiveRestartFailures,
            currentIntervalSec: Math.round(this.currentInterval / 1000),
            restartsInWindow: recent.length,
            maxRestarts: this.maxRestarts,
            canRestart: this._canRestart()
        };
    }

    // ==================== 新增：监控 API ====================

    /**
     * 获取健康度评分
     */
    getHealthScore() {
        return this.healthScorer.calculateHealthScore();
    }

    /**
     * 获取性能指标
     */
    getMetrics() {
        return this.metricsCollector.getMetricsSummary();
    }

    /**
     * 获取异常检测结果
     */
    getAnomalies() {
        return this.anomalyDetector.getRecentAnomalies(10);
    }

    /**
     * 获取完整状态（包含所有监控数据）
     */
    getFullStatus() {
        return {
            guardian: this.getStats(),
            health: this.getHealthScore(),
            metrics: this.getMetrics(),
            anomalies: this.getAnomalies(),
            timestamp: Date.now()
        };
    }

    /**
     * 清除监控数据
     */
    clearMetrics() {
        this.metricsCollector.clear();
        this.anomalyDetector.clearAnomalies();
    }
}

module.exports = GatewayGuardian;
