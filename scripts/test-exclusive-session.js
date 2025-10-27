#!/usr/bin/env node

/**
 * Claude 独占会话逻辑测试脚本
 *
 * 测试场景：
 * 1. 独占模式开启时，同一客户端ID只能有一个活跃会话
 * 2. 新会话会抢占旧会话
 * 3. 旧会话绑定的清理逻辑
 * 4. 非独占模式下可以有多个并发会话
 */

const Redis = require('ioredis')
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')

// 加载配置
require('dotenv').config()
const config = require('../config/config')

const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  db: config.redis.db
})

// 生成客户端ID
function generateClientId() {
  const randomBytes = crypto.randomBytes(64)
  return randomBytes.toString('hex')
}

// 计算会话hash
function calculateSessionHash(content) {
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

// 创建测试账户
async function createMockAccount(exclusive = true) {
  const accountId = `test_exclusive_${Date.now()}`
  const clientId = generateClientId()

  const account = {
    id: accountId,
    name: `测试账户 - 独占会话${exclusive ? '(开启)' : '(关闭)'}`,
    accountType: 'claude-console',
    status: 'active',
    unifiedClientIds: [clientId],
    maxConcurrentSessions: 5,
    exclusiveSession: exclusive,
    createdAt: new Date().toISOString()
  }

  await redis.set(`claude_console_account:${accountId}`, JSON.stringify(account))

  console.log('✅ 创建模拟账户成功')
  console.log(`📋 账户ID: ${accountId}`)
  console.log(`🔑 客户端ID: ${clientId.substring(0, 16)}...`)
  console.log(`🔒 独占模式: ${exclusive ? '开启' : '关闭'}`)

  return { accountId, clientId }
}

// 模拟绑定会话到客户端ID
async function bindSessionToClient(clientId, sessionHash, accountId) {
  const bindingKey = `client_session_binding:${clientId}`
  const binding = {
    sessionHash,
    accountId,
    boundAt: new Date().toISOString()
  }

  await redis.set(bindingKey, JSON.stringify(binding), 'EX', 3600)

  return binding
}

// 获取客户端ID的当前绑定
async function getClientBinding(clientId) {
  const bindingKey = `client_session_binding:${clientId}`
  const data = await redis.get(bindingKey)
  return data ? JSON.parse(data) : null
}

// 测试1: 独占模式 - 新会话抢占旧会话
async function testExclusiveMode(accountId, clientId) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🧪 测试1: 独占模式 - 新会话抢占旧会话')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  // 创建第一个会话
  const session1Content = { messages: [{ role: 'user', content: 'Session 1' }] }
  const session1Hash = calculateSessionHash(session1Content)

  console.log(`\n📝 会话1 Hash: ${session1Hash.substring(0, 16)}...`)

  // 绑定会话1到客户端ID
  await bindSessionToClient(clientId, session1Hash, accountId)
  console.log('🔗 会话1 已绑定到客户端ID')

  // 验证绑定
  let binding = await getClientBinding(clientId)
  console.log(`✅ 当前绑定: ${binding.sessionHash.substring(0, 16)}...`)

  // 创建第二个会话（应该抢占会话1）
  await new Promise(resolve => setTimeout(resolve, 1000)) // 等待1秒
  const session2Content = { messages: [{ role: 'user', content: 'Session 2' }] }
  const session2Hash = calculateSessionHash(session2Content)

  console.log(`\n📝 会话2 Hash: ${session2Hash.substring(0, 16)}...`)

  // 模拟独占逻辑检查
  const oldBinding = await getClientBinding(clientId)
  console.log(`🔍 检测到旧会话: ${oldBinding.sessionHash.substring(0, 16)}...`)

  if (oldBinding && oldBinding.sessionHash !== session2Hash) {
    console.log('⚠️  独占模式：旧会话将被抢占')

    // 清理旧会话的绑定
    const oldStickyKey = `sticky_session:${oldBinding.sessionHash}`
    const deleted = await redis.del(oldStickyKey)
    console.log(`🗑️  清理旧会话绑定: ${deleted > 0 ? '成功' : '无需清理'}`)

    // 绑定新会话
    await bindSessionToClient(clientId, session2Hash, accountId)
    console.log('🔗 会话2 已绑定到客户端ID')
  }

  // 验证最终绑定
  binding = await getClientBinding(clientId)
  const isPreempted = binding.sessionHash === session2Hash

  console.log(`\n${isPreempted ? '✅' : '❌'} 会话抢占${isPreempted ? '成功' : '失败'}`)
  console.log(`📊 当前绑定: ${binding.sessionHash.substring(0, 16)}...`)

  return isPreempted
}

// 测试2: 非独占模式 - 允许多个会话
async function testNonExclusiveMode() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🧪 测试2: 非独占模式 - 允许多个会话')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const { accountId, clientId } = await createMockAccount(false)

  // 创建多个会话
  const sessions = []
  for (let i = 0; i < 3; i++) {
    const content = { messages: [{ role: 'user', content: `Session ${i + 1}` }] }
    const hash = calculateSessionHash(content)
    sessions.push(hash)

    // 非独占模式：不绑定到客户端ID，使用粘性会话
    const stickyKey = `sticky_session:${hash}`
    await redis.setex(stickyKey, 3600, JSON.stringify({
      accountId,
      clientId,
      boundAt: new Date().toISOString()
    }))

    console.log(`📝 会话${i + 1} Hash: ${hash.substring(0, 16)}...`)
    console.log(`  ✅ 创建粘性会话绑定`)
  }

  // 验证所有会话都存在
  console.log('\n🔍 验证所有会话绑定:')
  let allExist = true
  for (let i = 0; i < sessions.length; i++) {
    const exists = await redis.exists(`sticky_session:${sessions[i]}`)
    console.log(`  会话${i + 1}: ${exists ? '✅ 存在' : '❌ 不存在'}`)
    allExist = allExist && exists
  }

  // 清理
  await redis.del(`claude_console_account:${accountId}`)
  for (const hash of sessions) {
    await redis.del(`sticky_session:${hash}`)
  }

  console.log(`\n${allExist ? '✅' : '❌'} 多会话并发${allExist ? '成功' : '失败'}`)

  return allExist
}

// 测试3: 独占会话的过滤逻辑
async function testExclusiveSessionFiltering(accountId, clientId) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🧪 测试3: 独占会话的过滤逻辑')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  // 创建当前会话
  const currentContent = { messages: [{ role: 'user', content: 'Current session' }] }
  const currentHash = calculateSessionHash(currentContent)

  console.log(`📝 当前会话 Hash: ${currentHash.substring(0, 16)}...`)

  // 绑定到客户端ID
  await bindSessionToClient(clientId, currentHash, accountId)

  // 创建多个其他会话
  const otherSessions = []
  for (let i = 0; i < 3; i++) {
    const content = { messages: [{ role: 'user', content: `Other session ${i + 1}` }] }
    const hash = calculateSessionHash(content)
    otherSessions.push(hash)

    // 创建粘性会话
    const stickyKey = `sticky_session:${hash}`
    await redis.setex(stickyKey, 3600, JSON.stringify({
      accountId,
      clientId,
      boundAt: new Date().toISOString()
    }))

    console.log(`  📝 其他会话${i + 1}: ${hash.substring(0, 16)}...`)
  }

  // 模拟调度器的过滤逻辑
  console.log('\n🔍 模拟独占会话过滤:')

  // 获取当前客户端绑定
  const binding = await getClientBinding(clientId)
  console.log(`🔗 客户端ID当前绑定: ${binding.sessionHash.substring(0, 16)}...`)

  // 过滤掉非当前会话的账户
  const shouldFilter = (sessionHash) => {
    return binding && sessionHash !== binding.sessionHash
  }

  let filteredCount = 0
  for (let i = 0; i < otherSessions.length; i++) {
    const filtered = shouldFilter(otherSessions[i])
    console.log(`  会话${i + 1}: ${filtered ? '❌ 被过滤' : '✅ 通过'}`)
    if (filtered) filteredCount++
  }

  const currentPassed = !shouldFilter(currentHash)
  console.log(`  当前会话: ${currentPassed ? '✅ 通过' : '❌ 被过滤'}`)

  // 清理
  for (const hash of otherSessions) {
    await redis.del(`sticky_session:${hash}`)
  }

  const isCorrect = filteredCount === otherSessions.length && currentPassed

  console.log(`\n${isCorrect ? '✅' : '❌'} 过滤逻辑${isCorrect ? '正确' : '错误'}`)
  console.log(`📊 过滤统计: ${filteredCount}/${otherSessions.length} 个其他会话被过滤`)

  return isCorrect
}

// 测试4: 旧会话兼容性（没有绑定信息）
async function testLegacySessionCompatibility(accountId, clientId) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🧪 测试4: 旧会话兼容性（没有绑定信息）')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  // 创建旧会话（没有客户端ID绑定）
  const legacyContent = { messages: [{ role: 'user', content: 'Legacy session' }] }
  const legacyHash = calculateSessionHash(legacyContent)

  console.log(`📝 旧会话 Hash: ${legacyHash.substring(0, 16)}...`)

  // 只创建粘性会话，不绑定到客户端ID
  const stickyKey = `sticky_session:${legacyHash}`
  await redis.setex(stickyKey, 3600, JSON.stringify({
    accountId,
    // 注意：没有 clientId 字段
    boundAt: new Date().toISOString()
  }))

  console.log('🔗 创建旧格式的粘性会话（无客户端ID）')

  // 检查是否存在客户端绑定
  const binding = await getClientBinding(clientId)
  console.log(`🔍 检查客户端绑定: ${binding ? '存在' : '不存在'}`)

  // 模拟过滤逻辑：如果没有绑定，旧会话应该可以通过
  const shouldPassFilter = !binding
  console.log(`  旧会话应该: ${shouldPassFilter ? '✅ 通过过滤' : '❌ 被过滤'}`)

  // 清理
  await redis.del(stickyKey)

  console.log(`\n${shouldPassFilter ? '✅' : '❌'} 旧会话兼容性${shouldPassFilter ? '正常' : '异常'}`)

  return shouldPassFilter
}

// 清理测试数据
async function cleanup(accountId, clientId) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🧹 清理测试数据')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const patterns = [
    `claude_console_account:${accountId}`,
    `client_session_binding:${clientId}`,
    'sticky_session:*',
    'test_exclusive_*'
  ]

  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      const keys = await redis.keys(pattern)
      if (keys.length > 0) {
        await redis.del(...keys)
        console.log(`🗑️  删除: ${keys.length} 个 ${pattern} 键`)
      }
    } else {
      await redis.del(pattern)
      console.log(`🗑️  删除: ${pattern}`)
    }
  }

  console.log('✅ 清理完成')
}

// 主测试流程
async function runTests() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🧪 Claude 独占会话逻辑测试')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log()

  try {
    // 创建独占模式账户
    const { accountId, clientId } = await createMockAccount(true)

    // 执行测试
    const results = []
    results.push(await testExclusiveMode(accountId, clientId))
    results.push(await testNonExclusiveMode())
    results.push(await testExclusiveSessionFiltering(accountId, clientId))
    results.push(await testLegacySessionCompatibility(accountId, clientId))

    // 清理
    await cleanup(accountId, clientId)

    // 汇总结果
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('📊 测试结果汇总')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`✅ 通过: ${results.filter(r => r).length}/${results.length}`)
    console.log(`❌ 失败: ${results.filter(r => !r).length}/${results.length}`)
    console.log()

    const allPassed = results.every(r => r)
    if (allPassed) {
      console.log('🎉 所有测试通过！')
      process.exit(0)
    } else {
      console.log('❌ 部分测试失败')
      process.exit(1)
    }

  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  } finally {
    redis.disconnect()
  }
}

// 运行测试
if (require.main === module) {
  runTests()
}

module.exports = { runTests }
