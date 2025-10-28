const Bottleneck = require('bottleneck')
const NodeCache = require('node-cache')
const logger = require('../utils/logger')

/**
 * 并发控制管理器（基于 Bottleneck + node-cache）
 *
 * 核心功能：
 * - 支持最大并发数限制
 * - 支持请求队列（队列满时立即拒绝）
 * - 支持等待超时
 * - 客户端断开自动释放信号量
 * - 基于 Redis 的分布式信号量
 * - 动态更新并发配置（热更新）
 * - 自动清理过期实例（30 分钟未访问）
 *
 * 使用示例：
 * ```javascript
 * const config = {
 *   enabled: true,
 *   maxConcurrency: 10,
 *   queueSize: 20,
 *   queueTimeout: 60  // 秒
 * };
 *
 * try {
 *   const release = await concurrencyManager.waitForSlot('account-123', config, req, res);
 *   // 通过并发检查，继续执行业务逻辑
 *   // 完成后会自动释放，也可以手动调用 release()
 * } catch (error) {
 *   if (error.code === 'QUEUE_FULL') {
 *     // 队列已满，返回 429
 *   } else if (error.code === 'TIMEOUT') {
 *     // 等待超时，返回 503
 *   }
 * }
 * ```
 */
class ConcurrencyManager {
  constructor() {
    /**
     * Bottleneck 实例缓存（基于 node-cache）
     * 自动特性：
     * - 30 分钟未访问自动删除
     * - 每次访问自动重置 TTL
     * - 删除时自动断开 Bottleneck 连接
     */
    this.limiters = new NodeCache({
      stdTTL: 1800, // 30 分钟（秒）
      checkperiod: 120, // 每 2 分钟检查过期
      useClones: false, // 不克隆对象（性能优化）
      deleteOnExpire: true // 过期时删除
    })

    /**
     * 监听删除事件（自动清理资源）
     */
    this.limiters.on('del', (key, value) => {
      this._disposeLimiter(key, value)
    })

    /**
     * Redis 客户端（懒加载）
     */
    this.redis = null

    /**
     * 配置更新锁（防止并发更新竞态条件）
     * 模式：Double-Checked Locking
     * Map<resourceId, Promise>
     */
    this.updateLocks = new Map()

    /**
     * 统计信息
     */
    this.stats = {
      totalCreated: 0,
      totalDisposed: 0,
      totalAcquired: 0,
      totalReleased: 0,
      totalQueueFull: 0,
      totalTimeout: 0,
      totalConfigUpdates: 0,
      totalConfigUpdateSkips: 0
    }
  }

  /**
   * 获取 Redis 客户端（懒加载）
   * @private
   * @returns {object} Redis 客户端实例
   */
  _getRedisClient() {
    if (!this.redis) {
      const redisModel = require('../models/redis')
      this.redis = redisModel.getClient()
      if (!this.redis) {
        throw new Error('Redis client is not connected')
      }
    }
    return this.redis
  }

  /**
   * 等待一个可用槽位（阻塞式）
   *
   * @param {string} resourceId - 资源ID（API Key ID 或 Account ID）
   * @param {object} config - 并发配置
   * @param {boolean} config.enabled - 是否启用并发控制
   * @param {number} config.maxConcurrency - 最大并发数
   * @param {number} config.queueSize - 队列长度（0 表示不排队，直接拒绝）
   * @param {number} config.queueTimeout - 等待超时时间（秒）
   * @param {object} req - Express request 对象
   * @param {object} res - Express response 对象
   * @returns {Promise<Function>} release 函数（用于手动释放，通常由事件监听器自动调用）
   * @throws {Error} code=QUEUE_FULL - 队列已满（立即拒绝）
   * @throws {Error} code=TIMEOUT - 等待超时
   */
  async waitForSlot(resourceId, config, req, res) {
    const { enabled, maxConcurrency, queueSize, queueTimeout } = config

    // 验证参数
    if (!resourceId || typeof resourceId !== 'string') {
      throw new Error('resourceId must be a non-empty string')
    }

    if (!req || !res) {
      throw new Error('req and res are required for auto-release')
    }

    // 未启用并发控制，直接返回空的 release 函数
    if (!enabled || maxConcurrency <= 0) {
      logger.debug(`🔓 Concurrency control disabled for ${resourceId}`)
      return () => {}
    }

    // 🔧 获取或创建 Bottleneck 实例
    let limiter = this.limiters.get(resourceId)

    if (!limiter) {
      // 首次创建
      limiter = this._createLimiter(resourceId, config)
      this.limiters.set(resourceId, limiter)
      this.stats.totalCreated++

      logger.info(
        `🆕 Created Bottleneck for ${resourceId}: maxConcurrency=${maxConcurrency}, queueSize=${queueSize}, ttl=30m`
      )
    } else {
      // 🔄 动态更新配置（异步、带锁）
      await this._updateLimiterConfig(limiter, resourceId, config)
    }

    // 🎯 获取槽位
    return await this._acquireSlot(limiter, resourceId, config, req, res)
  }

  /**
   * 创建 Bottleneck 实例
   * @private
   * @param {string} resourceId - 资源ID
   * @param {object} config - 并发配置
   * @returns {Bottleneck} Bottleneck 实例
   */
  _createLimiter(resourceId, config) {
    const { maxConcurrency, queueSize, queueTimeout } = config
    const redis = this._getRedisClient()

    const options = {
      datastore: 'ioredis',
      connection: redis,
      id: resourceId, // Redis key 前缀
      maxConcurrent: maxConcurrency,
      highWater: queueSize,
      strategy: Bottleneck.strategy.BLOCK, // 队列满则拒绝

      // 租约超时（防止死锁）
      timeout: 300000 // 5 分钟
    }

    // 设置等待超时
    if (queueTimeout > 0) {
      options.expiration = queueTimeout * 1000
    }

    return new Bottleneck(options)
  }

  /**
   * 动态更新配置（带双重检查锁定）
   * 模式：if (needUpdate) { synchronized { if (needUpdate) { update() } } }
   *
   * @private
   * @param {Bottleneck} limiter - Bottleneck 实例
   * @param {string} resourceId - 资源ID
   * @param {object} config - 新配置
   * @returns {Promise<void>}
   */
  async _updateLimiterConfig(limiter, resourceId, config) {
    const { maxConcurrency, queueSize } = config

    // 🔍 第一次检查（无锁 - 快速路径）
    const currentSettings = limiter.getSettings()
    const needUpdate =
      currentSettings.maxConcurrent !== maxConcurrency || currentSettings.highWater !== queueSize

    if (!needUpdate) {
      this.stats.totalConfigUpdateSkips++
      return // 配置未变，无需更新
    }

    // 🔒 获取/等待锁
    let existingLock = this.updateLocks.get(resourceId)

    if (existingLock) {
      // 有正在进行的更新，等待它完成
      logger.debug(`⏳ Waiting for config update lock: ${resourceId}`)
      await existingLock
      this.stats.totalConfigUpdateSkips++
      return // 更新已由其他调用完成
    }

    // 创建新锁（Promise）
    let releaseLock
    const lock = new Promise((resolve) => {
      releaseLock = resolve
    })

    this.updateLocks.set(resourceId, lock)

    try {
      // 🔍 第二次检查（有锁 - 确认状态未变）
      const latestSettings = limiter.getSettings()
      const stillNeedUpdate =
        latestSettings.maxConcurrent !== maxConcurrency || latestSettings.highWater !== queueSize

      if (stillNeedUpdate) {
        // ✅ 执行更新（原子操作）
        limiter.updateSettings({
          maxConcurrent: maxConcurrency,
          highWater: queueSize
        })

        this.stats.totalConfigUpdates++

        logger.info(
          `🔄 Updated Bottleneck for ${resourceId}: ` +
            `maxConcurrency=${latestSettings.maxConcurrent}->${maxConcurrency}, ` +
            `queueSize=${latestSettings.highWater}->${queueSize}`
        )
      } else {
        this.stats.totalConfigUpdateSkips++
        logger.debug(`⏭️ Config already updated by concurrent call: ${resourceId}`)
      }
    } finally {
      // 🔓 释放锁
      this.updateLocks.delete(resourceId)
      releaseLock()
    }
  }

  /**
   * 获取槽位
   * @private
   * @param {Bottleneck} limiter - Bottleneck 实例
   * @param {string} resourceId - 资源ID
   * @param {object} config - 并发配置
   * @param {object} req - Express request 对象
   * @param {object} res - Express response 对象
   * @returns {Promise<Function>} release 函数
   */
  async _acquireSlot(limiter, resourceId, config, req, res) {
    const { queueTimeout } = config
    const timeoutMs = queueTimeout > 0 ? queueTimeout * 1000 : 0

    try {
      // 包装成 job
      const job = () => {
        return new Promise((resolve) => {
          const release = () => {
            resolve()
            this.stats.totalReleased++
            logger.debug(`🔓 Released slot for ${resourceId}`)
          }

          // 🎯 自动释放机制
          req.once('close', release)
          req.once('aborted', release)
          res.once('close', release)
          res.once('finish', release)
          res.once('error', release)

          this.stats.totalAcquired++
          logger.debug(`✅ Acquired slot for ${resourceId}`)
        })
      }

      // 提交任务（带超时）
      await limiter.schedule({ expiration: timeoutMs }, job)

      return () => {} // 已通过事件自动释放
    } catch (error) {
      return this._handleAcquireError(error, resourceId, config, limiter)
    }
  }

  /**
   * 处理获取槽位错误
   * @private
   * @param {Error} error - 错误对象
   * @param {string} resourceId - 资源ID
   * @param {object} config - 并发配置
   * @param {Bottleneck} limiter - Bottleneck 实例
   * @throws {Error} 格式化后的错误
   */
  async _handleAcquireError(error, resourceId, config, limiter) {
    // 🚫 队列满
    if (error.message.includes('This job has been dropped by Bottleneck')) {
      const counts = await limiter.counts()
      this.stats.totalQueueFull++

      logger.warn(
        `🚫 Queue full for ${resourceId}: ${counts.QUEUED} waiting, max ${config.queueSize}`
      )

      const queueFullError = new Error(
        `Queue full: ${counts.QUEUED} requests waiting, maximum queue size is ${config.queueSize}`
      )
      queueFullError.code = 'QUEUE_FULL'
      queueFullError.resourceId = resourceId
      queueFullError.currentWaiting = counts.QUEUED
      queueFullError.maxQueueSize = config.queueSize
      throw queueFullError
    }

    // ⏱️ 超时
    if (error.message.includes('timeout') || error.message.includes('expiration')) {
      this.stats.totalTimeout++

      logger.warn(`⏱️ Timeout waiting for slot: ${resourceId} (waited ${config.queueTimeout}s)`)

      const timeoutError = new Error(`Concurrency timeout after ${config.queueTimeout}s`)
      timeoutError.code = 'TIMEOUT'
      timeoutError.resourceId = resourceId
      timeoutError.timeout = config.queueTimeout
      throw timeoutError
    }

    // 其他错误
    throw error
  }

  /**
   * 释放 Bottleneck 实例（自动清理）
   * @private
   * @param {string} resourceId - 资源ID
   * @param {Bottleneck} limiter - Bottleneck 实例
   */
  _disposeLimiter(resourceId, limiter) {
    try {
      if (limiter && typeof limiter.disconnect === 'function') {
        limiter.disconnect()
        this.stats.totalDisposed++
        logger.info(`🗑️ Auto-disposed Bottleneck for ${resourceId} (TTL expired)`)
      }
    } catch (error) {
      logger.error(`❌ Failed to dispose Bottleneck for ${resourceId}:`, error)
    }
  }

  /**
   * 获取指定资源的统计信息
   *
   * @param {string} resourceId - 资源ID
   * @returns {Promise<object|null>} 统计信息对象，包含 waiting、running、total、free、occupied
   */
  async getStats(resourceId) {
    const limiter = this.limiters.get(resourceId)
    if (!limiter) {
      return null
    }

    const counts = await limiter.counts()
    const settings = limiter.getSettings()

    return {
      waiting: counts.QUEUED,
      running: counts.RUNNING,
      total: settings.maxConcurrent,
      free: settings.maxConcurrent - counts.RUNNING,
      occupied: counts.RUNNING
    }
  }

  /**
   * 获取全局统计信息
   *
   * @returns {object} 全局统计信息
   */
  getGlobalStats() {
    return {
      ...this.stats,
      totalLimiters: this.limiters.keys().length,
      ttl: '30 minutes'
    }
  }

  /**
   * 清除指定资源的 Bottleneck 实例
   * 通常在账号删除时调用
   *
   * @param {string} resourceId - 资源ID
   * @returns {boolean} 是否成功清除
   */
  clear(resourceId) {
    const limiter = this.limiters.get(resourceId)
    if (limiter) {
      this.limiters.del(resourceId) // 会触发 'del' 事件，自动调用 _disposeLimiter
      return true
    }
    return false
  }

  /**
   * 清除所有 Bottleneck 实例
   * 通常在测试或重置时使用
   */
  clearAll() {
    const keys = this.limiters.keys()
    const count = keys.length

    // node-cache 的 flushAll() 会自动触发所有 'del' 事件
    this.limiters.flushAll()

    logger.info(`🗑️ Cleared all ${count} Bottleneck instances`)
  }

  /**
   * 列出所有资源ID
   * @returns {string[]} 资源ID列表
   */
  listResources() {
    return this.limiters.keys()
  }

  /**
   * 检查指定资源是否有活跃的并发控制
   * @param {string} resourceId - 资源ID
   * @returns {boolean} 是否存在
   */
  has(resourceId) {
    return this.limiters.has(resourceId)
  }

  /**
   * 手动刷新资源的 TTL（重置 30 分钟）
   * @param {string} resourceId - 资源ID
   * @returns {boolean} 是否成功刷新
   */
  refreshTTL(resourceId) {
    return this.limiters.ttl(resourceId, 1800) // 1800 秒 = 30 分钟
  }
}

// 导出单例
module.exports = new ConcurrencyManager()
