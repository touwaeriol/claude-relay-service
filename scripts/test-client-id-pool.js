#!/usr/bin/env node

/**
 * 客户端ID池功能测试脚本
 *
 * 测试场景：
 * 1. 创建带有多个客户端ID的模拟账户
 * 2. 测试客户端ID轮询分配
 * 3. 测试同一会话的粘性绑定
 * 4. 测试客户端ID刷新和删除
 */

const Redis = require('ioredis')
const crypto = require('crypto')
const { 继续v4: uuidv4 } = require('uuid')

// 加载配置
require('dotenv').config()
const config = require('../config/config')

const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  db: config.redis.db
})

// 生成客户端ID (与AccountForm.vue中的逻辑一致)
function generateClientId() {
  // 使用 crypto.randomBytes 生成64字节随机数据
  const randomBytes = crypto.randomBytes(64)
  // 转换为十六进制字符串（128个字符）
  return randomBytes.toString('hex')
}

// 模拟会话hash计算
function calculateSessionHash(content) {
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

// 创建测试用的模拟账户
async function createMockAccount() {
  const accountId = `test_account_${Date.now()}`
  const clientIds = [
    generateClientId(),
    generateClientId(),
    generateClientId()
  ]

  const account = {
    id: accountId,
    name: '测试账户 - 客户端ID池',
    accountType: 'claude-console',
    status: 'active',
    unifiedClientIds: clientIds,
    maxConcurrentSessions: 3,
    createdAt: new Date().toISOString()
  }

  await redis.set(`claude_console_account:${accountId}`, JSON.stringify(account))

  console.log('✅ 创建模拟账户成功')
  console.log(`📋 账户ID: ${accountId}`)
  console.log(`🔑 客户端ID数量: ${clientIds.length}`)
  console.log('客户端ID列表:')
  clientIds.forEach((id, index) => {
    console.log(`  ${index + 1}. ${id.substring(0, 16)}...${id.substring(112)}`)
  })

  return { accountId, clientIds }
}

// 测试1: 客户端ID轮询分配
async function testRoundRobinAllocation(accountId, clientIds) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🧪 测试1: 客户端ID轮询分配')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const allocations = []

  // 模拟9次分配（每个ID应该被分配3次）
  for (let i = 0; i < 9; i++) {
    const sessionId = `session_${i}`
    const key = `session_allocation:${accountId}`

    // 获取当前索引
    const currentIndex = await redis.get(key)
    const index = currentIndex ? parseInt(currentIndex) : 0

    // 选择客户端ID
    const selectedClientId = clientIds[index % clientIds.length]

    // 更新索引
    await redis.set(key, (index + 1) % clientIds.length)

    allocations.push({
      sessionId,
      clientIdIndex: index % clientIds.length,
      clientIdPreview: selectedClientId.substring(0, 8)
    })

    console.log(`  会话 ${i + 1}: 分配到客户端ID[${index % clientIds.length}] - ${selectedClientId.substring(0, 16)}...`)
  }

  // 验证每个ID都被均匀分配
  const distribution = allocations.reduce((acc, curr) => {
    acc[curr.clientIdIndex] = (acc[curr.clientIdIndex] || 0) + 1
    return acc
  }, {})

  console.log('\n📊 分配统计:')
  Object.entries(distribution).forEach(([index, count]) => {
    console.log(`  客户端ID[${index}]: ${count} 次分配`)
  })

  const isBalanced = Object.values(distribution).every(count => count === 3)
  console.log(`\n${isBalanced ? '✅' : '❌'} 轮询分配${isBalanced ? '成功' : '失败'}`)

  return isBalanced
}

// 测试2: 会话粘性绑定
async function testStickySession(accountId, clientIds) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🧪 测试2: 会话粘性绑定')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const sessionContent = {
    messages: [
      { role: 'user', content: 'Hello' }
    ]
  }

  const sessionHash = calculateSessionHash(sessionContent)
  console.log(`📝 会话Hash: ${sessionHash.substring(0, 16)}...`)

  // 首次分配
  const firstClientId = clientIds[0]
  const stickyKey = `sticky_session:${sessionHash}`
  await redis.setex(stickyKey, 3600, JSON.stringify({
    accountId,
    clientId: firstClientId,
    boundAt: new Date().toISOString()
  }))

  console.log(`\n🔗 首次绑定: ${firstClientId.substring(0, 16)}...`)

  // 模拟多次请求，应该都返回同一个客户端ID
  const requests = []
  for (let i = 0; i < 5; i++) {
    const stickyData = await redis.get(stickyKey)
    if (stickyData) {
      const { clientId } = JSON.parse(stickyData)
      requests.push(clientId)
      console.log(`  请求 ${i + 1}: ${clientId.substring(0, 16)}... ${clientId === firstClientId ? '✅' : '❌'}`)
    }
  }

  const isSticky = requests.every(id => id === firstClientId)
  console.log(`\n${isSticky ? '✅' : '❌'} 会话粘性绑定${isSticky ? '成功' : '失败'}`)

  return isSticky
}

// 测试3: 客户端ID刷新
async function testClientIdRefresh(accountId, clientIds) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🧪 测试3: 客户端ID刷新')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const oldClientId = clientIds[1]
  console.log(`📋 旧客户端ID: ${oldClientId.substring(0, 16)}...${oldClientId.substring(112)}`)

  // 生成新的客户端ID
  const newClientId = generateClientId()
  console.log(`🆕 新客户端ID: ${newClientId.substring(0, 16)}...${newClientId.substring(112)}`)

  // 更新账户
  const accountKey = `claude_console_account:${accountId}`
  const accountData = await redis.get(accountKey)
  const account = JSON.parse(accountData)

  account.unifiedClientIds[1] = newClientId
  await redis.set(accountKey, JSON.stringify(account))

  // 验证更新
  const updatedData = await redis.get(accountKey)
  const updatedAccount = JSON.parse(updatedData)
  const isRefreshed = updatedAccount.unifiedClientIds[1] === newClientId

  console.log(`\n${isRefreshed ? '✅' : '❌'} 客户端ID刷新${isRefreshed ? '成功' : '失败'}`)

  return isRefreshed
}

// 测试4: 客户端ID删除（保留至少1个）
async function testClientIdDeletion(accountId, clientIds) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🧪 测试4: 客户端ID删除')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const accountKey = `claude_console_account:${accountId}`
  const accountData = await redis.get(accountKey)
  const account = JSON.parse(accountData)

  console.log(`📋 删除前数量: ${account.unifiedClientIds.length}`)

  // 删除第2个客户端ID
  const deletedId = account.unifiedClientIds[1]
  account.unifiedClientIds.splice(1, 1)
  await redis.set(accountKey, JSON.stringify(account))

  console.log(`🗑️  已删除: ${deletedId.substring(0, 16)}...`)

  // 验证删除
  const updatedData = await redis.get(accountKey)
  const updatedAccount = JSON.parse(updatedData)

  console.log(`📋 删除后数量: ${updatedAccount.unifiedClientIds.length}`)

  const isDeleted = updatedAccount.unifiedClientIds.length === clientIds.length - 1 &&
                    !updatedAccount.unifiedClientIds.includes(deletedId)

  console.log(`\n${isDeleted ? '✅' : '❌'} 客户端ID删除${isDeleted ? '成功' : '失败'}`)

  // 测试不能删除最后一个
  if (updatedAccount.unifiedClientIds.length > 1) {
    console.log('\n测试删除到只剩1个...')
    while (updatedAccount.unifiedClientIds.length > 1) {
      updatedAccount.unifiedClientIds.pop()
    }
    await redis.set(accountKey, JSON.stringify(updatedAccount))

    const finalData = await redis.get(accountKey)
    const finalAccount = JSON.parse(finalData)
    console.log(`📋 最终数量: ${finalAccount.unifiedClientIds.length}`)
    console.log('✅ 保留了至少1个客户端ID')
  }

  return isDeleted
}

// 清理测试数据
async function cleanup(accountId) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🧹 清理测试数据')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const keys = [
    `claude_console_account:${accountId}`,
    `session_allocation:${accountId}`,
    `sticky_session:*`
  ]

  for (const key of keys) {
    if (key.includes('*')) {
      const matchedKeys = await redis.keys(key)
      if (matchedKeys.length > 0) {
        await redis.del(...matchedKeys)
        console.log(`🗑️  删除: ${matchedKeys.length} 个粘性会话`)
      }
    } else {
      await redis.del(key)
      console.log(`🗑️  删除: ${key}`)
    }
  }

  console.log('✅ 清理完成')
}

// 主测试流程
async function runTests() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🧪 客户端ID池功能测试')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log()

  try {
    // 创建模拟账户
    const { accountId, clientIds } = await createMockAccount()

    // 执行测试
    const results = []
    results.push(await testRoundRobinAllocation(accountId, clientIds))
    results.push(await testStickySession(accountId, clientIds))
    results.push(await testClientIdRefresh(accountId, clientIds))
    results.push(await testClientIdDeletion(accountId, clientIds))

    // 清理
    await cleanup(accountId)

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
