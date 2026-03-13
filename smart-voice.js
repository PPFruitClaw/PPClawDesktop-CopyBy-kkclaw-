// 🎙️ 智能语音播报系统 - 增强版（支持 MiniMax Speech / Edge TTS）
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const MiniMaxTTS = require('./voice/minimax-tts');

class SmartVoiceSystem {
    constructor(petConfig) {
        this.petConfig = petConfig || null;
        this.isSpeaking = false;
        this.tempDir = path.join(__dirname, 'temp');
        this.voice = 'zh-CN-XiaoxiaoNeural';  // Edge TTS 默认晓晓
        this.enabled = true;
        this.queue = [];
        this.maxQueueSize = 10;
        this.lastSpoken = '';
        this.lastSpokenTime = 0;
        this.singleVoiceMode = true; // 固定单一音色，避免来回切换
        this.speakSystemMessages = false; // 默认不播报系统类状态/报错
        this.degradationNotifyEnabled = false; // 默认不发送降级消息到会话
        
        // 🎭 情境模式
        this.contextMode = 'normal';  // normal, excited, calm, urgent
        
        // 🎙️ TTS 引擎选择: 'minimax' | 'edge' | 'qwen3'
        this.ttsEngine = 'minimax';  // 默认使用 MiniMax Speech 2.5

        // 🔑 MiniMax 配置
        this.minimax = null;
        this.minimaxVoiceId = 'xiaotuantuan_minimax';  // 🎤 小团团克隆音色 (KK的默认)
        this.minimaxModel = 'speech-2.5-turbo-preview';
        this.minimaxEmotion = 'happy';  // 默认开心

        // 🧠 本地 Qwen3-TTS 服务状态
        this.qwen3 = {
            process: null,
            ready: false,
            usingExternalServer: false
        };
        this._qwen3StartPromise = null;
        
        // 📊 统计数据
        this.stats = {
            totalSpoken: 0,
            totalSkipped: 0,
            totalQueued: 0,
            avgDuration: 0
        };
        
        const config = this.loadConfig();
        if (config.ttsEngine) {
            this.ttsEngine = String(config.ttsEngine).toLowerCase();
        }
        this.singleVoiceMode = config.singleVoiceMode !== false;
        this.speakSystemMessages = config.speakSystemMessages === true;
        this.degradationNotifyEnabled = config.degradationNotifyEnabled === true;

        this.initMiniMax();
        this.initTempDir();
        this._currentProcess = null; // 当前播放进程引用，用于 stop() 时杀掉

        // 需要时自动启动并预热 Qwen3 本地服务
        if (this.ttsEngine === 'qwen3' || config.qwen3Local?.enabled) {
            this.initQwen3().catch((err) => {
                console.error('[Voice] ⚠️ Qwen3 初始化失败:', err?.message || err);
                if (this.ttsEngine === 'qwen3') {
                    this.ttsEngine = 'edge';
                    console.log('[Voice] ⚠️ 已回退到 Edge TTS');
                }
            });
        }
    }

    async initTempDir() {
        try {
            await fs.mkdir(this.tempDir, { recursive: true });
        } catch (err) {
            console.error('[Voice] ❌ 创建临时目录失败:', err.message);
        }
    }

    /**
     * 🔑 初始化 MiniMax TTS
     */
    initMiniMax() {
        try {
            const config = this.loadConfig();
            const apiKey = process.env.MINIMAX_API_KEY || config.minimax?.apiKey || '';
            if (apiKey) {
                this.minimax = new MiniMaxTTS({
                    apiKey: apiKey,
                    model: config.minimax?.model || this.minimaxModel,
                    voiceId: config.minimax?.voiceId || this.minimaxVoiceId,
                    speed: config.minimax?.speed || 1.1,
                    vol: config.minimax?.vol || 3.0,
                    emotion: config.minimax?.emotion || this.minimaxEmotion,
                    tempDir: this.tempDir
                });
                const { c } = require('./utils/color-log');
                console.log(`[Voice] 🎙️ ${c.bGreen}${c.bold}MiniMax Speech 引擎已初始化${c.reset}`);
                console.log(`[Voice]    模型: ${c.bCyan}${c.bold}${config.minimax?.model || this.minimaxModel}${c.reset}`);
                console.log(`[Voice]    音色: ${c.bMagenta}${c.bold}${config.minimax?.voiceId || this.minimaxVoiceId}${c.reset}`);
                console.log(`[Voice]    情绪: ${c.bWhite}${c.bold}${config.minimax?.emotion || this.minimaxEmotion}${c.reset} | 语速: ${c.bWhite}${c.bold}${config.minimax?.speed || 1.1}x${c.reset} | 音量: ${c.bWhite}${c.bold}${config.minimax?.vol || 3.0}${c.reset}`);
            } else {
                console.log('[Voice] ⚠️ MiniMax API Key 未设置，回退到 Edge TTS');
                if (this.ttsEngine === 'minimax') {
                    this.ttsEngine = 'edge';
                }
            }
        } catch (err) {
            console.error('[Voice] ❌ MiniMax 初始化失败:', err.message);
            if (this.ttsEngine === 'minimax') {
                this.ttsEngine = 'edge';
            }
        }
    }

    /**
     * 🔊 跨平台音频播放
     */
    async _playAudioFile(filePath) {
        if (process.platform === 'darwin') {
            await execFileAsync('afplay', [filePath], { timeout: 120000 });
        } else if (process.platform === 'linux') {
            try {
                await execFileAsync('aplay', [filePath], { timeout: 120000 });
            } catch {
                await execFileAsync('paplay', [filePath], { timeout: 120000 });
            }
        } else {
            // Windows: 用 Electron 的 Chromium 内置 Audio API 播放
            // 完全进程内播放，绝不触发系统文件关联
            try {
                const { BrowserWindow } = require('electron');
                const windows = BrowserWindow.getAllWindows();
                if (windows.length === 0) {
                    console.warn('[Voice] 无可用窗口，跳过音频播放');
                    return;
                }
                const fileUrl = 'file:///' + filePath.replace(/\\/g, '/');
                const safeUrl = JSON.stringify(fileUrl);
                await windows[0].webContents.executeJavaScript(`
                    new Promise((resolve) => {
                        const audio = new Audio(${safeUrl});
                        audio.onended = () => { audio.src = ''; resolve('done'); };
                        audio.onerror = (e) => { audio.src = ''; resolve('error'); };
                        audio.play().catch(() => resolve('blocked'));
                        setTimeout(() => { try { audio.pause(); audio.src = ''; } catch(e) {} resolve('timeout'); }, 60000);
                    })
                `);
            } catch (err) {
                console.error('[Voice] Electron 音频播放失败:', err.message);
            }
        }
    }

    /**
     * 📄 加载配置（优先使用 petConfig 实例获取已解密的值）
     */
    loadConfig() {
        if (this.petConfig) {
            return {
                minimax: this.petConfig.get('minimax') || {},
                ttsEngine: this.petConfig.get('ttsEngine'),
                voiceEnabled: this.petConfig.get('voiceEnabled'),
                qwen3Local: this.petConfig.get('qwen3Local') || {},
            };
        }
        // Fallback: 直接读文件（无法解密）
        try {
            const configPath = path.join(__dirname, 'pet-config.json');
            const fsSync = require('fs');
            const SafeConfigLoader = require('./utils/safe-config-loader');
            if (fsSync.existsSync(configPath)) {
                return SafeConfigLoader.load(configPath, {});
            }
        } catch (err) {
            console.warn('[SmartVoice] 读取配置失败:', err?.message || err);
        }
        return {};
    }

    _resolveQwen3Config() {
        const cfg = this.loadConfig().qwen3Local || {};
        const home = process.env.HOME || '';
        const defaultRoot = path.join(home, '.gemini', 'antigravity', 'scratch', 'VoiceClone_Qwen3-TTS', 'Qwen3-TTS');
        const rootDir = cfg.rootDir || defaultRoot;
        const isWin = process.platform === 'win32';
        const defaultPython = isWin
            ? path.join(rootDir, '.venv_qwen3', 'Scripts', 'python.exe')
            : path.join(rootDir, '.venv_qwen3', 'bin', 'python');

        return {
            enabled: cfg.enabled !== false,
            preferManagedServer: cfg.preferManagedServer !== false,
            rootDir,
            pythonPath: cfg.pythonPath || defaultPython,
            modelDir: cfg.modelDir || path.join(rootDir, 'Qwen3-TTS-12Hz-1.7B-Base'),
            refAudio: cfg.refAudio || path.join(rootDir, 'examples', 'tokenizer_demo_1.wav'),
            refText: cfg.refText || 'This is a reference text for cloning.',
            language: cfg.language || 'Chinese',
            device: cfg.device || 'mps',
            dtype: cfg.dtype || 'float32',
            port: Number(cfg.port || 18789),
            startupTimeoutMs: Number(cfg.startupTimeoutMs || 120000),
            prewarmOnStart: cfg.prewarmOnStart !== false,
            prewarmText: cfg.prewarmText || '你好，这是预热测试。',
            streaming: cfg.streaming !== false,
            firstChunkChars: Number(cfg.firstChunkChars || 12),
            chunkChars: Number(cfg.chunkChars || 24),
            minChunkChars: Number(cfg.minChunkChars || 28),
            targetChunkChars: Number(cfg.targetChunkChars || 64),
            maxChunkChars: Number(cfg.maxChunkChars || 128),
            waitKChars: Number(cfg.waitKChars || 36),
            enableCrossfade: cfg.enableCrossfade === true,
            crossfadeMs: Number(cfg.crossfadeMs || 70),
            maxNewTokens: Number(cfg.maxNewTokens || 768),
            seed: Number(cfg.seed || 42),
            xVectorOnlyMode: cfg.xVectorOnlyMode !== false,
            serverScript: path.join(__dirname, 'voice', 'qwen3-local-server.py')
        };
    }

    async _killProcessOnPort(port) {
        const p = Number(port);
        if (!Number.isInteger(p) || p <= 0) return;
        try {
            if (process.platform === 'darwin' || process.platform === 'linux') {
                const { stdout } = await execFileAsync('lsof', ['-tiTCP:' + String(p), '-sTCP:LISTEN'], { timeout: 3000, windowsHide: true });
                const pids = String(stdout || '').split(/\s+/).map(s => s.trim()).filter(Boolean);
                for (const pid of pids) {
                    try { process.kill(Number(pid), 'SIGTERM'); } catch {}
                }
                if (pids.length > 0) {
                    await new Promise((r) => setTimeout(r, 300));
                }
            }
        } catch {
            // 忽略端口清理失败，后续按正常流程启动
        }
    }

    async _qwen3Health(baseUrl, timeoutMs = 1500) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
            if (!res.ok) return false;
            const data = await res.json().catch(() => ({}));
            return !!data?.ok;
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    async initQwen3() {
        if (this.qwen3.ready) return true;
        if (this._qwen3StartPromise) return this._qwen3StartPromise;

        this._qwen3StartPromise = this._startQwen3Server().finally(() => {
            this._qwen3StartPromise = null;
        });
        return this._qwen3StartPromise;
    }

    async _startQwen3Server() {
        const cfg = this._resolveQwen3Config();
        const baseUrl = `http://127.0.0.1:${cfg.port}`;
        const hasExternal = await this._qwen3Health(baseUrl);

        if (hasExternal && !cfg.preferManagedServer) {
            this.qwen3.ready = true;
            this.qwen3.usingExternalServer = true;
            console.log(`[Voice] 🎙️ 检测到外部 Qwen3 服务: ${baseUrl}`);
            return true;
        }

        if (hasExternal && cfg.preferManagedServer) {
            console.log('[Voice] 🔧 检测到外部 Qwen3 服务，切换为本进程托管模式');
            await this._killProcessOnPort(cfg.port);
        }

        if (!cfg.enabled) throw new Error('qwen3Local.enabled=false');
        if (!fsSync.existsSync(cfg.serverScript)) throw new Error(`服务脚本不存在: ${cfg.serverScript}`);
        if (!fsSync.existsSync(cfg.pythonPath)) throw new Error(`Python 不存在: ${cfg.pythonPath}`);
        if (!fsSync.existsSync(cfg.modelDir)) throw new Error(`模型目录不存在: ${cfg.modelDir}`);
        if (!fsSync.existsSync(cfg.refAudio)) throw new Error(`参考音频不存在: ${cfg.refAudio}`);

        const args = [
            cfg.serverScript,
            '--model-dir', cfg.modelDir,
            '--ref-audio', cfg.refAudio,
            '--ref-text', cfg.refText,
            '--device', cfg.device,
            '--dtype', cfg.dtype,
            '--port', String(cfg.port),
            '--max-new-tokens', String(cfg.maxNewTokens),
            '--seed', String(cfg.seed),
            '--output-dir', this.tempDir
        ];
        if (cfg.xVectorOnlyMode) {
            args.push('--x-vector-only-mode');
        }
        const child = spawn(cfg.pythonPath, args, {
            cwd: path.dirname(cfg.serverScript),
            stdio: ['ignore', 'pipe', 'pipe']
        });
        this.qwen3.process = child;
        this.qwen3.usingExternalServer = false;

        child.stdout.on('data', (buf) => {
            const line = String(buf).trim();
            if (line) console.log(`[Qwen3Local] ${line}`);
        });
        child.stderr.on('data', (buf) => {
            const line = String(buf).trim();
            if (line) console.warn(`[Qwen3Local][stderr] ${line}`);
        });
        child.on('exit', (code, signal) => {
            this.qwen3.ready = false;
            this.qwen3.process = null;
            console.warn(`[Voice] ⚠️ Qwen3 服务退出 code=${code} signal=${signal}`);
        });

        const startTs = Date.now();
        let ready = false;
        while (Date.now() - startTs < cfg.startupTimeoutMs) {
            if (await this._qwen3Health(baseUrl, 1000)) {
                ready = true;
                break;
            }
            await new Promise((r) => setTimeout(r, 700));
        }
        if (!ready) {
            if (this.qwen3.process && !this.qwen3.process.killed) this.qwen3.process.kill('SIGTERM');
            throw new Error('Qwen3 服务启动超时');
        }
        this.qwen3.ready = true;
        console.log(`[Voice] ✅ Qwen3 服务就绪: ${baseUrl}`);

        if (cfg.prewarmOnStart) {
            await this._qwen3Prewarm(baseUrl, cfg.prewarmText).catch((err) => {
                console.warn('[Voice] ⚠️ Qwen3 预热失败:', err?.message || err);
            });
        }
        return true;
    }

    async _qwen3Prewarm(baseUrl, text) {
        const res = await fetch(`${baseUrl}/prewarm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        if (!res.ok) throw new Error(`prewarm http ${res.status}`);
        const data = await res.json();
        if (!data?.ok) throw new Error(data?.error || 'prewarm failed');
        console.log(`[Voice] 🔥 Qwen3 预热完成: ${data.elapsedSec || '?'}s`);
    }

    _splitTextForQwen3Streaming(text, firstChunkChars, chunkChars) {
        const src = String(text || '').trim();
        if (!src) return [];
        const baseParts = src
            .split(/(?<=[。！？!?；;，,、])/)
            .map((s) => s.trim())
            .filter(Boolean);
        if (baseParts.length === 0) return [];

        const merged = [];
        let buf = '';
        for (const p of baseParts) {
            if ((buf + p).length <= chunkChars) {
                buf += p;
                continue;
            }
            if (buf) merged.push(buf);
            if (p.length <= chunkChars) {
                buf = p;
            } else {
                const chunks = p.match(new RegExp(`.{1,${chunkChars}}`, 'g')) || [p];
                merged.push(...chunks.slice(0, -1));
                buf = chunks[chunks.length - 1];
            }
        }
        if (buf) merged.push(buf);

        if (merged[0] && merged[0].length > firstChunkChars) {
            const head = merged[0].slice(0, firstChunkChars);
            const tail = merged[0].slice(firstChunkChars);
            merged[0] = head;
            if (tail) merged.splice(1, 0, tail);
        }
        return merged;
    }

    _splitTextForQwen3StreamingAdaptive(text, cfg) {
        const src = String(text || '').replace(/\s+/g, ' ').trim();
        if (!src) return [];

        const minLen = Math.max(8, Number(cfg.minChunkChars || 24));
        const targetLen = Math.max(minLen, Number(cfg.targetChunkChars || 48));
        const maxLen = Math.max(targetLen, Number(cfg.maxChunkChars || 96));
        const waitK = Math.max(minLen, Number(cfg.waitKChars || 28));

        // 先按标点切分，尽量保证韵律边界
        const parts = src
            .split(/(?<=[。！？!?；;，,、])/)
            .map((s) => s.trim())
            .filter(Boolean);

        const chunks = [];
        let buf = '';
        const flush = () => {
            if (!buf) return;
            chunks.push(buf.trim());
            buf = '';
        };

        const hardSplit = (str) => {
            let remain = str;
            while (remain.length > maxLen) {
                // 在 target 附近找最近的标点，找不到再硬切
                const center = Math.min(targetLen, remain.length - 1);
                const left = Math.max(0, center - 12);
                const right = Math.min(remain.length - 1, center + 12);
                let cut = -1;
                for (let i = right; i >= left; i--) {
                    if (/[,，。！？!?；;、]/.test(remain[i])) {
                        cut = i + 1;
                        break;
                    }
                }
                if (cut <= 0) cut = targetLen;
                chunks.push(remain.slice(0, cut).trim());
                remain = remain.slice(cut).trim();
            }
            if (remain) chunks.push(remain);
        };

        for (const p of parts) {
            if (!buf) {
                buf = p;
                continue;
            }
            const combined = `${buf}${p}`;
            if (combined.length <= targetLen) {
                buf = combined;
                continue;
            }
            if (buf.length < minLen && combined.length <= maxLen) {
                buf = combined;
                continue;
            }
            flush();
            if (p.length > maxLen) hardSplit(p);
            else buf = p;
        }
        flush();

        // 合并过短尾块
        for (let i = 0; i < chunks.length - 1; i++) {
            if (chunks[i].length < minLen) {
                chunks[i + 1] = `${chunks[i]}${chunks[i + 1]}`;
                chunks[i] = '';
            }
        }
        const merged = chunks.filter(Boolean);

        // wait-k：首包至少达到阈值，减少“太早开口导致断裂感”
        while (merged.length > 1 && merged[0].length < waitK) {
            merged[1] = `${merged[0]}${merged[1]}`;
            merged.shift();
        }

        // 尾包过短时并回前一段，减少“结尾突然快读”
        if (merged.length > 1) {
            const tail = merged[merged.length - 1];
            if (tail.length < Math.max(12, Math.floor(minLen * 0.6))) {
                merged[merged.length - 2] = `${merged[merged.length - 2]}${tail}`;
                merged.pop();
            }
        }

        // 末段缺少句末停顿时补全标点，帮助收尾节奏稳定
        if (merged.length > 0 && !/[。！？!?；;]$/.test(merged[merged.length - 1])) {
            merged[merged.length - 1] = `${merged[merged.length - 1]}。`;
        }

        return merged;
    }

    async synthesizeWithQwen3(text, outputFile) {
        const cfg = this._resolveQwen3Config();
        const baseUrl = `http://127.0.0.1:${cfg.port}`;
        const payload = {
            text,
            outputFile,
            language: cfg.language
        };
        const maxAttempts = 2;
        let lastErr = null;

        for (let i = 1; i <= maxAttempts; i++) {
            try {
                const ready = this.qwen3.ready || await this.initQwen3();
                if (!ready) throw new Error('Qwen3 服务不可用');

                const res = await fetch(`${baseUrl}/synthesize`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) throw new Error(`Qwen3 HTTP ${res.status}`);
                const data = await res.json();
                if (!data?.ok) throw new Error(data?.error || 'synthesize failed');
                return data.outputFile || outputFile;
            } catch (err) {
                lastErr = err;
                const errMsg = String(err?.message || err);
                const transient = /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|network/i.test(errMsg);
                if (i < maxAttempts && transient) {
                    console.warn(`[Voice] ⚠️ Qwen3 合成失败(第${i}次)，尝试自愈重试: ${errMsg}`);
                    this.qwen3.ready = false;
                    try {
                        await this.initQwen3();
                    } catch (_) {
                        // 二次重试前允许继续尝试请求
                    }
                    await new Promise((r) => setTimeout(r, 250));
                    continue;
                }
                break;
            }
        }

        throw lastErr || new Error('Qwen3 合成失败');
    }

    async speakWithQwen3(cleanText, outputFile) {
        const cfg = this._resolveQwen3Config();
        if (!cfg.streaming) {
            const audio = await this.synthesizeWithQwen3(cleanText, outputFile.replace(/\.mp3$/i, '.wav'));
            await this._playAudioFile(audio);
            return;
        }

        const chunks = this._splitTextForQwen3StreamingAdaptive(cleanText, cfg);
        if (chunks.length === 0) return;

        const synthAt = (index) => {
            const chunkOut = outputFile.replace(/\.mp3$/i, `_${index}.wav`);
            return this.synthesizeWithQwen3(chunks[index], chunkOut);
        };

        // 流水线：默认单段顺播；开启 crossfade 时按两段配对平滑播放
        let i = 0;
        let currentPromise = synthAt(0);
        while (i < chunks.length) {
            let audio = await currentPromise;

            if (cfg.enableCrossfade && i + 1 < chunks.length) {
                const nextAudio = await synthAt(i + 1);
                const mergedOut = outputFile.replace(/\.mp3$/i, `_${i}_cf.wav`);
                audio = await this._crossfadePairWav(audio, nextAudio, mergedOut, cfg.crossfadeMs, cfg.pythonPath);
                i += 2;
            } else {
                i += 1;
            }

            if (i < chunks.length) {
                currentPromise = synthAt(i);
            }
            await this._playAudioFile(audio);
        }
    }

    async _concatWavFiles(files, outFile) {
        const valid = (files || []).filter((f) => f && fsSync.existsSync(f));
        if (valid.length === 0) {
            throw new Error('没有可拼接的音频分段');
        }
        if (valid.length === 1) return valid[0];

        const listFile = path.join(this.tempDir, `concat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
        const lines = valid.map((f) => `file '${String(f).replace(/'/g, "'\\''")}'`).join('\n');
        fsSync.writeFileSync(listFile, lines, 'utf8');
        try {
            await execFileAsync('ffmpeg', [
                '-y',
                '-f', 'concat',
                '-safe', '0',
                '-i', listFile,
                '-c', 'copy',
                outFile
            ], { timeout: 60000, windowsHide: true });
            if (!fsSync.existsSync(outFile)) {
                throw new Error('拼接输出文件不存在');
            }
            return outFile;
        } finally {
            try { fsSync.unlinkSync(listFile); } catch {}
        }
    }

    async synthesizeWithQwen3ChunkedForExport(cleanText, outputFile) {
        const cfg = this._resolveQwen3Config();
        const chunks = this._splitTextForQwen3StreamingAdaptive(cleanText, cfg);
        if (chunks.length <= 1) {
            return this.synthesizeWithQwen3(cleanText, outputFile);
        }

        const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const partFiles = [];
        try {
            for (let i = 0; i < chunks.length; i++) {
                const part = outputFile.replace(/\.wav$/i, `_${ts}_part${i}.wav`);
                await this.synthesizeWithQwen3(chunks[i], part);
                partFiles.push(part);
            }
            const merged = outputFile.replace(/\.wav$/i, `_${ts}_merged.wav`);
            return await this._concatWavFiles(partFiles, merged);
        } finally {
            for (const f of partFiles) {
                try { if (fsSync.existsSync(f)) fsSync.unlinkSync(f); } catch {}
            }
        }
    }

    /**
     * 🔊 仅合成 Edge TTS 文件（不播放）
     */
    async synthesizeWithEdgeTTSOnly(cleanText, voiceConfig, outputFile) {
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        const textFile = path.join(this.tempDir, `tts_text_${Date.now()}.txt`);
        fsSync.writeFileSync(textFile, cleanText, 'utf8');

        const args = ['-m', 'edge_tts', '--voice', voiceConfig.voice, '--file', textFile, '--write-media', outputFile];
        if (voiceConfig.rate !== '+0%') args.push('--rate', voiceConfig.rate);
        if (voiceConfig.pitch !== '+0Hz') args.push('--pitch', voiceConfig.pitch);

        try {
            await execFileAsync(pythonCmd, args, { timeout: 30000, windowsHide: true });
        } finally {
            fsSync.unlink(textFile, () => {});
        }
        return outputFile;
    }

    async _crossfadePairWav(firstFile, secondFile, outFile, fadeMs = 90, pythonPath = null) {
        const py = pythonPath || (process.platform === 'win32' ? 'python' : 'python3');
        const fade = Math.max(0, Number(fadeMs || 0));
        if (fade <= 0) return firstFile;

        const code = `
import sys
import numpy as np
import soundfile as sf

f1, f2, outp, fade_ms = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
x1, sr1 = sf.read(f1)
x2, sr2 = sf.read(f2)
if sr1 != sr2:
    raise RuntimeError(f"sample rate mismatch: {sr1} vs {sr2}")
if x1.ndim > 1:
    x1 = x1.mean(axis=1)
if x2.ndim > 1:
    x2 = x2.mean(axis=1)
fade_n = int(sr1 * max(0.0, fade_ms) / 1000.0)
fade_n = min(fade_n, len(x1), len(x2))
if fade_n <= 0:
    y = np.concatenate([x1, x2], axis=0)
else:
    head = x1[:-fade_n]
    tail1 = x1[-fade_n:]
    head2 = x2[:fade_n]
    tail2 = x2[fade_n:]
    # 先做相邻片段 RMS 对齐，减少“音量突然跳变”
    eps = 1e-8
    rms1 = float(np.sqrt(np.mean(np.square(tail1))) + eps)
    rms2 = float(np.sqrt(np.mean(np.square(head2))) + eps)
    gain = np.clip(rms1 / rms2, 0.7, 1.4)
    x2 = x2 * gain
    head2 = x2[:fade_n]
    tail2 = x2[fade_n:]
    w = np.linspace(0.0, 1.0, fade_n, dtype=np.float32)
    mid = tail1 * (1.0 - w) + head2 * w
    y = np.concatenate([head, mid, tail2], axis=0)
sf.write(outp, y, sr1)
print(outp)
`;

        try {
            await execFileAsync(py, ['-c', code, firstFile, secondFile, outFile, String(fade)], {
                timeout: 45000,
                windowsHide: true
            });
            return outFile;
        } catch (err) {
            console.warn('[Voice] ⚠️ Crossfade 失败，回退直接播放:', err?.message || err);
            return firstFile;
        }
    }

    /**
     * 🎯 智能播报入口
     * @param {string} text - 要播报的文本
     * @param {object} options - 选项 { priority, context, emotion }
     */
    async speak(text, options = {}) {
        if (!this.enabled) {
            console.log('🔇 语音已关闭');
            return;
        }

        if (!this.speakSystemMessages && (options.system === true || this.isSystemMessage(text))) {
            this.stats.totalSkipped++;
            console.log(`⏭️ 跳过系统播报: ${String(text).substring(0, 60)}`);
            return;
        }

        // 🎯 智能内容分析和优化
        const analysis = this.analyzeContent(text);
        
        // 🎭 如果外部传入了 emotion，优先使用（比自动检测更准）
        if (options.emotion) {
            analysis.emotion = options.emotion;
            console.log(`[Voice] 🎭 使用外部情绪: ${options.emotion}`);
        }
        
        if (analysis.skip) {
            this.stats.totalSkipped++;
            console.log(`⏭️ ${analysis.reason}`);
            return;
        }
        
        // 🎭 根据内容调整语音特性
        const voiceConfig = this.selectVoice(analysis);
        
        // 🔊 队列管理
        if (this.isSpeaking) {
            if (options.priority === 'high' || analysis.priority === 'high') {
                // 高优先级插队
                this.queue.unshift({ text, voiceConfig, analysis });
                console.log(`🚨 优先级插队 (排队: ${this.queue.length})`);
            } else if (this.queue.length < this.maxQueueSize) {
                this.queue.push({ text, voiceConfig, analysis });
                this.stats.totalQueued++;
                console.log(`📝 加入队列 (排队: ${this.queue.length})`);
            } else {
                console.log('⚠️ 队列已满');
            }
            return;
        }

        await this.speakNow(text, voiceConfig, analysis);
        await this.processQueue();
    }

    /**
     * 📊 智能内容分析
     */
    analyzeContent(text) {
        const analysis = {
            skip: false,
            reason: '',
            priority: 'normal',
            emotion: 'neutral',
            category: 'general',
            processedText: text
        };
        
        // 1. 基础过滤
        if (text.length < 2) {
            analysis.skip = true;
            analysis.reason = '内容过短';
            return analysis;
        }
        
        if (/^[\s.,;!?。，；！？]+$/.test(text)) {
            analysis.skip = true;
            analysis.reason = '纯标点';
            return analysis;
        }
        
        // 2. 去重检测
        if (this.lastSpoken === text && Date.now() - this.lastSpokenTime < 5000) {
            analysis.skip = true;
            analysis.reason = '重复内容';
            return analysis;
        }
        
        // 3. 内容分类和优先级
        if (text.match(/🔥|紧急|错误|崩溃|失败|异常|断开|断连|不健康/)) {
            analysis.priority = 'high';
            analysis.emotion = 'urgent';
            analysis.category = 'error';
        } else if (text.match(/✅|完成|成功|好/)) {
            analysis.emotion = 'happy';
            analysis.category = 'success';
        } else if (text.match(/⚠️|警告|注意/)) {
            analysis.priority = 'medium';
            analysis.emotion = 'concern';
            analysis.category = 'warning';
        } else if (text.match(/📊|监控|性能|统计/)) {
            analysis.category = 'data';
        } else if (text.match(/🎉|恭喜|太好了/)) {
            analysis.emotion = 'excited';
            analysis.category = 'celebration';
        }
        
        // 4. 智能文本预处理
        analysis.processedText = this.enhanceText(text, analysis);
        
        return analysis;
    }

    /**
     * 系统状态类消息默认不播报，避免“报错内容被念出来”
     */
    isSystemMessage(text) {
        const s = String(text || '').trim();
        if (!s) return true;
        return /Gateway|OpenClaw|服务|断开|断连|连接已恢复|重启|启动失败|配置错误|health|健康|缓存|清理|检测到|警告|告警|异常|降级|评分|会话已清理|快捷方式已创建/i.test(s);
    }

    /**
     * ✨ 增强文本 - 让播报更自然
     */
    enhanceText(text, analysis, options = {}) {
        let enhanced = text;
        
        // 1. 清理特殊字符
        enhanced = this.cleanTextForSpeech(enhanced, { maxLength: options.maxLength });
        
        // 2. 根据情境添加语气词
        if (analysis.emotion === 'happy') {
            // 成功的事情，语气更轻快
            if (!enhanced.match(/[，。！]$/)) {
                enhanced += '！';
            }
        } else if (analysis.emotion === 'urgent') {
            // 紧急情况，更简洁直接
            enhanced = enhanced.replace(/正在|准备/, '');
        }
        
        // 3. 智能断句 - 让播报有节奏
        enhanced = this.addNaturalPauses(enhanced);
        
        // 4. 口语化处理
        enhanced = this.makeConversational(enhanced);
        
        return enhanced;
    }

    /**
     * 🎵 添加自然停顿
     */
    addNaturalPauses(text) {
        let paused = text;
        
        // 在关键位置添加停顿
        paused = paused.replace(/，/g, '， ')           // 逗号后短停顿
                       .replace(/。/g, '。 ')           // 句号后长停顿
                       .replace(/！/g, '！ ')           // 感叹号后停顿
                       .replace(/\s+/g, ' ')            // 清理多余空格
                       .trim();
        
        return paused;
    }

    /**
     * 💬 口语化处理
     */
    makeConversational(text) {
        let conversational = text;
        
        // 技术术语口语化
        const replacements = {
            'API': '接口',
            'URL': '网址',
            'JSON': '数据',
            'HTTP': '',
            'IPC': '通信',
            'CPU': '处理器',
            'GB': '吉字节',
            'MB': '兆字节',
            'KB': '千字节',
            'error': '错误',
            'success': '成功',
            'failed': '失败',
            'warning': '警告',
            'OK': '好的',
            'npm': '',
            'node': '',
            '.js': '脚本',
            '.json': '配置',
            'undefined': '未定义',
            'null': '空值'
        };
        
        for (const [tech, speak] of Object.entries(replacements)) {
            const regex = new RegExp(tech, 'gi');
            conversational = conversational.replace(regex, speak);
        }
        
        // 数字读法优化
        conversational = conversational.replace(/(\d+)MB/g, '$1兆')
                                       .replace(/(\d+)GB/g, '$1G')
                                       .replace(/(\d+)%/g, '百分之$1');
        
        // 添加自然的连接词
        if (conversational.match(/^(完成|成功|好|收到)$/)) {
            conversational += '了';
        }
        
        return conversational;
    }

    /**
     * 🎭 根据内容选择语音
     */
    selectVoice(analysis) {
        if (this.singleVoiceMode) {
            return {
                voice: 'zh-CN-XiaoxiaoNeural',
                rate: '+0%',
                pitch: '+0Hz'
            };
        }

        let config = {
            voice: this.voice,
            rate: '+0%',    // 语速
            pitch: '+0Hz'   // 音调
        };
        
        // 根据情境调整语音特性
        switch (analysis.emotion) {
            case 'excited':
            case 'happy':
                config.rate = '+10%';   // 稍快
                config.pitch = '+30Hz'; // 开心
                break;
            case 'surprised':
                config.rate = '+15%';   // 更快
                config.pitch = '+40Hz'; // 惊讶语调高
                break;
            case 'urgent':
            case 'fearful':
                config.rate = '+10%';
                config.voice = 'zh-CN-YunxiNeural';  // 换男声，更有力
                break;
            case 'sad':
                config.rate = '-5%';    // 稍慢
                config.pitch = '-10Hz'; // 低沉一点
                break;
            case 'thinking':
                config.rate = '-5%';    // 思考时慢一点
                config.pitch = '+10Hz';
                break;
            case 'calm':
                config.rate = '-5%';    // 平静舒缓
                config.pitch = '+15Hz';
                break;
            case 'angry':
                config.rate = '+5%';
                config.pitch = '+20Hz';
                break;
            default:
                config.pitch = '+15Hz';
                break;
        }
        
        return config;
    }

    /**
     * 🔊 立即播报
     */
    async speakNow(text, voiceConfig, analysis) {
        this.isSpeaking = true;
        const startTime = Date.now();
        
        try {
            const cleanText = analysis.processedText || this.cleanTextForSpeech(text);
            
            if (!cleanText.trim()) {
                console.log('⚠️ 清理后文本为空');
                return;
            }
            
            // 记录播报
            this.lastSpoken = text;
            this.lastSpokenTime = Date.now();
            this.stats.totalSpoken++;
            
            // 生成语音
            const outputFile = path.join(this.tempDir, `speech_${Date.now()}.mp3`);
            
            // 显示播报内容（带分类标签）
            const categoryIcon = {
                'success': '✅',
                'error': '🔥',
                'warning': '⚠️',
                'data': '📊',
                'celebration': '🎉',
                'general': '🔊'
            }[analysis.category] || '🔊';
            
            console.log(`${categoryIcon} 播报: ${cleanText.substring(0, 40)}${cleanText.length > 40 ? '...' : ''}`);
            
            // 🎙️ 根据引擎选择 TTS 方式
            if (this.ttsEngine === 'qwen3') {
                try {
                    await this.speakWithQwen3(cleanText, outputFile);
                } catch (qwenErr) {
                    console.error('[Voice] ❌ Qwen3 失败，回退到 Edge TTS:', qwenErr.message);
                    if (this.degradationNotifyEnabled) {
                        this.notifyDegradation('qwen3', 'edge', qwenErr.message);
                    }
                    await this.speakWithEdgeTTS(cleanText, voiceConfig, outputFile);
                }
            } else if (this.ttsEngine === 'minimax' && this.minimax) {
                // MiniMax Speech 2.5 (带情感控制)
                try {
                    // 优先用 analysis 传入的 emotion，否则自动检测
                    const emotion = (['happy','sad','angry','fearful','disgusted','surprised','calm'].includes(analysis.emotion))
                        ? analysis.emotion
                        : MiniMaxTTS.detectEmotion(cleanText);
                    console.log(`[Voice] 🎭 TTS情绪: ${emotion} (来源: ${analysis.emotion === emotion ? '外部指定' : '自动检测'})`);
                    const audioFile = await this.minimax.synthesize(cleanText, {
                        voiceId: this.minimaxVoiceId,
                        emotion: emotion,
                        outputFile: outputFile
                    });

                    await this._playAudioFile(audioFile);

                } catch (minimaxErr) {
                    console.error('[Voice] ❌ MiniMax 失败，回退到 Edge TTS:', minimaxErr.message);
                    // 🚨 发送降级通知
                    if (this.degradationNotifyEnabled) {
                        this.notifyDegradation('minimax', 'edge', minimaxErr.message);
                    }
                    // 直接回退到 Edge TTS
                    await this.speakWithEdgeTTS(cleanText, voiceConfig, outputFile);
                }
            } else {
                // Edge TTS (回退方案)
                await this.speakWithEdgeTTS(cleanText, voiceConfig, outputFile);
            }
            
            const duration = (Date.now() - startTime) / 1000;
            this.stats.avgDuration = (this.stats.avgDuration * (this.stats.totalSpoken - 1) + duration) / this.stats.totalSpoken;
            
            console.log(`✅ 播放完成 (${duration.toFixed(1)}秒)`);

            // 🧹 每 20 次播报自动清理旧文件，保留最近 30 个
            if (this.stats.totalSpoken % 20 === 0) {
                this.cleanupTempFiles(30).catch(() => {});
            }

        } catch (err) {
            console.error('🎙️ 播报失败:', err.message);
        } finally {
            this.isSpeaking = false;
        }
    }

    async processQueue() {
        if (this.queue.length > 0 && !this.isSpeaking) {
            const next = this.queue.shift();
            console.log(`🔊 队列播报 (剩余: ${this.queue.length})`);
            await this.speakNow(next.text, next.voiceConfig, next.analysis);
            // 继续处理队列
            if (this.queue.length > 0) {
                setTimeout(() => this.processQueue(), 500);
            }
        }
    }

    /**
     * 🧹 文本清理（基础版本）
     */
    cleanTextForSpeech(text, options = {}) {
        let cleaned = text;
        const maxLength = Number(options.maxLength ?? 800);
        
        // Emoji 移除
        cleaned = cleaned.replace(/[\u{1F600}-\u{1F64F}]/gu, '')
                         .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
                         .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
                         .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')
                         .replace(/[\u{2600}-\u{26FF}]/gu, '')
                         .replace(/[\u{2700}-\u{27BF}]/gu, '');
        
        // 常见符号替换
        cleaned = cleaned.replace(/✅/g, '完成')
                         .replace(/❌/g, '失败')
                         .replace(/⚠️/g, '注意')
                         .replace(/🚀/g, '')
                         .replace(/[📢💡🔧📝📸📤🔊⚙️]/g, '');
        
        // Markdown 清理
        cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, '$1')
                         .replace(/\*(.*?)\*/g, '$1')
                         .replace(/`(.*?)`/g, '$1')
                         .replace(/\[(.*?)\]\(.*?\)/g, '$1');
        
        // 特殊符号清理（保留 MiniMax TTS 停顿标记 <#X#>）
        cleaned = cleaned.replace(/<#([\d.]+)#>/g, 'TPAUSE$1TEND');  // 暂存停顿标记
        cleaned = cleaned.replace(/[【】\[\]{}「」_~#@]/g, '');
        cleaned = cleaned.replace(/TPAUSE([\d.]+)TEND/g, '<#$1#>');  // 恢复停顿标记
        
        // 长度限制（maxLength <= 0 表示不限制）
        if (maxLength > 0 && cleaned.length > maxLength) {
            cleaned = cleaned.substring(0, maxLength) + '，等共' + cleaned.length + '字';
        }
        
        // 空格清理
        cleaned = cleaned.replace(/\s+/g, ' ').trim();
        
        return cleaned;
    }

    /**
     * 📊 获取统计
     */
    getStats() {
        return {
            ...this.stats,
            queueLength: this.queue.length,
            isSpeaking: this.isSpeaking,
            enabled: this.enabled
        };
    }

    /**
     * 🎛️ 设置模式
     */
    setMode(mode) {
        this.contextMode = mode;
        console.log(`🎭 切换播报模式: ${mode}`);
    }

    /**
     * 🔇 开关语音
     */
    toggle(enabled) {
        this.enabled = enabled;
        console.log(`🔊 语音${enabled ? '开启' : '关闭'}`);
    }

    clearQueue() {
        this.queue = [];
    }

    stop() {
        this.clearQueue();
        this.isSpeaking = false;
        // 杀掉正在播放的进程
        if (this._currentProcess && !this._currentProcess.killed) {
            this._currentProcess.kill();
            this._currentProcess = null;
        }
        this.stopQwen3Server();
    }

    stopQwen3Server() {
        if (this.qwen3.usingExternalServer) return;
        if (this.qwen3.process && !this.qwen3.process.killed) {
            this.qwen3.process.kill('SIGTERM');
        }
        this.qwen3.process = null;
        this.qwen3.ready = false;
    }

    /**
     * 🔊 使用 Edge TTS 播报（回退方案，使用 execFile 避免命令注入）
     */
    async speakWithEdgeTTS(cleanText, voiceConfig, outputFile) {
        await this.synthesizeWithEdgeTTSOnly(cleanText, voiceConfig, outputFile);
        await this._playAudioFile(outputFile);
    }

    /**
     * 🎧 合成语音文件（不播放），用于飞书回传等场景
     */
    async synthesizeToFile(text, options = {}) {
        const raw = String(text || '').trim();
        if (!raw) {
            throw new Error('文本为空，无法合成语音');
        }

        const analysis = this.analyzeContent(raw);
        if (options.emotion) {
            analysis.emotion = options.emotion;
        }
        // synthesizeToFile 可单独指定 maxLength，覆盖默认 800 限制
        if (Object.prototype.hasOwnProperty.call(options, 'maxLength')) {
            analysis.processedText = this.enhanceText(raw, analysis, { maxLength: options.maxLength });
        }
        const voiceConfig = this.selectVoice(analysis);
        const cleanText = analysis.processedText || this.cleanTextForSpeech(raw, { maxLength: options.maxLength });
        if (!cleanText.trim()) {
            throw new Error('清理后文本为空，无法合成语音');
        }

        const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        if (this.ttsEngine === 'qwen3') {
            const wavFile = path.join(this.tempDir, `speech_export_${ts}.wav`);
            try {
                const useChunkedExport = Number(options.maxLength) <= 0 && cleanText.length > 220;
                const audioFile = useChunkedExport
                    ? await this.synthesizeWithQwen3ChunkedForExport(cleanText, wavFile)
                    : await this.synthesizeWithQwen3(cleanText, wavFile);
                return { outputFile: audioFile || wavFile, engine: 'qwen3', text: cleanText };
            } catch (qwenErr) {
                console.warn('[Voice] ⚠️ 导出语音时 Qwen3 失败，回退到 Edge:', qwenErr.message);
                const mp3File = path.join(this.tempDir, `speech_export_${ts}.mp3`);
                const out = await this.synthesizeWithEdgeTTSOnly(cleanText, voiceConfig, mp3File);
                return { outputFile: out, engine: 'edge', text: cleanText };
            }
        }

        if (this.ttsEngine === 'minimax' && this.minimax) {
            try {
                const emotion = (['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'].includes(analysis.emotion))
                    ? analysis.emotion
                    : MiniMaxTTS.detectEmotion(cleanText);
                const mp3File = path.join(this.tempDir, `speech_export_${ts}.mp3`);
                const out = await this.minimax.synthesize(cleanText, {
                    voiceId: this.minimaxVoiceId,
                    emotion,
                    outputFile: mp3File
                });
                return { outputFile: out || mp3File, engine: 'minimax', text: cleanText };
            } catch (minimaxErr) {
                console.warn('[Voice] ⚠️ 导出语音时 MiniMax 失败，回退到 Edge:', minimaxErr.message);
                const mp3File = path.join(this.tempDir, `speech_export_${ts}.mp3`);
                const out = await this.synthesizeWithEdgeTTSOnly(cleanText, voiceConfig, mp3File);
                return { outputFile: out, engine: 'edge', text: cleanText };
            }
        }

        const mp3File = path.join(this.tempDir, `speech_export_${ts}.mp3`);
        const out = await this.synthesizeWithEdgeTTSOnly(cleanText, voiceConfig, mp3File);
        return { outputFile: out, engine: 'edge', text: cleanText };
    }

    /**
     * 🎙️ 切换 TTS 引擎
     */
    setEngine(engine) {
        if (!['minimax', 'edge', 'qwen3'].includes(engine)) {
            console.log(`[Voice] ⚠️ 不支持的引擎: ${engine}，可选: minimax, edge, qwen3`);
            return false;
        }
        if (engine === 'minimax' && !this.minimax) {
            console.log('[Voice] ⚠️ MiniMax 未初始化，无法切换');
            return false;
        }
        if (engine === 'qwen3') {
            this.initQwen3().catch((err) => {
                console.warn('[Voice] ⚠️ Qwen3 初始化失败:', err?.message || err);
            });
        }
        this.ttsEngine = engine;
        console.log(`[Voice] 🎙️ TTS 引擎切换为: ${engine}`);
        return true;
    }

    /**
     * 🚨 发送降级通知到 OpenClaw
     */
    async notifyDegradation(fromEngine, toEngine, errorMessage) {
        try {
            const https = require('https');
            const http = require('http');
            
            // 判断错误原因
            let reason = '未知错误';
            let suggestion = '';
            
            if (errorMessage.includes('quota') || errorMessage.includes('balance') || errorMessage.includes('insufficient')) {
                reason = '额度用完';
                suggestion = 'MiniMax API 额度已用完，请前往官网充值续费';
            } else if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT') || errorMessage.includes('ECONNREFUSED')) {
                reason = '网络超时';
                suggestion = '网络连接失败，请检查网络状态';
            } else if (errorMessage.includes('401') || errorMessage.includes('403') || errorMessage.includes('Unauthorized')) {
                reason = 'API Key 无效';
                suggestion = '请检查 API Key 是否正确';
            } else if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
                reason = '请求频率过高';
                suggestion = '触发限流，请稍后再试';
            } else {
                reason = 'API 调用失败';
                suggestion = errorMessage.substring(0, 100);
            }
            
            const message = `🚨 语音引擎降级通知\n\n` +
                          `从 ${fromEngine.toUpperCase()} 降级到 ${toEngine.toUpperCase()}\n` +
                          `原因: ${reason}\n` +
                          `建议: ${suggestion}\n\n` +
                          `时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
            
            console.log('[Voice] 📤 发送降级通知到 OpenClaw');
            
            // 发送到 OpenClaw Gateway (desktop-bridge.js 会转发到飞书)
            const payload = JSON.stringify({
                action: 'agent-response',
                text: message
            });
            
            const notifyPort = (this.petConfig && this.petConfig.get('notifyPort')) || 18788;
            const options = {
                hostname: '127.0.0.1',
                port: notifyPort,
                path: '/notify',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            };
            
            const req = http.request(options, (res) => {
                console.log(`[Voice] ✅ 降级通知已发送 (状态: ${res.statusCode})`);
            });
            
            req.on('error', (err) => {
                console.error('[Voice] ❌ 降级通知发送失败:', err.message);
            });
            
            req.write(payload);
            req.end();
            
        } catch (err) {
            console.error('[Voice] ❌ notifyDegradation 失败:', err.message);
        }
    }

    /**
     * 🧹 清理临时文件
     */
    async cleanupTempFiles(keepCount = 50) {
        try {
            const files = await fs.readdir(this.tempDir);
            const mp3Files = files.filter(f => f.endsWith('.mp3'));
            
            if (mp3Files.length <= keepCount) {
                return { deleted: 0, freed: 0 };
            }
            
            const fileStats = await Promise.all(
                mp3Files.map(async (file) => {
                    const filePath = path.join(this.tempDir, file);
                    const stat = await fs.stat(filePath);
                    return { file, path: filePath, mtime: stat.mtime, size: stat.size };
                })
            );
            
            fileStats.sort((a, b) => b.mtime - a.mtime);
            const toDelete = fileStats.slice(keepCount);
            
            let deleted = 0;
            let freed = 0;
            
            for (const item of toDelete) {
                try {
                    await fs.unlink(item.path);
                    deleted++;
                    freed += item.size;
                } catch (err) {
                    console.warn('[SmartVoice] 清理临时语音文件失败:', item.path, err?.message || err);
                }
            }
            
            if (deleted > 0) {
                console.log(`🧹 清理语音文件: ${deleted}个, ${(freed / 1024).toFixed(1)}KB`);
            }
            
            return { deleted, freed };
        } catch (err) {
            return { deleted: 0, freed: 0 };
        }
    }
}

module.exports = SmartVoiceSystem;
