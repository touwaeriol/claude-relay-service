#!/usr/bin/env node
/**
 * 会话并发控制测试脚本
 *
 * 测试场景：
 * 1. 同一会话多次请求 - 验证同一会话的多次请求不会增加并发计数
 * 2. 不同会话未超限 - 验证不同会话在未超限时都能通过
 * 3. 达到会话上限 - 验证达到上限后新会话被拒绝
 * 4. 会话过期后释放 - 验证过期会话自动释放
 * 5. TTL刷新机制 - 验证每次请求都刷新TTL
 * 6. 配置验证 - 验证配置规范化
 */

const Redis = require('ioredis')
const crypto = require('crypto')

// 加载配置
require('dotenv').config()
const config = require('../config/config')
const sessionConcurrencyManager = require('../src/services/sessionConcurrencyManager')

// Redis 配置
const redisOptions = {
  host: config.redis.host,
  port: config.redis.port,
  db: config.redis.db
}

// 只有当密码非空时才添加
if (config.redis.password) {
  redisOptions.password = config.redis.password
}

const redis = new Redis(redisOptions)

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

// 生成会话哈希
function generateSessionHash(content) {
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

// 延迟函数
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 测试1: 同一会话多次请求
async function testSameSessionMultipleRequests() {
  log('cyan', '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log('cyan', '🧪 测试1: 同一会话多次请求')
  log('cyan', '验证同一会话的多次请求不会增加并发计数')
  log('cyan', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const accountId = 'test_session_concurrency_account_1'
  const sessionContent = { messages: [{ role: 'user', content: 'Test session 1' }] }
  const sessionHash = generateSessionHash(sessionContent)
  const redisKey = `session_concurrency:${accountId}`

  const testConfig = {
    enabled: true,
    maxSessions: 5,
    windowSeconds: 300 // 5分钟
  }

  log('blue', `会话Hash: ${sessionHash.substring(0, 16)}...`)
  log('blue', `账户ID: ${accountId}`)
  log('blue', `配置: maxSessions=${testConfig.maxSessions}, window=${testConfig.windowSeconds}s`)

  try {
    const results = []
    let sessionCount = 0

    // 发起10次相同会话的请求
    for (let i = 0; i < 10; i++) {
      const result = await sessionConcurrencyManager.checkSessionLimit(
        accountId,
        sessionHash,
        testConfig
      )
      results.push(result)

      if (i === 0) {
        log('yellow', `\n首次请求: ${result.allowed ? '✅ 允许' : '❌ 拒绝'}`)
      }

      // 检查Redis中的会话数
      const count = await redis.zcard(redisKey)
      sessionCount = count

      if ((i + 1) % 3 === 0) {
        log('blue', `  ✓ 完成 ${i + 1}/10 次请求，当前会话数: ${count}`)
      }
    }

    // 验证结果
    const allAllowed = results.every((r) => r.allowed === true)
    const finalCount = await redis.zcard(redisKey)

    log('yellow', `\n📊 统计结果:`)
    log('yellow', `  总请求数: 10`)
    log('yellow', `  全部允许: ${allAllowed ? '是' : '否'}`)
    log('yellow', `  最终会话数: ${finalCount}`)
    log('yellow', `  预期会话数: 1`)

    const passed = allAllowed && finalCount === 1

    if (passed) {
      log('green', '\n✅ 通过: 同一会话多次请求不会增加并发计数')
      log('green', `   所有请求都被允许，会话数始终为 1`)
    } else {
      log('red', '\n❌ 失败: 同一会话处理异常')
      if (!allAllowed) {
        log('red', `   有请求被拒绝`)
      }
      if (finalCount !== 1) {
        log('red', `   会话数异常: 预期1，实际${finalCount}`)
      }
    }

    return passed
  } finally {
    // 清理
    await redis.del(redisKey)
  }
}

// 测试2: 不同会话未超限
async function testDifferentSessionsWithinLimit() {
  log('cyan', '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log('cyan', '🧪 测试2: 不同会话未超限')
  log('cyan', '验证不同会话在未超限时都能通过')
  log('cyan', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const accountId = 'test_session_concurrency_account_2'
  const redisKey = `session_concurrency:${accountId}`

  const testConfig = {
    enabled: true,
    maxSessions: 5,
    windowSeconds: 300
  }

  log('blue', `账户ID: ${accountId}`)
  log('blue', `配置: maxSessions=${testConfig.maxSessions}, window=${testConfig.windowSeconds}s`)

  try {
    const sessions = []

    // 创建5个不同的会话
    for (let i = 0; i < 5; i++) {
      const sessionContent = { messages: [{ role: 'user', content: `Session ${i + 1}` }] }
      const sessionHash = generateSessionHash(sessionContent)

      const result = await sessionConcurrencyManager.checkSessionLimit(
        accountId,
        sessionHash,
        testConfig
      )

      sessions.push({
        index: i + 1,
        hash: sessionHash.substring(0, 12),
        allowed: result.allowed,
        stats: result.stats
      })

      const currentCount = await redis.zcard(redisKey)
      log(
        result.allowed ? 'green' : 'red',
        `  会话${i + 1}: ${result.allowed ? '✅' : '❌'} ${currentCount}/${testConfig.maxSessions} 会话`
      )
    }

    // 验证结果
    const allAllowed = sessions.every((s) => s.allowed === true)
    const finalCount = await redis.zcard(redisKey)

    log('yellow', `\n📊 统计结果:`)
    log('yellow', `  创建会话数: 5`)
    log('yellow', `  全部允许: ${allAllowed ? '是' : '否'}`)
    log('yellow', `  最终会话数: ${finalCount}`)
    log('yellow', `  预期会话数: 5`)

    const passed = allAllowed && finalCount === 5

    if (passed) {
      log('green', '\n✅ 通过: 不同会话在未超限时都能通过')
      log('green', `   所有5个会话都被允许`)
    } else {
      log('red', '\n❌ 失败: 不同会话处理异常')
      if (!allAllowed) {
        const rejectedCount = sessions.filter((s) => !s.allowed).length
        log('red', `   有 ${rejectedCount} 个会话被拒绝`)
      }
      if (finalCount !== 5) {
        log('red', `   会话数异常: 预期5，实际${finalCount}`)
      }
    }

    return passed
  } finally {
    // 清理
    await redis.del(redisKey)
  }
}

// 测试3: 达到会话上限
async function testSessionLimitExceeded() {
  log('cyan', '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log('cyan', '🧪 测试3: 达到会话上限')
  log('cyan', '验证达到上限后新会话被拒绝')
  log('cyan', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const accountId = 'test_session_concurrency_account_3'
  const redisKey = `session_concurrency:${accountId}`

  const testConfig = {
    enabled: true,
    maxSessions: 3,
    windowSeconds: 300
  }

  log('blue', `账户ID: ${accountId}`)
  log('blue', `配置: maxSessions=${testConfig.maxSessions}, window=${testConfig.windowSeconds}s`)

  try {
    const results = []

    // 创建4个不同的会话（超过上限）
    for (let i = 0; i < 4; i++) {
      const sessionContent = { messages: [{ role: 'user', content: `Session ${i + 1}` }] }
      const sessionHash = generateSessionHash(sessionContent)

      const result = await sessionConcurrencyManager.checkSessionLimit(
        accountId,
        sessionHash,
        testConfig
      )

      results.push(result)

      const currentCount = await redis.zcard(redisKey)
      log(
        result.allowed ? 'green' : 'red',
        `  会话${i + 1}: ${result.allowed ? '✅ 允许' : '❌ 拒绝'} | 当前: ${currentCount}/${testConfig.maxSessions}`
      )

      if (!result.allowed && result.error) {
        log('yellow', `    错误码: ${result.error.code}`)
        log('yellow', `    错误消息: ${result.error.message}`)
      }
    }

    // 验证结果
    const first3Allowed = results.slice(0, 3).every((r) => r.allowed === true)
    const fourth = results[3]
    const fourthRejected = fourth.allowed === false
    const correctErrorCode = fourth.error?.code === 'SESSION_LIMIT_EXCEEDED'

    log('yellow', `\n📊 统计结果:`)
    log('yellow', `  前3个会话: ${first3Allowed ? '全部允许' : '有拒绝'}`)
    log('yellow', `  第4个会话: ${fourthRejected ? '被拒绝' : '被允许'}`)
    log('yellow', `  错误码: ${fourth.error?.code || 'N/A'}`)

    const passed = first3Allowed && fourthRejected && correctErrorCode

    if (passed) {
      log('green', '\n✅ 通过: 达到上限后新会话正确被拒绝')
      log('green', `   前3个允许，第4个拒绝，错误码正确`)
    } else {
      log('red', '\n❌ 失败: 会话上限处理异常')
      if (!first3Allowed) {
        log('red', `   前3个会话应该被允许`)
      }
      if (!fourthRejected) {
        log('red', `   第4个会话应该被拒绝`)
      }
      if (!correctErrorCode) {
        log('red', `   错误码应该是 SESSION_LIMIT_EXCEEDED`)
      }
    }

    return passed
  } finally {
    // 清理
    await redis.del(redisKey)
  }
}

// 测试4: 会话过期后释放
async function testSessionExpiration() {
  log('cyan', '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log('cyan', '🧪 测试4: 会话过期后释放')
  log('cyan', '验证过期会话自动释放')
  log('cyan', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const accountId = 'test_session_concurrency_account_4'
  const redisKey = `session_concurrency:${accountId}`

  const testConfig = {
    enabled: true,
    maxSessions: 2,
    windowSeconds: 5 // 5秒窗口（测试用）
  }

  log('blue', `账户ID: ${accountId}`)
  log('blue', `配置: maxSessions=${testConfig.maxSessions}, window=${testConfig.windowSeconds}s`)
  log('yellow', `\n⚠️  此测试需要等待约6秒...`)

  try {
    // 创建2个会话（达到上限）
    const session1Content = { messages: [{ role: 'user', content: 'Session 1' }] }
    const session1Hash = generateSessionHash(session1Content)

    const session2Content = { messages: [{ role: 'user', content: 'Session 2' }] }
    const session2Hash = generateSessionHash(session2Content)

    await sessionConcurrencyManager.checkSessionLimit(accountId, session1Hash, testConfig)
    await sessionConcurrencyManager.checkSessionLimit(accountId, session2Hash, testConfig)

    let count = await redis.zcard(redisKey)
    log('green', `\n✅ 创建了2个会话: ${count}/${testConfig.maxSessions}`)

    // 尝试创建第3个会话（应该被拒绝）
    const session3Content = { messages: [{ role: 'user', content: 'Session 3' }] }
    const session3Hash = generateSessionHash(session3Content)

    const beforeResult = await sessionConcurrencyManager.checkSessionLimit(
      accountId,
      session3Hash,
      testConfig
    )

    log(beforeResult.allowed ? 'red' : 'green', `第3个会话: ${beforeResult.allowed ? '❌ 被允许（异常）' : '✅ 被拒绝（正确）'}`)

    // 等待6秒（超过5秒窗口）
    log('cyan', `\n⏳ 等待6秒让会话过期...`)
    await sleep(6000)

    // 再次尝试创建第3个会话（应该成功）
    const afterResult = await sessionConcurrencyManager.checkSessionLimit(
      accountId,
      session3Hash,
      testConfig
    )

    count = await redis.zcard(redisKey)
    log(afterResult.allowed ? 'green' : 'red', `6秒后再试: ${afterResult.allowed ? '✅ 被允许（正确）' : '❌ 被拒绝（异常）'}`)
    log('blue', `当前会话数: ${count}`)

    // 验证结果
    const passed = !beforeResult.allowed && afterResult.allowed

    if (passed) {
      log('green', '\n✅ 通过: 过期会话正确被清理并释放空间')
    } else {
      log('red', '\n❌ 失败: 会话过期处理异常')
      if (beforeResult.allowed) {
        log('red', `   过期前第3个会话应该被拒绝`)
      }
      if (!afterResult.allowed) {
        log('red', `   过期后第3个会话应该被允许`)
      }
    }

    return passed
  } finally {
    // 清理
    await redis.del(redisKey)
  }
}

// 测试5: TTL刷新机制
async function testTTLRefresh() {
  log('cyan', '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log('cyan', '🧪 测试5: TTL刷新机制')
  log('cyan', '验证每次请求都刷新TTL')
  log('cyan', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const accountId = 'test_session_concurrency_account_5'
  const redisKey = `session_concurrency:${accountId}`

  const testConfig = {
    enabled: true,
    maxSessions: 5,
    windowSeconds: 10 // 10秒窗口（测试用）
  }

  log('blue', `账户ID: ${accountId}`)
  log('blue', `配置: windowSeconds=${testConfig.windowSeconds}s`)
  log('yellow', `\n⚠️  此测试需要等待约4秒...`)

  const sessionContent = { messages: [{ role: 'user', content: 'TTL test session' }] }
  const sessionHash = generateSessionHash(sessionContent)

  try {
    // 首次请求
    await sessionConcurrencyManager.checkSessionLimit(accountId, sessionHash, testConfig)
    let ttl1 = await redis.ttl(redisKey)
    log('yellow', `\n首次请求后 TTL: ${ttl1}秒 (应该≈${testConfig.windowSeconds}秒)`)

    // 等待3秒
    log('cyan', `\n⏳ 等待3秒...`)
    await sleep(3000)

    // 检查TTL降低
    let ttl2 = await redis.ttl(redisKey)
    log('blue', `3秒后 TTL: ${ttl2}秒 (应该≈${testConfig.windowSeconds - 3}秒)`)

    // 再次请求（应该刷新TTL）
    await sessionConcurrencyManager.checkSessionLimit(accountId, sessionHash, testConfig)
    let ttl3 = await redis.ttl(redisKey)
    log('yellow', `\n再次请求后 TTL: ${ttl3}秒 (应该≈${testConfig.windowSeconds}秒)`)

    // 验证结果
    const initialTTLCorrect = ttl1 >= testConfig.windowSeconds - 1 && ttl1 <= testConfig.windowSeconds
    const decreasedTTLCorrect = ttl2 >= testConfig.windowSeconds - 4 && ttl2 <= testConfig.windowSeconds - 2
    const refreshedTTLCorrect = ttl3 >= testConfig.windowSeconds - 1 && ttl3 <= testConfig.windowSeconds

    log('yellow', `\n📊 验证结果:`)
    log(initialTTLCorrect ? 'green' : 'red', `  初始TTL: ${initialTTLCorrect ? '✅' : '❌'} ${ttl1}秒`)
    log(decreasedTTLCorrect ? 'green' : 'red', `  降低TTL: ${decreasedTTLCorrect ? '✅' : '❌'} ${ttl2}秒`)
    log(refreshedTTLCorrect ? 'green' : 'red', `  刷新TTL: ${refreshedTTLCorrect ? '✅' : '❌'} ${ttl3}秒`)

    const passed = initialTTLCorrect && decreasedTTLCorrect && refreshedTTLCorrect

    if (passed) {
      log('green', '\n✅ 通过: TTL正确刷新')
    } else {
      log('red', '\n❌ 失败: TTL刷新异常')
    }

    return passed
  } finally {
    // 清理
    await redis.del(redisKey)
  }
}

// 测试6: 配置验证
async function testConfigValidation() {
  log('cyan', '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log('cyan', '🧪 测试6: 配置验证')
  log('cyan', '验证配置规范化')
  log('cyan', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const accountId = 'test_session_concurrency_account_6'
  const sessionContent = { messages: [{ role: 'user', content: 'Config test' }] }
  const sessionHash = generateSessionHash(sessionContent)

  try {
    const tests = []

    // 测试6.1: null配置
    log('blue', '\n测试6.1: null配置')
    const result1 = await sessionConcurrencyManager.checkSessionLimit(accountId, sessionHash, null)
    tests.push({
      name: 'null配置',
      expected: true,
      actual: result1.allowed,
      passed: result1.allowed === true
    })
    log(result1.allowed ? 'green' : 'red', `  ${result1.allowed ? '✅' : '❌'} 结果: ${result1.allowed ? '允许（默认禁用）' : '拒绝'}`)

    // 测试6.2: 空对象配置
    log('blue', '\n测试6.2: 空对象配置')
    const result2 = await sessionConcurrencyManager.checkSessionLimit(accountId, sessionHash, {})
    tests.push({
      name: '空对象配置',
      expected: true,
      actual: result2.allowed,
      passed: result2.allowed === true
    })
    log(result2.allowed ? 'green' : 'red', `  ${result2.allowed ? '✅' : '❌'} 结果: ${result2.allowed ? '允许（默认禁用）' : '拒绝'}`)

    // 测试6.3: 字符串类型值
    log('blue', '\n测试6.3: 字符串类型值')
    const result3 = await sessionConcurrencyManager.checkSessionLimit(accountId, sessionHash, {
      enabled: 'true',
      maxSessions: '5',
      windowSeconds: '300'
    })
    tests.push({
      name: '字符串类型值',
      expected: true,
      actual: result3.allowed,
      passed: result3.allowed === true
    })
    log(result3.allowed ? 'green' : 'red', `  ${result3.allowed ? '✅' : '❌'} 结果: ${result3.allowed ? '允许（字符串转数字）' : '拒绝'}`)

    // 测试6.4: maxSessions=0
    log('blue', '\n测试6.4: maxSessions=0（应该自动修正为1）')
    const result4 = await sessionConcurrencyManager.checkSessionLimit(accountId, sessionHash, {
      enabled: true,
      maxSessions: 0,
      windowSeconds: 300
    })
    tests.push({
      name: 'maxSessions=0',
      expected: true,
      actual: result4.allowed,
      passed: result4.allowed === true
    })
    log(result4.allowed ? 'green' : 'red', `  ${result4.allowed ? '✅' : '❌'} 结果: ${result4.allowed ? '允许（修正为1）' : '拒绝'}`)

    // 测试6.5: windowSeconds=30（低于最小值）
    log('blue', '\n测试6.5: windowSeconds=30（应该自动修正为60）')
    const result5 = await sessionConcurrencyManager.checkSessionLimit(accountId, sessionHash, {
      enabled: true,
      maxSessions: 5,
      windowSeconds: 30
    })
    tests.push({
      name: 'windowSeconds=30',
      expected: true,
      actual: result5.allowed,
      passed: result5.allowed === true
    })
    log(result5.allowed ? 'green' : 'red', `  ${result5.allowed ? '✅' : '❌'} 结果: ${result5.allowed ? '允许（修正为60）' : '拒绝'}`)

    // 统计结果
    const allPassed = tests.every((t) => t.passed)

    log('yellow', `\n📊 统计结果:`)
    tests.forEach((t) => {
      log(t.passed ? 'green' : 'red', `  ${t.passed ? '✅' : '❌'} ${t.name}`)
    })

    if (allPassed) {
      log('green', '\n✅ 通过: 所有配置验证测试通过')
    } else {
      log('red', '\n❌ 失败: 有配置验证测试失败')
    }

    return allPassed
  } finally {
    // 清理
    await redis.del(`session_concurrency:${accountId}`)
  }
}

// 主测试流程
async function runTests() {
  log('cyan', '\n========================================')
  log('cyan', '  会话并发控制测试')
  log('cyan', '========================================\n')

  try {
    // 连接Redis
    log('cyan', '连接Redis...')
    await redis.ping()
    log('green', '✅ Redis连接成功\n')

    const results = []

    // 运行所有测试
    results.push(await testSameSessionMultipleRequests())
    await sleep(500)

    results.push(await testDifferentSessionsWithinLimit())
    await sleep(500)

    results.push(await testSessionLimitExceeded())
    await sleep(500)

    results.push(await testSessionExpiration())
    await sleep(500)

    results.push(await testTTLRefresh())
    await sleep(500)

    results.push(await testConfigValidation())

    // 汇总结果
    log('cyan', '\n========================================')
    log('cyan', '📊 测试结果汇总')
    log('cyan', '========================================')

    const testNames = [
      '测试1: 同一会话多次请求',
      '测试2: 不同会话未超限',
      '测试3: 达到会话上限',
      '测试4: 会话过期后释放',
      '测试5: TTL刷新机制',
      '测试6: 配置验证'
    ]

    results.forEach((passed, index) => {
      log(passed ? 'green' : 'red', `${passed ? '✅' : '❌'} ${testNames[index]}`)
    })

    const passedCount = results.filter((r) => r).length
    const totalCount = results.length
    const passRate = ((passedCount / totalCount) * 100).toFixed(1)

    // 获取全局统计
    const globalStats = sessionConcurrencyManager.getGlobalStats()
    log('cyan', '\n📈 全局统计:')
    log('yellow', `  总检查次数: ${globalStats.totalChecks}`)
    log('green', `  允许次数: ${globalStats.totalAllowed}`)
    log('red', `  拒绝次数: ${globalStats.totalRejected}`)
    log('blue', `  已存在会话: ${globalStats.totalExistingSessions}`)
    log('blue', `  新增会话: ${globalStats.totalNewSessions}`)
    log('cyan', `  成功率: ${globalStats.successRate.toFixed(1)}%`)

    log('cyan', '\n========================================')
    if (passedCount === totalCount) {
      log('green', `✅ 所有测试通过 (${passedCount}/${totalCount})`)
      log('green', '\n🎉 会话并发控制功能正常！')
    } else {
      log('yellow', `⚠️  部分测试通过 (${passedCount}/${totalCount}, ${passRate}%)`)
      log('yellow', '\n请检查失败的测试项')
    }
    log('cyan', '========================================\n')

    process.exit(passedCount === totalCount ? 0 : 1)
  } catch (error) {
    log('red', '\n❌ 测试失败:', error.message)
    console.error(error)
    process.exit(1)
  } finally {
    await redis.quit()
    await sessionConcurrencyManager.dispose()
    log('cyan', '✅ 连接已断开')
  }
}

// 运行测试
runTests()
