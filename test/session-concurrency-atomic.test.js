/**
 * 会话并发 Lua 脚本原子性测试
 * 验证修复：使用 Redis Lua 脚本实现原子操作，解决竞态条件
 */

const IORedis = require('ioredis')
const sessionConcurrencyManager = require('../src/services/sessionConcurrencyManager')

describe('Session Concurrency - Lua Script Atomicity Tests', () => {
  let redis

  beforeAll(() => {
    // 使用真实的 Redis 连接进行测试
    redis = new IORedis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6385', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      db: parseInt(process.env.REDIS_TEST_DB || '15', 10)
    })
  })

  afterAll(async () => {
    if (redis) {
      await redis.quit()
    }
    // 清理 sessionConcurrencyManager 的 Redis 连接
    await sessionConcurrencyManager.dispose()
  })

  beforeEach(async () => {
    // 清理测试数据
    const keys = await redis.keys('session_concurrency:test-*')
    if (keys.length > 0) {
      await redis.del(...keys)
    }
  })

  describe('场景1: 新会话添加成功', () => {
    it('应该成功添加新会话并返回正确的状态', async () => {
      const accountId = 'test-account-1'
      const sessionHash = 'session-hash-1'
      const config = {
        enabled: true,
        maxSessions: 5,
        windowSeconds: 3600
      }

      const result = await sessionConcurrencyManager.checkSessionLimit(
        accountId,
        sessionHash,
        config
      )

      expect(result.allowed).toBe(true)
      expect(result.stats).toBeDefined()
      expect(result.stats.current).toBe(1)
      expect(result.stats.max).toBe(5)

      // 验证 Redis 中的数据
      const redisKey = `session_concurrency:${accountId}`
      const count = await redis.zcard(redisKey)
      expect(count).toBe(1)

      const members = await redis.zrange(redisKey, 0, -1)
      expect(members).toContain(sessionHash)
    })
  })

  describe('场景2: 已存在会话更新时间戳', () => {
    it('应该更新已存在会话的时间戳而不增加计数', async () => {
      const accountId = 'test-account-2'
      const sessionHash = 'session-hash-2'
      const config = {
        enabled: true,
        maxSessions: 5,
        windowSeconds: 3600
      }

      // 第一次添加
      const result1 = await sessionConcurrencyManager.checkSessionLimit(
        accountId,
        sessionHash,
        config
      )
      expect(result1.allowed).toBe(true)
      expect(result1.stats.current).toBe(1)

      const redisKey = `session_concurrency:${accountId}`
      const score1 = await redis.zscore(redisKey, sessionHash)

      // 等待 10ms 确保时间戳不同
      await new Promise((resolve) => setTimeout(resolve, 10))

      // 第二次调用（同一会话）
      const result2 = await sessionConcurrencyManager.checkSessionLimit(
        accountId,
        sessionHash,
        config
      )
      expect(result2.allowed).toBe(true)

      // 验证会话数量没有增加
      const count = await redis.zcard(redisKey)
      expect(count).toBe(1)

      // 验证时间戳已更新
      const score2 = await redis.zscore(redisKey, sessionHash)
      expect(parseFloat(score2)).toBeGreaterThan(parseFloat(score1))
    })
  })

  describe('场景3: 达到上限时拒绝新会话', () => {
    it('应该在达到 maxSessions 上限时拒绝新会话', async () => {
      const accountId = 'test-account-3'
      const config = {
        enabled: true,
        maxSessions: 3,
        windowSeconds: 3600
      }

      // 添加 3 个不同的会话（达到上限）
      for (let i = 1; i <= 3; i++) {
        const result = await sessionConcurrencyManager.checkSessionLimit(
          accountId,
          `session-hash-${i}`,
          config
        )
        expect(result.allowed).toBe(true)
      }

      // 尝试添加第 4 个会话（应该被拒绝）
      const result = await sessionConcurrencyManager.checkSessionLimit(
        accountId,
        'session-hash-4',
        config
      )

      expect(result.allowed).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error.code).toBe('SESSION_LIMIT_EXCEEDED')
      expect(result.stats).toBeDefined()
      expect(result.stats.current).toBe(3)
      expect(result.stats.max).toBe(3)

      // 验证 Redis 中只有 3 个会话
      const redisKey = `session_concurrency:${accountId}`
      const count = await redis.zcard(redisKey)
      expect(count).toBe(3)
    })
  })

  describe('场景4: 过期会话自动清理', () => {
    it('应该自动清理过期的会话', async () => {
      const accountId = 'test-account-4'
      const config = {
        enabled: true,
        maxSessions: 3,
        windowSeconds: 1 // 1 秒窗口，方便测试
      }

      // 添加 2 个会话
      await sessionConcurrencyManager.checkSessionLimit(accountId, 'session-1', config)
      await sessionConcurrencyManager.checkSessionLimit(accountId, 'session-2', config)

      const redisKey = `session_concurrency:${accountId}`
      let count = await redis.zcard(redisKey)
      expect(count).toBe(2)

      // 等待 1.5 秒，让会话过期（留出更多余量）
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // 添加新会话，应该触发清理
      const result = await sessionConcurrencyManager.checkSessionLimit(
        accountId,
        'session-3',
        config
      )

      expect(result.allowed).toBe(true)
      expect(result.stats.current).toBe(1) // 只有新会话，旧会话已被清理

      // 验证 Redis 中只有新会话
      count = await redis.zcard(redisKey)
      expect(count).toBe(1)

      const members = await redis.zrange(redisKey, 0, -1)
      expect(members).toContain('session-3')
      expect(members).not.toContain('session-1')
      expect(members).not.toContain('session-2')
    })
  })

  describe('场景5: 并发添加会话 - 原子性测试（核心）', () => {
    it('应该在高并发情况下正确限制会话数量，不超过 maxSessions', async () => {
      const accountId = 'test-account-5'
      const config = {
        enabled: true,
        maxSessions: 5,
        windowSeconds: 3600
      }

      // 模拟 20 个并发请求，尝试添加不同的会话
      const concurrentRequests = []
      for (let i = 1; i <= 20; i++) {
        concurrentRequests.push(
          sessionConcurrencyManager.checkSessionLimit(accountId, `session-${i}`, config)
        )
      }

      const results = await Promise.all(concurrentRequests)

      // 统计成功和失败的请求
      const allowed = results.filter((r) => r.allowed)
      const rejected = results.filter((r) => !r.allowed)

      expect(allowed.length).toBe(5) // 只有 5 个成功
      expect(rejected.length).toBe(15) // 15 个被拒绝

      // 验证 Redis 中确实只有 5 个会话
      const redisKey = `session_concurrency:${accountId}`
      const count = await redis.zcard(redisKey)
      expect(count).toBe(5)

      // 验证所有被拒绝的请求都返回了正确的错误
      rejected.forEach((result) => {
        expect(result.error).toBeDefined()
        expect(result.error.code).toBe('SESSION_LIMIT_EXCEEDED')
        expect(result.stats).toBeDefined()
        expect(result.stats.current).toBeGreaterThanOrEqual(5)
      })
    })

    it('应该正确处理并发更新同一会话的情况', async () => {
      const accountId = 'test-account-6'
      const sessionHash = 'same-session'
      const config = {
        enabled: true,
        maxSessions: 5,
        windowSeconds: 3600
      }

      // 10 个并发请求，都是同一个会话
      const concurrentRequests = []
      for (let i = 0; i < 10; i++) {
        concurrentRequests.push(
          sessionConcurrencyManager.checkSessionLimit(accountId, sessionHash, config)
        )
      }

      const results = await Promise.all(concurrentRequests)

      // 所有请求都应该成功
      results.forEach((result) => {
        expect(result.allowed).toBe(true)
      })

      // Redis 中应该只有 1 个会话
      const redisKey = `session_concurrency:${accountId}`
      const count = await redis.zcard(redisKey)
      expect(count).toBe(1)
    })

    it('应该在并发场景下正确处理已存在和新会话的混合情况', async () => {
      const accountId = 'test-account-7'
      const config = {
        enabled: true,
        maxSessions: 5,
        windowSeconds: 3600
      }

      // 先添加 2 个会话
      await sessionConcurrencyManager.checkSessionLimit(accountId, 'existing-1', config)
      await sessionConcurrencyManager.checkSessionLimit(accountId, 'existing-2', config)

      // 现在并发发送：2个已存在会话的更新 + 8个新会话的添加
      const concurrentRequests = [
        // 已存在的会话（应该成功更新）
        sessionConcurrencyManager.checkSessionLimit(accountId, 'existing-1', config),
        sessionConcurrencyManager.checkSessionLimit(accountId, 'existing-2', config),
        // 新会话（只有3个能成功，因为已经有2个了，maxSessions=5）
        ...Array.from({ length: 8 }, (_, i) =>
          sessionConcurrencyManager.checkSessionLimit(accountId, `new-session-${i}`, config)
        )
      ]

      const results = await Promise.all(concurrentRequests)

      // 前 2 个（已存在的）应该都成功
      expect(results[0].allowed).toBe(true)
      expect(results[1].allowed).toBe(true)

      // 剩余的请求中，只有 3 个新会话能成功（因为 maxSessions=5）
      const newSessionResults = results.slice(2)
      const allowedNew = newSessionResults.filter((r) => r.allowed)
      const rejectedNew = newSessionResults.filter((r) => !r.allowed)

      expect(allowedNew.length).toBe(3)
      expect(rejectedNew.length).toBe(5)

      // 最终 Redis 中应该有 5 个会话
      const redisKey = `session_concurrency:${accountId}`
      const count = await redis.zcard(redisKey)
      expect(count).toBe(5)
    })
  })

  describe('Lua 脚本返回值验证', () => {
    it('应该返回正确的 Lua 脚本执行结果格式', async () => {
      const accountId = 'test-account-8'
      const config = {
        enabled: true,
        maxSessions: 3,
        windowSeconds: 3600
      }

      // 测试新会话添加
      const result1 = await sessionConcurrencyManager.checkSessionLimit(
        accountId,
        'session-1',
        config
      )
      expect(result1.allowed).toBe(true)
      expect(result1.stats.current).toBe(1)

      // 测试已存在会话更新
      const result2 = await sessionConcurrencyManager.checkSessionLimit(
        accountId,
        'session-1',
        config
      )
      expect(result2.allowed).toBe(true)
      // 已存在会话不返回 stats

      // 添加更多会话直到达到上限
      await sessionConcurrencyManager.checkSessionLimit(accountId, 'session-2', config)
      await sessionConcurrencyManager.checkSessionLimit(accountId, 'session-3', config)

      // 测试达到上限
      const result3 = await sessionConcurrencyManager.checkSessionLimit(
        accountId,
        'session-4',
        config
      )
      expect(result3.allowed).toBe(false)
      expect(result3.error).toBeDefined()
      expect(result3.stats).toBeDefined()
      expect(result3.stats.current).toBe(3)
    })
  })

  describe('配置变更和 TTL 更新', () => {
    it('应该在配置变更时更新 Redis TTL', async () => {
      const accountId = 'test-account-9'
      const config1 = {
        enabled: true,
        maxSessions: 5,
        windowSeconds: 60 // 60秒
      }

      await sessionConcurrencyManager.checkSessionLimit(accountId, 'session-1', config1)

      const redisKey = `session_concurrency:${accountId}`
      const ttl1 = await redis.ttl(redisKey)
      expect(ttl1).toBeGreaterThan(0)
      expect(ttl1).toBeLessThanOrEqual(60)

      // 使用不同的 windowSeconds
      const config2 = {
        enabled: true,
        maxSessions: 5,
        windowSeconds: 120 // 120秒
      }

      await sessionConcurrencyManager.checkSessionLimit(accountId, 'session-2', config2)

      const ttl2 = await redis.ttl(redisKey)
      expect(ttl2).toBeGreaterThan(60) // 应该更新为新的 TTL
      expect(ttl2).toBeLessThanOrEqual(120)
    })
  })

  describe('边界情况测试', () => {
    it('应该正确处理 maxSessions=1 的情况', async () => {
      const accountId = 'test-account-10'
      const config = {
        enabled: true,
        maxSessions: 1,
        windowSeconds: 3600
      }

      const result1 = await sessionConcurrencyManager.checkSessionLimit(
        accountId,
        'session-1',
        config
      )
      expect(result1.allowed).toBe(true)

      const result2 = await sessionConcurrencyManager.checkSessionLimit(
        accountId,
        'session-2',
        config
      )
      expect(result2.allowed).toBe(false)
    })

    it('应该在 enabled=false 时跳过检查', async () => {
      const accountId = 'test-account-11'
      const config = {
        enabled: false,
        maxSessions: 1,
        windowSeconds: 3600
      }

      // 即使 maxSessions=1，也应该允许多个会话
      const result1 = await sessionConcurrencyManager.checkSessionLimit(
        accountId,
        'session-1',
        config
      )
      const result2 = await sessionConcurrencyManager.checkSessionLimit(
        accountId,
        'session-2',
        config
      )

      expect(result1.allowed).toBe(true)
      expect(result2.allowed).toBe(true)
    })

    it('应该在 sessionHash 为空时跳过检查', async () => {
      const accountId = 'test-account-12'
      const config = {
        enabled: true,
        maxSessions: 1,
        windowSeconds: 3600
      }

      const result = await sessionConcurrencyManager.checkSessionLimit(
        accountId,
        null, // 无会话 hash
        config
      )
      expect(result.allowed).toBe(true)
    })
  })
})
