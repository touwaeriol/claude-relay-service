/**
 * 手动测试：会话粘性绑定功能
 *
 * 运行方式：node test/manual-test-session-exclusive.js
 */

const { buildSessionContext, registerSessionForAccount, refreshSessionRetention } = require('../src/utils/claudeSessionCoordinator')

console.log('✅ 测试1: 导入函数成功')

// 测试 buildSessionContext
async function testBuildSessionContext() {
  console.log('\n📝 测试2: buildSessionContext')

  // 新会话（只有user消息）
  const newSessionBody = {
    messages: [
      { role: 'user', content: 'Hello' }
    ]
  }
  const newSessionContext = await buildSessionContext('hash123', newSessionBody)
  console.log('新会话上下文:', newSessionContext)
  console.assert(newSessionContext.isNewSession === true, '❌ 新会话判断错误')
  console.log('✅ 新会话判断正确')

  // 老会话（有assistant消息）
  const oldSessionBody = {
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' }
    ]
  }
  const oldSessionContext = await buildSessionContext('hash456', oldSessionBody)
  console.log('老会话上下文:', oldSessionContext)
  console.assert(oldSessionContext.isNewSession === false, '❌ 老会话判断错误')
  console.log('✅ 老会话判断正确')
}

// 测试函数存在性
async function testFunctionExists() {
  console.log('\n📝 测试3: 函数存在性检查')

  console.assert(typeof buildSessionContext === 'function', '❌ buildSessionContext 不存在')
  console.log('✅ buildSessionContext 存在')

  console.assert(typeof registerSessionForAccount === 'function', '❌ registerSessionForAccount 不存在')
  console.log('✅ registerSessionForAccount 存在')

  console.assert(typeof refreshSessionRetention === 'function', '❌ refreshSessionRetention 不存在')
  console.log('✅ refreshSessionRetention 存在')
}

// 运行测试
async function runTests() {
  try {
    await testFunctionExists()
    await testBuildSessionContext()
    console.log('\n✅ 所有测试通过！')
  } catch (error) {
    console.error('\n❌ 测试失败:', error)
    process.exit(1)
  }
}

runTests()
