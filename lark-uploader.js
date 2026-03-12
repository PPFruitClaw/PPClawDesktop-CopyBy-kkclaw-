// 飞书文件上传系统 - 支持图片和文件
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

class LarkUploader {
    constructor() {
        this.uploadDir = path.join(__dirname, 'screenshots');
        // 从 OpenClaw 配置读取飞书凭证
        this.config = this.loadConfig();
        this.appId = this.config.appId;
        this.appSecret = this.config.appSecret;
        this.accessToken = null;
        this.tokenExpiry = 0;
        this.apiHost = null;
        this.lastTarget = null; // { receiveIdType, receiveId, sessionKey, updatedAt }
    }

    loadConfig() {
        try {
            const pathResolver = require('./utils/openclaw-path-resolver');
            const SafeConfigLoader = require('./utils/safe-config-loader');
            const configPath = pathResolver.getConfigPath();
            const config = SafeConfigLoader.load(configPath, {});
            const lark = config.channels?.lark || {};
            const feishu = config.channels?.feishu || {};
            const credential = feishu.credential || lark.credential || {};
            const appIdRaw = String(
                lark.appId || lark.app_id ||
                feishu.appId || feishu.app_id ||
                credential.appId || credential.app_id || ''
            ).trim();
            const appSecretRaw = String(
                lark.appSecret || lark.app_secret ||
                feishu.appSecret || feishu.app_secret ||
                credential.appSecret || credential.app_secret || ''
            ).trim();
            const appId = this._resolveTemplateValue(appIdRaw);
            const appSecret = this._resolveTemplateValue(appSecretRaw);
            const domain = String(lark.domain || feishu.domain || 'feishu').trim().toLowerCase();
            return {
                appId,
                appSecret,
                domain
            };
        } catch (err) {
            console.error('❌ 读取飞书配置失败:', err.message);
            return { appId: null, appSecret: null, domain: 'feishu' };
        }
    }

    _loadOpenClawEnvMap() {
        if (this._envMap) return this._envMap;
        const envMap = {};
        try {
            const envPath = path.join(os.homedir(), '.openclaw', '.env');
            if (fs.existsSync(envPath)) {
                const content = fs.readFileSync(envPath, 'utf8');
                for (const line of content.split(/\r?\n/)) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) continue;
                    const idx = trimmed.indexOf('=');
                    if (idx <= 0) continue;
                    const key = trimmed.slice(0, idx).trim();
                    let val = trimmed.slice(idx + 1).trim();
                    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                        val = val.slice(1, -1);
                    }
                    envMap[key] = val;
                }
            }
        } catch (_) {
            // ignore
        }
        this._envMap = envMap;
        return envMap;
    }

    _resolveTemplateValue(value) {
        const raw = String(value || '').trim();
        const match = raw.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
        if (!match) return raw;
        const key = match[1];
        const envMap = this._loadOpenClawEnvMap();
        return process.env[key] || envMap[key] || raw;
    }

    _resolveAuthHosts() {
        const domain = String(this.config?.domain || 'feishu').toLowerCase();
        if (domain.includes('lark') || domain.includes('suite')) {
            return ['open.larksuite.com', 'open.feishu.cn'];
        }
        return ['open.feishu.cn', 'open.larksuite.com'];
    }

    _getApiHost() {
        return this.apiHost || this._resolveAuthHosts()[0];
    }

    async _requestTenantToken(hostname, data) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname,
                path: '/open-apis/auth/v3/tenant_access_token/internal',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(body || '{}');
                        resolve(result);
                    } catch (err) {
                        reject(err);
                    }
                });
            });

            req.on('error', reject);
            req.write(data);
            req.end();
        });
    }

    /**
     * 获取飞书 access_token
     */
    async getAccessToken() {
        // 检查缓存的 token 是否有效
        if (this.accessToken && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }

        // 每次取 token 前刷新配置，避免运行中改配置后仍用旧值
        this.config = this.loadConfig();

        if (!this.config.appId || !this.config.appSecret) {
            throw new Error('飞书 appId 或 appSecret 未配置');
        }

        const data = JSON.stringify({
            app_id: this.config.appId,
            app_secret: this.config.appSecret
        });
        const hosts = this._resolveAuthHosts();
        let lastErr = null;

        for (const host of hosts) {
            try {
                const result = await this._requestTenantToken(host, data);
                if (result.code === 0 && result.tenant_access_token) {
                    this.accessToken = result.tenant_access_token;
                    this.tokenExpiry = Date.now() + ((result.expire || 7200) - 300) * 1000;
                    this.apiHost = host;
                    console.log(`✅ 飞书 token 获取成功 (${host})`);
                    return this.accessToken;
                }
                lastErr = new Error(`飞书认证失败(${host}): code=${result.code}, msg=${result.msg}`);
            } catch (err) {
                lastErr = err;
            }
        }

        const hint = this.config.appId && !String(this.config.appId).startsWith('cli_')
            ? '提示: appId 通常以 cli_ 开头，请确认填写的是飞书开放平台应用的 App ID / App Secret。'
            : '提示: 请确认应用凭证和飞书/国际版域名匹配。';
        throw new Error(`${lastErr?.message || '飞书认证失败'} ${hint}`);
    }

    _parseTargetFromSessionKey(sessionKey = '') {
        const key = String(sessionKey || '');
        if (!key.includes(':feishu:') && !key.includes(':lark:')) return null;

        // direct 会话通常携带 open_id: ...:direct:ou_xxx
        const openIdMatch = key.match(/:(?:direct):((?:ou|on)_[A-Za-z0-9_-]+)/i);
        if (openIdMatch && openIdMatch[1]) {
            return { receiveIdType: 'open_id', receiveId: openIdMatch[1], sessionKey: key };
        }

        // 群聊会话通常携带 chat_id: ...:group:oc_xxx / ...:chat:oc_xxx
        const chatIdMatch = key.match(/:(?:group|chat):((?:oc|chat)_[A-Za-z0-9_-]+)/i);
        if (chatIdMatch && chatIdMatch[1]) {
            return { receiveIdType: 'chat_id', receiveId: chatIdMatch[1], sessionKey: key };
        }

        // 兜底扫描
        const anyOpenId = key.match(/(ou_[A-Za-z0-9_-]+)/i);
        if (anyOpenId && anyOpenId[1]) {
            return { receiveIdType: 'open_id', receiveId: anyOpenId[1], sessionKey: key };
        }
        const anyChatId = key.match(/((?:oc|chat)_[A-Za-z0-9_-]+)/i);
        if (anyChatId && anyChatId[1]) {
            return { receiveIdType: 'chat_id', receiveId: anyChatId[1], sessionKey: key };
        }
        return null;
    }

    rememberSessionTarget(sessionKey = '') {
        const parsed = this._parseTargetFromSessionKey(sessionKey);
        if (!parsed) return false;
        this.lastTarget = {
            ...parsed,
            updatedAt: Date.now()
        };
        return true;
    }

    async sendMessageByKey({ msgType, key, caption = '' }) {
        const token = await this.getAccessToken();
        const target = this.lastTarget;
        if (!target?.receiveIdType || !target?.receiveId) {
            throw new Error('未找到可发送的飞书会话目标。请先在飞书和机器人对话一次，再点击截图。');
        }

        const content = msgType === 'image'
            ? JSON.stringify({ image_key: key })
            : JSON.stringify({ file_key: key });

        const payload = JSON.stringify({
            receive_id: target.receiveId,
            msg_type: msgType,
            content
        });

        const response = await new Promise((resolve, reject) => {
            const options = {
                hostname: this._getApiHost(),
                path: `/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(target.receiveIdType)}`,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            };
            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body || '{}'));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on('error', reject);
            req.write(payload);
            req.end();
        });

        if (response.code !== 0) {
            throw new Error(`消息发送失败: code=${response.code}, msg=${response.msg || 'unknown'}`);
        }

        // 可选补一条文本说明
        if (caption && caption.trim()) {
            const textPayload = JSON.stringify({
                receive_id: target.receiveId,
                msg_type: 'text',
                content: JSON.stringify({ text: caption.trim() })
            });
            await new Promise((resolve, reject) => {
                const options = {
                    hostname: this._getApiHost(),
                    path: `/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(target.receiveIdType)}`,
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(textPayload)
                    }
                };
                const req = https.request(options, (res) => {
                    let body = '';
                    res.on('data', c => body += c);
                    res.on('end', () => {
                        try {
                            const r = JSON.parse(body || '{}');
                            if (r.code === 0) resolve();
                            else reject(new Error(`说明发送失败: code=${r.code}, msg=${r.msg || 'unknown'}`));
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
                req.on('error', reject);
                req.write(textPayload);
                req.end();
            });
        }

        return {
            success: true,
            target
        };
    }

    /**
     * 上传图片到飞书获取 image_key
     */
    async uploadImage(filepath) {
        const token = await this.getAccessToken();
        const imageBuffer = fs.readFileSync(filepath);
        const filename = path.basename(filepath);

        return new Promise((resolve, reject) => {
            const boundary = '----FormBoundary' + Math.random().toString(16).slice(2);

            const header = Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="image_type"\r\n\r\n` +
                `message\r\n` +
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
                `Content-Type: image/png\r\n\r\n`
            );
            const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
            const body = Buffer.concat([header, imageBuffer, footer]);

            const options = {
                hostname: 'open.feishu.cn',
                path: '/open-apis/im/v1/images',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': body.length
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        if (result.code === 0) {
                            console.log('✅ 图片上传成功, image_key:', result.data.image_key);
                            resolve(result.data.image_key);
                        } else {
                            reject(new Error(`图片上传失败: ${result.msg}`));
                        }
                    } catch (err) {
                        reject(err);
                    }
                });
            });

            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    /**
     * 🆕 上传文件到飞书获取 file_key
     * @param {string} filepath - 文件路径
     * @param {string} fileType - 文件类型 (stream/pdf/doc等)
     */
    async uploadFile(filepath, fileType = 'stream') {
        const token = await this.getAccessToken();
        const fileBuffer = fs.readFileSync(filepath);
        const filename = path.basename(filepath);
        const fileSize = fileBuffer.length;

        console.log(`📤 上传文件: ${filename} (${(fileSize / 1024).toFixed(2)} KB)`);

        return new Promise((resolve, reject) => {
            const boundary = '----FormBoundary' + Math.random().toString(16).slice(2);

            // 构建 multipart/form-data
            const header = Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="file_type"\r\n\r\n` +
                `${fileType}\r\n` +
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="file_name"\r\n\r\n` +
                `${filename}\r\n` +
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
                `Content-Type: application/octet-stream\r\n\r\n`
            );
            const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
            const body = Buffer.concat([header, fileBuffer, footer]);

            const options = {
                hostname: 'open.feishu.cn',
                path: '/open-apis/im/v1/files',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': body.length
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        if (result.code === 0) {
                            console.log('✅ 文件上传成功, file_key:', result.data.file_key);
                            resolve(result.data.file_key);
                        } else {
                            reject(new Error(`文件上传失败: ${result.msg}`));
                        }
                    } catch (err) {
                        reject(err);
                    }
                });
            });

            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    /**
     * 🆕 智能检测文件类型
     */
    detectFileType(filepath) {
        const ext = path.extname(filepath).toLowerCase();
        
        // 图片类型
        if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext)) {
            return 'image';
        }
        
        // PDF
        if (ext === '.pdf') {
            return 'pdf';
        }
        
        // Office 文档
        if (['.doc', '.docx'].includes(ext)) {
            return 'doc';
        }
        
        if (['.xls', '.xlsx'].includes(ext)) {
            return 'xls';
        }
        
        if (['.ppt', '.pptx'].includes(ext)) {
            return 'ppt';
        }
        
        // 其他文件
        return 'stream';
    }

    /**
     * 🆕 通用上传方法 - 自动识别图片/文件
     * @param {string} filepath - 文件路径
     * @param {string} caption - 说明文字
     */
    async uploadToLark(filepath, caption = '') {
        try {
            console.log('📤 准备上传到飞书:', filepath);

            // 检查文件是否存在
            if (!fs.existsSync(filepath)) {
                throw new Error(`文件不存在: ${filepath}`);
            }

            const fileType = this.detectFileType(filepath);
            const filename = path.basename(filepath);
            const fileSize = fs.statSync(filepath).size;

            console.log(`📊 文件信息: ${filename}, 类型: ${fileType}, 大小: ${(fileSize / 1024).toFixed(2)} KB`);

            let key;
            if (fileType === 'image') {
                // 图片使用 uploadImage
                key = await this.uploadImage(filepath);
            } else {
                // 其他文件使用 uploadFile
                key = await this.uploadFile(filepath, fileType);
            }

            // 上传成功后，直接发送到飞书会话（而不是仅保存 key）
            await this.sendMessageByKey({
                msgType: fileType === 'image' ? 'image' : 'file',
                key,
                caption
            });

            // 复制文件到 OpenClaw 数据目录
            const openclawDataDir = path.join(process.env.HOME || process.env.USERPROFILE, 'openclaw-data');
            const destFilename = fileType === 'image' ? 'screen.png' : `upload_${filename}`;
            const destPath = path.join(openclawDataDir, destFilename);
            fs.copyFileSync(filepath, destPath);
            console.log('📁 文件已复制到:', destPath);

            // 保存元数据
            const metaPath = path.join(openclawDataDir, 'last_upload.json');
            fs.writeFileSync(metaPath, JSON.stringify({
                filepath: destPath,
                originalPath: filepath,
                filename: filename,
                fileType: fileType,
                fileSize: fileSize,
                key: key,
                caption: caption,
                timestamp: Date.now()
            }, null, 2));

            console.log('✅ 飞书上传成功');
            console.log(`📎 ${fileType === 'image' ? 'image_key' : 'file_key'}:`, key);
            console.log('📝 说明:', caption);

            return {
                success: true,
                filepath: destPath,
                filename: filename,
                fileType: fileType,
                fileSize: fileSize,
                key: key,
                caption: caption,
                target: this.lastTarget
            };

        } catch (err) {
            console.error('❌ 上传飞书失败:', err.message);
            return {
                success: false,
                error: err.message,
                filepath: filepath
            };
        }
    }

}

module.exports = LarkUploader;
