#!/usr/bin/env node

/**
 * 测试客户端断开连接时，服务端能否正确释放并发槽位
 *
 * 使用方法：
 *   node scripts/test-client-disconnect.js
 */

const http = require('http')
const redis = require('ioredis')

const CONFIG = {
  apiKey: process.env.API_KEY || 'cr_test_key',
  apiKeyId: process.env.API_KEY_ID || 'test-key-id',
  baseUrl: 'localhost',
  port: 3000
}

const redisClient = new redis({
  host: 'localhost',
  port: 6379
})

/**
 * 获取当前并发数
 */
async function getConcurrency() {
  const key = `concurrency:${CONFIG.apiKeyId}`
  const count = await redisClient.zcard(key)
  return count
}

/**
 * 测试场景 1：正常请求完成
 */
async function testNormalCompletion() {
  console.log('\n=== 测试 1: 正常请求完成 ===')

  const before = await getConcurrency()
  console.log(`📊 初始并发数: ${before}`)

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: CONFIG.baseUrl,
        port: CONFIG.port,
        path: '/api/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': CONFIG.apiKey,
          'Content-Type': 'application/json'
        }
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', async () => {
          const during = await getConcurrency()
          console.log(`📊 请求处理中并发数: ${during}`)

          // 等待一下确保事件处理完成
          setTimeout(async () => {
            const after = await getConcurrency()
            console.log(`📊 请求完成后并发数: ${after}`)
            console.log(`✅ 结果: ${before} → ${during} → ${after}`)

            if (after === before) {
              console.log('✅ PASS: 并发槽位正确释放')
            } else {
              console.log(`❌ FAIL: 预期 ${before}, 实际 ${after}`)
            }
            resolve()
          }, 200)
        })
      }
    )

    req.write(
      JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'Say hi' }]
      })
    )
    req.end()
  })
}

/**
 * 测试场景 2：客户端主动中止（req.abort）
 */
async function testAbort() {
  console.log('\n=== 测试 2: 客户端主动中止 (req.abort) ===')

  const before = await getConcurrency()
  console.log(`📊 初始并发数: ${before}`)

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: CONFIG.baseUrl,
        port: CONFIG.port,
        path: '/api/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': CONFIG.apiKey,
          'Content-Type': 'application/json'
        }
      },
      (res) => {
        // 不应该到这里
        console.log('⚠️ 收到响应（不应该）')
      }
    )

    req.write(
      JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1000,
        messages: [{ role: 'user', content: 'Write a long story...' }]
      })
    )
    req.end()

    // 立即检查并发数（应该增加了）
    setTimeout(async () => {
      const during = await getConcurrency()
      console.log(`📊 请求发送后并发数: ${during}`)

      // 500ms 后主动中止
      console.log('🔴 主动中止请求 (req.abort)...')
      req.abort()

      // 等待事件处理
      setTimeout(async () => {
        const after = await getConcurrency()
        console.log(`📊 中止后并发数: ${after}`)
        console.log(`✅ 结果: ${before} → ${during} → ${after}`)

        if (after === before) {
          console.log('✅ PASS: 并发槽位正确释放')
        } else {
          console.log(`❌ FAIL: 预期 ${before}, 实际 ${after}`)
        }
        resolve()
      }, 500)
    }, 100)
  })
}

/**
 * 测试场景 3：客户端超时断开
 */
async function testTimeout() {
  console.log('\n=== 测试 3: 客户端超时断开 ===')

  const before = await getConcurrency()
  console.log(`📊 初始并发数: ${before}`)

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: CONFIG.baseUrl,
        port: CONFIG.port,
        path: '/api/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': CONFIG.apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 1000 // 1 秒超时
      },
      (res) => {
        console.log('⚠️ 收到响应')
      }
    )

    req.on('timeout', () => {
      console.log('⏱️ 请求超时，主动中止...')
      req.abort()
    })

    req.on('error', (err) => {
      console.log(`❌ 请求错误: ${err.message}`)
    })

    req.write(
      JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 2000,
        messages: [{ role: 'user', content: 'Write a very long essay...' }]
      })
    )
    req.end()

    // 检查初始并发数
    setTimeout(async () => {
      const during = await getConcurrency()
      console.log(`📊 请求发送后并发数: ${during}`)

      // 等待超时后检查
      setTimeout(async () => {
        const after = await getConcurrency()
        console.log(`📊 超时后并发数: ${after}`)
        console.log(`✅ 结果: ${before} → ${during} → ${after}`)

        if (after === before) {
          console.log('✅ PASS: 并发槽位正确释放')
        } else {
          console.log(`❌ FAIL: 预期 ${before}, 实际 ${after}`)
        }
        resolve()
      }, 2000)
    }, 100)
  })
}

/**
 * 测试场景 4：TCP 连接断开（destroy）
 */
async function testDestroy() {
  console.log('\n=== 测试 4: TCP 连接强制断开 (socket.destroy) ===')

  const before = await getConcurrency()
  console.log(`📊 初始并发数: ${before}`)

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: CONFIG.baseUrl,
        port: CONFIG.port,
        path: '/api/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': CONFIG.apiKey,
          'Content-Type': 'application/json'
        }
      },
      (res) => {
        console.log('⚠️ 收到响应（不应该）')
      }
    )

    req.write(
      JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1000,
        messages: [{ role: 'user', content: 'Tell me a story...' }]
      })
    )
    req.end()

    setTimeout(async () => {
      const during = await getConcurrency()
      console.log(`📊 请求发送后并发数: ${during}`)

      // 强制销毁底层 TCP 连接
      console.log('💥 强制销毁 TCP 连接 (socket.destroy)...')
      req.socket.destroy()

      setTimeout(async () => {
        const after = await getConcurrency()
        console.log(`📊 销毁后并发数: ${after}`)
        console.log(`✅ 结果: ${before} → ${during} → ${after}`)

        if (after === before) {
          console.log('✅ PASS: 并发槽位正确释放')
        } else {
          console.log(`❌ FAIL: 预期 ${before}, 实际 ${after}`)
        }
        resolve()
      }, 500)
    }, 100)
  })
}

/**
 * 主函数
 */
async function main() {
  try {
    console.log('🚀 开始测试客户端断开连接场景...\n')
    console.log(`配置: API Key ID = ${CONFIG.apiKeyId}`)

    // 依次运行测试
    await testNormalCompletion()
    await new Promise((r) => setTimeout(r, 1000))

    await testAbort()
    await new Promise((r) => setTimeout(r, 1000))

    await testTimeout()
    await new Promise((r) => setTimeout(r, 1000))

    await testDestroy()

    console.log('\n✅ 所有测试完成！')
    process.exit(0)
  } catch (error) {
    console.error('\n❌ 测试失败:', error)
    process.exit(1)
  } finally {
    redisClient.disconnect()
  }
}

// 运行测试
if (require.main === module) {
  main()
}
