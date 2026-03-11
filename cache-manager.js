/**
 * 缓存管理器 - 自动清理系统
 * 
 * 功能:
 * - 定期清理截图、语音、日志等缓存
 * - 监控磁盘使用情况
 * - 智能保留策略
 * - 清理结果语音播报
 */

const fs = require('fs').promises;
const path = require('path');
const { session } = require('electron');

class CacheManager {
  constructor(options = {}) {
    // 清理间隔 (默认6小时)
    this.cleanupInterval = options.interval || 6 * 60 * 60 * 1000;
    
    // 保留策略
    this.limits = {
      screenshots: options.screenshots || 50,      // 保留最近50张截图
      voiceFiles: options.voiceFiles || 100,       // 保留最近100个语音文件
      logDays: options.logDays || 30,              // 保留30天日志
      cacheSize: options.cacheSize || 200 * 1024 * 1024  // 200MB应用缓存上限
    };
    
    // 清理统计
    this.stats = {
      lastCleanup: null,
      totalCleaned: 0,
      cleanupCount: 0
    };
    
    // 定时器
    this.timer = null;
    
    // 回调
    this.onCleanup = options.onCleanup || null;
    
    const { colorLog } = require('./utils/color-log');
    colorLog('🧹 缓存管理器初始化完成');
  }

  /**
   * 启动自动清理
   */
  start() {
    const { colorLog: cl } = require('./utils/color-log');
    cl(`🔄 启动自动清理 (间隔: ${this.cleanupInterval / 1000 / 60} 分钟)`);
    
    // 立即执行一次清理
    this.cleanup();
    
    // 定时清理
    this.timer = setInterval(() => {
      this.cleanup();
    }, this.cleanupInterval);
  }

  /**
   * 停止自动清理
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('⏹️ 自动清理已停止');
    }
  }

  /**
   * 执行清理
   */
  async cleanup() {
    console.log('🧹 开始清理缓存...');
    const startTime = Date.now();
    
    const results = {
      screenshots: await this.cleanupScreenshots(),
      voiceFiles: await this.cleanupVoiceFiles(),
      logs: await this.cleanupLogs(),
      appCache: await this.cleanupAppCache()
    };
    
    // 统计
    const totalFreed = Object.values(results).reduce((sum, r) => sum + r.freedBytes, 0);
    const totalFiles = Object.values(results).reduce((sum, r) => sum + r.filesDeleted, 0);
    const duration = Date.now() - startTime;
    
    this.stats.lastCleanup = new Date();
    this.stats.totalCleaned += totalFreed;
    this.stats.cleanupCount++;
    
    // 格式化大小
    const freedMB = (totalFreed / 1024 / 1024).toFixed(2);
    
    console.log(`✅ 清理完成: 删除${totalFiles}个文件, 释放${freedMB}MB空间, 耗时${duration}ms`);
    
    // 回调通知
    if (this.onCleanup) {
      this.onCleanup({
        results,
        totalFreed,
        totalFiles,
        freedMB,
        duration
      });
    }
    
    return {
      success: true,
      results,
      totalFreed,
      totalFiles,
      freedMB,
      duration
    };
  }

  /**
   * 清理截图
   */
  async cleanupScreenshots() {
    const screenshotDir = path.join(__dirname, 'screenshots');
    return await this.cleanupDirectory(screenshotDir, {
      keepCount: this.limits.screenshots,
      extensions: ['.png', '.jpg', '.jpeg'],
      sortBy: 'mtime' // 按修改时间排序
    });
  }

  /**
   * 清理语音文件
   */
  async cleanupVoiceFiles() {
    // 方法1: 清理 temp 目录
    const tempDir = path.join(__dirname, 'temp');
    const result1 = await this.cleanupDirectory(tempDir, {
      keepCount: this.limits.voiceFiles,
      extensions: ['.mp3', '.wav'],
      sortBy: 'mtime'
    });
    
    // 方法2: 清理 voice-cache 目录(如果存在)
    const voiceDir = path.join(__dirname, 'voice-cache');
    const result2 = await this.cleanupDirectory(voiceDir, {
      keepCount: this.limits.voiceFiles,
      extensions: ['.mp3', '.wav'],
      sortBy: 'mtime'
    });
    
    return {
      filesDeleted: result1.filesDeleted + result2.filesDeleted,
      freedBytes: result1.freedBytes + result2.freedBytes
    };
  }

  /**
   * 清理过期日志
   */
  async cleanupLogs() {
    const memoryDir = path.join(__dirname, '..', '..', '..', 'openclaw-data', 'memory');
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.limits.logDays);
    
    return await this.cleanupDirectory(memoryDir, {
      olderThan: cutoffDate,
      extensions: ['.md'],
      exclude: ['MEMORY.md', 'README.md'] // 保留重要文件
    });
  }

  /**
   * 清理应用缓存
   */
  async cleanupAppCache() {
    try {
      // Electron session 缓存
      if (session && session.defaultSession) {
        await session.defaultSession.clearCache();
        console.log('✅ Electron 缓存已清理');
        
        // 估算清理的空间 (无法精确获取)
        return {
          filesDeleted: 0,
          freedBytes: 50 * 1024 * 1024 // 估计50MB
        };
      }
      
      return { filesDeleted: 0, freedBytes: 0 };
    } catch (err) {
      console.error('❌ 清理应用缓存失败:', err.message);
      return { filesDeleted: 0, freedBytes: 0 };
    }
  }

  /**
   * 通用目录清理
   */
  async cleanupDirectory(dirPath, options = {}) {
    try {
      // 检查目录是否存在
      try {
        await fs.access(dirPath);
      } catch {
        // 目录不存在,跳过
        return { filesDeleted: 0, freedBytes: 0 };
      }

      const files = await fs.readdir(dirPath);
      const fileStats = [];

      // 收集文件信息
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        try {
          const stat = await fs.stat(filePath);
          
          // 跳过目录
          if (stat.isDirectory()) continue;
          
          // 检查扩展名
          if (options.extensions) {
            const ext = path.extname(file).toLowerCase();
            if (!options.extensions.includes(ext)) continue;
          }
          
          // 检查排除列表
          if (options.exclude && options.exclude.includes(file)) {
            continue;
          }
          
          fileStats.push({
            path: filePath,
            name: file,
            size: stat.size,
            mtime: stat.mtime,
            atime: stat.atime
          });
        } catch (err) {
          console.warn(`跳过文件 ${file}:`, err.message);
        }
      }

      // 排序
      if (options.sortBy === 'mtime') {
        fileStats.sort((a, b) => b.mtime - a.mtime); // 最新的在���
      } else if (options.sortBy === 'atime') {
        fileStats.sort((a, b) => b.atime - a.atime);
      }

      // 确定要删除的文件
      let toDelete = [];
      
      if (options.keepCount) {
        // 保留最近N个文件
        toDelete = fileStats.slice(options.keepCount);
      } else if (options.olderThan) {
        // 删除早于指定日期的文件
        toDelete = fileStats.filter(f => f.mtime < options.olderThan);
      }

      // 执行删除
      let filesDeleted = 0;
      let freedBytes = 0;

      for (const file of toDelete) {
        try {
          await fs.unlink(file.path);
          filesDeleted++;
          freedBytes += file.size;
          console.log(`🗑️ 删除: ${file.name} (${(file.size / 1024).toFixed(2)}KB)`);
        } catch (err) {
          console.warn(`删除失败 ${file.name}:`, err.message);
        }
      }

      return { filesDeleted, freedBytes };
    } catch (err) {
      console.error(`清理目录失败 ${dirPath}:`, err.message);
      return { filesDeleted: 0, freedBytes: 0 };
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      totalCleanedMB: (this.stats.totalCleaned / 1024 / 1024).toFixed(2)
    };
  }

  /**
   * 手动触发清理
   */
  async triggerCleanup() {
    return await this.cleanup();
  }
}

module.exports = CacheManager;
