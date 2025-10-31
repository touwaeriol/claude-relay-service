const Bottleneck = require('bottleneck')
const { LRUCache } = require('lru-cache')
const logger = require('../utils/logger')
const appConfig = require('../../config/config')
const { CONCURRENCY_ERRORS } = require('../constants/errorCodes')
const redisConnectionManager = require('../utils/redisConnectionManager')

const DEFAULT_EXECUTION_TIMEOUT_SECONDS = 300

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
 *   queueTimeout: 120 // 秒
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
     * Bottleneck 实例缓存（基于 LRUCache）
     * 自动特性：
     * - 30 分钟未访问自动删除（可通过 CONCURRENCY_LIMITER_CACHE_TTL 配置）
     * - get/has 时自动刷新 TTL
     * - 删除时自动断开 Bottleneck 连接
     */
    this.limiterTtlMs = appConfig.concurrency?.limiterCacheTtl || (30 * 60 * 1000)
    this.limiters = new LRUCache({
      max: 10000,
      ttl: this.limiterTtlMs,
      ttlAutopurge: true,
      updateAgeOnGet: true,
      updateAgeOnHas: true,
      noDisposeOnSet: true,
      dispose: (value, key, reason) => {
        this._disposeLimiter(key, value, reason)
      }
    })

    /**
     * 配置更新锁（防止并发更新竞态条件）
     * 模式：Double-Checked Locking
     * Map<resourceId, Promise>
     */
    this.updateLocks = new Map()

    /**
     * 记录各资源的配置信息，避免依赖 Bottleneck 内部私有属性
     * Map<resourceId, { maxConcurrent: number, highWater: number }>
     */
    this.limiterSettings = new Map()

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
      totalExecutionTimeout: 0,
      totalConfigUpdates: 0,
      skipsDueToUnchanged: 0, // 配置未变化而跳过更新
      skipsDueToLockWait: 0 // 等待锁后发现已更新而跳过
    }
  }

  _normalizeConfig(config) {
    const configDefaults = (appConfig?.defaults && appConfig.defaults.concurrency) || {}
    const defaults = {
      enabled: false,
      maxConcurrency: 10,
      queueSize: 20,
      queueTimeout: 120,
      executionTimeout:
        typeof configDefaults.executionTimeout === 'number'
          ? configDefaults.executionTimeout
          : DEFAULT_EXECUTION_TIMEOUT_SECONDS,
      targetServices: [],
      ...configDefaults
    }

    if (defaults.executionTimeout === undefined || defaults.executionTimeout === null) {
      defaults.executionTimeout = DEFAULT_EXECUTION_TIMEOUT_SECONDS
    }

    if (typeof config === 'string') {
      const trimmed = config.trim()
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed)
          return this._normalizeConfig(parsed)
        } catch (error) {
          logger.warn('⚠️ Failed to parse concurrency config string, using defaults:', error)
          return { ...defaults }
        }
      }
      return { ...defaults }
    }

    if (!config || typeof config !== 'object') {
      return { ...defaults }
    }

    const toNumber = (value, fallback) => {
      if (value === null || value === undefined || value === '') {
        return fallback
      }
      const num = Number(value)
      return Number.isFinite(num) ? num : fallback
    }

    const normalized = { ...defaults }

    normalized.enabled =
      config.enabled === true ||
      config.enabled === 'true' ||
      config.enabled === 1 ||
      config.enabled === '1'

    const coercedMaxConcurrency = Math.floor(
      toNumber(config.maxConcurrency, defaults.maxConcurrency)
    )
    normalized.maxConcurrency = coercedMaxConcurrency < 1 ? 1 : coercedMaxConcurrency

    const coercedQueueSize = Math.floor(toNumber(config.queueSize, defaults.queueSize))
    // 强制 queueSize >= 0（不支持无限队列）
    if (coercedQueueSize < 0) {
      normalized.queueSize = 0 // 0 表示不排队，立即拒绝
    } else {
      normalized.queueSize = coercedQueueSize
    }

    const coercedQueueTimeout = Math.floor(toNumber(config.queueTimeout, defaults.queueTimeout))
    normalized.queueTimeout = coercedQueueTimeout < 1 ? 1 : coercedQueueTimeout

    const coercedExecutionTimeout = Math.floor(
      toNumber(config.executionTimeout, defaults.executionTimeout)
    )
    normalized.executionTimeout = coercedExecutionTimeout <= 0 ? null : coercedExecutionTimeout

    // 处理 targetServices 字段
    const validServices = ['claude', 'gemini', 'openai', 'droid']
    if (Array.isArray(config.targetServices)) {
      normalized.targetServices = [
        ...new Set(
          config.targetServices
            .map((s) => (typeof s === 'string' ? s.toLowerCase().trim() : null))
            .filter((s) => s && validServices.includes(s))
        )
      ]
    } else {
      normalized.targetServices = defaults.targetServices
    }

    return normalized
  }

  normalizeConfig(config) {
    return this._normalizeConfig(config)
  }

  /**
   * 获取 Bottleneck IORedisConnection（复用全局连接池）
   * @private
   * @returns {import('bottleneck').IORedisConnection}
   */
  _getRedisConnection() {
    return redisConnectionManager.getBottleneckConnection()
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
    const normalizedConfig = this._normalizeConfig(config)
    const { enabled, maxConcurrency, queueSize } = normalizedConfig

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
      limiter = this._createLimiter(resourceId, normalizedConfig)
      this.limiters.set(resourceId, limiter, { ttl: this.limiterTtlMs })
      this.stats.totalCreated++

      logger.info(
        `🆕 Created Bottleneck for ${resourceId}: maxConcurrency=${maxConcurrency}, queueSize=${queueSize}, executionTimeout=${normalizedExecutionTimeout ?? 'disabled'}s, ttl=30m`
      )
    } else {
      // 🔄 动态更新配置（异步、带锁）
      limiter = await this._updateLimiterConfig(limiter, resourceId, normalizedConfig)
    }

    // 🎯 获取槽位
    return await this._acquireSlot(limiter, resourceId, normalizedConfig, req, res)
  }

  /**
   * 创建 Bottleneck 实例
   * @private
   * @param {string} resourceId - 资源ID
   * @param {object} config - 并发配置
   * @returns {Bottleneck} Bottleneck 实例
   */
  _createLimiter(resourceId, config) {
    const { maxConcurrency, queueSize, executionTimeout } = config
    const redisConnection = this._getRedisConnection()

    const normalizedExecutionTimeout =
      typeof executionTimeout === 'number' && executionTimeout > 0
        ? executionTimeout
        : null
    const executionTimeoutMs =
      normalizedExecutionTimeout !== null ? normalizedExecutionTimeout * 1000 : null

    // 统一使用 OVERFLOW 策略（queueSize >= 0）
    const options = {
      datastore: 'ioredis',
      connection: redisConnection,
      id: resourceId, // Redis key 前缀
      maxConcurrent: maxConcurrency,
      highWater: queueSize, // 直接使用 queueSize (>= 0)
      strategy: Bottleneck.strategy.OVERFLOW, // 统一策略
      timeout: executionTimeoutMs ?? undefined
    }

    const limiter = new Bottleneck(options)
    this.limiterSettings.set(resourceId, {
      maxConcurrent: maxConcurrency,
      queueSize,
      executionTimeout: normalizedExecutionTimeout
    })
    return limiter
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
    const { maxConcurrency, queueSize, executionTimeout } = config
    const normalizedExecutionTimeout =
      typeof executionTimeout === 'number' && executionTimeout > 0
        ? executionTimeout
        : null

    // 🔍 第一次检查（无锁 - 快速路径）
    const currentSettings = this.limiterSettings.get(resourceId) || {
      maxConcurrent: null,
      queueSize: null,
      executionTimeout: null
    }
    const needUpdate =
      currentSettings.maxConcurrent !== maxConcurrency ||
      currentSettings.queueSize !== queueSize ||
      currentSettings.executionTimeout !== normalizedExecutionTimeout

    if (!needUpdate) {
      this.stats.skipsDueToUnchanged++
      return limiter // 配置未变，无需更新
    }

    // 🔒 获取/等待锁
    const existingLock = this.updateLocks.get(resourceId)

    if (existingLock) {
      // 有正在进行的更新，等待它完成
      logger.debug(`⏳ Waiting for config update lock: ${resourceId}`)
      await existingLock
      this.stats.skipsDueToLockWait++
      return this.limiters.get(resourceId) || limiter // 更新已由其他调用完成
    }

    // 创建新锁（Promise）
    let releaseLock
    const lock = new Promise((resolve) => {
      releaseLock = resolve
    })

    this.updateLocks.set(resourceId, lock)

    try {
      // 🔍 第二次检查（有锁 - 确认状态未变）
      const latestSettings = this.limiterSettings.get(resourceId) || {
        maxConcurrent: null,
        queueSize: null,
        executionTimeout: null
      }
      const stillNeedUpdate =
        latestSettings.maxConcurrent !== maxConcurrency ||
        latestSettings.queueSize !== queueSize ||
        latestSettings.executionTimeout !== normalizedExecutionTimeout

      if (stillNeedUpdate) {
        // ✅ 直接更新配置（不需要重建，因为 queueSize >= 0 统一使用 OVERFLOW 策略）
        limiter.updateSettings({
          maxConcurrent: maxConcurrency,
          highWater: queueSize,
          timeout:
            normalizedExecutionTimeout !== null ? normalizedExecutionTimeout * 1000 : null
        })

        this.limiterSettings.set(resourceId, {
          maxConcurrent: maxConcurrency,
          queueSize,
          executionTimeout: normalizedExecutionTimeout
        })

        this.stats.totalConfigUpdates++

        logger.info(
          `🔄 Updated Bottleneck for ${resourceId}: ` +
            `maxConcurrency=${latestSettings.maxConcurrent}->${maxConcurrency}, ` +
            `queueSize=${latestSettings.queueSize}->${queueSize}, ` +
            `executionTimeout=${
              latestSettings.executionTimeout ?? 'disabled'
            }->${normalizedExecutionTimeout ?? 'disabled'}`
        )
      } else {
        this.stats.skipsDueToUnchanged++
        logger.debug(`⏭️ Config already updated by concurrent call: ${resourceId}`)
      }
    } finally {
      // 🔓 释放锁
      this.updateLocks.delete(resourceId)
      releaseLock()
    }

    return limiter
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
    const timeoutMs = queueTimeout * 1000

    let earlyDisconnected = false

    const onEarlyDisconnect = () => {
      earlyDisconnected = true
    }

    req.once('close', onEarlyDisconnect)
    req.once('aborted', onEarlyDisconnect)

    const cleanupEarlyListeners = () => {
      req.removeListener('close', onEarlyDisconnect)
      req.removeListener('aborted', onEarlyDisconnect)
    }

    let acquireResolve
    let acquireReject
    let acquireSettled = false

    const acquirePromise = new Promise((resolve, reject) => {
      acquireResolve = resolve
      acquireReject = reject
    })

    const resolveAcquireOnce = (releaseFn) => {
      if (acquireSettled) {
        return
      }
      acquireSettled = true
      acquireResolve(releaseFn)
    }

    const rejectAcquireOnce = (error) => {
      if (acquireSettled) {
        return
      }
      acquireSettled = true
      acquireReject(error)
    }

    let jobStarted = false

    const job = () =>
      new Promise((resolveJob) => {
        jobStarted = true
        cleanupEarlyListeners()

        if (earlyDisconnected) {
          const disconnectError = new Error('Client disconnected before acquiring slot')
          disconnectError.code = CONCURRENCY_ERRORS.CLIENT_DISCONNECTED
          disconnectError.resourceId = resourceId
          logger.info(`🔌 Client disconnected before acquiring slot: ${resourceId}`)
          resolveJob()
          rejectAcquireOnce(disconnectError)
          return
        }

        let released = false

        const cleanupActiveListeners = () => {
          req.removeListener('close', handleDisconnect)
          req.removeListener('aborted', handleDisconnect)
          res.removeListener('close', handleDisconnect)
          res.removeListener('finish', handleFinish)
          res.removeListener('error', handleError)
        }

        const finalizeRelease = () => {
          if (released) {
            return
          }
          released = true
          cleanupActiveListeners()
          resolveJob()
        }

        const handleDisconnect = () => {
          if (released) {
            return
          }
          finalizeRelease()
          const disconnectError = new Error('Client disconnected while holding slot')
          disconnectError.code = CONCURRENCY_ERRORS.CLIENT_DISCONNECTED
          disconnectError.resourceId = resourceId
          logger.info(`🔌 Client disconnected while holding slot: ${resourceId}`)
          this.stats.totalReleased++
          rejectAcquireOnce(disconnectError)
        }

        const handleError = (err) => {
          if (released) {
            return
          }
          finalizeRelease()
          this.stats.totalReleased++
          logger.error(`❌ Response stream error while holding slot: ${resourceId}`, err)
          rejectAcquireOnce(err)
        }

        const handleFinish = () => {
          release()
        }

        const release = () => {
          if (released) {
            return
          }
          finalizeRelease()
          this.stats.totalReleased++
          logger.debug(`🔓 Released slot for ${resourceId}`)
        }

        req.once('close', handleDisconnect)
        req.once('aborted', handleDisconnect)
        res.once('close', handleDisconnect)
        res.once('finish', handleFinish)
        res.once('error', handleError)

        this.stats.totalAcquired++
        logger.debug(`✅ Acquired slot for ${resourceId}`)

        resolveAcquireOnce(() => {
          release()
        })
      })

    const scheduledPromise = limiter.schedule({ expiration: timeoutMs }, job)

    scheduledPromise.catch(async (error) => {
      cleanupEarlyListeners()

      if (acquireSettled) {
        return
      }

      try {
        await this._handleAcquireError(error, resourceId, config, limiter, jobStarted)
      } catch (handledError) {
        rejectAcquireOnce(handledError)
        return
      }

      rejectAcquireOnce(error)
    })

    return acquirePromise
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
  async _handleAcquireError(error, resourceId, config, limiter, jobStarted = false) {
    const isBottleneckError = error instanceof Bottleneck.BottleneckError
    const message = typeof error.message === 'string' ? error.message : ''

    if (isBottleneckError && message === 'This job has been dropped by Bottleneck') {
      const counts = await limiter.counts()
      this.stats.totalQueueFull++

      logger.warn(
        `🚫 Queue full for ${resourceId}: ${counts.QUEUED} waiting, max ${config.queueSize}`
      )

      const queueFullError = new Error(
        `Queue full: ${counts.QUEUED} requests waiting, maximum queue size is ${config.queueSize}`
      )
      queueFullError.code = CONCURRENCY_ERRORS.QUEUE_FULL
      queueFullError.resourceId = resourceId
      queueFullError.currentWaiting = counts.QUEUED
      queueFullError.maxQueueSize = config.queueSize
      throw queueFullError
    }

    if (!jobStarted && isBottleneckError && message === 'This job reached its expiration time.') {
      this.stats.totalTimeout++

      logger.warn(`⏱️ Timeout waiting for slot: ${resourceId} (waited ${config.queueTimeout}s)`)

      const timeoutError = new Error(`Concurrency timeout after ${config.queueTimeout}s`)
      timeoutError.code = CONCURRENCY_ERRORS.TIMEOUT
      timeoutError.resourceId = resourceId
      timeoutError.timeout = config.queueTimeout
      timeoutError.timeoutMs = config.queueTimeout * 1000
      timeoutError.timeoutType = 'queue'
      throw timeoutError
    }

    if (jobStarted && isBottleneckError && message === 'This job has timed out.') {
      this.stats.totalExecutionTimeout++

      const executionTimeout = config.executionTimeout || 0
      logger.warn(
        `⏱️ Execution timeout for ${resourceId}: exceeded ${executionTimeout || 'configured'}s`
      )

      const executionTimeoutError = new Error(
        executionTimeout
          ? `Concurrency execution timeout after ${executionTimeout}s`
          : 'Concurrency execution timeout'
      )
      executionTimeoutError.code = CONCURRENCY_ERRORS.TIMEOUT
      executionTimeoutError.resourceId = resourceId
      executionTimeoutError.timeout = executionTimeout
      executionTimeoutError.timeoutMs =
        executionTimeout && executionTimeout > 0 ? executionTimeout * 1000 : null
      executionTimeoutError.timeoutType = 'execution'
      throw executionTimeoutError
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
  _disposeLimiter(resourceId, limiter, reason = 'unknown') {
    try {
      if (limiter && typeof limiter.disconnect === 'function') {
        limiter.disconnect()
        this.stats.totalDisposed++
        logger.info(
          `🗑️ Auto-disposed Bottleneck for ${resourceId} (reason: ${reason || 'unknown'})`
        )
      }
      this.limiterSettings.delete(resourceId)
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
    const settings = this.limiterSettings.get(resourceId)
    if (!settings) {
      return {
        waiting: counts.QUEUED,
        running: counts.RUNNING,
        total: null,
        free: null,
        occupied: counts.RUNNING
      }
    }

    return {
      waiting: counts.QUEUED,
      running: counts.RUNNING,
      total: settings.maxConcurrent,
      free: settings.maxConcurrent - counts.RUNNING,
      occupied: counts.RUNNING
    }
  }

  /**
   * 获取指定资源的并发配置
   * @param {string} resourceId - 资源ID
   * @returns {{maxConcurrent:number, highWater:number}|null}
   */
  getSettings(resourceId) {
    return this.limiterSettings.get(resourceId) || null
  }

  /**
   * 获取全局统计信息
   *
   * @returns {object} 全局统计信息
   */
  getGlobalStats() {
    return {
      ...this.stats,
      totalLimiters: this.limiters.size,
      ttl: `${Math.floor(this.limiterTtlMs / 60000)} minutes`
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
      this.limiters.delete(resourceId)
      this.limiterSettings.delete(resourceId)
      return true
    }
    return false
  }

  /**
   * 清除所有 Bottleneck 实例
   * 通常在测试或重置时使用
   */
  clearAll() {
    const count = this.limiters.size
    this.limiters.clear()
    this.limiterSettings.clear()

    logger.info(`🗑️ Cleared all ${count} Bottleneck instances`)
  }

  /**
   * 列出所有资源ID
   * @returns {string[]} 资源ID列表
   */
  listResources() {
    return Array.from(this.limiters.keys())
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
    const limiter = this.limiters.get(resourceId)
    if (!limiter) {
      return false
    }
    this.limiters.set(resourceId, limiter, { ttl: this.limiterTtlMs })
    return true
  }
}

// 导出单例
module.exports = new ConcurrencyManager()
