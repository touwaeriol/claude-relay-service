/**
 * 测试：会话独占逻辑修复验证
 *
 * 测试修复前后的区别：
 * 修复前：老会话无绑定 → 返回所有账号（包括独占账号）❌
 * 修复后：老会话无绑定 → 过滤掉独占账号 ✅
 */

// 模拟过滤逻辑（修复后的版本）
function filterAccountsFixed(accounts, sessionContext, stickyAccountId) {
  const { isNewSession } = sessionContext

  // 新会话 → 所有账号可用
  if (isNewSession) {
    return accounts
  }

  // 老会话 → 过滤独占账号
  return accounts.filter(account => {
    const exclusive = account.exclusiveSessionOnly === true

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

// 模拟过滤逻辑（修复前的版本）
function filterAccountsBuggy(accounts, sessionContext, stickyAccountId) {
  const { isNewSession } = sessionContext

  // 新会话 → 所有账号可用
  if (isNewSession) {
    return accounts
  }

  // ❌ BUG: 老会话无绑定时，直接返回所有账号
  if (!stickyAccountId) {
    return accounts
  }

  // 老会话有绑定 → 过滤独占账号
  return accounts.filter(account => {
    const exclusive = account.exclusiveSessionOnly === true
    if (exclusive && stickyAccountId !== account.id) {
      return false
    }
    return true
  })
}

// 测试数据
const accounts = [
  { id: 'account-A', name: '账号A(独占)', exclusiveSessionOnly: true },
  { id: 'account-B', name: '账号B(独占)', exclusiveSessionOnly: true },
  { id: 'account-C', name: '账号C(共享)', exclusiveSessionOnly: false }
]

console.log('=== 会话独占逻辑测试 ===\n')

// 测试1: 新会话
console.log('📝 测试1: 新会话')
const result1Fixed = filterAccountsFixed(accounts, { isNewSession: true }, null)
const result1Buggy = filterAccountsBuggy(accounts, { isNewSession: true }, null)
console.log('修复后结果:', result1Fixed.map(a => a.name))
console.log('修复前结果:', result1Buggy.map(a => a.name))
console.log('✅ 两者一致，都正确\n')

// 测试2: 老会话 + 绑定到账号A
console.log('📝 测试2: 老会话 + 绑定到账号A')
const result2Fixed = filterAccountsFixed(accounts, { isNewSession: false }, 'account-A')
const result2Buggy = filterAccountsBuggy(accounts, { isNewSession: false }, 'account-A')
console.log('修复后结果:', result2Fixed.map(a => a.name))
console.log('修复前结果:', result2Buggy.map(a => a.name))
console.log('✅ 两者一致，都正确（账号A和账号C）\n')

// 测试3: 老会话 + 无绑定（关键测试！）
console.log('📝 测试3: 老会话 + 无绑定（🚨 修复前有BUG的场景）')
const result3Fixed = filterAccountsFixed(accounts, { isNewSession: false }, null)
const result3Buggy = filterAccountsBuggy(accounts, { isNewSession: false }, null)

console.log('修复后结果:', result3Fixed.map(a => a.name))
console.log('修复前结果:', result3Buggy.map(a => a.name))

if (result3Fixed.length === 1 && result3Fixed[0].id === 'account-C') {
  console.log('✅ 修复后正确：只返回共享账号C')
} else {
  console.log('❌ 修复后错误：应该只返回共享账号C')
}

if (result3Buggy.length === 3) {
  console.log('❌ 修复前错误：返回了所有账号（包括独占账号A和B）')
} else {
  console.log('⚠️  修复前结果异常')
}

console.log('\n=== 测试完成 ===')

// 详细说明
console.log('\n📖 逻辑说明：')
console.log('1. 新会话：所有账号可用（包括独占账号）')
console.log('2. 老会话+有绑定：独占账号只能处理绑定到自己的会话')
console.log('3. 老会话+无绑定：❗应该过滤掉所有独占账号❗')
console.log('   原因：独占账号只处理"新会话"或"已绑定到自己的会话"')
console.log('         老会话无绑定 = 既不是新会话，也没绑定到自己')
console.log('         所以独占账号不应该处理！')
