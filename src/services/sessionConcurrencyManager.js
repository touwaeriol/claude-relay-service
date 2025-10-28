const IORedis = require('ioredis')
const { LRUCache } = require('lru-cache')
const logger = require('../utils/logger')
const appConfig = require('../../config/config')
const {
  normalizeConfig: normalizeSessionConcurrencyConfig
} = require('../utils/sessionConcurrencyConfigHelper')

/**
 * 会话并发控制管理器
 *
 * 核心功能：
 * - 限制时间窗口内的唯一会话数量
 * - 基于 Redis Sorted Set 实现滑动时间窗口
 * - 同一会话的多次请求只算1个会话
 * - 每次请求刷新会话TTL
 * - 达到上限时直接拒绝（不排队）
 *
 * 使用场景：
 * - 防止短时间内创建大量不同会话
 * - 配额管理（如"1小时内最多10个对话"）
 * - 滥用检测
 *
 * 使用示例：
 * ```javascript
 * const config = {
 *   enabled: true,
 *   maxSessions: 10,
 *   windowSeconds: 3600  // 1小时
 * };
 *
 * const result = await sessionConcurrencyManager.checkSessionLimit(
 *   'account-123',
 *   'session-hash-abc',
 *   config
 * );
 *
 * if (!result.allowed) {
 *   // 返回 429 错误
 *   throw result.error;
 * }
 * ```
 *
 * Redis 数据结构：
 * ```
 * Key: session_concurrency:{accountId}
 * Type: Sorted Set
 * Member: sessionHash
 * Score: 最后活跃时间戳
 * TTL: windowSeconds（自动过期）
 * ```
 */
class SessionConcurrencyManager {
  constructor() {
    /**
     * Redis 客户端（懒加载）
     */
    this.redis = null

    /**
     * 配置缓存（用于配置变更检测）
     * 存储每个账户的上次使用配置
     * 类似 concurrencyManager 的 limiters 缓存 Bottleneck 实例配置
     */
    this.accountConfigs = new LRUCache({
      max: 10000, // 最多缓存 10000 个账户
      ttl: 30 * 60 * 1000, // 30 分钟过期
      updateAgeOnGet: true // 访问时刷新 TTL
    })
  }

  /**
   * 获取 Redis 客户端（懒加载）
   * @private
   * @returns {IORedis} Redis 客户端实例
   */
  _getRedis() {
    if (!this.redis) {
      const redisOptions = {
        host: appConfig.redis.host,
        port: appConfig.redis.port,
        password: appConfig.redis.password || undefined,
        db: appConfig.redis.db,
        lazyConnect: false,
        maxRetriesPerRequest: appConfig.redis.maxRetriesPerRequest,
        retryDelayOnFailover: appConfig.redis.retryDelayOnFailover,
        connectTimeout: appConfig.redis.connectTimeout
      }

      if (appConfig.redis.enableTLS) {
        redisOptions.tls = {}
      }

      // 清理 undefined/null 值
      Object.keys(redisOptions).forEach((key) => {
        if (redisOptions[key] === undefined || redisOptions[key] === null) {
          delete redisOptions[key]
        }
      })

      this.redis = new IORedis(redisOptions)

      this.redis.on('error', (err) => {
        logger.error('❌ SessionConcurrencyManager Redis error:', err)
      })
    }
    return this.redis
  }

  /**
   * 标准化配置（使用统一的配置helper）
   * @private
   * @param {object} config - 原始配置
   * @returns {object} 标准化后的配置
   */
  _normalizeConfig(config) {
    return normalizeSessionConcurrencyConfig(config)
  }

  /**
   * 检查会话并发限制
   *
   * @param {string} accountId - 账户ID
   * @param {string} sessionHash - 会话哈希（来自 sessionHelper.generateSessionHash）
   * @param {object} config - 会话并发配置
   * @param {boolean} config.enabled - 是否启用
   * @param {number} config.maxSessions - 最大会话数
   * @param {number} config.windowSeconds - 时间窗口（秒）
   * @returns {Promise<{allowed: boolean, error?: Error, stats?: object}>}
   */
  async checkSessionLimit(accountId, sessionHash, config) {
    const normalizedConfig = this._normalizeConfig(config)
    const { enabled, maxSessions, windowSeconds } = normalizedConfig

    // 验证参数
    if (!accountId || typeof accountId !== 'string') {
      const error = new Error('accountId must be a non-empty string')
      error.code = 'INVALID_ACCOUNT_ID'
      return { allowed: false, error }
    }

    if (!sessionHash || typeof sessionHash !== 'string') {
      // 无法识别会话，跳过检查（允许请求）
      logger.debug(
        `⏭️  [SessionConcurrency] Cannot identify session for ${accountId}, skipping check`
      )
      return { allowed: true }
    }

    // 未启用会话并发控制
    if (!enabled || maxSessions <= 0) {
      logger.debug(`🔓 [SessionConcurrency] Disabled for ${accountId}`)
      return { allowed: true }
    }

    const redis = this._getRedis()
    const redisKey = `session_concurrency:${accountId}`
    const now = Date.now()

    try {
      // 🔍 检查会话是否已存在
      const existingScore = await redis.zscore(redisKey, sessionHash)

      if (existingScore !== null) {
        // ✅ 会话已存在，更新Score并刷新TTL
        const pipeline = redis.pipeline()
        pipeline.zadd(redisKey, now, sessionHash) // 更新最后活跃时间

        // 🔍 检查配置是否变化（类似 concurrencyManager 的 DCL 模式）
        const cached = this.accountConfigs.get(accountId)

        if (!cached || cached.windowSeconds !== windowSeconds) {
          // 配置变了，或首次设置
          pipeline.expire(redisKey, windowSeconds)
          this.accountConfigs.set(accountId, { windowSeconds })
          logger.debug(
            `🔄 [SessionConcurrency] Config updated for ${accountId}: windowSeconds=${windowSeconds}`
          )
        }
        // 配置未变，跳过 EXPIRE

        await pipeline.exec()

        logger.debug(
          `✅ [SessionConcurrency] Existing session refreshed: ${accountId} | ${sessionHash.substring(0, 8)}...`
        )

        return { allowed: true }
      }

      // 🧹 清理过期会话 + 统计当前会话数 + 添加新会话（原子操作）
      const cutoffTime = now - windowSeconds * 1000
      const pipeline = redis.pipeline()

      // 1. 清理过期会话
      pipeline.zremrangebyscore(redisKey, '-inf', cutoffTime)

      // 2. 统计当前会话数
      pipeline.zcard(redisKey)

      const results = await pipeline.exec()

      // 解析结果
      const cleanedCount = results[0][1] // ZREMRANGEBYSCORE 返回删除数量
      const currentSessionCount = results[1][1] // ZCARD 返回成员数量

      if (cleanedCount > 0) {
        logger.debug(
          `🧹 [SessionConcurrency] Cleaned ${cleanedCount} expired sessions for ${accountId}`
        )
      }

      // ❌ 达到会话上限
      if (currentSessionCount >= maxSessions) {
        logger.warn(
          `🚫 [SessionConcurrency] Session limit exceeded for ${accountId}: ${currentSessionCount}/${maxSessions} sessions`
        )

        const error = new Error(
          `Session concurrency limit exceeded: ${currentSessionCount} active sessions, maximum is ${maxSessions} within ${windowSeconds}s window`
        )
        error.code = 'SESSION_LIMIT_EXCEEDED'
        error.accountId = accountId
        error.currentSessions = currentSessionCount
        error.maxSessions = maxSessions
        error.windowSeconds = windowSeconds
        error.details = {
          current: currentSessionCount,
          max: maxSessions,
          windowSeconds
        }

        return {
          allowed: false,
          error,
          stats: {
            current: currentSessionCount,
            max: maxSessions,
            windowSeconds
          }
        }
      }

      // ✅ 添加新会话
      const addPipeline = redis.pipeline()
      addPipeline.zadd(redisKey, now, sessionHash)

      // 🔍 检查配置是否变化（与上面相同的逻辑）
      const cached = this.accountConfigs.get(accountId)

      if (!cached || cached.windowSeconds !== windowSeconds) {
        // 配置变了，或首次设置
        addPipeline.expire(redisKey, windowSeconds)
        this.accountConfigs.set(accountId, { windowSeconds })
      }
      // 配置未变，跳过 EXPIRE

      await addPipeline.exec()

      logger.info(
        `➕ [SessionConcurrency] New session added: ${accountId} | ${sessionHash.substring(0, 8)}... | ${currentSessionCount + 1}/${maxSessions} sessions`
      )

      return {
        allowed: true,
        stats: {
          current: currentSessionCount + 1,
          max: maxSessions,
          windowSeconds
        }
      }
    } catch (error) {
      logger.error(`❌ [SessionConcurrency] Redis error for ${accountId}:`, error)

      // Redis 错误时允许请求（降级策略）
      return { allowed: true }
    }
  }

  /**
   * 获取账户的会话统计信息
   *
   * @param {string} accountId - 账户ID
   * @returns {Promise<{current: number, sessions: string[], windowSeconds: number}|null>}
   */
  async getAccountStats(accountId) {
    if (!accountId || typeof accountId !== 'string') {
      return null
    }

    const redis = this._getRedis()
    const redisKey = `session_concurrency:${accountId}`

    try {
      // 获取当前会话数和TTL
      const pipeline = redis.pipeline()
      pipeline.zcard(redisKey)
      pipeline.zrange(redisKey, 0, -1)
      pipeline.ttl(redisKey)

      const results = await pipeline.exec()

      const currentCount = results[0][1]
      const sessions = results[1][1]
      const ttl = results[2][1]

      return {
        current: currentCount,
        sessions: sessions || [],
        ttl: ttl > 0 ? ttl : 0
      }
    } catch (error) {
      logger.error(`❌ [SessionConcurrency] Failed to get stats for ${accountId}:`, error)
      return null
    }
  }

  /**
   * 手动移除会话
   *
   * @param {string} accountId - 账户ID
   * @param {string} sessionHash - 会话哈希
   * @returns {Promise<boolean>} 是否成功移除
   */
  async removeSession(accountId, sessionHash) {
    if (!accountId || !sessionHash) {
      return false
    }

    const redis = this._getRedis()
    const redisKey = `session_concurrency:${accountId}`

    try {
      const removed = await redis.zrem(redisKey, sessionHash)
      if (removed > 0) {
        logger.info(
          `🗑️  [SessionConcurrency] Session removed: ${accountId} | ${sessionHash.substring(0, 8)}...`
        )
        return true
      }
      return false
    } catch (error) {
      logger.error(`❌ [SessionConcurrency] Failed to remove session for ${accountId}:`, error)
      return false
    }
  }

  /**
   * 清空账户的所有会话
   *
   * @param {string} accountId - 账户ID
   * @returns {Promise<boolean>} 是否成功清空
   */
  async clearAccount(accountId) {
    if (!accountId) {
      return false
    }

    const redis = this._getRedis()
    const redisKey = `session_concurrency:${accountId}`

    try {
      await redis.del(redisKey)
      logger.info(`🗑️  [SessionConcurrency] All sessions cleared for ${accountId}`)
      return true
    } catch (error) {
      logger.error(`❌ [SessionConcurrency] Failed to clear sessions for ${accountId}:`, error)
      return false
    }
  }

  /**
   * 清理资源（断开Redis连接并清空缓存）
   */
  async dispose() {
    // 清空配置缓存
    this.accountConfigs.clear()

    if (this.redis) {
      try {
        await this.redis.quit()
        this.redis = null
        logger.info('✅ [SessionConcurrency] Redis connection closed')
      } catch (error) {
        logger.error('❌ [SessionConcurrency] Failed to close Redis connection:', error)
      }
    }
  }
}

// 导出单例
module.exports = new SessionConcurrencyManager()
