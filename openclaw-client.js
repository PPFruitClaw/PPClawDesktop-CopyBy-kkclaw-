// OpenClaw 连接模块
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const pathResolver = require('./utils/openclaw-path-resolver');
const configManager = require('./utils/config-manager');
const LogSanitizer = require('./utils/log-sanitizer');
const SecureStorage = require('./utils/secure-storage');
const SessionLockManager = require('./utils/session-lock-manager');

// 从配置读取端口
function getOpenClawHost() {
    try {
        const config = configManager.getConfig();
        const port = config.gateway?.port || 18789;
        return `http://127.0.0.1:${port}`;
    } catch (e) {
        return 'http://127.0.0.1:18789';
    }
}

// 从配置读取 token（支持加密存储）
function getOpenClawToken() {
    if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
    try {
        const configPath = pathResolver.getConfigPath();
        const token = SecureStorage.getSecureToken(configPath);
        if (token) return resolveTemplateToken(token);

        // Fallback 到配置管理器
        const config = configManager.getConfig();
        return resolveTemplateToken(config.gateway?.auth?.token || '');
    } catch (e) {
        return '';
    }
}

function resolveTemplateToken(rawToken) {
    const token = String(rawToken || '').trim();
    if (!token.startsWith('${') || !token.endsWith('}')) {
        return token;
    }
    const varName = token.slice(2, -1).trim();
    if (!varName) return '';
    if (process.env[varName]) return process.env[varName];

    try {
        const envPath = path.join(os.homedir(), '.openclaw', '.env');
        if (!fs.existsSync(envPath)) return '';
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const idx = trimmed.indexOf('=');
            if (idx <= 0) continue;
            const key = trimmed.slice(0, idx).trim();
            if (key !== varName) continue;
            const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
            return value;
        }
    } catch (e) {
        // ignore
    }
    return '';
}

class OpenClawClient {
    constructor() {
        this.connected = false;
        this.sessionKey = null;
        this.lastCheckTime = 0;
        this.checkInterval = 10000; // 10秒检查一次,不要太频繁
        this.onError = null; // 错误回调，用于触发服务管理器检测
        this.currentSessionId = null; // 当前会话 ID
        this.sessionTokenCount = 0; // 当前会话 token 估算
        this.requestCounter = 0; // 请求计数器
        this.errorHistory = []; // 错误历史记录
        this.maxErrorHistory = 50; // 最多保留50条错误
        this.requestHistory = []; // 请求历史记录
        this.maxRequestHistory = 20; // 最多保留20条请求记录
    }

    _isPluginSessionKey(sessionKey) {
        return SessionLockManager.isPluginSessionKey(sessionKey);
    }

    _getHost() {
        return getOpenClawHost();
    }

    _getToken() {
        return getOpenClawToken();
    }

    // 设置错误回调
    setErrorHandler(handler) {
        this.onError = handler;
    }

    async checkConnection() {
        // 避免频繁检查
        const now = Date.now();
        if (now - this.lastCheckTime < this.checkInterval && this.connected) {
            return this.connected;
        }
        this.lastCheckTime = now;

        const tryPing = async (timeoutMs = 8000) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetch(`${this._getHost()}/`, {
                    method: 'GET',
                    signal: controller.signal
                });
                return Number.isInteger(response.status);
            } catch {
                return false;
            } finally {
                clearTimeout(timeoutId);
            }
        };

        // 两次探活：降低瞬时抖动导致的误报
        const first = await tryPing(8000);
        if (first) {
            this.connected = true;
            return true;
        }

        await new Promise(resolve => setTimeout(resolve, 250));
        const second = await tryPing(8000);
        this.connected = second;
        return second;
    }

    async sendMessage(message) {
        const requestId = ++this.requestCounter;
        const startTime = Date.now();

        console.log(`[Req#${requestId}] 📤 发送消息: ${LogSanitizer.sanitizeMessage(message)}`);

        // 检查上下文长度
        const contextCheck = await this.checkContextLength(message);
        if (contextCheck.warning) {
            console.warn(`[Req#${requestId}] ⚠️ ${contextCheck.message}`);
        }

        // 设置超时检测（30秒）
        const timeoutWarning = setTimeout(() => {
            console.error(`[Req#${requestId}] ⏰ 请求超时警告：已等待30秒无响应`);
            console.error(`[Req#${requestId}] 可能原因：1) Gateway处理缓慢 2) API调用超时 3) 网络问题`);
        }, 30000);

        try {
            const content = await this._sendMessageViaWebSocket(message, requestId);
            const elapsed = Date.now() - startTime;
            this.connected = true;

            // 更新 token 计数（粗略估算：中文1字≈2token，英文1词≈1.3token）
            this.sessionTokenCount += this.estimateTokens(message) + this.estimateTokens(content);

            clearTimeout(timeoutWarning); // 确保清除超时警告

            console.log(`[Req#${requestId}] ✅ 收到响应 (耗时: ${elapsed}ms, 累计tokens: ~${this.sessionTokenCount})`);

            // 记录成功的请求
            this._recordRequest(requestId, message, content, elapsed, true);

            return content;
        } catch (err) {
            clearTimeout(timeoutWarning); // 清除超时警告
            const elapsed = Date.now() - startTime;
            console.error(`[Req#${requestId}] ❌ 发送消息失败 (耗时: ${elapsed}ms):`, err.message);

            // 记录错误
            this._recordError(requestId, err.message, elapsed, message);

            this.connected = false;
            // 触发服务检测
            if (this.onError) {
                this.onError(err.message);
            }
            return `错误: ${err.message}`;
        }
    }

    async fetchChatHistory(sessionKey = 'main', limit = 50) {
        try {
            const payload = await this._callGatewayViaWebSocket('chat.history', { sessionKey, limit }, 15000);
            const messages = Array.isArray(payload?.messages) ? payload.messages : [];
            return {
                success: true,
                sessionKey: payload?.sessionKey || sessionKey,
                sessionId: payload?.sessionId || '',
                messages
            };
        } catch (err) {
            return {
                success: false,
                sessionKey,
                sessionId: '',
                messages: [],
                error: err.message
            };
        }
    }

    async listRemoteSessions(limit = 120) {
        try {
            const payload = await this._callGatewayViaWebSocket('sessions.list', { limit }, 15000);
            const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
            return { success: true, sessions };
        } catch (err) {
            return { success: false, sessions: [], error: err.message };
        }
    }

    async _callGatewayViaWebSocket(method, params = {}, timeoutMs = 15000) {
        const gatewayToken = this._getToken();
        const wsUrl = this._toWsUrl(this._getHost());

        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            let done = false;
            let reqSeq = 0;
            const pending = new Map();
            const timers = new Set();

            const finish = (err, value) => {
                if (done) return;
                done = true;

                for (const timer of timers) clearTimeout(timer);
                for (const [, p] of pending) p.reject(new Error('连接已关闭'));
                pending.clear();

                try {
                    ws.removeAllListeners();
                    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                        ws.terminate();
                    }
                } catch (e) { /* ignore */ }

                if (err) reject(err);
                else resolve(value);
            };

            const setTimer = (fn, ms) => {
                const t = setTimeout(() => {
                    timers.delete(t);
                    fn();
                }, ms);
                timers.add(t);
                return t;
            };

            const request = (rpcMethod, rpcParams, ms = 12000) => new Promise((resolveReq, rejectReq) => {
                if (done) return rejectReq(new Error('请求已结束'));
                if (ws.readyState !== WebSocket.OPEN) return rejectReq(new Error('WebSocket 未连接'));

                const id = `rpc-${Date.now()}-${++reqSeq}`;
                const timeout = setTimer(() => {
                    pending.delete(id);
                    rejectReq(new Error(`${rpcMethod} 超时`));
                }, ms);

                pending.set(id, {
                    resolve: (payload) => {
                        clearTimeout(timeout);
                        timers.delete(timeout);
                        resolveReq(payload);
                    },
                    reject: (err) => {
                        clearTimeout(timeout);
                        timers.delete(timeout);
                        rejectReq(err);
                    }
                });

                ws.send(JSON.stringify({
                    type: 'req',
                    id,
                    method: rpcMethod,
                    params: rpcParams
                }));
            });

            setTimer(() => finish(new Error(`Gateway 请求超时: ${method}`)), timeoutMs);

            ws.on('open', async () => {
                try {
                    await request('connect', {
                        minProtocol: 3,
                        maxProtocol: 3,
                        client: {
                            id: 'gateway-client',
                            version: 'kkclaw-desktop',
                            platform: process.platform,
                            mode: 'cli',
                            instanceId: `kkclaw-rpc-${Date.now()}`
                        },
                        role: 'operator',
                        scopes: ['operator.admin'],
                        caps: ['tool-events'],
                        auth: gatewayToken ? { token: gatewayToken } : undefined
                    });
                    const result = await request(method, params, timeoutMs);
                    finish(null, result);
                } catch (err) {
                    finish(err);
                }
            });

            ws.on('message', (buffer) => {
                if (done) return;
                let msg = null;
                try {
                    msg = JSON.parse(String(buffer));
                } catch (e) {
                    return;
                }

                if (msg?.type === 'res' && msg?.id && pending.has(msg.id)) {
                    const handler = pending.get(msg.id);
                    pending.delete(msg.id);
                    if (msg.ok) {
                        handler.resolve(msg.payload);
                    } else {
                        const errorCode = msg.error?.code || 'REQUEST_FAILED';
                        const errorMsg = msg.error?.message || '请求失败';
                        handler.reject(new Error(`${errorCode} ${errorMsg}`));
                    }
                }
            });

            ws.on('error', (err) => finish(err));
            ws.on('close', (code, reason) => {
                if (!done) finish(new Error(`Gateway 连接关闭 (${code}) ${String(reason || '')}`));
            });
        });
    }

    _toWsUrl(host) {
        return host.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    }

    _extractTextFromGatewayMessage(message) {
        if (!message) return '';
        if (typeof message === 'string') return message;
        if (typeof message.text === 'string') return message.text;
        if (Array.isArray(message.content)) {
            return message.content
                .map(part => {
                    if (typeof part === 'string') return part;
                    if (typeof part?.text === 'string') return part.text;
                    return '';
                })
                .filter(Boolean)
                .join('\n');
        }
        return '';
    }

    async _sendMessageViaWebSocket(message, requestId) {
        const gatewayToken = this._getToken();
        const wsUrl = this._toWsUrl(this._getHost());
        const timeoutMs = 90000;

        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            let reqSeq = 0;
            let completed = false;
            let runId = null;
            let latestDelta = '';
            const pending = new Map();
            const timers = new Set();

            const finish = (err, value) => {
                if (completed) return;
                completed = true;

                for (const timer of timers) clearTimeout(timer);
                for (const [, p] of pending) p.reject(new Error('连接已关闭'));
                pending.clear();

                try {
                    ws.removeAllListeners();
                    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                        ws.terminate();
                    }
                } catch (e) { /* ignore */ }

                if (err) reject(err);
                else resolve(value || '无响应');
            };

            const setTimer = (fn, ms) => {
                const t = setTimeout(() => {
                    timers.delete(t);
                    fn();
                }, ms);
                timers.add(t);
                return t;
            };

            const request = (method, params, ms = 12000) => new Promise((resolveReq, rejectReq) => {
                if (completed) return rejectReq(new Error('请求已结束'));
                if (ws.readyState !== WebSocket.OPEN) return rejectReq(new Error('WebSocket 未连接'));

                const id = `req-${Date.now()}-${requestId}-${++reqSeq}`;
                const timeout = setTimer(() => {
                    pending.delete(id);
                    rejectReq(new Error(`${method} 超时`));
                }, ms);

                pending.set(id, {
                    resolve: (payload) => {
                        clearTimeout(timeout);
                        timers.delete(timeout);
                        resolveReq(payload);
                    },
                    reject: (err) => {
                        clearTimeout(timeout);
                        timers.delete(timeout);
                        rejectReq(err);
                    }
                });

                ws.send(JSON.stringify({
                    type: 'req',
                    id,
                    method,
                    params
                }));
            });

            setTimer(() => {
                finish(new Error('Gateway 响应超时'));
            }, timeoutMs);

            ws.on('open', async () => {
                try {
                    await request('connect', {
                        minProtocol: 3,
                        maxProtocol: 3,
                        client: {
                            id: 'gateway-client',
                            version: 'kkclaw-desktop',
                            platform: process.platform,
                            mode: 'cli',
                            instanceId: `kkclaw-${Date.now()}`
                        },
                        role: 'operator',
                        scopes: ['operator.admin'],
                        caps: ['tool-events'],
                        auth: gatewayToken ? { token: gatewayToken } : undefined
                    });

                    const sendResult = await request('chat.send', {
                        sessionKey: 'main',
                        idempotencyKey: `kkclaw-${Date.now()}-${requestId}`,
                        message
                    });
                    runId = sendResult?.runId || null;
                } catch (err) {
                    finish(err);
                }
            });

            ws.on('message', (buffer) => {
                if (completed) return;
                let msg = null;
                try {
                    msg = JSON.parse(String(buffer));
                } catch (e) {
                    return;
                }

                if (msg?.type === 'res' && msg?.id && pending.has(msg.id)) {
                    const handler = pending.get(msg.id);
                    pending.delete(msg.id);
                    if (msg.ok) {
                        handler.resolve(msg.payload);
                    } else {
                        const errorCode = msg.error?.code || 'REQUEST_FAILED';
                        const errorMsg = msg.error?.message || '请求失败';
                        handler.reject(new Error(`${errorCode} ${errorMsg}`));
                    }
                    return;
                }

                if (msg?.type !== 'event' || msg?.event !== 'chat') {
                    return;
                }

                const payload = msg.payload || {};
                if (runId && payload.runId && payload.runId !== runId) {
                    return;
                }

                if (payload.state === 'delta') {
                    const text = this._extractTextFromGatewayMessage(payload.message);
                    if (text) latestDelta = text;
                    return;
                }

                if (payload.state === 'error') {
                    finish(new Error(payload.errorMessage || 'chat error'));
                    return;
                }

                if (payload.state === 'aborted' || payload.state === 'final') {
                    const text = this._extractTextFromGatewayMessage(payload.message) || latestDelta || '无响应';
                    finish(null, text);
                }
            });

            ws.on('error', (err) => {
                finish(err);
            });

            ws.on('close', (code, reason) => {
                if (!completed) {
                    finish(new Error(`Gateway 连接关闭 (${code}) ${String(reason || '')}`));
                }
            });
        });
    }

    /**
     * 记录错误到历史
     */
    _recordError(requestId, error, elapsed, message) {
        this.errorHistory.unshift({
            requestId,
            timestamp: new Date().toISOString(),
            error,
            elapsed,
            messageLength: message.length,
            type: error.includes('超时') ? 'timeout' : error.includes('连接') ? 'connection' : 'unknown'
        });

        if (this.errorHistory.length > this.maxErrorHistory) {
            this.errorHistory = this.errorHistory.slice(0, this.maxErrorHistory);
        }
    }

    /**
     * 记录请求到历史
     */
    _recordRequest(requestId, message, response, elapsed, success) {
        this.requestHistory.unshift({
            requestId,
            timestamp: new Date().toISOString(),
            messageLength: message.length,
            responseLength: response ? response.length : 0,
            elapsed,
            success
        });

        if (this.requestHistory.length > this.maxRequestHistory) {
            this.requestHistory = this.requestHistory.slice(0, this.maxRequestHistory);
        }
    }

    /**
     * 获取最近的错误
     */
    getRecentErrors(limit = 10) {
        return this.errorHistory.slice(0, limit);
    }

    /**
     * 获取最近的请求
     */
    getRecentRequests(limit = 10) {
        return this.requestHistory.slice(0, limit);
    }

    /**
     * 获取诊断信息
     */
    async getDiagnostics() {
        const info = await this.getSessionInfo();
        const contextCheck = await this.checkContextLength('');
        const recentErrors = this.getRecentErrors(5);
        const recentRequests = this.getRecentRequests(5);

        return {
            connection: {
                connected: this.connected,
                lastCheckTime: new Date(this.lastCheckTime).toISOString()
            },
            session: {
                activeSessions: info.activeSessions,
                estimatedTokens: this.sessionTokenCount,
                contextPercentage: contextCheck.percentage,
                contextLimit: contextCheck.limit
            },
            requests: {
                total: this.requestCounter,
                recentCount: recentRequests.length,
                recent: recentRequests
            },
            errors: {
                total: this.errorHistory.length,
                recentCount: recentErrors.length,
                recent: recentErrors
            }
        };
    }

    async getStatus() {
        return this.connected ? 'connected' : 'disconnected';
    }

    /**
     * 估算文本的 token 数量（粗略估算）
     * 中文：1字 ≈ 2 tokens
     * 英文：1词 ≈ 1.3 tokens
     */
    estimateTokens(text) {
        if (!text) return 0;

        // 统计中文字符
        const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
        // 统计英文单词（简单按空格分割）
        const englishWords = text.replace(/[\u4e00-\u9fa5]/g, '').split(/\s+/).filter(w => w.length > 0).length;

        return Math.ceil(chineseChars * 2 + englishWords * 1.3);
    }

    /**
     * 检查上下文长度是否接近限制
     */
    async checkContextLength(newMessage) {
        const newTokens = this.estimateTokens(newMessage);
        const totalTokens = this.sessionTokenCount + newTokens;

        // 从 model-switcher 获取当前模型的上下文限制
        const modelLimit = await this.getCurrentModelLimit();
        const threshold = modelLimit * 0.8; // 80% 阈值

        if (totalTokens > modelLimit) {
            return {
                warning: true,
                level: 'critical',
                message: `上下文已超出限制！当前 ~${totalTokens} tokens，模型限制 ${modelLimit} tokens。建议立即清理会话。`,
                tokens: totalTokens,
                limit: modelLimit,
                percentage: Math.round((totalTokens / modelLimit) * 100)
            };
        } else if (totalTokens > threshold) {
            return {
                warning: true,
                level: 'warning',
                message: `上下文接近限制：~${totalTokens}/${modelLimit} tokens (${Math.round((totalTokens / modelLimit) * 100)}%)`,
                tokens: totalTokens,
                limit: modelLimit,
                percentage: Math.round((totalTokens / modelLimit) * 100)
            };
        }

        return {
            warning: false,
            tokens: totalTokens,
            limit: modelLimit,
            percentage: Math.round((totalTokens / modelLimit) * 100)
        };
    }

    /**
     * 获取当前模型的上下文限制
     */
    async getCurrentModelLimit() {
        try {
            const config = configManager.getConfig();
            const defaultsModel = config.agents?.defaults?.model;
            const primaryModel = typeof defaultsModel === 'string'
                ? defaultsModel
                : defaultsModel?.primary;

            if (!primaryModel) return 200000;

            const [providerName, modelId] = primaryModel.split('/');
            const provider = config.models?.providers?.[providerName];
            const model = provider?.models?.find(m => m.id === modelId);

            return model?.contextWindow || 200000;
        } catch (err) {
            console.warn('无法读取模型上下文限制，使用默认值 200k');
            return 200000;
        }
    }

    /**
     * 清理当前会话（删除 session 文件）
     */
    async clearCurrentSession() {
        try {
            const result = SessionLockManager.cleanupPluginSessions({
                agentId: 'main',
                removeIndex: true,
                force: false,
                lockStaleMs: 120000
            });

            // 重置 token 计数
            this.sessionTokenCount = 0;
            this.currentSessionId = null;

            console.log(`✅ 已清理 ${result.deletedSessions} 个会话，移除 ${result.removedLocks} 个僵尸锁`);
            return {
                success: true,
                message: `已清理 ${result.deletedSessions} 个会话`,
                deletedCount: result.deletedSessions,
                removedLocks: result.removedLocks,
                skippedLocked: result.skippedLocked
            };
        } catch (err) {
            console.error('清理会话失败:', err);
            return {
                success: false,
                message: `清理失败: ${err.message}`,
                error: err.message
            };
        }
    }

    /**
     * 获取会话信息
     */
    async getSessionInfo() {
        try {
            const sessionDir = pathResolver.getSessionsDir('main');
            const sessionFile = pathResolver.getSessionsFilePath('main');

            if (!fs.existsSync(sessionFile)) {
                return {
                    activeSessions: 0,
                    estimatedTokens: this.sessionTokenCount,
                    sessions: []
                };
            }

            const SafeConfigLoader = require('./utils/safe-config-loader');
            const sessionsData = SafeConfigLoader.load(sessionFile, {});
            const sessions = [];

            for (const [key, value] of Object.entries(sessionsData)) {
                if (this._isPluginSessionKey(key) && value.sessionId) {
                    const sessionPath = path.join(sessionDir, `${value.sessionId}.jsonl`);
                    if (fs.existsSync(sessionPath)) {
                        const stats = fs.statSync(sessionPath);
                        const content = fs.readFileSync(sessionPath, 'utf8');
                        const lines = content.trim().split('\n').filter(l => l.length > 0);

                        sessions.push({
                            key,
                            sessionId: value.sessionId,
                            messageCount: lines.length,
                            sizeKB: Math.round(stats.size / 1024),
                            lastModified: stats.mtime
                        });
                    }
                }
            }

            return {
                activeSessions: sessions.length,
                estimatedTokens: this.sessionTokenCount,
                sessions
            };
        } catch (err) {
            console.error('获取会话信息失败:', err);
            return {
                activeSessions: 0,
                estimatedTokens: this.sessionTokenCount,
                sessions: [],
                error: err.message
            };
        }
    }

    /**
     * 列出所有会话（用于诊断）
     */
    async listSessions() {
        return this.getSessionInfo();
    }
}

module.exports = OpenClawClient;
