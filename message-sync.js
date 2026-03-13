// 真正的消息同步系统 - 通过轮询会话历史
const EventEmitter = require('events');

class MessageSyncSystem extends EventEmitter {
    constructor(openclawClient) {
        super();
        this.openclawClient = openclawClient;
        this.isConnected = false;
        this.messageHistory = [];
        this.pollTimer = null;
        this.pollIntervalMs = 2500;
        this.lastSeenBySession = new Map();
        this.sessionKeys = new Set(['main', 'agent:main:main']);
        this.lastSessionRefreshAt = 0;
        this.sessionRefreshIntervalMs = 15000;
    }

    _isFeishuDirectSession(sessionKey = '') {
        return /:feishu:direct:/i.test(String(sessionKey || ''));
    }

    _isFeishuSession(sessionKey = '') {
        return /:(feishu|lark):/i.test(String(sessionKey || ''));
    }

    _normalizeUserSender(rawSender, channel = 'lark', sessionKey = '') {
        const sender = String(rawSender || '').trim();
        const ch = String(channel || '').toLowerCase();
        const isDirect = this._isFeishuDirectSession(sessionKey);
        const isFeishu = this._isFeishuSession(sessionKey) || ch === 'lark' || ch === 'feishu';

        if (!sender) return isDirect ? '屁屁果' : (isFeishu ? '飞书成员' : '用户');
        if (sender === '用户' || sender.toLowerCase() === 'user') return isDirect ? '屁屁果' : sender;

        if (isDirect) return '屁屁果';

        // 群聊不映射为“屁屁果”，但要隐藏原始ID，避免泄露
        if (/^ou_[a-z0-9]+$/i.test(sender) || sender.includes(':') || /feishu|lark/i.test(sender)) {
            return isFeishu ? '飞书成员' : sender;
        }
        return sender;
    }

    _sanitizeDisplayContent(content, sessionKey = '') {
        const text = String(content || '').trim();
        if (!text) return '';
        if (!this._isFeishuSession(sessionKey)) return text;

        // 去除飞书用户ID前缀: ou_xxx: 你好
        const withoutOuPrefix = text.replace(/^ou_[a-z0-9]+:\s*/i, '');

        // 群聊场景下也去除明显的 ID 前缀（保留正文）
        return withoutOuPrefix.replace(/^(?:open_id|user_id|chat_id)\s*[:=]\s*[a-z0-9_-]+\s*[:：]\s*/i, '');
    }

    connect() {
        const { colorLog } = require('./utils/color-log');
        colorLog('✅ 消息同步系统已启动(会话轮询模式)');
        this.isConnected = true;
        this.emit('connected');
        this._startPolling();
    }

    handleMessage(message) {
        // 处理新消息
        this.messageHistory.push({
            timestamp: Date.now(),
            sender: message.sender || '用户',
            content: message.content,
            channel: message.channel || 'lark',
            role: message.role || 'user'
        });

        this.emit('new_message', {
            sender: message.sender || '用户',
            content: message.content,
            channel: message.channel || 'lark',
            role: message.role || 'user'
        });
    }

    _extractText(content) {
        if (!content) return '';
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content.map(part => {
                if (typeof part === 'string') return part;
                if (typeof part?.text === 'string') return part.text;
                return '';
            }).filter(Boolean).join('\n');
        }
        if (typeof content?.text === 'string') return content.text;
        return '';
    }

    _messageKey(msg) {
        const text = this._extractText(msg?.content || '').slice(0, 80);
        const ts = msg?.timestamp || 0;
        const role = msg?.role || '';
        const sender = msg?.senderLabel || '';
        return `${ts}|${role}|${sender}|${text}`;
    }

    _toSyncMessage(msg, sessionKey = '') {
        const rawContent = this._extractText(msg?.content || '');
        const content = this._sanitizeDisplayContent(rawContent, sessionKey);
        const role = String(msg?.role || '').toLowerCase() === 'assistant' ? 'assistant' : 'user';
        const sender = role === 'assistant'
            ? '小屁'
            : this._normalizeUserSender(msg?.senderLabel, 'lark', sessionKey);
        return {
            sender,
            content,
            channel: 'lark',
            role,
            sessionKey
        };
    }

    async _refreshSessionKeys() {
        const now = Date.now();
        if (now - this.lastSessionRefreshAt < this.sessionRefreshIntervalMs) return;
        this.lastSessionRefreshAt = now;

        if (!this.openclawClient?.listRemoteSessions) return;
        const result = await this.openclawClient.listRemoteSessions(120);
        if (!result.success || !Array.isArray(result.sessions)) return;

        for (const s of result.sessions) {
            const key = s?.key || s?.sessionKey;
            if (!key || typeof key !== 'string') continue;
            // 重点跟踪主会话 + 飞书会话
            if (key === 'main' || key === 'agent:main:main' || key.includes(':feishu:')) {
                this.sessionKeys.add(key);
            }
        }
    }

    async _pollSession(sessionKey) {
        const result = await this.openclawClient.fetchChatHistory(sessionKey, 30);
        if (!result.success || !Array.isArray(result.messages)) return;

        const messages = result.messages;
        if (messages.length === 0) return;

        const currentLastSeen = this.lastSeenBySession.get(sessionKey) || null;
        if (!currentLastSeen) {
            this.lastSeenBySession.set(sessionKey, this._messageKey(messages[messages.length - 1]));
            return;
        }

        const newMessages = [];
        let foundLast = false;
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            const key = this._messageKey(msg);
            if (key === currentLastSeen) {
                foundLast = true;
                break;
            }
            newMessages.push(msg);
        }

        if (!foundLast && currentLastSeen) {
            // 历史被截断时，避免一次性重复刷屏
            this.lastSeenBySession.set(sessionKey, this._messageKey(messages[messages.length - 1]));
            return;
        }

        if (newMessages.length === 0) return;
        newMessages.reverse();

        for (const msg of newMessages) {
            const role = String(msg?.role || '').toLowerCase();
            if (role !== 'user' && role !== 'assistant') continue;

            // user: 过滤本地网关客户端注入，避免重复
            if (role === 'user' && (msg?.senderLabel || '').toLowerCase() === 'gateway-client') continue;
            // assistant: 仅飞书会话同步，避免 main 会话与本地发送链路重复
            if (role === 'assistant' && !this._isFeishuSession(sessionKey)) continue;

            const syncMsg = this._toSyncMessage(msg, sessionKey);
            if (!syncMsg.content) continue;
            this.handleMessage(syncMsg);
        }

        this.lastSeenBySession.set(sessionKey, this._messageKey(messages[messages.length - 1]));
    }

    async _pollOnce() {
        if (!this.isConnected || !this.openclawClient?.fetchChatHistory) return;
        await this._refreshSessionKeys();
        for (const key of this.sessionKeys) {
            await this._pollSession(key);
        }
    }

    _startPolling() {
        this._stopPolling();
        const tick = async () => {
            try {
                await this._pollOnce();
            } catch (e) {
                // 降噪：同步失败不打断主流程
            }
        };
        tick();
        this.pollTimer = setInterval(tick, this.pollIntervalMs);
    }

    _stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    disconnect() {
        this.isConnected = false;
        this._stopPolling();
    }
}

module.exports = MessageSyncSystem;
