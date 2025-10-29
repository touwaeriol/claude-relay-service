/**
 * 并发修复集成测试
 * 验证两个修复在完整请求流程中的协同工作：
 * 1. 会话并发 Lua 脚本原子性
 * 2. 摘要验证缓存机制
 */

const IORedis = require('ioredis')
const UnifiedClaudeScheduler = require('../src/services/unifiedClaudeScheduler')
const sessionConcurrencyManager = require('../src/services/sessionConcurrencyManager')
const claudeSessionCoordinator = require('../src/utils/claudeSessionCoordinator')
const redis = require('../src/models/redis')
const messageDigestHelper = require('../src/utils/messageDigest')

// Mock 账户服务
jest.mock('../src/services/claudeAccountService', () => ({
  getAccount: jest.fn(),
  getAllAccounts: jest.fn()
}))

jest.mock('../src/services/claudeConsoleAccountService', () => ({
  getAccount: jest.fn(),
  getAllAccounts: jest.fn()
}))

// Mock logger
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const logger = require('../src/utils/logger')
const claudeAccountService = require('../src/services/claudeAccountService')
const claudeConsoleAccountService = require('../src/services/claudeConsoleAccountService')

describe('Integration Tests - Concurrency Fixes', () => {
  let scheduler
  let testRedis

  beforeAll () => {
    scheduler = new UnifiedClaudeScheduler()
    testRedis = new IORedis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6385', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      db: parseInt(process.env.REDIS_TEST_DB || '15', 10)
    })
  })

  afterAll(async () => {
    if (testRedis) {
      await testRedis.quit()
    }
    await sessionConcurrencyManager.dispose()
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(async () => {
    // 清理测试数据
    try {
      const patterns = [
        'session_concurrency:integration-*',
        'sticky_session:integration-*',
        'exclusive_session_digest:*integration-*'
      ]

      for (const pattern of patterns) {
        const keys = await testRedis.keys(pattern)
        if (keys.length > 0) {
          await testRedis.del(...keys)
        }
      }
    } catch (error) {
      console.error('清理测试数据失败:', error)
    }
  })

  describe('集成场景1: 完整请求流程中摘要验证只执行一次', () => {
    it('应该在一次请求处理中，对同一账户的摘要验证只执行一次', async () => {
      // 设置测试账户
      const testAccount = {
        id: 'integration-account-1',
        accountId: 'integration-account-1',
        name: 'Integration Test Account 1',
        exclusiveSessionOnly: true,
        enableMessageDigest: true,
        status: 'active',
        isActive: true,
        sessionConcurrency: {
          enabled: false
        }
      }

      // Mock 账户服务返回测试账户
      claudeAccountService.getAllAccounts.mockResolvedValue([testAccount])

      // 创建会话上下文
      const sessionHash = 'integration-session-1'
      const requestBody = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello' }]
      }

      const sessionContext = await claudeSessionCoordinator.buildSessionContext(
        sessionHash,
        requestBody
      )

      // 验证 sessionContext 包含缓存字段
      expect(sessionContext.digestValidationCache).toBeDefined()
      expect(sessionContext.digestValidationCache).toEqual({})

      // 模拟在同一请求中多次调用摘要验证（这在实际代码中可能发生）
      const validationPromises = []
      for (let i = 0; i < 5; i++) {
        validationPromises.push(
          scheduler._validateExclusiveAccountDigest(
            testAccount,
            sessionHash,
            requestBody.messages,
            sessionContext.isNewSession,
            sessionContext
          )
        )
      }

      const results = await Promise.all(validationPromises)

      // 所有验证都应该返回成功
      results.forEach((result) => {
        expect(result.valid).toBe(true)
      })

      // 🔍 关键验证：只有第一次执行了真正的验证逻辑
      const digestValidationCalls = logger.info.mock.calls.filter((call) =>
        call[0].includes('Digest validation PASSED')
      )
      expect(digestValidationCalls.length).toBe(1) // 只执行一次

      // 🔍 验证缓存命中了 4 次（2-5次调用）
      const cacheHitCalls = logger.debug.mock.calls.filter((call) =>
        call[0].includes('Using cached digest validation result')
      )
      expect(cacheHitCalls.length).toBe(4)
    })

    it('应该在 _applySessionEligibilityRules 中正确使用缓存', async () => {
      const testAccount1 = {
        id: 'integration-account-2a',
        accountId: 'integration-account-2a',
        name: 'Exclusive Account A',
        exclusiveSessionOnly: true,
        enableMessageDigest: true,
        status: 'active',
        isActive: true
      }

      const testAccount2 = {
        id: 'integration-account-2b',
        accountId: 'integration-account-2b',
        name: 'Exclusive Account B',
        exclusiveSessionOnly: true,
        enableMessageDigest: true,
        status: 'active',
        isActive: true
      }

      const sessionHash = 'integration-session-2'
      const requestBody = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Test message' }]
      }

      const sessionContext = await claudeSessionCoordinator.buildSessionContext(
        sessionHash,
        requestBody
      )

      // 先将会话绑定到账户 A
      await redis.setSessionAccountMapping(sessionHash, testAccount1.id, 7200)

      // 初始化摘要（账户 A）
      await messageDigestHelper.validateAndStoreDigest(
        testAccount1.id,
        sessionHash,
        requestBody.messages,
        { allowCreate: true }
      )

      // 应用会话资格过滤规则（模拟真实调度流程）
      const accounts = [testAccount1, testAccount2]
      const filtered = await scheduler._applySessionEligibilityRules(accounts, sessionContext)

      // 只有账户 A 应该通过过滤（因为会话绑定到 A）
      expect(filtered.length).toBe(1)
      expect(filtered[0].id).toBe(testAccount1.id)

      // 🔍 验证摘要验证被缓存
      expect(sessionContext.digestValidationCache[testAccount1.id]).toBeDefined()
      expect(sessionContext.digestValidationCache[testAccount1.id].valid).toBe(true)

      // 再次调用过滤规则（模拟重试或重复检查）
      jest.clearAllMocks()
      const filtered2 = await scheduler._applySessionEligibilityRules(accounts, sessionContext)

      expect(filtered2.length).toBe(1)

      // 🔍 验证第二次使用了缓存，没有重复执行验证
      const cacheHitCalls = logger.debug.mock.calls.filter((call) =>
        call[0].includes('Using cached digest validation result')
      )
      expect(cacheHitCalls.length).toBeGreaterThan(0)
    })
  })

  describe('集成场景2: 会话并发控制在高并发场景下工作正常', () => {
    it('应该在高并发场景下正确限制会话数量', async () => {
      const accountId = 'integration-account-3'
      const config = {
        enabled: true,
        maxSessions: 10,
        windowSeconds: 3600
      }

      // 模拟 50 个并发请求
      const concurrentRequests = []
      for (let i = 1; i <= 50; i++) {
        concurrentRequests.push(
          sessionConcurrencyManager.checkSessionLimit(accountId, `session-${i}`, config)
        )
      }

      const results = await Promise.all(concurrentRequests)

      // 统计成功和失败
      const allowed = results.filter((r) => r.allowed)
      const rejected = results.filter((r) => !r.allowed)

      expect(allowed.length).toBe(10)
      expect(rejected.length).toBe(40)

      // 验证 Redis 中的数据一致性
      const redisKey = `session_concurrency:${accountId}`
      const count = await testRedis.zcard(redisKey)
      expect(count).toBe(10)
    })

    it('应该在并发场景下正确处理已存在会话和新会话的混合', async () => {
      const accountId = 'integration-account-4'
      const config = {
        enabled: true,
        maxSessions: 10,
        windowSeconds: 3600
      }

      // 先添加 5 个会话
      for (let i = 1; i <= 5; i++) {
        await sessionConcurrencyManager.checkSessionLimit(accountId, `existing-${i}`, config)
      }

      // 并发发送 20 个请求：5个已存在 + 15个新会话
      const concurrentRequests = []

      // 已存在的会话（应该全部成功）
      for (let i = 1; i <= 5; i++) {
        concurrentRequests.push(
          sessionConcurrencyManager.checkSessionLimit(accountId, `existing-${i}`, config)
        )
      }

      // 新会话（只有 5 个能成功）
      for (let i = 1; i <= 15; i++) {
        concurrentRequests.push(
          sessionConcurrencyManager.checkSessionLimit(accountId, `new-session-${i}`, config)
        )
      }

      const results = await Promise.all(concurrentRequests)

      // 前 5 个（已存在）应该全部成功
      results.slice(0, 5).forEach((result) => {
        expect(result.allowed).toBe(true)
      })

      // 后 15 个中只有 5 个成功
      const newSessionResults = results.slice(5)
      const allowedNew = newSessionResults.filter((r) => r.allowed)
      const rejectedNew = newSessionResults.filter((r) => !r.allowed)

      expect(allowedNew.length).toBe(5)
      expect(rejectedNew.length).toBe(10)

      // 最终 Redis 中应该有 10 个会话
      const redisKey = `session_concurrency:${accountId}`
      const count = await testRedis.zcard(redisKey)
      expect(count).toBe(10)
    })
  })

  describe('集成场景3: 两个功能同时启用时互不干扰', () => {
    it('应该在同时启用摘要验证和会话并发控制时正常工作', async () => {
      const testAccount = {
        id: 'integration-account-5',
        accountId: 'integration-account-5',
        name: 'Full Integration Test Account',
        exclusiveSessionOnly: true,
        enableMessageDigest: true,
        status: 'active',
        isActive: true,
        sessionConcurrency: {
          enabled: true,
          maxSessions: 5,
          windowSeconds: 3600
        }
      }

      claudeAccountService.getAllAccounts.mockResolvedValue([testAccount])

      // 创建 3 个不同的会话
      const sessionHashes = ['integration-session-5a', 'integration-session-5b', 'integration-session-5c']

      const results = []

      for (const sessionHash of sessionHashes) {
        const requestBody = {
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: `Hello from ${sessionHash}` }]
        }

        // 构建会话上下文
        const sessionContext = await claudeSessionCoordinator.buildSessionContext(
          sessionHash,
          requestBody
        )

        // 检查会话并发限制
        const concurrencyResult = await sessionConcurrencyManager.checkSessionLimit(
          testAccount.id,
          sessionHash,
          testAccount.sessionConcurrency
        )

        // 如果并发检查通过，执行摘要验证
        let digestResult
        if (concurrencyResult.allowed) {
          digestResult = await scheduler._validateExclusiveAccountDigest(
            testAccount,
            sessionHash,
            requestBody.messages,
            sessionContext.isNewSession,
            sessionContext
          )

          // 注册会话
          if (digestResult.valid) {
            await claudeSessionCoordinator.registerSessionForAccount(
              {
                accountId: testAccount.id,
                accountType: 'claude-official',
                account: testAccount
              },
              sessionContext
            )
          }
        }

        results.push({
          sessionHash,
          concurrencyAllowed: concurrencyResult.allowed,
          digestValid: digestResult?.valid || false
        })
      }

      // 验证所有 3 个会话都成功
      results.forEach((result) => {
        expect(result.concurrencyAllowed).toBe(true)
        expect(result.digestValid).toBe(true)
      })

      // 验证并发计数
      const concurrencyStats = await sessionConcurrencyManager.getAccountStats(testAccount.id)
      expect(concurrencyStats.current).toBe(3)

      // 验证每个会话都有粘性绑定
      for (const sessionHash of sessionHashes) {
        const boundAccountId = await redis.getSessionAccountMapping(sessionHash)
        expect(boundAccountId).toBe(testAccount.id)
      }

      // 验证每个会话都有摘要
      for (const sessionHash of sessionHashes) {
        const digestKey = messageDigestHelper.getDigestRedisKey(testAccount.id, sessionHash)
        const digestExists = await testRedis.exists(digestKey)
        expect(digestExists).toBe(1)
      }
    })

    it('应该在达到并发上限时拒绝，但不影响摘要验证缓存', async () => {
      const testAccount = {
        id: 'integration-account-6',
        accountId: 'integration-account-6',
        name: 'Concurrency Limit Test',
        exclusiveSessionOnly: true,
        enableMessageDigest: true,
        status: 'active',
        isActive: true,
        sessionConcurrency: {
          enabled: true,
          maxSessions: 2,
          windowSeconds: 3600
        }
      }

      // 先创建 2 个会话（达到上限）
      for (let i = 1; i <= 2; i++) {
        const sessionHash = `integration-session-6-${i}`
        const requestBody = {
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: `Message ${i}` }]
        }

        const sessionContext = await claudeSessionCoordinator.buildSessionContext(
          sessionHash,
          requestBody
        )

        const concurrencyResult = await sessionConcurrencyManager.checkSessionLimit(
          testAccount.id,
          sessionHash,
          testAccount.sessionConcurrency
        )

        expect(concurrencyResult.allowed).toBe(true)

        await scheduler._validateExclusiveAccountDigest(
          testAccount,
          sessionHash,
          requestBody.messages,
          sessionContext.isNewSession,
          sessionContext
        )

        await claudeSessionCoordinator.registerSessionForAccount(
          {
            accountId: testAccount.id,
            accountType: 'claude-official',
            account: testAccount
          },
          sessionContext
        )
      }

      // 尝试创建第 3 个会话（应该被并发限制拒绝）
      const sessionHash3 = 'integration-session-6-3'
      const requestBody3 = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Message 3' }]
      }

      const sessionContext3 = await claudeSessionCoordinator.buildSessionContext(
        sessionHash3,
        requestBody3
      )

      const concurrencyResult3 = await sessionConcurrencyManager.checkSessionLimit(
        testAccount.id,
        sessionHash3,
        testAccount.sessionConcurrency
      )

      // 应该被并发限制拒绝
      expect(concurrencyResult3.allowed).toBe(false)
      expect(concurrencyResult3.error.code).toBe('SESSION_LIMIT_EXCEEDED')

      // 但摘要验证缓存应该仍然可用（如果执行的话）
      expect(sessionContext3.digestValidationCache).toBeDefined()
      expect(sessionContext3.digestValidationCache).toEqual({})

      // 验证已存在的会话仍然可以更新
      const sessionHash1 = 'integration-session-6-1'
      const requestBody1Update = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [
          { role: 'user', content: 'Message 1' },
          { role: 'assistant', content: 'Response 1' },
          { role: 'user', content: 'Follow-up' }
        ]
      }

      const sessionContext1 = await claudeSessionCoordinator.buildSessionContext(
        sessionHash1,
        requestBody1Update
      )

      const concurrencyResult1 = await sessionConcurrencyManager.checkSessionLimit(
        testAccount.id,
        sessionHash1,
        testAccount.sessionConcurrency
      )

      // 已存在的会话应该可以更新
      expect(concurrencyResult1.allowed).toBe(true)

      // 摘要验证也应该通过
      const digestResult1 = await scheduler._validateExclusiveAccountDigest(
        testAccount,
        sessionHash1,
        requestBody1Update.messages,
        false, // 不是新会话
        sessionContext1
      )

      expect(digestResult1.valid).toBe(true)
    })
  })

  describe('性能改进验证', () => {
    it('应该通过缓存显著减少 Redis 查询次数', async () => {
      const testAccount = {
        id: 'integration-account-7',
        accountId: 'integration-account-7',
        name: 'Performance Test',
        exclusiveSessionOnly: true,
        enableMessageDigest: true,
        status: 'active',
        isActive: true
      }

      const sessionHash = 'integration-session-7'
      const requestBody = {
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Performance test' }]
      }

      const sessionContext = await claudeSessionCoordinator.buildSessionContext(
        sessionHash,
        requestBody
      )

      // 记录初始的 Redis 命令计数（如果可用）
      // 注：真实场景可能需要 Redis MONITOR 或其他方式

      // 第一次验证
      await scheduler._validateExclusiveAccountDigest(
        testAccount,
        sessionHash,
        requestBody.messages,
        sessionContext.isNewSession,
        sessionContext
      )

      // 后续 10 次验证（应该使用缓存，不查询 Redis）
      const validationPromises = []
      for (let i = 0; i < 10; i++) {
        validationPromises.push(
          scheduler._validateExclusiveAccountDigest(
            testAccount,
            sessionHash,
            requestBody.messages,
            sessionContext.isNewSession,
            sessionContext
          )
        )
      }

      await Promise.all(validationPromises)

      // 验证缓存命中
      const cacheHitCalls = logger.debug.mock.calls.filter((call) =>
        call[0].includes('Using cached digest validation result')
      )

      expect(cacheHitCalls.length).toBe(10)

      console.log(`✅ 缓存有效避免了 ${cacheHitCalls.length} 次重复的摘要验证操作`)
    })
  })
})
