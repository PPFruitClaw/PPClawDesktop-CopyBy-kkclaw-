// 📝 日志轮转管理器
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

class LogRotationManager {
    constructor(options = {}) {
        this.logDir = options.logDir || path.join(
            process.env.USERPROFILE || process.env.HOME,
            'openclaw-data',
            'logs'
        );
        
        this.maxAge = options.maxAge || 30; // 保留30天
        this.maxSize = options.maxSize || 10 * 1024 * 1024; // 单文件最大10MB
        this.checkInterval = options.checkInterval || 24 * 60 * 60 * 1000; // 每天检查
        
        this.timer = null;
        this.ensureLogDir();
    }

    async ensureLogDir() {
        try {
            await fs.mkdir(this.logDir, { recursive: true });
        } catch (err) {
            console.error('创建日志目录失败:', err);
        }
    }

    // 开始自动轮转
    start() {
        const { colorLog } = require('./utils/color-log');
        colorLog('📝 日志轮转系统启动');
        
        // 立即执行一次
        this.rotate();
        
        // 定时执行
        this.timer = setInterval(() => {
            this.rotate();
        }, this.checkInterval);
    }

    // 停止自动轮转
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        console.log('📝 日志轮转系统停止');
    }

    // 执行轮转
    async rotate() {
        console.log('🔄 开始日志轮转...');
        
        try {
            const stats = await this.cleanupOldLogs();
            const compressed = await this.compressLargeLogs();
            
            console.log(`✅ 日志轮转完成: 删除${stats.deleted}个文件, 压缩${compressed}个文件`);
            
            return { ...stats, compressed };
        } catch (err) {
            console.error('日志轮转失败:', err);
            return { deleted: 0, freed: 0, compressed: 0 };
        }
    }

    // 清理过期日志
    async cleanupOldLogs() {
        const cutoff = Date.now() - this.maxAge * 24 * 60 * 60 * 1000;
        
        let deleted = 0;
        let freed = 0;
        
        try {
            const files = await fs.readdir(this.logDir);
            
            for (const file of files) {
                const filePath = path.join(this.logDir, file);
                const stat = await fs.stat(filePath);
                
                // 删除过期文件
                if (stat.mtimeMs < cutoff) {
                    freed += stat.size;
                    await fs.unlink(filePath);
                    deleted++;
                    console.log(`🗑️ 删除过期日志: ${file}`);
                }
            }
        } catch (err) {
            console.error('清理日志失败:', err);
        }
        
        return { deleted, freed };
    }

    // 压缩大文件 (简单实现：重命名为.old)
    async compressLargeLogs() {
        let compressed = 0;
        
        try {
            const files = await fs.readdir(this.logDir);
            
            for (const file of files) {
                // 跳过已压缩文件
                if (file.endsWith('.old') || file.endsWith('.gz')) continue;
                
                const filePath = path.join(this.logDir, file);
                const stat = await fs.stat(filePath);
                
                // 压缩超过限制的文件
                if (stat.size > this.maxSize) {
                    const archivePath = filePath + '.old';
                    await fs.rename(filePath, archivePath);
                    compressed++;
                    console.log(`📦 归档大文件: ${file} (${this.formatBytes(stat.size)})`);
                }
            }
        } catch (err) {
            console.error('压缩日志失败:', err);
        }
        
        return compressed;
    }

    // 获取日志统计
    async getStats() {
        const stats = {
            totalFiles: 0,
            totalSize: 0,
            byType: {},
            oldestFile: null,
            newestFile: null
        };
        
        try {
            const files = await fs.readdir(this.logDir);
            
            for (const file of files) {
                const filePath = path.join(this.logDir, file);
                const stat = await fs.stat(filePath);
                
                stats.totalFiles++;
                stats.totalSize += stat.size;
                
                // 按类型统计
                const ext = path.extname(file) || '.log';
                if (!stats.byType[ext]) {
                    stats.byType[ext] = { count: 0, size: 0 };
                }
                stats.byType[ext].count++;
                stats.byType[ext].size += stat.size;
                
                // 最老/最新文件
                if (!stats.oldestFile || stat.mtimeMs < stats.oldestFile.time) {
                    stats.oldestFile = {
                        name: file,
                        time: stat.mtimeMs,
                        age: Date.now() - stat.mtimeMs
                    };
                }
                
                if (!stats.newestFile || stat.mtimeMs > stats.newestFile.time) {
                    stats.newestFile = {
                        name: file,
                        time: stat.mtimeMs,
                        age: Date.now() - stat.mtimeMs
                    };
                }
            }
        } catch (err) {
            console.error('获取日志统计失败:', err);
        }
        
        return {
            ...stats,
            totalSizeFormatted: this.formatBytes(stats.totalSize),
            oldestFileAge: stats.oldestFile ? this.formatAge(stats.oldestFile.age) : 'N/A',
            newestFileAge: stats.newestFile ? this.formatAge(stats.newestFile.age) : 'N/A'
        };
    }

    // 列出最近的日志文件
    async listRecentLogs(count = 10) {
        try {
            const files = await fs.readdir(this.logDir);
            const fileStats = [];
            
            for (const file of files) {
                const filePath = path.join(this.logDir, file);
                const stat = await fs.stat(filePath);
                fileStats.push({
                    name: file,
                    path: filePath,
                    size: stat.size,
                    modified: stat.mtimeMs,
                    age: Date.now() - stat.mtimeMs
                });
            }
            
            // 按修改时间排序
            fileStats.sort((a, b) => b.modified - a.modified);
            
            return fileStats.slice(0, count).map(f => ({
                name: f.name,
                size: this.formatBytes(f.size),
                modified: new Date(f.modified).toLocaleString('zh-CN'),
                age: this.formatAge(f.age)
            }));
        } catch (err) {
            console.error('列出日志失败:', err);
            return [];
        }
    }

    // 读取日志文件
    async readLog(filename, lines = 100) {
        const filePath = path.join(this.logDir, filename);
        
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const allLines = content.split('\n');
            const recentLines = allLines.slice(-lines);
            
            return {
                filename,
                totalLines: allLines.length,
                lines: recentLines.length,
                content: recentLines.join('\n')
            };
        } catch (err) {
            console.error('读取日志失败:', err);
            return null;
        }
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
    }

    formatAge(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}天前`;
        if (hours > 0) return `${hours}小时前`;
        if (minutes > 0) return `${minutes}分钟前`;
        return `${seconds}秒前`;
    }
}

module.exports = LogRotationManager;
