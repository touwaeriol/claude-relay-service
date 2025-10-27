/**
 * 会话管理功能测试
 *
 * 测试内容：
 * 1. 新/旧会话识别
 * 2. 粘性会话绑定
 * 3. 会话TTL刷新
 * 4. 独占会话过滤逻辑
 */

const redis = require('../src/models/redis')

/**
 * 构建会话上下文（从 claudeSessionCoordinator.js 提取）
 */
function buildSessionContext(sessionHash, requestBody) {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : []
  let isNewSession = true

  for (const msg of messages) {
    if (!msg || msg.role === 'system') {
      continue
    }
    if (msg.role !== 'user') {
      isNewSession = false
      break
    }
  }

  return {
    sessionHash,
    isNewSession
  }
}

/**
 * 注册会话到账户（建立粘性绑定）
 */
async function registerSessionForAccount(accountId, sessionContext, ttl = 25200) {
  if (!sessionContext?.sessionHash || sessionContext.isNewSession) {
    return
  }

  const sessionKey = `sticky_session:${sessionContext.sessionHash}`
  await redis.getClient().setex(sessionKey, ttl, accountId)
}

/**
 * 刷新会话保留时间
 */
async function refreshSessionRetention(accountId, sessionContext, ttl = 25200, renewalThreshold = 3600) {
  if (!sessionContext?.sessionHash || sessionContext.isNewSession) {
    return false
  }

  const sessionKey = `sticky_session:${sessionContext.sessionHash}`
  const currentTtl = await redis.getClient().ttl(sessionKey)

  if (currentTtl > 0 && currentTtl < renewalThreshold) {
    await redis.getClient().setex(sessionKey, ttl, accountId)
    return true
  }

  return false
}

/**
 * 独占会话过滤逻辑
 */
function filterAccountsByExclusiveSession(accounts, sessionContext, stickyAccountId) {
  const { isNewSession } = sessionContext

  // 新会话：所有账号可用
  if (isNewSession) {
    return accounts
  }

  // 旧会话：过滤独占账号
  return accounts.filter((account) => {
    const exclusive = account.exclusiveSession === true

    // 非独占账号：永远可用
    if (!exclusive) return true

    // 独占账号规则：
    // 1. 无绑定 → 不能用
    if (!stickyAccountId) return false

    // 2. 有绑定但不是自己 → 不能用
    // 3. 有绑定且是自己 → 可以用
    return stickyAccountId === account.id
  })
}

/**
 * 延迟函数
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('会话管理功能测试', () => {
  beforeAll(async () => {
    await redis.connect()

    let retries = 50
    while (retries > 0) {
      const client = redis.getClient()
      if (client) {
        try {
          await client.ping()
          console.log('✅ Redis connected for sessionManagement tests')
          break
        } catch (err) {
          // 继续等待
        }
      }
      await sleep(100)
      retries--
    }

    if (retries === 0) {
      throw new Error('Failed to connect to Redis')
    }
  }, 10000)

  afterAll(async () => {
    await redis.disconnect()
  })

  afterEach(async () => {
    const client = redis.getClient()
    if (client) {
      const keys = await client.keys('sticky_session:*')
      if (keys.length > 0) {
        await client.del(...keys)
      }
    }
  })

  describe('会话识别', () => {
    test('只有user消息应识别为新会话', () => {
      const requestBody = {
        messages: [{ role: 'user', content: 'Hello' }, { role: 'user', content: 'World' }]
      }

      const context = buildSessionContext('hash-001', requestBody)

      expect(context.isNewSession).toBe(true)
      expect(context.sessionHash).toBe('hash-001')
    })

    test('包含assistant消息应识别为旧会话', () => {
      const requestBody = {
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
          { role: 'user', content: 'How are you?' }
        ]
      }

      const context = buildSessionContext('hash-002', requestBody)

      expect(context.isNewSession).toBe(false)
    })

    test('包含system消息但只有user消息应识别为新会话', () => {
      const requestBody = {
        messages: [
          { role: 'system', content: 'You are a helpful assistant' },
          { role: 'user', content: 'Hello' }
        ]
      }

      const context = buildSessionContext('hash-003', requestBody)

      expect(context.isNewSession).toBe(true)
    })

    test('空消息数组应识别为新会话', () => {
      const requestBody = { messages: [] }

      const context = buildSessionContext('hash-004', requestBody)

      expect(context.isNewSession).toBe(true)
    })
  })

  describe('粘性会话绑定', () => {
    test('新会话不应创建绑定', async () => {
      const accountId = 'account-001'
      const sessionContext = {
        sessionHash: 'new-session-001',
        isNewSession: true
      }

      await registerSessionForAccount(accountId, sessionContext)

      const client = redis.getClient()
      const value = await client.get(`sticky_session:${sessionContext.sessionHash}`)
      expect(value).toBeNull()
    })

    test('旧会话应创建绑定', async () => {
      const accountId = 'account-002'
      const sessionContext = {
        sessionHash: 'old-session-001',
        isNewSession: false
      }

      await registerSessionForAccount(accountId, sessionContext)

      const client = redis.getClient()
      const value = await client.get(`sticky_session:${sessionContext.sessionHash}`)
      expect(value).toBe(accountId)
    })

    test('绑定应有正确的TTL', async () => {
      const accountId = 'account-003'
      const sessionContext = {
        sessionHash: 'old-session-002',
        isNewSession: false
      }
      const ttl = 3600 // 1小时

      await registerSessionForAccount(accountId, sessionContext, ttl)

      const client = redis.getClient()
      const actualTtl = await client.ttl(`sticky_session:${sessionContext.sessionHash}`)

      // TTL应该在3595-3600之间（允许5秒误差）
      expect(actualTtl).toBeGreaterThanOrEqual(3595)
      expect(actualTtl).toBeLessThanOrEqual(3600)
    })
  })

  describe('会话TTL刷新', () => {
    test('新会话不应触发刷新', async () => {
      const accountId = 'account-004'
      const sessionContext = {
        sessionHash: 'new-session-refresh',
        isNewSession: true
      }

      const refreshed = await refreshSessionRetention(accountId, sessionContext, 7200, 3600)

      expect(refreshed).toBe(false)
    })

    test('TTL高于阈值不应刷新', async () => {
      const accountId = 'account-005'
      const sessionContext = {
        sessionHash: 'old-session-high-ttl',
        isNewSession: false
      }

      // 创建绑定（TTL = 7200秒）
      await registerSessionForAccount(accountId, sessionContext, 7200)

      // 尝试刷新（阈值 = 3600秒）
      const refreshed = await refreshSessionRetention(accountId, sessionContext, 7200, 3600)

      expect(refreshed).toBe(false)
    })

    test('TTL低于阈值应刷新', async () => {
      const accountId = 'account-006'
      const sessionContext = {
        sessionHash: 'old-session-low-ttl',
        isNewSession: false
      }

      // 创建绑定（TTL = 30秒，低于阈值）
      await registerSessionForAccount(accountId, sessionContext, 30)

      // 等待1秒确保TTL降低
      await sleep(1000)

      // 尝试刷新（阈值 = 3600秒）
      const refreshed = await refreshSessionRetention(accountId, sessionContext, 7200, 3600)

      expect(refreshed).toBe(true)

      // 验证TTL已更新
      const client = redis.getClient()
      const newTtl = await client.ttl(`sticky_session:${sessionContext.sessionHash}`)
      expect(newTtl).toBeGreaterThan(7000) // 应该接近7200
    }, 10000)
  })

  describe('独占会话过滤', () => {
    const accounts = [
      { id: 'account-A', name: '独占账号A', exclusiveSession: true },
      { id: 'account-B', name: '独占账号B', exclusiveSession: true },
      { id: 'account-C', name: '共享账号C', exclusiveSession: false },
      { id: 'account-D', name: '共享账号D', exclusiveSession: false }
    ]

    test('新会话应返回所有账号', () => {
      const sessionContext = { isNewSession: true }
      const filtered = filterAccountsByExclusiveSession(accounts, sessionContext, null)

      expect(filtered).toHaveLength(4)
      expect(filtered).toEqual(accounts)
    })

    test('旧会话无绑定应只返回共享账号', () => {
      const sessionContext = { isNewSession: false }
      const filtered = filterAccountsByExclusiveSession(accounts, sessionContext, null)

      expect(filtered).toHaveLength(2)
      expect(filtered.map((a) => a.id)).toEqual(['account-C', 'account-D'])
    })

    test('旧会话绑定到独占账号A应返回A和共享账号', () => {
      const sessionContext = { isNewSession: false }
      const filtered = filterAccountsByExclusiveSession(accounts, sessionContext, 'account-A')

      expect(filtered).toHaveLength(3)
      expect(filtered.map((a) => a.id)).toEqual(['account-A', 'account-C', 'account-D'])
    })

    test('旧会话绑定到共享账号应只返回共享账号', () => {
      const sessionContext = { isNewSession: false }
      const filtered = filterAccountsByExclusiveSession(accounts, sessionContext, 'account-C')

      expect(filtered).toHaveLength(2)
      expect(filtered.map((a) => a.id)).toEqual(['account-C', 'account-D'])
    })

    test('旧会话绑定到不存在的账号应只返回共享账号', () => {
      const sessionContext = { isNewSession: false }
      const filtered = filterAccountsByExclusiveSession(accounts, sessionContext, 'account-X')

      expect(filtered).toHaveLength(2)
      expect(filtered.map((a) => a.id)).toEqual(['account-C', 'account-D'])
    })
  })

  describe('集成场景', () => {
    test('完整会话流程：新会话 → 旧会话 → 刷新', async () => {
      const accountId = 'account-integration'

      // 1. 新会话
      const newRequest = {
        messages: [{ role: 'user', content: 'Hello' }]
      }
      const newContext = buildSessionContext('session-integration', newRequest)
      expect(newContext.isNewSession).toBe(true)

      // 新会话不创建绑定
      await registerSessionForAccount(accountId, newContext)
      const client = redis.getClient()
      let value = await client.get(`sticky_session:${newContext.sessionHash}`)
      expect(value).toBeNull()

      // 2. 旧会话（继续对话）
      const oldRequest = {
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi!' },
          { role: 'user', content: 'How are you?' }
        ]
      }
      const oldContext = buildSessionContext('session-integration', oldRequest)
      expect(oldContext.isNewSession).toBe(false)

      // 旧会话创建绑定（TTL = 60秒）
      await registerSessionForAccount(accountId, oldContext, 60)
      value = await client.get(`sticky_session:${oldContext.sessionHash}`)
      expect(value).toBe(accountId)

      // 等待2秒
      await sleep(2000)

      // 3. 刷新TTL（阈值 = 100秒，当前TTL应该低于阈值）
      const refreshed = await refreshSessionRetention(accountId, oldContext, 7200, 100)
      expect(refreshed).toBe(true)

      // 验证TTL已更新
      const newTtl = await client.ttl(`sticky_session:${oldContext.sessionHash}`)
      expect(newTtl).toBeGreaterThan(7000)
    }, 15000)
  })
})
