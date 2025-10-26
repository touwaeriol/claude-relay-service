const { Semaphore } = require('redis-semaphore')
const logger = require('../utils/logger')
const redisClient = require('../models/redis')

/**
 * 并发控制管理器（基于 Redis）
 * 基于 redis-semaphore 实现的账户和 API Key 级别的并发控制
 *
 * 核心功能：
 * - 支持最大并发数限制
 * - 支持请求队列（队列满时立即拒绝）
 * - 支持等待超时
 * - 客户端断开自动释放信号量
 * - 基于 Redis 的分布式信号量（近似公平）
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
 *   } else if (error.code === 'CLIENT_DISCONNECTED') {
 *     // 客户端已断开，直接返回（不需要响应）
 *     return;
 *   }
 * }
 * ```
 */
class ConcurrencyManager {
  constructor() {
    /**
     * 存储所有 Semaphore 实例
     * Map<resourceId, { semaphore: Semaphore, configHash: string, createdAt: number }>
     */
    this.semaphores = new Map()

    /**
     * LRU 缓存限制（防止内存泄漏）
     * 超过此限制时，删除最早创建的实例
     */
    this.maxInstances = 1000

    /**
     * 队列计数 TTL（秒）
     * 10分钟无活动后自动过期
     */
    this.queueCountTTL = 600 // 10分钟

    /**
     * 统计信息
     */
    this.stats = {
      totalCreated: 0,
      totalEvicted: 0,
      totalAcquired: 0,
      totalReleased: 0,
      totalQueueFull: 0,
      totalTimeout: 0,
      totalClientDisconnected: 0 // 客户端断开计数
    }
  }

  /**
   * 获取 Redis 客户端（懒加载）
   * @private
   * @returns {object} Redis 客户端实例
   */
  _getRedisClient() {
    const client = redisClient.getClient()
    if (!client) {
      throw new Error('Redis client is not connected')
    }
    return client
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
   * @throws {Error} code=CLIENT_DISCONNECTED - 客户端在等待期间断开连接（立即释放槽位）
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
      return () => {} // 返回空的 release 函数
    }

    // 获取或创建 Semaphore 实例
    const semaphoreInfo = this._getSemaphoreInfo(resourceId, config)
    const { semaphore } = semaphoreInfo

    // 队列计数键
    const queueCountKey = `concurrency:queue:${resourceId}`
    const redis = this._getRedisClient()

    // 1. 入队前先"占位"——控制等待队列长度
    const waiting = await redis.incr(queueCountKey)
    // 设置/更新 TTL（10分钟）
    await redis.expire(queueCountKey, this.queueCountTTL)

    if (waiting > queueSize) {
      // 队列已满，撤销占位
      await redis.decr(queueCountKey)
      await redis.expire(queueCountKey, this.queueCountTTL)
      this.stats.totalQueueFull++

      logger.warn(
        `🚫 Queue full for ${resourceId}: ${waiting - 1} waiting, max ${queueSize}`
      )

      const error = new Error(
        `Queue full: ${waiting - 1} requests waiting, maximum queue size is ${queueSize}`
      )
      error.code = 'QUEUE_FULL'
      error.resourceId = resourceId
      error.currentWaiting = waiting - 1
      error.maxQueueSize = queueSize
      throw error
    }

    // 2. 尝试获取信号量（阻塞等待）
    let acquired = false
    // queueTimeout 为 0 表示永久等待，不设置超时
    const timeoutMs = queueTimeout > 0 ? queueTimeout * 1000 : 0

    try {
      logger.debug(
        `⏳ Acquiring slot for ${resourceId} (waiting: ${waiting - 1}, timeout: ${queueTimeout > 0 ? `${queueTimeout}s` : 'infinite'})`
      )

      // 使用 redis-semaphore 的 acquire 方法（支持超时）
      await semaphore.acquire()
      acquired = true
      this.stats.totalAcquired++

      // 获取成功后，减少等待计数
      await redis.decr(queueCountKey)
      await redis.expire(queueCountKey, this.queueCountTTL)

      logger.debug(`✅ Acquired slot for ${resourceId}`)

      // 🎯 关键优化：检查客户端是否已经断开连接
      // 如果客户端在等待期间断开了，立即释放槽位，不再继续执行
      if (req.destroyed || req.socket?.destroyed || res.destroyed) {
        this.stats.totalClientDisconnected++
        logger.warn(
          `🔌 Client already disconnected for ${resourceId}, releasing slot immediately (total: ${this.stats.totalClientDisconnected})`
        )

        // 立即释放
        await semaphore.release()

        const error = new Error('Client disconnected while waiting for slot')
        error.code = 'CLIENT_DISCONNECTED'
        error.resourceId = resourceId
        throw error
      }
    } catch (error) {
      // 获取失败时撤销占位
      if (!acquired) {
        await redis.decr(queueCountKey)
        await redis.expire(queueCountKey, this.queueCountTTL)
      }

      // 检查是否是超时错误
      if (error.name === 'TimeoutError' || error.message?.includes('timeout')) {
        this.stats.totalTimeout++
        logger.warn(`⏱️ Timeout waiting for slot: ${resourceId} (waited ${queueTimeout}s)`)

        const timeoutError = new Error(`Concurrency timeout after ${queueTimeout}s`)
        timeoutError.code = 'TIMEOUT'
        timeoutError.resourceId = resourceId
        timeoutError.timeout = queueTimeout
        timeoutError.timeoutMs = timeoutMs
        throw timeoutError
      }

      throw error
    }

    // 3. 自动释放机制（监听所有可能的断开事件）
    let released = false
    const release = async () => {
      if (!released) {
        released = true
        try {
          await semaphore.release()
          this.stats.totalReleased++
          logger.debug(`🔓 Released slot for ${resourceId}`)
        } catch (err) {
          logger.error(`❌ Error releasing slot for ${resourceId}:`, err)
        }
      }
    }

    // 监听客户端断开和请求完成事件
    // 注意：这些事件可能会重复触发，但 release() 有防重复机制
    req.once('close', release) // 客户端关闭连接
    req.once('aborted', release) // 请求被中止
    res.once('close', release) // 响应关闭
    res.once('finish', release) // 响应完成
    res.once('error', release) // 响应错误

    logger.debug(`🔗 Registered auto-release handlers for ${resourceId}`)

    // 返回 release 函数供手动调用
    return release
  }

  /**
   * 获取或创建 Semaphore 实例
   * @private
   * @param {string} resourceId - 资源ID
   * @param {object} config - 并发配置
   * @returns {object} Semaphore 信息对象
   */
  _getSemaphoreInfo(resourceId, config) {
    const { maxConcurrency, queueSize } = config

    // 计算配置哈希（用于检测配置变化）
    const configHash = this._hashConfig(config)

    // 获取现有实例
    const semaphoreInfo = this.semaphores.get(resourceId)

    // 配置未变化，直接返回现有信息对象
    if (semaphoreInfo && semaphoreInfo.configHash === configHash) {
      return semaphoreInfo
    }

    // 配置变化或首次创建
    logger.info(
      `🆕 ${semaphoreInfo ? 'Recreating' : 'Creating'} Semaphore for ${resourceId}: maxConcurrency=${maxConcurrency}, queueSize=${queueSize}`
    )

    // 创建新的 Semaphore 实例
    const redis = this._getRedisClient()
    const semaphore = new Semaphore(redis, `sem:${resourceId}`, maxConcurrency, {
      acquireTimeout: (config.queueTimeout || 30) * 1000, // 等待超时（毫秒）
    const semaphoreOptions = {
      lockTimeout: 300000, // 占用租约（5分钟），防止忘记释放导致死锁
      retryInterval: 100 // 重试间隔（毫秒）
    })
    }

    // queueTimeout > 0 时设置等待超时，否则永久等待
    if (config.queueTimeout > 0) {
      semaphoreOptions.acquireTimeout = config.queueTimeout * 1000
    }

    const semaphore = new Semaphore(redis, `sem:${resourceId}`, maxConcurrency, semaphoreOptions)

    // 存储实例
    const newSemaphoreInfo = {
      semaphore,
      configHash,
      createdAt: Date.now(),
      maxConcurrency,
      queueSize
    }

    this.semaphores.set(resourceId, newSemaphoreInfo)
    this.stats.totalCreated++

    // LRU 清理：超过限制时删除最早创建的实例
    if (this.semaphores.size > this.maxInstances) {
      this._evictOldest()
    }

    return newSemaphoreInfo
  }

  /**
   * 计算配置哈希
   * @private
   * @param {object} config - 并发配置
   * @returns {string} 配置哈希字符串
   */
  _hashConfig(config) {
    return `${config.maxConcurrency}:${config.queueSize}:${config.queueTimeout}`
  }

  /**
   * LRU 清理：删除最早创建的实例
   * @private
   */
  _evictOldest() {
    let oldestKey = null
    let oldestTime = Infinity

    // 找到最早创建的实例
    for (const [key, info] of this.semaphores.entries()) {
      if (info.createdAt < oldestTime) {
        oldestTime = info.createdAt
        oldestKey = key
      }
    }

    if (oldestKey) {
      this.semaphores.delete(oldestKey)
      this.stats.totalEvicted++
      logger.warn(
        `⚠️ Semaphore cache full (${this.maxInstances}), evicted oldest: ${oldestKey} (created ${new Date(oldestTime).toISOString()})`
      )
    }
  }

  /**
   * 获取指定资源的统计信息
   *
   * @param {string} resourceId - 资源ID
   * @returns {Promise<object|null>} 统计信息对象，包含 waiting、free、total、occupied
   */
  async getStats(resourceId) {
    const semaphoreInfo = this.semaphores.get(resourceId)
    if (!semaphoreInfo) {
      return null
    }

    const { maxConcurrency } = semaphoreInfo
    const queueCountKey = `concurrency:queue:${resourceId}`
    const redis = this._getRedisClient()

    // 从 Redis 获取等待队列长度
    const waiting = parseInt((await redis.get(queueCountKey)) || '0', 10)

    // 注意：redis-semaphore 没有直接的 API 获取当前占用数
    // 这里我们只能返回配置的最大并发数和等待队列长度
    return {
      waiting, // 等待中的请求数
      total: maxConcurrency, // 最大并发数
      // free 和 occupied 需要通过 Redis ZCARD 查询，这里暂时不实现
      info: 'Use Redis ZCARD to get precise free/occupied counts'
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
      totalSemaphores: this.semaphores.size,
      maxInstances: this.maxInstances
    }
  }

  /**
   * 清除指定资源的 Semaphore 实例
   * 通常在账号删除或配置更新时调用
   *
   * 注意：Redis 中的并发控制数据会通过 TTL 自动过期（10分钟），无需手动删除
   *
   * @param {string} resourceId - 资源ID
   * @returns {boolean} 是否成功清除
   */
  clear(resourceId) {
    const existed = this.semaphores.has(resourceId)
    if (existed) {
      this.semaphores.delete(resourceId)
      logger.info(
        `🗑️ Cleared Semaphore for ${resourceId} (Redis data will auto-expire in ${this.queueCountTTL}s)`
      )
    }
    return existed
  }

  /**
   * 清除所有 Semaphore 实例
   * 通常在测试或重置时使用
   *
   * 注意：Redis 中的并发控制数据会通过 TTL 自动过期（10分钟），无需手动删除
   */
  clearAll() {
    const count = this.semaphores.size
    this.semaphores.clear()
    logger.info(
      `🗑️ Cleared all ${count} Semaphore instances (Redis data will auto-expire in ${this.queueCountTTL}s)`
    )
  }

  /**
   * 列出所有资源ID
   * @returns {string[]} 资源ID列表
   */
  listResources() {
    return Array.from(this.semaphores.keys())
  }

  /**
   * 检查指定资源是否有活跃的并发控制
   * @param {string} resourceId - 资源ID
   * @returns {boolean} 是否存在
   */
  has(resourceId) {
    return this.semaphores.has(resourceId)
  }
}

// 导出单例
module.exports = new ConcurrencyManager()
