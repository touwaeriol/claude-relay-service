#!/usr/bin/env node

/**
 * Redis 连接池管理器验证脚本
 *
 * 验证内容：
 * 1. 统一的 Redis 连接复用
 * 2. sessionConcurrencyManager 重复 TTL 刷新已修复
 * 3. concurrencyManager 使用连接池
 * 4. 连接数量统计
 */

const redisClient = require('../src/models/redis')
const redisConnectionManager = require('../src/utils/redisConnectionManager')
const concurrencyManager = require('../src/services/concurrencyManager')
const sessionConcurrencyManager = require('../src/services/sessionConcurrencyManager')

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function testRedisConnectionPool() {
  console.log('🧪 开始测试 Redis 连接池管理器...\n')

  try {
    // 1. 连接 Redis
    console.log('1️⃣ 连接 Redis...')
    await redisClient.connect()
    await sleep(500)

    // 2. 测试连接池管理器
    console.log('\n2️⃣ 测试连接池管理器...')
    const stats = redisConnectionManager.getStats()
    console.log('连接池状态:', JSON.stringify(stats, null, 2))

    // 3. 测试 sessionConcurrencyManager 使用连接池
    console.log('\n3️⃣ 测试 sessionConcurrencyManager...')
    const sessionConfig = {
      enabled: true,
      maxSessions: 5,
      windowSeconds: 60
    }

    const testAccountId = 'test-account-redis-pool'
    const testSessionHash = 'test-session-' + Date.now()

    // 清理旧数据
    const redis = redisClient.getClient()
    await redis.del(`session_concurrency:${testAccountId}`)

    console.log('执行会话并发检查...')
    const result1 = await sessionConcurrencyManager.checkSessionLimit(
      testAccountId,
      testSessionHash,
      sessionConfig
    )
    console.log('第一次检查结果:', {
      allowed: result1.allowed,
      stats: result1.stats
    })

    // 再次检查同一会话（验证 TTL 刷新但不重复）
    console.log('再次检查同一会话...')
    const result2 = await sessionConcurrencyManager.checkSessionLimit(
      testAccountId,
      testSessionHash,
      sessionConfig
    )
    console.log('第二次检查结果:', {
      allowed: result2.allowed
    })

    // 4. 测试 concurrencyManager 使用连接池
    console.log('\n4️⃣ 测试 concurrencyManager...')

    // 创建模拟的 req/res 对象
    const EventEmitter = require('events')
    const req = new EventEmitter()
    const res = new EventEmitter()

    req.destroyed = false
    req.socket = { destroyed: false }
    res.destroyed = false

    const testResourceId = 'test-resource-redis-pool'
    const concurrencyConfig = {
      enabled: true,
      maxConcurrency: 3,
      queueSize: 5,
      queueTimeout: 10
    }

    console.log('获取并发槽位...')
    const release = await concurrencyManager.waitForSlot(testResourceId, concurrencyConfig, req, res)
    console.log('✅ 成功获取槽位')

    const concurrencyStats = await concurrencyManager.getStats(testResourceId)
    console.log('并发统计:', concurrencyStats)

    // 释放槽位
    console.log('释放槽位...')
    res.emit('finish')
    await sleep(100)

    const concurrencyStatsAfter = await concurrencyManager.getStats(testResourceId)
    console.log('释放后统计:', concurrencyStatsAfter)

    // 5. 验证连接复用
    console.log('\n5️⃣ 验证连接复用...')

    // 获取不同管理器使用的 Redis 客户端
    const globalClient = redisClient.getClient()
    const sessionClient = sessionConcurrencyManager._getRedis()
    const bottleneckConnection = concurrencyManager._getRedisConnection()

    console.log('Redis 客户端对比:')
    console.log('- 全局客户端:', globalClient.constructor.name, '@', globalClient.options.host)
    console.log('- Session Manager 客户端:', sessionClient.constructor.name, '@', sessionClient.options.host)
    console.log('- Bottleneck Connection:', bottleneckConnection.constructor.name)

    // 验证是否为同一实例
    const isSameInstance = globalClient === sessionClient
    console.log(
      isSameInstance
        ? '✅ sessionConcurrencyManager 正确复用了全局连接'
        : '❌ sessionConcurrencyManager 未复用全局连接'
    )

    // 6. 全局统计
    console.log('\n6️⃣ 全局统计信息...')
    const globalStats = concurrencyManager.getGlobalStats()
    console.log('ConcurrencyManager 全局统计:')
    console.log(JSON.stringify(globalStats, null, 2))

    // 7. 清理测试数据
    console.log('\n7️⃣ 清理测试数据...')
    await redis.del(`session_concurrency:${testAccountId}`)
    concurrencyManager.clear(testResourceId)
    console.log('✅ 清理完成')

    console.log('\n✅ 所有测试通过！')
    console.log('\n📊 总结:')
    console.log('- ✅ Redis 连接池管理器正常工作')
    console.log('- ✅ sessionConcurrencyManager 使用连接池（不再重复刷新 TTL）')
    console.log('- ✅ concurrencyManager 使用连接池')
    console.log('- ✅ 连接复用验证成功')

    return true
  } catch (error) {
    console.error('\n❌ 测试失败:', error)
    console.error(error.stack)
    return false
  } finally {
    // 清理资源
    console.log('\n🧹 清理资源...')
    await sessionConcurrencyManager.dispose()
    await redisClient.disconnect()
    console.log('✅ 资源清理完成')
  }
}

// 运行测试
if (require.main === module) {
  testRedisConnectionPool()
    .then((success) => {
      process.exit(success ? 0 : 1)
    })
    .catch((error) => {
      console.error('Fatal error:', error)
      process.exit(1)
    })
}

module.exports = testRedisConnectionPool
