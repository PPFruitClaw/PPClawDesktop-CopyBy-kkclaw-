// OpenClaw 路径智能解析模块
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

class OpenClawPathResolver {
    constructor() {
        this._cachedPath = null;
        this._cachedConfigDir = null;
    }

    /**
     * 智能查找 openclaw 安装路径
     * @returns {string|null} openclaw/dist/index.js 的完整路径，未找到返回 null
     */
    findOpenClawPath() {
        if (this._cachedPath) return this._cachedPath;

        const home = process.env.HOME || process.env.USERPROFILE;
        let openclawPath = null;

        // 方法0: 常见 openclaw 可执行脚本（解析 wrapper 中实际 entry.js）
        if (!openclawPath) {
            const localBins = [
                path.join(home, '.local', 'bin', 'openclaw'),
                '/usr/local/bin/openclaw',
                '/opt/homebrew/bin/openclaw',
            ];
            for (const bin of localBins) {
                const resolved = this._resolveEntryFromCliBin(bin);
                if (resolved) {
                    openclawPath = resolved;
                    break;
                }
            }
        }

        // 方法1: pnpm root -g（需要添加 PNPM_HOME 到 PATH）
        if (!openclawPath) {
            try {
                const pnpmHome = process.env.PNPM_HOME || path.join(home, 'AppData', 'Local', 'pnpm');
                const env = { ...process.env, PATH: `${pnpmHome}${path.delimiter}${process.env.PATH || ''}` };
                const pnpmRoot = execSync('pnpm root -g', { encoding: 'utf8', windowsHide: true, env }).trim();
                const p = path.join(pnpmRoot, 'openclaw', 'dist', 'index.js');
                if (fs.existsSync(p)) openclawPath = p;
            } catch (e) { /* fallback */ }
        }

        // 方法2: npm root -g
        if (!openclawPath) {
            try {
                const npmRoot = execSync('npm root -g', { encoding: 'utf8', windowsHide: true }).trim();
                const p = path.join(npmRoot, 'openclaw', 'dist', 'index.js');
                if (fs.existsSync(p)) openclawPath = p;
            } catch (e) { /* fallback */ }
        }

        // 方法3: yarn global dir
        if (!openclawPath) {
            try {
                const yarnDir = execSync('yarn global dir', { encoding: 'utf8', windowsHide: true }).trim();
                const p = path.join(yarnDir, 'node_modules', 'openclaw', 'dist', 'index.js');
                if (fs.existsSync(p)) openclawPath = p;
            } catch (e) { /* fallback */ }
        }

        // 方法4: where/which openclaw
        if (!openclawPath) {
            try {
                const cmd = process.platform === 'win32' ? 'where openclaw' : 'which openclaw';
                const binPath = execSync(cmd, { encoding: 'utf8', windowsHide: true }).trim().split('\n')[0];
                const binDir = path.dirname(binPath);
                const fromBin = this._resolveEntryFromCliBin(binPath);
                if (fromBin) {
                    openclawPath = fromBin;
                    throw new Error('__FOUND__');
                }
                const candidates = [
                    path.join(binDir, '..', 'node_modules', 'openclaw', 'dist', 'index.js'),
                    path.join(binDir, '..', 'node_modules', 'openclaw', 'dist', 'entry.js'),
                    path.join(binDir, '..', 'lib', 'node_modules', 'openclaw', 'dist', 'index.js'),
                    path.join(binDir, '..', 'lib', 'node_modules', 'openclaw', 'dist', 'entry.js'),
                ];
                for (const c of candidates) {
                    if (fs.existsSync(path.normalize(c))) {
                        openclawPath = path.normalize(c);
                        break;
                    }
                }
            } catch (e) { /* fallback */ }
        }

        // 方法5: 常见安装路径
        if (!openclawPath) {
            const altPaths = [
                path.join(home, 'AppData', 'Local', 'pnpm', 'global', '5', 'node_modules', 'openclaw', 'dist', 'index.js'),
                path.join(home, '.local', 'share', 'pnpm', 'global', '5', 'node_modules', 'openclaw', 'dist', 'index.js'),
                path.join(home, '.npm-global', 'node_modules', 'openclaw', 'dist', 'index.js'),
                path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'openclaw', 'dist', 'index.js'),
                path.join('/usr/local/lib/node_modules/openclaw/dist/index.js'),
                path.join('/usr/local/lib/node_modules/openclaw/dist/entry.js'),
                path.join('/usr/lib/node_modules/openclaw/dist/index.js'),
                path.join('/usr/lib/node_modules/openclaw/dist/entry.js'),
                path.join(home, '.nvm/versions/node', process.version, 'lib/node_modules/openclaw/dist/index.js'),
                path.join(home, '.nvm/versions/node', process.version, 'lib/node_modules/openclaw/dist/entry.js'),
            ];
            for (const alt of altPaths) {
                if (fs.existsSync(alt)) {
                    openclawPath = alt;
                    break;
                }
            }
        }

        this._cachedPath = openclawPath;
        return openclawPath;
    }

    _resolveEntryFromCliBin(binPath) {
        try {
            if (!binPath || !fs.existsSync(binPath)) return null;
            const content = fs.readFileSync(binPath, 'utf8');
            // 兼容 bash wrapper: exec node "/path/to/dist/entry.js" "$@"
            const m = content.match(/exec\s+node\s+["']([^"']+\/dist\/(?:entry|index)\.js)["']/i);
            if (m && fs.existsSync(m[1])) {
                return path.normalize(m[1]);
            }
        } catch {
            // ignore
        }
        return null;
    }

    /**
     * 获取 openclaw 配置目录
     * @returns {string} ~/.openclaw 目录路径
     */
    getConfigDir() {
        if (this._cachedConfigDir) return this._cachedConfigDir;
        const home = process.env.HOME || process.env.USERPROFILE;
        this._cachedConfigDir = path.join(home, '.openclaw');
        return this._cachedConfigDir;
    }

    /**
     * 获取 openclaw 配置文件路径
     * @returns {string} ~/.openclaw/openclaw.json 路径
     */
    getConfigPath() {
        return path.join(this.getConfigDir(), 'openclaw.json');
    }

    /**
     * 获取 agent sessions 目录
     * @param {string} agentId - agent ID，默认 'main'
     * @returns {string} ~/.openclaw/agents/{agentId}/sessions 路径
     */
    getSessionsDir(agentId = 'main') {
        return path.join(this.getConfigDir(), 'agents', agentId, 'sessions');
    }

    /**
     * 获取 sessions.json 文件路径
     * @param {string} agentId - agent ID，默认 'main'
     * @returns {string} sessions.json 文件路径
     */
    getSessionsFilePath(agentId = 'main') {
        return path.join(this.getSessionsDir(agentId), 'sessions.json');
    }

    /**
     * 获取缓存目录
     * @returns {string} ~/.openclaw/cache 路径
     */
    getCacheDir() {
        return path.join(this.getConfigDir(), 'cache');
    }

    /**
     * 获取 session 锁文件路径
     * @param {string} sessionId - session ID
     * @param {string} agentId - agent ID，默认 'main'
     * @returns {string} session.lock 文件路径
     */
    getSessionLockPath(sessionId, agentId = 'main') {
        return path.join(this.getSessionsDir(agentId), `${sessionId}.jsonl.lock`);
    }

    /**
     * 清除缓存（用于测试或强制重新检测）
     */
    clearCache() {
        this._cachedPath = null;
        this._cachedConfigDir = null;
    }
}

// 导出单例
module.exports = new OpenClawPathResolver();
