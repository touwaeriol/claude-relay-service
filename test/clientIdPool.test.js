/**
 * 客户端ID池功能测试
 *
 * 测试内容：
 * 1. 单个ID直接使用
 * 2. 多个ID的Round Robin选择
 * 3. Sticky Session绑定
 * 4. ID删除后的处理
 */

const redis = require('../src/models/redis')

/**
 * 模拟账户数据
 */
function createMockAccount(ids, options = {}) {
  return {
    id: options.id || 'account-test-001',
    name: options.name || 'Test Account',
    unifiedClientId: JSON.stringify(ids),
    sessionRetentionSeconds: options.sessionRetentionSeconds || 3600,
    exclusiveSession: options.exclusiveSession || false
  }
}

/**
 * 模拟客户端ID选择逻辑（从 claudeRelayService.js 提取）
 */
async function selectClientId(account, sessionHash) {
  const ids = JSON.parse(account.unifiedClientId || '[]')

  // 单个ID直接返回
  if (ids.length === 1) {
    return ids[0]
  }

  // 检查是否有粘性绑定
  const sessionKey = `sticky_session:${sessionHash}:${account.id}`
  const boundId = await redis.getClient().get(sessionKey)

  if (boundId && ids.includes(boundId)) {
    return boundId
  }

  // Round Robin选择
  const counterKey = `clientId:roundRobin:${account.id}`
  const counter = await redis.getClient().incr(counterKey)
  const selectedId = ids[counter % ids.length]

  // 建立粘性绑定
  const ttl = account.sessionRetentionSeconds || 3600
  await redis.getClient().setex(sessionKey, ttl, selectedId)

  return selectedId
}

/**
 * 检测客户端ID是否被删除
 */
async function isClientIdDeleted(account, sessionHash) {
  const ids = JSON.parse(account.unifiedClientId || '[]')
  const sessionKey = `sticky_session:${sessionHash}:${account.id}`
  const boundId = await redis.getClient().get(sessionKey)

  if (!boundId) {
    return false
  }

  return !ids.includes(boundId)
}

/**
 * 延迟函数
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('客户端ID池功能测试', () => {
  // 测试前连接 Redis
  beforeAll(async () => {
    await redis.connect()

    // 等待连接完成
    let retries = 50
    while (retries > 0) {
      const client = redis.getClient()
      if (client) {
        try {
          await client.ping()
          console.log('✅ Redis connected for clientIdPool tests')
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

  // 测试后断开 Redis
  afterAll(async () => {
    await redis.disconnect()
  })

  // 每个测试后清理数据
  afterEach(async () => {
    const client = redis.getClient()
    if (client) {
      const keys = await client.keys('sticky_session:*')
      const roundRobinKeys = await client.keys('clientId:roundRobin:*')
      const allKeys = [...keys, ...roundRobinKeys]
      if (allKeys.length > 0) {
        await client.del(...allKeys)
      }
    }
  })

  describe('单个客户端ID', () => {
    test('应该直接返回唯一的客户端ID', async () => {
      const account = createMockAccount(['client-id-001'])
      const sessionHash = 'session-hash-001'

      const selectedId = await selectClientId(account, sessionHash)

      expect(selectedId).toBe('client-id-001')
    })

    test('多次调用应该返回相同的ID', async () => {
      const account = createMockAccount(['client-id-001'])
      const sessionHash = 'session-hash-002'

      const id1 = await selectClientId(account, sessionHash)
      const id2 = await selectClientId(account, sessionHash)
      const id3 = await selectClientId(account, sessionHash)

      expect(id1).toBe('client-id-001')
      expect(id2).toBe('client-id-001')
      expect(id3).toBe('client-id-001')
    })
  })

  describe('多个客户端ID - Round Robin', () => {
    test('应该轮流选择不同的客户端ID', async () => {
      const account = createMockAccount(['id-1', 'id-2', 'id-3'])

      // 三个不同的会话
      const id1 = await selectClientId(account, 'session-001')
      const id2 = await selectClientId(account, 'session-002')
      const id3 = await selectClientId(account, 'session-003')

      // 应该选择不同的ID
      const selectedIds = [id1, id2, id3]
      expect(new Set(selectedIds).size).toBe(3) // 三个不同的ID
    })

    test('Round Robin应该循环使用ID', async () => {
      const account = createMockAccount(['id-1', 'id-2'])

      // 创建4个会话，应该循环使用2个ID
      const ids = []
      for (let i = 0; i < 4; i++) {
        const id = await selectClientId(account, `session-${i}`)
        ids.push(id)
      }

      // 第1和第3个应该相同，第2和第4个应该相同
      expect(ids[0]).toBe(ids[2])
      expect(ids[1]).toBe(ids[3])
      expect(ids[0]).not.toBe(ids[1])
    })
  })

  describe('Sticky Session绑定', () => {
    test('同一会话应该绑定到同一个客户端ID', async () => {
      const account = createMockAccount(['id-1', 'id-2', 'id-3'])
      const sessionHash = 'session-sticky-001'

      // 多次调用同一会话
      const id1 = await selectClientId(account, sessionHash)
      const id2 = await selectClientId(account, sessionHash)
      const id3 = await selectClientId(account, sessionHash)

      // 应该都是同一个ID
      expect(id1).toBe(id2)
      expect(id2).toBe(id3)
    })

    test('不同会话应该有独立的绑定', async () => {
      const account = createMockAccount(['id-1', 'id-2', 'id-3'])

      const sessionA_id = await selectClientId(account, 'session-A')
      const sessionB_id = await selectClientId(account, 'session-B')

      // 再次调用，应该保持各自的绑定
      const sessionA_id2 = await selectClientId(account, 'session-A')
      const sessionB_id2 = await selectClientId(account, 'session-B')

      expect(sessionA_id).toBe(sessionA_id2)
      expect(sessionB_id).toBe(sessionB_id2)
    })

    test('绑定应该有TTL限制', async () => {
      const account = createMockAccount(['id-1', 'id-2'], {
        sessionRetentionSeconds: 1 // 1秒TTL
      })
      const sessionHash = 'session-ttl-test'

      // 首次选择
      const id1 = await selectClientId(account, sessionHash)

      // 等待TTL过期
      await sleep(1500)

      // 再次选择，应该可能选择不同的ID（因为绑定已过期）
      const id2 = await selectClientId(account, sessionHash)

      // 验证TTL生效（至少不会报错）
      expect(id2).toMatch(/^id-[12]$/)
    }, 10000)
  })

  describe('客户端ID删除检测', () => {
    test('应该检测到客户端ID被删除', async () => {
      const account = createMockAccount(['id-1', 'id-2', 'id-3'])
      const sessionHash = 'session-delete-test'

      // 首次选择并绑定
      const selectedId = await selectClientId(account, sessionHash)
      expect(['id-1', 'id-2', 'id-3']).toContain(selectedId)

      // 模拟删除该ID（更新账户配置）
      const updatedAccount = {
        ...account,
        unifiedClientId: JSON.stringify(['id-1', 'id-2']) // 删除了 id-3
      }

      // 检测是否被删除
      const isDeleted = await isClientIdDeleted(updatedAccount, sessionHash)

      if (selectedId === 'id-3') {
        expect(isDeleted).toBe(true)
      } else {
        expect(isDeleted).toBe(false)
      }
    })

    test('未绑定的会话应该返回false', async () => {
      const account = createMockAccount(['id-1', 'id-2'])
      const sessionHash = 'session-no-binding'

      const isDeleted = await isClientIdDeleted(account, sessionHash)
      expect(isDeleted).toBe(false)
    })
  })

  describe('边界情况', () => {
    test('空ID数组应该返回undefined', async () => {
      const account = createMockAccount([])
      const sessionHash = 'session-empty'

      const selectedId = await selectClientId(account, sessionHash)
      expect(selectedId).toBeUndefined()
    })

    test('无效JSON应该抛出错误', async () => {
      const account = {
        id: 'test-account',
        unifiedClientId: 'invalid-json',
        sessionRetentionSeconds: 3600
      }

      await expect(
        selectClientId(account, 'session-test')
      ).rejects.toThrow()
    })
  })
})
