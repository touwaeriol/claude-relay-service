/**
 * Jest 测试环境设置
 */

// 加载测试专用的环境变量（优先级高于.env）
require('dotenv').config({ path: '.env.test' })

// 确保 NODE_ENV 设置为 test
process.env.NODE_ENV = 'test'

// 设置测试超时
jest.setTimeout(30000)

// 全局错误处理
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Promise Rejection in tests:', error)
})
