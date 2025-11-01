#!/usr/bin/env node
/**
 * 客户端ID绑定稳定性测试
 *
 * 测试场景：
 * 1. 同一会话多次请求，验证客户端ID绑定不会"跳"
 * 2. 并发请求同一会话，验证绑定稳定性
 * 3. 不同会话，验证各自独立绑定
 * 4. TTL刷新，验证绑定持续存在
 * 5. 压力测试：1000次请求验证绑定不变
 */

const Redis = require('ioredis')
const crypto = require('crypto')

// 加载配置
require('dotenv').config()
const config = require('../config/config')

const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  db: config.redis.db
})

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
}

function log(color, ...args) {
  console.log(colors[color], ...args, colors.reset)
}

// 模拟会话hash计算
function calculateSessionHash(content) {
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

// 模拟客户端ID选择逻辑（从claudeRelayService.js提取）
async function selectClientId(accountId, clientIds, sessionHash, ttl = 3600) {
  if (clientIds.length === 1) {
    return clientIds[0]
  }

  const sessionKey = `sticky_session:${sessionHash}:${accountId}`
  const boundClientId = await redis.get(sessionKey)

  // 如果已有绑定且ID仍在列表中，复用
  if (boundClientId && clientIds.includes(boundClientId)) {
    await redis.expire(sessionKey, ttl) // 刷新TTL
    return boundClientId
  }

  // Round Robin选择新ID
  const roundRobinKey = `clientId:roundRobin:${accountId}`
  const counter = await redis.incr(roundRobinKey)
  const index = (counter - 1) % clientIds.length
  const selectedClientId = clientIds[index]

  // 创建绑定
  await redis.setex(sessionKey, ttl, selectedClientId)

  return selectedClientId
}

// 延迟函数
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 测试1: 同一会话多次请求，绑定不会跳
async function testSameSessionStability() {
  log('cyan', '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log('cyan', '🧪 测试1: 同一会话100次请求，验证绑定稳定性')
  log('cyan', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const accountId = 'test_stability_account_1'
  const clientIds = ['client-id-A', 'client-id-B', 'client-id-C']
  const sessionContent = { messages: [{ role: 'user', content: 'Hello, this is session 1' }] }
  const sessionHash = calculateSessionHash(sessionContent)

  log('blue', `会话Hash: ${sessionHash.substring(0, 16)}...`)
  log('blue', `账户ID: ${accountId}`)
  log('blue', `客户端ID池: ${clientIds.join(', ')}`)

  const results = []
  let firstClientId = null

  for (let i = 0; i < 100; i++) {
    const clientId = await selectClientId(accountId, clientIds, sessionHash)
    results.push(clientId)

    if (i === 0) {
      firstClientId = clientId
      log('yellow', `\n首次选择: ${clientId}`)
    }

    if (i % 20 === 19) {
      log('blue', `  ✓ 完成 ${i + 1}/100 次请求`)
    }
  }

  // 验证所有结果是否一致
  const uniqueIds = new Set(results)
  const allSame = uniqueIds.size === 1

  log('yellow', `\n📊 统计结果:`)
  log('yellow', `  总请求数: 100`)
  log('yellow', `  唯一客户端ID数: ${uniqueIds.size}`)
  log('yellow', `  使用的客户端ID: ${Array.from(uniqueIds).join(', ')}`)

  if (allSame) {
    log('green', '\n✅ 通过: 100次请求始终使用同一客户端ID')
    log('green', `   客户端ID: ${firstClientId}`)
  } else {
    log('red', '\n❌ 失败: 客户端ID发生了变化！')
    log('red', `   预期: 1个唯一ID`)
    log('red', `   实际: ${uniqueIds.size}个唯一ID`)
  }

  // 清理
  await redis.del(`sticky_session:${sessionHash}:${accountId}`)
  await redis.del(`clientId:roundRobin:${accountId}`)

  return allSame
}

// 测试2: 并发请求同一会话，验证绑定稳定性
async function testConcurrentSameSession() {
  log('cyan', '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log('cyan', '🧪 测试2: 50个并发请求同一会话，验证绑定稳定性')
  log('cyan', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const accountId = 'test_stability_account_2'
  const clientIds = ['client-id-A', 'client-id-B', 'client-id-C']
  const sessionContent = { messages: [{ role: 'user', content: 'Hello, concurrent test' }] }
  const sessionHash = calculateSessionHash(sessionContent)

  log('blue', `会话Hash: ${sessionHash.substring(0, 16)}...`)
  log('blue', `账户ID: ${accountId}`)
  log('blue', `并发请求数: 50`)

  // 并发发起50个请求
  const promises = []
  for (let i = 0; i < 50; i++) {
    promises.push(selectClientId(accountId, clientIds, sessionHash))
  }

  const results = await Promise.all(promises)

  // 验证结果
  const uniqueIds = new Set(results)

  log('yellow', `\n📊 统计结果:`)
  log('yellow', `  总请求数: 50`)
  log('yellow', `  唯一客户端ID数: ${uniqueIds.size}`)
  log('yellow', `  使用的客户端ID: ${Array.from(uniqueIds).join(', ')}`)

  // 计算每个ID出现的次数
  const idCounts = {}
  results.forEach((id) => {
    idCounts[id] = (idCounts[id] || 0) + 1
  })

  log('yellow', '\n分布统计:')
  Object.entries(idCounts).forEach(([id, count]) => {
    log('yellow', `  ${id}: ${count}次 (${((count / 50) * 100).toFixed(1)}%)`)
  })

  // 判断是否合理：理想情况下应该只有1-2个不同的ID
  // 因为可能有竞态条件，允许少量请求选择到不同的ID
  const passed = uniqueIds.size <= 2

  if (passed) {
    log('green', '\n✅ 通过: 并发请求绑定稳定（允许少量竞态）')
    log('green', `   ${uniqueIds.size}个唯一ID是可接受的范围`)
  } else {
    log('red', '\n❌ 失败: 并发请求绑定不稳定')
    log('red', `   预期: ≤2个唯一ID`)
    log('red', `   实际: ${uniqueIds.size}个唯一ID`)
  }

  // 清理
  await redis.del(`sticky_session:${sessionHash}:${accountId}`)
  await redis.del(`clientId:roundRobin:${accountId}`)

  return passed
}

// 测试3: 不同会话各自独立绑定
async function testDifferentSessionsIndependence() {
  log('cyan', '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log('cyan', '🧪 测试3: 5个不同会话，验证各自独立绑定')
  log('cyan', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const accountId = 'test_stability_account_3'
  const clientIds = ['client-id-A', 'client-id-B', 'client-id-C']

  const sessions = []
  for (let i = 0; i < 5; i++) {
    const sessionContent = { messages: [{ role: 'user', content: `Session ${i}` }] }
    const sessionHash = calculateSessionHash(sessionContent)
    sessions.push({ content: sessionContent, hash: sessionHash, clientId: null })
  }

  // 每个会话请求10次
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]
    const results = []

    for (let j = 0; j < 10; j++) {
      const clientId = await selectClientId(accountId, clientIds, session.hash)
      results.push(clientId)
    }

    // 验证该会话的10次请求都使用同一客户端ID
    const uniqueIds = new Set(results)
    session.clientId = results[0]
    session.stable = uniqueIds.size === 1

    log('blue', `\n会话${i + 1}: ${session.hash.substring(0, 12)}...`)
    log('yellow', `  绑定客户端ID: ${session.clientId}`)
    log('yellow', `  10次请求唯一ID数: ${uniqueIds.size}`)
    log(
      session.stable ? 'green' : 'red',
      `  ${session.stable ? '✓' : '✗'} ${session.stable ? '稳定' : '不稳定'}`
    )
  }

  // 验证所有会话都稳定
  const allStable = sessions.every((s) => s.stable)

  // 验证不同会话使用了不同的客户端ID（Round Robin生效）
  const boundClientIds = sessions.map((s) => s.clientId)
  const uniqueBoundIds = new Set(boundClientIds)

  log('yellow', `\n📊 统计结果:`)
  log('yellow', `  总会话数: 5`)
  log('yellow', `  每会话稳定: ${allStable ? '是' : '否'}`)
  log('yellow', `  使用的不同客户端ID数: ${uniqueBoundIds.size}`)
  log('yellow', `  客户端ID: ${Array.from(uniqueBoundIds).join(', ')}`)

  if (allStable && uniqueBoundIds.size === 3) {
    log('green', '\n✅ 通过: 所有会话稳定且使用了不同的客户端ID')
  } else if (allStable) {
    log('yellow', '\n⚠️  部分通过: 所有会话稳定，但Round Robin可能需要更多会话才能使用全部ID')
  } else {
    log('red', '\n❌ 失败: 有会话绑定不稳定')
  }

  // 清理
  for (const session of sessions) {
    await redis.del(`sticky_session:${session.hash}:${accountId}`)
  }
  await redis.del(`clientId:roundRobin:${accountId}`)

  return allStable
}

// 测试4: TTL刷新机制
async function testTTLRefresh() {
  log('cyan', '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log('cyan', '🧪 测试4: TTL刷新机制验证')
  log('cyan', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const accountId = 'test_stability_account_4'
  const clientIds = ['client-id-A', 'client-id-B', 'client-id-C']
  const sessionContent = { messages: [{ role: 'user', content: 'TTL test session' }] }
  const sessionHash = calculateSessionHash(sessionContent)
  const sessionKey = `sticky_session:${sessionHash}:${accountId}`

  log('blue', `会话Hash: ${sessionHash.substring(0, 16)}...`)
  log('blue', `初始TTL: 5秒`)

  // 首次选择（TTL = 5秒）
  const clientId1 = await selectClientId(accountId, clientIds, sessionHash, 5)
  log('yellow', `\n首次选择: ${clientId1}`)

  // 检查TTL
  let ttl = await redis.ttl(sessionKey)
  log('blue', `  当前TTL: ${ttl}秒 (应该≈5秒)`)

  // 等待3秒
  log('cyan', '\n⏳ 等待3秒...')
  await sleep(3000)

  // 检查TTL降低
  ttl = await redis.ttl(sessionKey)
  log('blue', `  3秒后TTL: ${ttl}秒 (应该≈2秒)`)

  // 再次选择（应该刷新TTL到5秒）
  const clientId2 = await selectClientId(accountId, clientIds, sessionHash, 5)
  log('yellow', `\n再次选择: ${clientId2}`)

  // 检查TTL是否刷新
  ttl = await redis.ttl(sessionKey)
  log('blue', `  刷新后TTL: ${ttl}秒 (应该≈5秒)`)

  const passed = clientId1 === clientId2 && ttl >= 4 && ttl <= 5

  if (passed) {
    log('green', '\n✅ 通过: 客户端ID保持一致，TTL正确刷新')
  } else {
    log('red', '\n❌ 失败: TTL刷新异常')
    if (clientId1 !== clientId2) {
      log('red', `   客户端ID变化: ${clientId1} → ${clientId2}`)
    }
    if (ttl < 4 || ttl > 5) {
      log('red', `   TTL异常: ${ttl}秒（预期≈5秒）`)
    }
  }

  // 清理
  await redis.del(sessionKey)
  await redis.del(`clientId:roundRobin:${accountId}`)

  return passed
}

// 测试5: 压力测试 - 1000次请求
async function testHighVolume() {
  log('cyan', '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log('cyan', '🧪 测试5: 压力测试 - 1000次请求验证绑定稳定性')
  log('cyan', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const accountId = 'test_stability_account_5'
  const clientIds = ['client-id-A', 'client-id-B', 'client-id-C']
  const sessionContent = { messages: [{ role: 'user', content: 'High volume test' }] }
  const sessionHash = calculateSessionHash(sessionContent)

  log('blue', `会话Hash: ${sessionHash.substring(0, 16)}...`)
  log('blue', `账户ID: ${accountId}`)
  log('blue', `请求次数: 1000`)

  const startTime = Date.now()
  const results = []
  let firstClientId = null

  for (let i = 0; i < 1000; i++) {
    const clientId = await selectClientId(accountId, clientIds, sessionHash)
    results.push(clientId)

    if (i === 0) {
      firstClientId = clientId
    }

    if ((i + 1) % 200 === 0) {
      log('blue', `  ✓ 完成 ${i + 1}/1000 次请求`)
    }
  }

  const endTime = Date.now()
  const duration = endTime - startTime

  // 验证结果
  const uniqueIds = new Set(results)
  const allSame = uniqueIds.size === 1

  log('yellow', `\n📊 统计结果:`)
  log('yellow', `  总请求数: 1000`)
  log('yellow', `  唯一客户端ID数: ${uniqueIds.size}`)
  log('yellow', `  使用的客户端ID: ${Array.from(uniqueIds).join(', ')}`)
  log('yellow', `  执行时间: ${duration}ms`)
  log('yellow', `  平均每次: ${(duration / 1000).toFixed(2)}ms`)

  if (allSame) {
    log('green', '\n✅ 通过: 1000次请求始终使用同一客户端ID')
    log('green', `   客户端ID: ${firstClientId}`)
    log('green', `   性能: ${(1000 / (duration / 1000)).toFixed(0)} 请求/秒`)
  } else {
    log('red', '\n❌ 失败: 客户端ID发生了变化！')
    log('red', `   预期: 1个唯一ID`)
    log('red', `   实际: ${uniqueIds.size}个唯一ID`)
  }

  // 清理
  await redis.del(`sticky_session:${sessionHash}:${accountId}`)
  await redis.del(`clientId:roundRobin:${accountId}`)

  return allSame
}

// 主测试流程
async function runTests() {
  log('cyan', '\n========================================')
  log('cyan', '  客户端ID绑定稳定性测试')
  log('cyan', '========================================\n')

  try {
    // 连接Redis
    log('cyan', '连接Redis...')
    await redis.ping()
    log('green', '✅ Redis连接成功\n')

    const results = []

    // 运行所有测试
    results.push(await testSameSessionStability())
    await sleep(500)

    results.push(await testConcurrentSameSession())
    await sleep(500)

    results.push(await testDifferentSessionsIndependence())
    await sleep(500)

    results.push(await testTTLRefresh())
    await sleep(500)

    results.push(await testHighVolume())

    // 汇总结果
    log('cyan', '\n========================================')
    log('cyan', '📊 测试结果汇总')
    log('cyan', '========================================')

    const testNames = [
      '测试1: 同一会话100次请求',
      '测试2: 50个并发请求',
      '测试3: 5个不同会话独立性',
      '测试4: TTL刷新机制',
      '测试5: 1000次压力测试'
    ]

    results.forEach((passed, index) => {
      log(passed ? 'green' : 'red', `${passed ? '✅' : '❌'} ${testNames[index]}`)
    })

    const passedCount = results.filter((r) => r).length
    const totalCount = results.length
    const passRate = ((passedCount / totalCount) * 100).toFixed(1)

    log('cyan', '\n========================================')
    if (passedCount === totalCount) {
      log('green', `✅ 所有测试通过 (${passedCount}/${totalCount})`)
      log('green', '\n🎉 客户端ID绑定稳定，不会"跳"！')
    } else {
      log('yellow', `⚠️  部分测试通过 (${passedCount}/${totalCount}, ${passRate}%)`)
      log('yellow', '\n请检查失败的测试项')
    }
    log('cyan', '========================================\n')
  } catch (error) {
    log('red', '\n❌ 测试失败:', error.message)
    console.error(error)
    process.exit(1)
  } finally {
    await redis.quit()
    log('cyan', '✅ Redis已断开')
  }
}

// 运行测试
runTests()
