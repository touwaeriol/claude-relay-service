/**
 * 摘要验证缓存测试
 * 验证修复：在 sessionContext 中添加缓存，避免重复验证
 */

const UnifiedClaudeScheduler = require('../src/services/unifiedClaudeScheduler')
const redis = require('../src/models/redis')
const messageDigestHelper = require('../src/utils/messageDigest')

// Mock logger to reduce test output noise
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const logger = require('../src/utils/logger')

describe('Digest Validation Cache Tests', () => {
  let scheduler

  beforeAll(() => {
    scheduler = new UnifiedClaudeScheduler()
  })

  beforeEach(() => {
    // 清除所有 mock 调用记录
    jest.clearAllMocks()
  })

  afterEach(async () => {
    // 清理测试数据
    try {
      const keys = await redis.getClient().keys('sticky_session:test-*')
      if (keys.length > 0) {
        await redis.getClient().del(...keys)
      }
      const digestKeys = await redis.getClient().keys('exclusive_session_digest:*')
      if (digestKeys.length > 0) {
        await redis.getClient().del(...digestKeys)
      }
    } catch (error) {
      console.error('清理测试数据失败:', error)
    }
  })

  describe('场景1: 首次验证 - 执行验证逻辑并缓存结果', () => {
    it('应该在首次验证时执行验证逻辑，并将结果存入缓存', async () => {
      const account = {
        id: 'test-account-1',
        accountId: 'test-account-1',
        name: 'Test Account',
        exclusiveSessionOnly: true,
        enableMessageDigest: true
      }

      const sessionHash = 'test-session-hash-1'
      const messages = [{ role: 'user', content: 'Hello' }]
      const isNewSession = true

      // 创建带有缓存字段的 sessionContext
      const sessionContext = {
        sessionHash,
        isNewSession,
        requestBody: { messages },
        digestValidationCache: {} // 空缓存
      }

      // 执行验证
      const result = await scheduler._validateExclusiveAccountDigest(
        account,
        sessionHash,
        messages,
        isNewSession,
        sessionContext
      )

      // 验证结果
      expect(result.valid).toBe(true)

      // 验证缓存已被填充
      expect(sessionContext.digestValidationCache[account.id]).toBeDefined()
      expect(sessionContext.digestValidationCache[account.id].valid).toBe(true)

      // 验证调用了验证逻辑（通过检查 logger 调用）
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Digest validation PASSED')
      )
    })

    it('应该在验证失败时也缓存失败结果', async () => {
      const account = {
        id: 'test-account-2',
        accountId: 'test-account-2',
        name: 'Test Account',
        exclusiveSessionOnly: true,
        enableMessageDigest: true
      }

      const sessionHash = 'test-session-hash-2'
      const isNewSession = false // 老会话

      // 先创建一个初始摘要
      const initialMessages = [{ role: 'user', content: 'Hello' }]
      await messageDigestHelper.validateAndStoreDigest(account.id, sessionHash, initialMessages, {
        allowCreate: true
      })

      // 创建不匹配的消息（应该验证失败）
      const modifiedMessages = [{ role: 'user', content: 'Different message' }]

      const sessionContext = {
        sessionHash,
        isNewSession,
        requestBody: { messages: modifiedMessages },
        digestValidationCache: {}
      }

      // 执行验证（应该失败）
      const result = await scheduler._validateExclusiveAccountDigest(
        account,
        sessionHash,
        modifiedMessages,
        isNewSession,
        sessionContext
      )

      // 验证结果
      expect(result.valid).toBe(false)
      expect(result.shouldClearBinding).toBe(true)

      // 验证失败结果也被缓存
      expect(sessionContext.digestValidationCache[account.id]).toBeDefined()
      expect(sessionContext.digestValidationCache[account.id].valid).toBe(false)

      // 验证调用了失败日志
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Exclusive account Test Account digest validation failed')
      )
    })
  })

  describe('场景2: 后续验证使用缓存 - 不重复执行', () => {
    it('应该在第二次验证同一账户时使用缓存，不重复执行验证', async () => {
      const account = {
        id: 'test-account-3',
        accountId: 'test-account-3',
        name: 'Test Account',
        exclusiveSessionOnly: true,
        enableMessageDigest: true
      }

      const sessionHash = 'test-session-hash-3'
      const messages = [{ role: 'user', content: 'Hello' }]
      const isNewSession = true

      const sessionContext = {
        sessionHash,
        isNewSession,
        requestBody: { messages },
        digestValidationCache: {}
      }

      // 第一次验证
      const result1 = await scheduler._validateExclusiveAccountDigest(
        account,
        sessionHash,
        messages,
        isNewSession,
        sessionContext
      )

      expect(result1.valid).toBe(true)

      // 清除 logger 调用记录
      jest.clearAllMocks()

      // 第二次验证同一账户
      const result2 = await scheduler._validateExclusiveAccountDigest(
        account,
        sessionHash,
        messages,
        isNewSession,
        sessionContext
      )

      // 验证返回了相同的结果
      expect(result2.valid).toBe(true)

      // 🔍 关键验证：应该有缓存命中的日志
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Using cached digest validation result')
      )
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('PASS'))

      // 🔍 关键验证：不应该再次执行验证逻辑
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('Digest validation PASSED')
      )
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Digest validation FAILED')
      )
    })

    it('应该在缓存失败结果后，第二次验证直接返回失败', async () => {
      const account = {
        id: 'test-account-4',
        accountId: 'test-account-4',
        name: 'Test Account',
        exclusiveSessionOnly: true,
        enableMessageDigest: true
      }

      const sessionHash = 'test-session-hash-4'
      const isNewSession = false

      // 创建初始摘要
      const initialMessages = [{ role: 'user', content: 'Original' }]
      await messageDigestHelper.validateAndStoreDigest(account.id, sessionHash, initialMessages, {
        allowCreate: true
      })

      // 不匹配的消息
      const modifiedMessages = [{ role: 'user', content: 'Modified' }]

      const sessionContext = {
        sessionHash,
        isNewSession,
        requestBody: { messages: modifiedMessages },
        digestValidationCache: {}
      }

      // 第一次验证（失败）
      const result1 = await scheduler._validateExclusiveAccountDigest(
        account,
        sessionHash,
        modifiedMessages,
        isNewSession,
        sessionContext
      )

      expect(result1.valid).toBe(false)

      // 清除日志记录
      jest.clearAllMocks()

      // 第二次验证同一账户
      const result2 = await scheduler._validateExclusiveAccountDigest(
        account,
        sessionHash,
        modifiedMessages,
        isNewSession,
        sessionContext
      )

      // 验证返回了缓存的失败结果
      expect(result2.valid).toBe(false)

      // 🔍 验证使用了缓存
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Using cached digest validation result')
      )
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('FAIL'))

      // 🔍 不应该重复清理绑定
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('digest validation failed, clearing binding')
      )
    })
  })

  describe('场景3: 不同账户的验证结果独立缓存', () => {
    it('应该为每个账户独立缓存验证结果', async () => {
      const account1 = {
        id: 'test-account-5a',
        accountId: 'test-account-5a',
        name: 'Account A',
        exclusiveSessionOnly: true,
        enableMessageDigest: true
      }

      const account2 = {
        id: 'test-account-5b',
        accountId: 'test-account-5b',
        name: 'Account B',
        exclusiveSessionOnly: true,
        enableMessageDigest: true
      }

      const sessionHash = 'test-session-hash-5'
      const messages = [{ role: 'user', content: 'Hello' }]
      const isNewSession = true

      const sessionContext = {
        sessionHash,
        isNewSession,
        requestBody: { messages },
        digestValidationCache: {}
      }

      // 验证账户 A
      const result1 = await scheduler._validateExclusiveAccountDigest(
        account1,
        sessionHash,
        messages,
        isNewSession,
        sessionContext
      )

      expect(result1.valid).toBe(true)

      // 验证账户 B
      const result2 = await scheduler._validateExclusiveAccountDigest(
        account2,
        sessionHash,
        messages,
        isNewSession,
        sessionContext
      )

      expect(result2.valid).toBe(true)

      // 验证两个账户的结果都被独立缓存
      expect(sessionContext.digestValidationCache[account1.id]).toBeDefined()
      expect(sessionContext.digestValidationCache[account2.id]).toBeDefined()
      expect(sessionContext.digestValidationCache[account1.id]).not.toBe(
        sessionContext.digestValidationCache[account2.id]
      )

      // 再次验证账户 A，应该使用缓存
      jest.clearAllMocks()
      const result3 = await scheduler._validateExclusiveAccountDigest(
        account1,
        sessionHash,
        messages,
        isNewSession,
        sessionContext
      )

      expect(result3.valid).toBe(true)
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Using cached digest validation result')
      )
    })
  })

  describe('场景4: 非独占账户跳过验证和缓存', () => {
    it('应该跳过非独占账户的验证，不使用缓存', async () => {
      const account = {
        id: 'test-account-6',
        accountId: 'test-account-6',
        name: 'Non-exclusive Account',
        exclusiveSessionOnly: false, // 非独占
        enableMessageDigest: true
      }

      const sessionHash = 'test-session-hash-6'
      const messages = [{ role: 'user', content: 'Hello' }]
      const isNewSession = false

      const sessionContext = {
        sessionHash,
        isNewSession,
        requestBody: { messages },
        digestValidationCache: {}
      }

      // 验证
      const result = await scheduler._validateExclusiveAccountDigest(
        account,
        sessionHash,
        messages,
        isNewSession,
        sessionContext
      )

      // 非独占账户应该直接返回 valid: true
      expect(result.valid).toBe(true)

      // 缓存应该为空（不缓存非独占账户的结果）
      expect(sessionContext.digestValidationCache[account.id]).toBeUndefined()

      // 不应该有任何验证日志
      expect(logger.info).not.toHaveBeenCalled()
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('应该跳过未启用摘要验证的独占账户', async () => {
      const account = {
        id: 'test-account-7',
        accountId: 'test-account-7',
        name: 'Exclusive but No Digest',
        exclusiveSessionOnly: true, // 独占
        enableMessageDigest: false // 未启用摘要
      }

      const sessionHash = 'test-session-hash-7'
      const messages = [{ role: 'user', content: 'Hello' }]
      const isNewSession = false

      const sessionContext = {
        sessionHash,
        isNewSession,
        requestBody: { messages },
        digestValidationCache: {}
      }

      // 验证
      const result = await scheduler._validateExclusiveAccountDigest(
        account,
        sessionHash,
        messages,
        isNewSession,
        sessionContext
      )

      // 应该直接返回 valid: true
      expect(result.valid).toBe(true)

      // 缓存应该为空
      expect(sessionContext.digestValidationCache[account.id]).toBeUndefined()
    })
  })

  describe('缓存性能提升验证', () => {
    it('应该显著减少重复验证的开销（性能对比）', async () => {
      const account = {
        id: 'test-account-8',
        accountId: 'test-account-8',
        name: 'Performance Test Account',
        exclusiveSessionOnly: true,
        enableMessageDigest: true
      }

      const sessionHash = 'test-session-hash-8'
      const messages = [{ role: 'user', content: 'Performance test' }]
      const isNewSession = true

      const sessionContext = {
        sessionHash,
        isNewSession,
        requestBody: { messages },
        digestValidationCache: {}
      }

      // 第一次验证（无缓存）
      const start1 = Date.now()
      await scheduler._validateExclusiveAccountDigest(
        account,
        sessionHash,
        messages,
        isNewSession,
        sessionContext
      )
      const duration1 = Date.now() - start1

      // 后续 10 次验证（使用缓存）
      const start2 = Date.now()
      for (let i = 0; i < 10; i++) {
        await scheduler._validateExclusiveAccountDigest(
          account,
          sessionHash,
          messages,
          isNewSession,
          sessionContext
        )
      }
      const duration2 = Date.now() - start2
      const avgCachedDuration = duration2 / 10

      console.log(`首次验证耗时: ${duration1}ms`)
      console.log(`缓存验证平均耗时: ${avgCachedDuration}ms`)
      console.log(`性能提升: ${((duration1 / avgCachedDuration - 1) * 100).toFixed(1)}%`)

      // 缓存验证应该显著快于首次验证（至少快 10 倍）
      expect(avgCachedDuration).toBeLessThan(duration1 / 10)

      // 验证缓存命中次数（应该是 10 次）
      const cacheHitCalls = logger.debug.mock.calls.filter((call) =>
        call[0].includes('Using cached digest validation result')
      )
      expect(cacheHitCalls.length).toBe(10)
    })
  })

  describe('缓存边界情况', () => {
    it('应该处理 sessionContext 为 null 的情况', async () => {
      const account = {
        id: 'test-account-9',
        accountId: 'test-account-9',
        name: 'Test Account',
        exclusiveSessionOnly: true,
        enableMessageDigest: true
      }

      const sessionHash = 'test-session-hash-9'
      const messages = [{ role: 'user', content: 'Hello' }]
      const isNewSession = true

      // sessionContext 为 null（不使用缓存）
      const result = await scheduler._validateExclusiveAccountDigest(
        account,
        sessionHash,
        messages,
        isNewSession,
        null // 无 sessionContext
      )

      // 验证应该正常执行
      expect(result.valid).toBe(true)

      // 不应该有缓存相关的日志
      expect(logger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('Using cached digest validation result')
      )
    })

    it('应该处理 digestValidationCache 未初始化的情况', async () => {
      const account = {
        id: 'test-account-10',
        accountId: 'test-account-10',
        name: 'Test Account',
        exclusiveSessionOnly: true,
        enableMessageDigest: true
      }

      const sessionHash = 'test-session-hash-10'
      const messages = [{ role: 'user', content: 'Hello' }]
      const isNewSession = true

      const sessionContext = {
        sessionHash,
        isNewSession,
        requestBody: { messages }
        // 缺少 digestValidationCache 字段
      }

      // 验证应该正常执行（不使用缓存）
      const result = await scheduler._validateExclusiveAccountDigest(
        account,
        sessionHash,
        messages,
        isNewSession,
        sessionContext
      )

      expect(result.valid).toBe(true)

      // 不应该崩溃，也不应该尝试缓存
      expect(sessionContext.digestValidationCache).toBeUndefined()
    })
  })
})
