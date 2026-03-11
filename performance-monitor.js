// 📊 性能监控与日志管理系统
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');

class PerformanceMonitor {
    constructor(options = {}) {
        this.interval = options.interval || 60 * 1000; // 1分钟采样
        this.maxSamples = options.maxSamples || 1440; // 24小时数据
        this.logDir = options.logDir || path.join(
            process.env.USERPROFILE || process.env.HOME,
            'openclaw-data',
            'logs'
        );
        
        this.samples = [];
        this.errors = [];
        this.maxErrors = 100;
        this.startTime = Date.now();
        this.timer = null;
        this.isRunning = false;
        
        this.stats = {
            totalErrors: 0,
            totalWarnings: 0,
            restarts: 0,
            crashs: 0,
            uptime: 0
        };
        
        this.ensureLogDir();
    }

    async ensureLogDir() {
        try {
            await fs.mkdir(this.logDir, { recursive: true });
            await this.loadStats();
        } catch (err) {
            console.error('创建日志目录失败:', err);
        }
    }

    // 开始监控
    start() {
        if (this.isRunning) return;
        
        const { colorLog } = require('./utils/color-log');
        colorLog('📊 性能监控系统启动');
        this.isRunning = true;
        this.collectSample(); // 立即采样
        
        this.timer = setInterval(() => {
            this.collectSample();
        }, this.interval);
    }

    // 停止监控
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.isRunning = false;
        console.log('📊 性能监控系统停止');
    }

    // 采集性能样本
    collectSample() {
        const memUsage = process.memoryUsage();
        const cpuUsage = process.cpuUsage();
        
        const sample = {
            timestamp: Date.now(),
            memory: {
                rss: memUsage.rss,
                heapTotal: memUsage.heapTotal,
                heapUsed: memUsage.heapUsed,
                external: memUsage.external,
                arrayBuffers: memUsage.arrayBuffers
            },
            cpu: {
                user: cpuUsage.user,
                system: cpuUsage.system
            },
            system: {
                totalMem: os.totalmem(),
                freeMem: os.freemem(),
                loadAvg: os.loadavg()[0],
                uptime: os.uptime()
            },
            process: {
                uptime: process.uptime(),
                pid: process.pid
            }
        };
        
        this.samples.push(sample);
        
        // 限制样本数量
        if (this.samples.length > this.maxSamples) {
            this.samples.shift();
        }
        
        // 检查异常
        this.checkAnomalies(sample);
        
        return sample;
    }

    // 检查性能异常
    checkAnomalies(sample) {
        const warnings = [];
        
        // 内存使用超过1GB
        if (sample.memory.heapUsed > 1024 * 1024 * 1024) {
            warnings.push({
                type: 'memory',
                level: 'warning',
                message: `内存使用过高: ${this.formatBytes(sample.memory.heapUsed)}`
            });
        }
        
        // 系统内存不足 (小于500MB)
        if (sample.system.freeMem < 500 * 1024 * 1024) {
            warnings.push({
                type: 'system',
                level: 'warning',
                message: `系统内存不足: ${this.formatBytes(sample.system.freeMem)}`
            });
        }
        
        // CPU负载过高 (1分钟负载 > CPU核心数 * 2)
        const cpuCores = os.cpus().length;
        if (sample.system.loadAvg > cpuCores * 2) {
            warnings.push({
                type: 'cpu',
                level: 'warning',
                message: `CPU负载过高: ${sample.system.loadAvg.toFixed(2)}`
            });
        }
        
        if (warnings.length > 0) {
            this.stats.totalWarnings += warnings.length;
            warnings.forEach(w => {
                console.warn(`⚠️ ${w.message}`);
                this.recordError(w.type, w.message, 'warning');
            });
        }
    }

    // 记录错误
    recordError(type, message, level = 'error') {
        const error = {
            timestamp: Date.now(),
            type,
            level,
            message,
            stack: new Error().stack
        };
        
        this.errors.push(error);
        
        if (this.errors.length > this.maxErrors) {
            this.errors.shift();
        }
        
        if (level === 'error') {
            this.stats.totalErrors++;
        } else if (level === 'warning') {
            this.stats.totalWarnings++;
        }
        
        // 写入错误日志
        this.writeErrorLog(error);
    }

    // 写入错误日志
    async writeErrorLog(error) {
        const today = new Date().toISOString().split('T')[0];
        const logFile = path.join(this.logDir, `errors-${today}.log`);
        
        const logLine = `[${new Date(error.timestamp).toISOString()}] [${error.level.toUpperCase()}] [${error.type}] ${error.message}\n${error.stack}\n\n`;
        
        try {
            await fs.appendFile(logFile, logLine, 'utf8');
        } catch (err) {
            console.error('写入错误日志失败:', err);
        }
    }

    // 获取当前性能状态
    getCurrentStats() {
        const latest = this.samples[this.samples.length - 1] || this.collectSample();
        const uptime = Date.now() - this.startTime;
        
        return {
            uptime: {
                ms: uptime,
                formatted: this.formatUptime(uptime),
                process: process.uptime()
            },
            memory: {
                heapUsed: this.formatBytes(latest.memory.heapUsed),
                heapTotal: this.formatBytes(latest.memory.heapTotal),
                rss: this.formatBytes(latest.memory.rss),
                percentage: ((latest.memory.heapUsed / latest.memory.heapTotal) * 100).toFixed(1) + '%'
            },
            system: {
                totalMem: this.formatBytes(latest.system.totalMem),
                freeMem: this.formatBytes(latest.system.freeMem),
                usedMem: this.formatBytes(latest.system.totalMem - latest.system.freeMem),
                loadAvg: latest.system.loadAvg.toFixed(2),
                cpus: os.cpus().length
            },
            counters: {
                ...this.stats,
                uptime: uptime
            },
            errors: {
                total: this.stats.totalErrors,
                recent: this.errors.slice(-10).map(e => ({
                    time: new Date(e.timestamp).toLocaleString('zh-CN'),
                    type: e.type,
                    level: e.level,
                    message: e.message
                }))
            }
        };
    }

    // 获取历史数据
    getHistoryData(minutes = 60) {
        const cutoff = Date.now() - minutes * 60 * 1000;
        const recent = this.samples.filter(s => s.timestamp > cutoff);
        
        return {
            samples: recent.length,
            period: `${minutes}分钟`,
            memory: {
                min: Math.min(...recent.map(s => s.memory.heapUsed)),
                max: Math.max(...recent.map(s => s.memory.heapUsed)),
                avg: recent.reduce((sum, s) => sum + s.memory.heapUsed, 0) / recent.length
            },
            data: recent.map(s => ({
                time: new Date(s.timestamp).toLocaleTimeString('zh-CN'),
                memoryMB: (s.memory.heapUsed / 1024 / 1024).toFixed(1),
                rssMB: (s.memory.rss / 1024 / 1024).toFixed(1),
                loadAvg: s.system.loadAvg.toFixed(2)
            }))
        };
    }

    // 生成性能报告
    async generateReport() {
        const stats = this.getCurrentStats();
        const history = this.getHistoryData(60);
        
        const report = {
            generatedAt: new Date().toISOString(),
            uptime: stats.uptime,
            memory: stats.memory,
            system: stats.system,
            counters: stats.counters,
            errors: stats.errors,
            history: {
                samples: history.samples,
                period: history.period,
                memory: {
                    min: this.formatBytes(history.memory.min),
                    max: this.formatBytes(history.memory.max),
                    avg: this.formatBytes(history.memory.avg)
                }
            },
            health: this.calculateHealthScore()
        };
        
        // 保存报告
        const today = new Date().toISOString().split('T')[0];
        const reportFile = path.join(this.logDir, `report-${today}.json`);
        await fs.writeFile(reportFile, JSON.stringify(report, null, 2), 'utf8');
        
        return report;
    }

    // 计算健康分数
    calculateHealthScore() {
        let score = 100;
        const latest = this.samples[this.samples.length - 1];
        
        if (!latest) return { score: 0, status: 'unknown', issues: [] };
        
        const issues = [];
        
        // 内存使用 (最多扣20分)
        const memUsagePercent = (latest.memory.heapUsed / latest.memory.heapTotal) * 100;
        if (memUsagePercent > 90) {
            score -= 20;
            issues.push('内存使用超过90%');
        } else if (memUsagePercent > 80) {
            score -= 10;
            issues.push('内存使用超过80%');
        }
        
        // 系统内存 (最多扣15分)
        const sysMemPercent = ((latest.system.totalMem - latest.system.freeMem) / latest.system.totalMem) * 100;
        if (sysMemPercent > 95) {
            score -= 15;
            issues.push('系统内存不足');
        } else if (sysMemPercent > 90) {
            score -= 8;
            issues.push('系统内存紧张');
        }
        
        // 错误率 (最多扣30分)
        const uptime = Date.now() - this.startTime;
        const errorRate = this.stats.totalErrors / (uptime / 1000 / 60); // 每分钟错误数
        if (errorRate > 1) {
            score -= 30;
            issues.push('错误率过高');
        } else if (errorRate > 0.5) {
            score -= 15;
            issues.push('错误较多');
        }
        
        // CPU负载 (最多扣15分)
        const cpuCores = os.cpus().length;
        if (latest.system.loadAvg > cpuCores * 2) {
            score -= 15;
            issues.push('CPU负载过高');
        } else if (latest.system.loadAvg > cpuCores * 1.5) {
            score -= 8;
            issues.push('CPU负载较高');
        }
        
        // 重启次数 (最多扣20分)
        if (this.stats.restarts > 5) {
            score -= 20;
            issues.push('重启次数过多');
        } else if (this.stats.restarts > 2) {
            score -= 10;
            issues.push('有多次重启');
        }
        
        score = Math.max(0, score);
        
        let status = 'excellent';
        if (score < 50) status = 'critical';
        else if (score < 70) status = 'warning';
        else if (score < 90) status = 'good';
        
        return { score, status, issues };
    }

    // 保存统计
    async saveStats() {
        const statsFile = path.join(this.logDir, 'stats.json');
        try {
            await fs.writeFile(statsFile, JSON.stringify({
                stats: this.stats,
                lastUpdate: Date.now()
            }, null, 2), 'utf8');
        } catch (err) {
            console.error('保存统计失败:', err);
        }
    }

    // 加载统计
    async loadStats() {
        const statsFile = path.join(this.logDir, 'stats.json');
        try {
            if (fsSync.existsSync(statsFile)) {
                const data = await fs.readFile(statsFile, 'utf8');
                const loaded = JSON.parse(data);
                this.stats = { ...this.stats, ...loaded.stats };
                console.log('📊 已加载历史统计');
            }
        } catch (err) {
            console.error('加载统计失败:', err);
        }
    }

    // 格式化字节
    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
    }

    // 格式化时长
    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) {
            return `${days}天 ${hours % 24}小时`;
        } else if (hours > 0) {
            return `${hours}小时 ${minutes % 60}分钟`;
        } else if (minutes > 0) {
            return `${minutes}分钟 ${seconds % 60}秒`;
        } else {
            return `${seconds}秒`;
        }
    }

    // 更新统计
    incrementStat(key) {
        if (key in this.stats) {
            this.stats[key]++;
            this.saveStats();
        }
    }
}

module.exports = PerformanceMonitor;
