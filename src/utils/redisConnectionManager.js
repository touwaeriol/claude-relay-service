const Bottleneck = require('bottleneck')
const logger = require('./logger')
const redisClient = require('../models/redis')

/**
 * 统一的 Redis 连接池管理器
 *
 * 职责：
 * - 管理全局共享的 Redis 连接
 * - 为 Bottleneck 提供 IORedisConnection
 * - 避免创建多个 Redis 连接实例
 * - 统一连接生命周期管理
 *
 * 使用场景：
 * - concurrencyManager: 需要 Bottleneck IORedisConnection
 * - sessionConcurrencyManager: 需要普通 IORedis 客户端
 * - 其他服务: 通过 redis.js 统一访问
 */
class RedisConnectionManager {
  constructor() {
    /**
     * Bottleneck IORedisConnection 单例
     * 用于分布式并发控制
     */
    this._bottleneckConnection = null

    /**
     * 初始化状态
     */
    this._initialized = false
  }

  /**
   * 获取普通的 IORedis 客户端（复用全局 redis.js 客户端）
   *
   * @returns {import('ioredis').Redis} Redis 客户端实例
   * @throws {Error} 如果 Redis 未连接
   */
  getRedisClient() {
    const client = redisClient.getClient()
    if (!client) {
      throw new Error('Redis client is not connected. Call redisClient.connect() first.')
    }
    return client
  }

  /**
   * 获取安全的 IORedis 客户端（用于关键操作）
   * 与 getRedisClient() 的区别：总是抛出异常而不是返回 null
   *
   * @returns {import('ioredis').Redis} Redis 客户端实例
   * @throws {Error} 如果 Redis 未连接
   */
  getRedisClientSafe() {
    return redisClient.getClientSafe()
  }

  /**
   * 获取 Bottleneck IORedisConnection（单例模式）
   *
   * 特点：
   * - 复用全局 Redis 客户端
   * - 懒加载：首次调用时创建
   * - 全局共享：避免创建多个 Redis 连接
   *
   * @returns {import('bottleneck').IORedisConnection} Bottleneck Redis 连接
   * @throws {Error} 如果 Redis 未连接
   */
  getBottleneckConnection() {
    // 确保全局 Redis 客户端已连接
    const client = this.getRedisClient()

    // 懒加载：首次调用时创建
    if (!this._bottleneckConnection) {
      const { IORedisConnection } = Bottleneck

      this._bottleneckConnection = new IORedisConnection({
        client, // 复用全局 Redis 客户端
        Promise
      })

      logger.info('✅ Created Bottleneck IORedisConnection (reusing global Redis client)')
    }

    return this._bottleneckConnection
  }

  /**
   * 检查 Redis 连接状态
   *
   * @returns {boolean} 是否已连接
   */
  isConnected() {
    return redisClient.isConnected
  }

  /**
   * 断开所有连接（用于优雅关闭）
   *
   * 注意：
   * - Bottleneck IORedisConnection 会自动断开复用的客户端
   * - 实际的 Redis 连接由 redis.js 管理
   */
  async disconnect() {
    if (this._bottleneckConnection) {
      try {
        // Bottleneck connection 的 disconnect 会断开共享的 Redis 客户端
        // 所以这里只是清理引用，不实际调用 disconnect
        this._bottleneckConnection = null
        logger.info('🔌 Cleared Bottleneck IORedisConnection reference')
      } catch (error) {
        logger.error('❌ Error clearing Bottleneck connection:', error)
      }
    }

    // 实际的 Redis 断开由 redis.js 的 disconnect() 方法处理
    // 这里不需要调用 redisClient.disconnect()
    logger.info('✅ RedisConnectionManager cleanup completed')
  }

  /**
   * 获取连接统计信息
   *
   * @returns {object} 连接统计
   */
  getStats() {
    return {
      isConnected: this.isConnected(),
      hasBottleneckConnection: !!this._bottleneckConnection,
      redisClientInfo: {
        host: redisClient.client?.options?.host || 'unknown',
        port: redisClient.client?.options?.port || 'unknown',
        db: redisClient.client?.options?.db || 0
      }
    }
  }
}

// 导出单例
module.exports = new RedisConnectionManager()
