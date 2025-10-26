const concurrencyManager = require('../src/services/concurrencyManager')
const EventEmitter = require('events')
const redisClient = require('../src/models/redis')

/**
 * 模拟 Express req/res 对象
 */
function createMockReqRes() {
  const req = new EventEmitter()
  const res = new EventEmitter()

  // 模拟关闭方法
  req.close = () => req.emit('close')
  req.abort = () => req.emit('aborted')
  res.close = () => res.emit('close')
  res.finish = () => res.emit('finish')

  return { req, res }
}

/**
 * 延迟函数
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('ConcurrencyManager', () => {
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

    test('maxConcurrency <= 0 时应直接返回', async () => {
      const { req, res } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 0,
        queueSize: 20,
        queueTimeout: 30
      }

      await expect(
        concurrencyManager.waitForSlot('test-resource', config, req, res)
      ).resolves.toBeDefined()

      expect(concurrencyManager.has('test-resource')).toBe(false)
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
      const { req, res } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 2,
        queueSize: 5,
        queueTimeout: 5
      }

      // 第一个请求应成功
      await concurrencyManager.waitForSlot('test-resource', config, req, res)

      const stats = await concurrencyManager.getStats('test-resource')
      expect(stats).not.toBeNull()
      expect(stats.total).toBe(2) // 最大并发数为2
    })

    test('超过并发限制但在队列内应等待', async () => {
      const config = {
        enabled: true,
        maxConcurrency: 1, // 只允许1个并发
        queueSize: 2, // 队列长度2
        queueTimeout: 5
      }

      // 第一个请求：占用唯一的槽位
      const { req: req1, res: res1 } = createMockReqRes()
      await concurrencyManager.waitForSlot('test-resource', config, req1, res1)

      // 第二个请求：应该进入队列等待
      const { req: req2, res: res2 } = createMockReqRes()
      const promise2 = concurrencyManager.waitForSlot('test-resource', config, req2, res2)

      // 等待一小段时间，确保第二个请求进入队列
      await sleep(100)

      const stats = await concurrencyManager.getStats('test-resource')
      expect(stats.waiting).toBe(1) // 有1个请求在等待
      expect(stats.total).toBe(1) // 最大并发数为1

      // 释放第一个请求
      req1.close()

      // 第二个请求应该能获取到槽位
      await expect(promise2).resolves.toBeDefined() // 应返回 release 函数
    })

    test('队列满时应立即抛出 QUEUE_FULL 错误', async () => {
      const config = {
        enabled: true,
        maxConcurrency: 1,
        queueSize: 1, // 队列只能容纳1个
        queueTimeout: 5
      }

      // 第一个请求：占用槽位
      const { req: req1, res: res1 } = createMockReqRes()
      await concurrencyManager.waitForSlot('test-resource', config, req1, res1)

      // 第二个请求：进入队列
      const { req: req2, res: res2 } = createMockReqRes()
      const promise2 = concurrencyManager.waitForSlot('test-resource', config, req2, res2)

      // 等待确保第二个请求进入队列
      await sleep(100)

      // 第三个请求：队列满，应立即拒绝
      const { req: req3, res: res3 } = createMockReqRes()
      await expect(
        concurrencyManager.waitForSlot('test-resource', config, req3, res3)
      ).rejects.toMatchObject({
        code: 'QUEUE_FULL',
        resourceId: 'test-resource',
        currentWaiting: 1,
        maxQueueSize: 1
      })

      // 清理
      req1.close()
      await promise2
    })

    test('queueSize=0 时应不允许排队（立即拒绝）', async () => {
      const config = {
        enabled: true,
        maxConcurrency: 1,
        queueSize: 0, // 不允许排队
        queueTimeout: 5
      }

      // 第一个请求：占用槽位
      const { req: req1, res: res1 } = createMockReqRes()
      await concurrencyManager.waitForSlot('test-resource', config, req1, res1)

      // 第二个请求：应立即拒绝
      const { req: req2, res: res2 } = createMockReqRes()
      await expect(
        concurrencyManager.waitForSlot('test-resource', config, req2, res2)
      ).rejects.toMatchObject({
        code: 'QUEUE_FULL',
        maxQueueSize: 0
      })

      // 清理
      req1.close()
    })
  })

  describe('超时处理', () => {
    test('等待超时应抛出 TIMEOUT 错误', async () => {
      const config = {
        enabled: true,
        maxConcurrency: 1,
        queueSize: 5,
        queueTimeout: 1 // 1秒超时
      }

      // 第一个请求：占用槽位
      const { req: req1, res: res1 } = createMockReqRes()
      await concurrencyManager.waitForSlot('test-resource', config, req1, res1)

      // 第二个请求：应该超时
      const { req: req2, res: res2 } = createMockReqRes()
      await expect(
        concurrencyManager.waitForSlot('test-resource', config, req2, res2)
      ).rejects.toMatchObject({
        code: 'TIMEOUT',
        resourceId: 'test-resource',
        timeout: 1,
        timeoutMs: 1000
      })

      // 清理
      req1.close()
    }, 10000) // 增加测试超时时间
  })

  describe('自动释放机制', () => {
    test('req.close 应自动释放槽位', async () => {
      const { req, res } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 1,
        queueSize: 5,
        queueTimeout: 30
      }

      await concurrencyManager.waitForSlot('test-resource', config, req, res)

      // 触发 req.close
      req.close()

      // 等待异步释放完成
      await sleep(100)

      // 验证已释放（通过统计信息）
      const globalStats = concurrencyManager.getGlobalStats()
      expect(globalStats.totalReleased).toBeGreaterThan(0)
    })

    test('req.aborted 应自动释放槽位', async () => {
      const { req, res } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 1,
        queueSize: 5,
        queueTimeout: 30
      }

      await concurrencyManager.waitForSlot('test-resource', config, req, res)

      // 触发 req.aborted
      req.abort()

      await sleep(100)

      // 验证已释放
      const globalStats = concurrencyManager.getGlobalStats()
      expect(globalStats.totalReleased).toBeGreaterThan(0)
    })

    test('res.finish 应自动释放槽位', async () => {
      const { req, res } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 1,
        queueSize: 5,
        queueTimeout: 30
      }

      await concurrencyManager.waitForSlot('test-resource', config, req, res)

      // 触发 res.finish
      res.finish()

      await sleep(100)

      // 验证已释放
      const globalStats = concurrencyManager.getGlobalStats()
      expect(globalStats.totalReleased).toBeGreaterThan(0)
    })

    test('重复释放应只释放一次', async () => {
      const { req, res } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 1,
        queueSize: 5,
        queueTimeout: 30
      }

      await concurrencyManager.waitForSlot('test-resource', config, req, res)

      // 触发多个事件
      req.close()
      req.abort()
      res.finish()

      await sleep(50)

      // 应该只释放一次
      const globalStats = concurrencyManager.getGlobalStats()
      expect(globalStats.totalReleased).toBe(1)
    })
  })

  describe('统计功能', () => {
    test('getStats 应返回正确的统计信息', async () => {
      const { req, res } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 5,
        queueSize: 10,
        queueTimeout: 30
      }

      // 占用1个槽位
      await concurrencyManager.waitForSlot('test-resource', config, req, res)

      const stats = await concurrencyManager.getStats('test-resource')
      expect(stats).not.toBeNull()
      expect(stats.waiting).toBe(0) // 没有等待的请求
      expect(stats.total).toBe(5) // 最大并发数为5
    })

    test('getStats 对不存在的资源应返回 null', async () => {
      const stats = await concurrencyManager.getStats('non-existent')
      expect(stats).toBeNull()
    })

    test('getGlobalStats 应返回全局统计', async () => {
      const { req, res } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 1,
        queueSize: 5,
        queueTimeout: 30
      }

      await concurrencyManager.waitForSlot('test-1', config, req, res)

      const globalStats = concurrencyManager.getGlobalStats()
      expect(globalStats).toMatchObject({
        totalCreated: 1,
        totalAcquired: 1,
        totalSemas: 1,
        maxInstances: 1000
      })
    })
  })

  describe('配置变更', () => {
    test('配置变更时应重新创建 Semaphore', async () => {
      const { req: req1, res: res1 } = createMockReqRes()
      const config1 = {
        enabled: true,
        maxConcurrency: 5,
        queueSize: 10,
        queueTimeout: 30
      }

      await concurrencyManager.waitForSlot('test-resource', config1, req1, res1)

      const stats1 = await concurrencyManager.getStats('test-resource')
      expect(stats1.total).toBe(5) // maxConcurrency=5

      // 释放
      req1.close()
      await sleep(100)

      // 配置变更
      const { req: req2, res: res2 } = createMockReqRes()
      const config2 = {
        enabled: true,
        maxConcurrency: 10, // 改为10
        queueSize: 10,
        queueTimeout: 30
      }

      await concurrencyManager.waitForSlot('test-resource', config2, req2, res2)

      const stats2 = await concurrencyManager.getStats('test-resource')
      expect(stats2.total).toBe(10) // maxConcurrency=10

      // 清理
      req2.close()
    })
  })

  describe('实例管理', () => {
    test('clear 应删除指定资源的 Semaphore（Redis 数据通过 TTL 自动过期）', async () => {
      const { req, res } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 5,
        queueSize: 10,
        queueTimeout: 30
      }

      await concurrencyManager.waitForSlot('test-resource', config, req, res)
      expect(concurrencyManager.has('test-resource')).toBe(true)

      const cleared = concurrencyManager.clear('test-resource')
      expect(cleared).toBe(true)
      expect(concurrencyManager.has('test-resource')).toBe(false)

      // 清理
      req.close()
    })

    test('clearAll 应删除所有 Semaphore（Redis 数据通过 TTL 自动过期）', async () => {
      const { req: req1, res: res1 } = createMockReqRes()
      const { req: req2, res: res2 } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 5,
        queueSize: 10,
        queueTimeout: 30
      }

      await concurrencyManager.waitForSlot('resource-1', config, req1, res1)
      await concurrencyManager.waitForSlot('resource-2', config, req2, res2)

      expect(concurrencyManager.listResources()).toHaveLength(2)

      concurrencyManager.clearAll()
      expect(concurrencyManager.listResources()).toHaveLength(0)

      // 清理
      req1.close()
      req2.close()
    })

    test('listResources 应返回所有资源ID', async () => {
      const { req: req1, res: res1 } = createMockReqRes()
      const { req: req2, res: res2 } = createMockReqRes()
      const config = {
        enabled: true,
        maxConcurrency: 5,
        queueSize: 10,
        queueTimeout: 30
      }

      await concurrencyManager.waitForSlot('resource-1', config, req1, res1)
      await concurrencyManager.waitForSlot('resource-2', config, req2, res2)

      const resources = concurrencyManager.listResources()
      expect(resources).toEqual(expect.arrayContaining(['resource-1', 'resource-2']))

      // 清理
      req1.close()
      req2.close()
    })
  })
})
