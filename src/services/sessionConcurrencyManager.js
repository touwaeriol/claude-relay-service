const { LRUCache } = require('lru-cache')
const logger = require('../utils/logger')
const appConfig = require('../../config/config')
const {
  normalizeConfig: normalizeSessionConcurrencyConfig,
  getConfigHash
} = require('../utils/sessionConcurrencyConfigHelper')
const { SESSION_CONCURRENCY_ERRORS, REDIS_ERRORS } = require('../constants/errorCodes')
const redisConnectionManager = require('../utils/redisConnectionManager')

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

// 常量
const LRU_CACHE_MAX_ACCOUNTS = 10000
const LRU_CACHE_TTL_MS = appConfig.concurrency?.sessionConfigCacheTtl || (30 * 60 * 1000) // 30 分钟（可通过 SESSION_CONFIG_CACHE_TTL 配置）

class SessionConcurrencyManager {
  constructor() {
    /**
     * 配置缓存（用于配置变更检测）
     * 存储每个账户的上次使用配置哈希
     * 类似 concurrencyManager 的 limiters 缓存 Bottleneck 实例配置
     */
    this.accountConfigs = new LRUCache({
      max: LRU_CACHE_MAX_ACCOUNTS,
      ttl: LRU_CACHE_TTL_MS,
      updateAgeOnGet: true // 访问时刷新 TTL
    })
  }

  /**
   * 获取 Redis 客户端（复用全局连接池）
   * @private
   * @returns {import('ioredis').Redis} Redis 客户端实例
   */
  _getRedis() {
    return redisConnectionManager.getRedisClient()
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
   * Lua 脚本：原子性地检查并添加会话
   * 返回值：
   *   [1, 'existing'] - 会话已存在，已更新时间戳
   *   [1, 'added', currentCount] - 成功添加新会话，返回当前会话数
   *   [0, currentCount] - 达到上限，拒绝添加
   *
   * 注意：脚本中会对 redisKey 刷新 TTL（ARGV[5]）
   */
  _getCheckAndAddLuaScript() {
    return `
      local redisKey = KEYS[1]
      local now = tonumber(ARGV[1])
      local cutoffTime = tonumber(ARGV[2])
      local maxSessions = tonumber(ARGV[3])
      local sessionHash = ARGV[4]
      local windowSeconds = tonumber(ARGV[5])

      -- 检查是否已存在
      local existingScore = redis.call('ZSCORE', redisKey, sessionHash)
      if existingScore then
        -- 会话已存在，更新时间戳和 TTL
        redis.call('ZADD', redisKey, now, sessionHash)
        redis.call('EXPIRE', redisKey, windowSeconds)
        return {1, 'existing'}
      end

      -- 清理过期会话
      local cleanedCount = redis.call('ZREMRANGEBYSCORE', redisKey, '-inf', cutoffTime)

      -- 统计当前会话数
      local currentCount = redis.call('ZCARD', redisKey)

      -- 检查是否达到上限
      if currentCount >= maxSessions then
        -- 即使达到上限，也刷新 TTL 以保持时间窗口准确性
        redis.call('EXPIRE', redisKey, windowSeconds)
        return {0, currentCount}
      end

      -- 添加新会话并刷新 TTL
      redis.call('ZADD', redisKey, now, sessionHash)
      redis.call('EXPIRE', redisKey, windowSeconds)
      return {1, 'added', currentCount + 1}
    `
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
      error.code = SESSION_CONCURRENCY_ERRORS.INVALID_ACCOUNT_ID
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
    const cutoffTime = now - windowSeconds * 1000

    try {
      // 🔒 使用 Lua 脚本执行原子操作：检查+清理+统计+添加+刷新TTL
      const luaScript = this._getCheckAndAddLuaScript()
      const result = await redis.eval(
        luaScript,
        1,
        redisKey,
        now,
        cutoffTime,
        maxSessions,
        sessionHash,
        windowSeconds
      )

      const [success, action, currentCount] = result

      // 🔍 检查配置是否变化（使用完整哈希）
      // 注意：Lua 脚本已经刷新了 TTL，这里只需要更新缓存
      const configHash = getConfigHash(normalizedConfig)
      const cachedHash = this.accountConfigs.get(accountId)

      if (cachedHash !== configHash) {
        // 配置变化，只更新缓存（TTL 已由 Lua 脚本刷新）
        this.accountConfigs.set(accountId, configHash)
        logger.debug(
          `🔄 [SessionConcurrency] Config updated for ${accountId}: hash=${configHash.substring(0, 16)}...`
        )
      }

      // 处理结果
      if (success === 1) {
        if (action === 'existing') {
          // 会话已存在
          logger.debug(
            `✅ [SessionConcurrency] Existing session refreshed: ${accountId} | ${sessionHash.substring(0, 8)}...`
          )
          return { allowed: true }
        } else if (action === 'added') {
          // 成功添加新会话
          logger.info(
            `➕ [SessionConcurrency] New session added: ${accountId} | ${sessionHash.substring(0, 8)}... | ${currentCount}/${maxSessions} sessions`
          )
          return {
            allowed: true,
            stats: {
              current: currentCount,
              max: maxSessions,
              windowSeconds
            }
          }
        }
      }

      // 达到会话上限（success === 0）
      logger.warn(
        `🚫 [SessionConcurrency] Session limit exceeded for ${accountId}: ${currentCount}/${maxSessions} sessions`
      )

      const error = new Error(
        `Session concurrency limit exceeded: ${currentCount} active sessions, maximum is ${maxSessions} within ${windowSeconds}s window`
      )
      error.code = SESSION_CONCURRENCY_ERRORS.SESSION_LIMIT_EXCEEDED
      error.accountId = accountId
      error.currentSessions = currentCount
      error.maxSessions = maxSessions
      error.windowSeconds = windowSeconds
      error.details = {
        current: currentCount,
        max: maxSessions,
        windowSeconds
      }

      return {
        allowed: false,
        error,
        stats: {
          current: currentCount,
          max: maxSessions,
          windowSeconds
        }
      }
    } catch (error) {
      logger.error(`❌ [SessionConcurrency] Redis error for ${accountId}:`, error)

      // 🔴 Redis 故障时直接抛出异常，阻止继续提供服务
      const redisError = new Error('Session concurrency check failed due to Redis error')
      redisError.code = REDIS_ERRORS.REDIS_ERROR
      redisError.accountId = accountId
      redisError.originalError = error

      throw redisError
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
   * 清理资源（清空缓存）
   * 注意：Redis 连接由全局连接池管理，这里不需要关闭
   */
  async dispose() {
    // 清空配置缓存
    this.accountConfigs.clear()
    logger.info('✅ [SessionConcurrency] Manager disposed (cache cleared)')
  }
}

// 导出单例
module.exports = new SessionConcurrencyManager()
