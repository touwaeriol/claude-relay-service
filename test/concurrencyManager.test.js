const concurrencyManager = require('../src/services/concurrencyManager')
const EventEmitter = require('events')
const redisClient = require('../src/models/redis')

/**
 * 模拟 Express req/res 对象
 */
function createMockReqRes() {
  const req = new EventEmitter()
  const res = new EventEmitter()

  req.destroyed = false
  req.socket = { destroyed: false }
  res.destroyed = false

  // 模拟关闭方法
  req.close = () => {
    req.destroyed = true
    req.socket.destroyed = true
    req.emit('close')
  }
  req.abort = () => {
    req.destroyed = true
    req.socket.destroyed = true
    req.emit('aborted')
  }
  res.close = () => {
    res.destroyed = true
    res.emit('close')
  }
  res.finish = () => {
    res.destroyed = true
    res.emit('finish')
  }

  return { req, res }
}

/**
 * 延迟函数
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquireSlot(resourceId, config) {
  const { req, res } = createMockReqRes()
  const release = await concurrencyManager.waitForSlot(resourceId, config, req, res)
  return { req, res, release }
}

async function waitForPromiseWithTimeout(promise, timeoutMs, errorMessage) {
  let timer = null
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

describe('ConcurrencyManager', () => {
  console.log('🔧 Test Redis config:', {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD ? '[set]' : '[missing]'
  })
  // 测试前连接 Redis
  beforeAll(async () => {
    await redisClient.connect()

    // 等待真正连接完成（lazyConnect 需要发送一个命令来触发连接）
    // 轮询直到连接成功
    let retries = 50
    while (retries > 0) {
      const client = redisClient.getClient()
      if (client) {
        try {
          await client.ping()
          console.log('✅ Redis connected and ready for tests')
          break
        } catch (err) {
          // 继续等待
        }
      }
      await sleep(100)
      retries--
    }

    if (retries === 0) {
      throw new Error('Failed to connect to Redis after 5 seconds')
    }
  }, 10000) // 增加超时时间

  // 测试后断开 Redis
  afterAll(async () => {
    await redisClient.disconnect()
  })

  // 每个测试前清空所有 Semaphore 实例
  beforeEach(() => {
    concurrencyManager.clearAll()
  })

  // 每个测试后清理 Redis 数据（避免测试之间互相影响）
  afterEach(async () => {
    concurrencyManager.clearAll()

    // 等待一小段时间让正在进行的操作完成
    await sleep(50)

    // 清理 Redis 中的测试数据
    const client = redisClient.getClient()
    if (client) {
      const keys = await client.keys('concurrency:queue:*')
      const semKeys = await client.keys('sem:*')
      const allKeys = [...keys, ...semKeys]
      if (allKeys.length > 0) {
        await client.del(...allKeys)
      }
    }
  })

  describe('基础功能', () => {
    test('未启用时应直接返回', async () => {
      const { req, res } = createMockReqRes()
      const config = {
        enabled: false,
        maxConcurrency: 10,
        queueSize: 20,
        queueTimeout: 30
      }

      // 不应抛出错误，应返回空的 release 函数
      await expect(
        concurrencyManager.waitForSlot('test-resource', config, req, res)
      ).resolves.toBeDefined()

      // 不应创建 Semaphore 实例
      expect(concurrencyManager.has('test-resource')).toBe(false)
    })

    test('maxConcurrency <= 0 时应自动规范化为 1', async () => {
      const resourceId = 'normalize-max-concurrency'
      const { req, res } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 0,
        queueSize: 20,
        queueTimeout: 30
      }

      const release = await concurrencyManager.waitForSlot(resourceId, config, req, res)
      expect(typeof release).toBe('function')

      const stats = await concurrencyManager.getStats(resourceId)
      expect(stats).not.toBeNull()
      expect(stats.total).toBe(1)

      await release()
    })

    test('参数验证 - resourceId 必须是非空字符串', async () => {
      const { req, res } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 10,
        queueSize: 20,
        queueTimeout: 30
      }

      await expect(concurrencyManager.waitForSlot('', config, req, res)).rejects.toThrow(
        'resourceId must be a non-empty string'
      )

      await expect(concurrencyManager.waitForSlot(null, config, req, res)).rejects.toThrow(
        'resourceId must be a non-empty string'
      )
    })

    test('参数验证 - req 和 res 必须提供', async () => {
      const config = {
        enabled: true,
        maxConcurrency: 10,
        queueSize: 20,
        queueTimeout: 30
      }

      await expect(concurrencyManager.waitForSlot('test', config, null, null)).rejects.toThrow(
        'req and res are required for auto-release'
      )
    })
  })

  describe('并发控制', () => {
    test('在并发限制内应成功获取槽位', async () => {
      const resourceId = 'concurrency-basic'
      const config = {
        enabled: true,
        maxConcurrency: 2,
        queueSize: 5,
        queueTimeout: 5
      }

      const { release } = await acquireSlot(resourceId, config)

      const stats = await concurrencyManager.getStats(resourceId)
      expect(stats).not.toBeNull()
      expect(stats.total).toBe(2) // 最大并发数为2

      await release()
    })

    test('超过并发限制但在队列内应等待', async () => {
      const resourceId = 'concurrency-wait'
      const config = {
        enabled: true,
        maxConcurrency: 1, // 只允许1个并发
        queueSize: 2, // 队列长度2
        queueTimeout: 5
      }

      // 第一个请求：占用唯一的槽位
      const { req: req1, res: res1 } = createMockReqRes()
      const release1 = await concurrencyManager.waitForSlot(resourceId, config, req1, res1)

      // 第二个请求：应该进入队列等待
      const { req: req2, res: res2 } = createMockReqRes()
      const promise2 = concurrencyManager.waitForSlot(resourceId, config, req2, res2)

      // 等待一小段时间，确保第二个请求进入队列
      await sleep(100)

      const stats = await concurrencyManager.getStats(resourceId)
      expect(stats.waiting).toBe(1) // 有1个请求在等待
      expect(stats.total).toBe(1) // 最大并发数为1

      // 释放第一个请求
      await release1()

      // 第二个请求应该能获取到槽位
      const release2 = await promise2
      expect(release2).toBeDefined()
      await release2()
    })

    test('队列满时应立即抛出 QUEUE_FULL 错误', async () => {
      const resourceId = 'queue-full'
      const config = {
        enabled: true,
        maxConcurrency: 1,
        queueSize: 1, // 队列只能容纳1个
        queueTimeout: 5
      }

      const client = redisClient.getClient()
      if (client) {
        await client.del(`concurrency:queue:${resourceId}`)
        await client.del(`sem:${resourceId}`)
      }

      const { req: req1, res: res1 } = createMockReqRes()
      const release1 = await concurrencyManager.waitForSlot(resourceId, config, req1, res1)

      const { req: req2, res: res2 } = createMockReqRes()
      const waitingPromise = concurrencyManager.waitForSlot(resourceId, config, req2, res2)

      await sleep(100)

      const { req: req3, res: res3 } = createMockReqRes()
      let queueError = null
      try {
        await concurrencyManager.waitForSlot(resourceId, config, req3, res3)
      } catch (error) {
        queueError = error
      }

      expect(queueError).toBeDefined()
      expect(queueError.code).toBe('QUEUE_FULL')
      expect(queueError.resourceId).toBe(resourceId)
      expect(queueError.maxQueueSize).toBe(1)
      expect(queueError.currentWaiting).toBeGreaterThanOrEqual(0)

      await release1()
      const release2 = await waitingPromise
      expect(release2).toBeDefined()
      await release2()
    })

    test('queueSize=0 时应不允许排队（立即拒绝）', async () => {
      const resourceId = 'queue-zero'
      const config = {
        enabled: true,
        maxConcurrency: 1,
        queueSize: 0, // 不允许排队
        queueTimeout: 5
      }

      const client = redisClient.getClient()
      if (client) {
        await client.del(`concurrency:queue:${resourceId}`)
        await client.del(`sem:${resourceId}`)
      }

      // 第一个请求：占用槽位
      const { req: req1, res: res1 } = createMockReqRes()
      const release1 = await concurrencyManager.waitForSlot(resourceId, config, req1, res1)

      // 第二个请求：应立即拒绝
      const { req: req2, res: res2 } = createMockReqRes()
      let queueError = null
      try {
        await concurrencyManager.waitForSlot(resourceId, config, req2, res2)
      } catch (error) {
        queueError = error
      }

      expect(queueError).toBeDefined()
      expect(queueError.code).toBe('QUEUE_FULL')
      expect(queueError.maxQueueSize).toBe(0)
      expect(queueError.currentWaiting).toBeGreaterThanOrEqual(0)

      await release1()
    })
  })

  describe('超时处理', () => {
    test('等待超时应抛出 TIMEOUT 错误', async () => {
      const resourceId = 'timeout-test'
      const config = {
        enabled: true,
        maxConcurrency: 1,
        queueSize: 5,
        queueTimeout: 2 // 2秒超时
      }

      // 第一个请求：占用槽位
      const { release: release1 } = await acquireSlot(resourceId, config)

      // 第二个请求：应该超时
      const { req: req2, res: res2 } = createMockReqRes()
      await expect(
        concurrencyManager.waitForSlot(resourceId, config, req2, res2)
      ).rejects.toMatchObject({
        code: 'TIMEOUT',
        resourceId,
        timeout: 2,
        timeoutMs: 2000
      })

      await release1()
    }, 10000) // 增加测试超时时间
  })

  describe('自动释放机制', () => {
    test('req.close 应自动释放槽位', async () => {
      const resourceId = 'auto-release-close'
      const { req, res } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 1,
        queueSize: 5,
        queueTimeout: 30
      }

      await concurrencyManager.waitForSlot(resourceId, config, req, res)

      const initialReleased = concurrencyManager.getGlobalStats().totalReleased

      // 触发 req.close
      req.close()

      // 等待异步释放完成
      await sleep(100)

      const afterStats = concurrencyManager.getGlobalStats()
      expect(afterStats.totalReleased).toBeGreaterThan(initialReleased)

      const { req: req2, res: res2 } = createMockReqRes()
      const release2 = await waitForPromiseWithTimeout(
        concurrencyManager.waitForSlot(resourceId, config, req2, res2),
        1000,
        'Slot was not released after req.close()'
      )
      await release2()
    })

    test('req.aborted 应自动释放槽位', async () => {
      const resourceId = 'auto-release-abort'
      const { req, res } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 1,
        queueSize: 5,
        queueTimeout: 30
      }

      await concurrencyManager.waitForSlot(resourceId, config, req, res)

      const initialReleased = concurrencyManager.getGlobalStats().totalReleased

      // 触发 req.aborted
      req.abort()

      await sleep(100)

      const afterStats = concurrencyManager.getGlobalStats()
      expect(afterStats.totalReleased).toBeGreaterThan(initialReleased)

      const { req: req2, res: res2 } = createMockReqRes()
      const release2 = await waitForPromiseWithTimeout(
        concurrencyManager.waitForSlot(resourceId, config, req2, res2),
        1000,
        'Slot was not released after req.abort()'
      )
      await release2()
    })

    test('res.finish 应自动释放槽位', async () => {
      const resourceId = 'auto-release-finish'
      const { req, res } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 1,
        queueSize: 5,
        queueTimeout: 30
      }

      await concurrencyManager.waitForSlot(resourceId, config, req, res)

      const initialReleased = concurrencyManager.getGlobalStats().totalReleased

      // 触发 res.finish
      res.finish()

      await sleep(100)

      const afterStats = concurrencyManager.getGlobalStats()
      expect(afterStats.totalReleased).toBeGreaterThan(initialReleased)

      const { req: req2, res: res2 } = createMockReqRes()
      const release2 = await waitForPromiseWithTimeout(
        concurrencyManager.waitForSlot(resourceId, config, req2, res2),
        1000,
        'Slot was not released after res.finish()'
      )
      await release2()
    })

    test('重复释放应只释放一次', async () => {
      const resourceId = 'auto-release-once'
      const { req, res } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 1,
        queueSize: 5,
        queueTimeout: 30
      }

      await concurrencyManager.waitForSlot(resourceId, config, req, res)

      const initialReleased = concurrencyManager.getGlobalStats().totalReleased

      // 触发多个事件
      req.close()
      req.abort()
      res.finish()

      await sleep(50)

      // 应该只释放一次
      const afterStats = concurrencyManager.getGlobalStats()
      expect(afterStats.totalReleased).toBe(initialReleased + 1)

      const { req: req2, res: res2 } = createMockReqRes()
      const release2 = await waitForPromiseWithTimeout(
        concurrencyManager.waitForSlot(resourceId, config, req2, res2),
        1000,
        'Slot was not released after duplicate events'
      )
      await release2()
    })
  })

  describe('统计功能', () => {
    test('getStats 应返回正确的统计信息', async () => {
      const resourceId = 'stats-basic'
      const { release } = await acquireSlot(resourceId, {
        enabled: true,
        maxConcurrency: 5,
        queueSize: 10,
        queueTimeout: 30
      })

      const stats = await concurrencyManager.getStats(resourceId)
      expect(stats).not.toBeNull()
      expect(stats.waiting).toBe(0) // 没有等待的请求
      expect(stats.total).toBe(5) // 最大并发数为5

      await release()
    })

    test('getStats 对不存在的资源应返回 null', async () => {
      const stats = await concurrencyManager.getStats('non-existent')
      expect(stats).toBeNull()
    })

    test('getGlobalStats 应返回全局统计', async () => {
      const resourceId = 'stats-global'
      const config = {
        enabled: true,
        maxConcurrency: 1,
        queueSize: 5,
        queueTimeout: 30
      }

      const before = concurrencyManager.getGlobalStats()
      const { release } = await acquireSlot(resourceId, config)

      const globalStats = concurrencyManager.getGlobalStats()
      expect(globalStats.totalLimiters).toBeGreaterThanOrEqual(1)
      expect(globalStats.ttl).toBe('30 minutes')
      expect(globalStats.totalCreated).toBeGreaterThanOrEqual(before.totalCreated)
      expect(globalStats.totalAcquired).toBeGreaterThan(before.totalAcquired)

      await release()
    })
  })

  describe('配置变更', () => {
    test('配置变更时应重新创建 Semaphore', async () => {
      const resourceId = 'config-change'
      const config1 = {
        enabled: true,
        maxConcurrency: 5,
        queueSize: 10,
        queueTimeout: 30
      }

      const { release: release1 } = await acquireSlot(resourceId, config1)

      const stats1 = await concurrencyManager.getStats(resourceId)
      expect(stats1.total).toBe(5) // maxConcurrency=5

      await release1()
      await sleep(50)

      // 配置变更
      const config2 = {
        enabled: true,
        maxConcurrency: 10, // 改为10
        queueSize: 10,
        queueTimeout: 30
      }

      const { release: release2 } = await acquireSlot(resourceId, config2)

      const stats2 = await concurrencyManager.getStats(resourceId)
      expect(stats2.total).toBe(10) // maxConcurrency=10

      await release2()
    })
  })

  describe('实例管理', () => {
    test('clear 应删除指定资源的 Semaphore（Redis 数据通过 TTL 自动过期）', async () => {
      const resourceId = 'instance-clear'
      const { release } = await acquireSlot(resourceId, {
        enabled: true,
        maxConcurrency: 5,
        queueSize: 10,
        queueTimeout: 30
      })

      expect(concurrencyManager.has(resourceId)).toBe(true)

      const cleared = concurrencyManager.clear(resourceId)
      expect(cleared).toBe(true)
      expect(concurrencyManager.has(resourceId)).toBe(false)

      await release()
    })

    test('clearAll 应删除所有 Semaphore（Redis 数据通过 TTL 自动过期）', async () => {
      const { release: release1 } = await acquireSlot('instance-clearAll-1', {
        enabled: true,
        maxConcurrency: 5,
        queueSize: 10,
        queueTimeout: 30
      })
      const { release: release2 } = await acquireSlot('instance-clearAll-2', {
        enabled: true,
        maxConcurrency: 5,
        queueSize: 10,
        queueTimeout: 30
      })

      expect(concurrencyManager.listResources()).toHaveLength(2)

      concurrencyManager.clearAll()
      expect(concurrencyManager.listResources()).toHaveLength(0)

      await release1()
      await release2()
    })

    test('listResources 应返回所有资源ID', async () => {
      const { release: release1 } = await acquireSlot('instance-list-1', {
        enabled: true,
        maxConcurrency: 5,
        queueSize: 10,
        queueTimeout: 30
      })
      const { release: release2 } = await acquireSlot('instance-list-2', {
        enabled: true,
        maxConcurrency: 5,
        queueSize: 10,
        queueTimeout: 30
      })

      const resources = concurrencyManager.listResources()
      expect(resources).toEqual(
        expect.arrayContaining(['instance-list-1', 'instance-list-2'])
      )

      await release1()
      await release2()
    })
  })
})
