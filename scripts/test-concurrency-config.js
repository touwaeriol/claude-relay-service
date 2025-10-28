#!/usr/bin/env node

/**
 * 测试 API Key 并发配置的完整流程
 *
 * 测试内容：
 * 1. 创建 API Key 时保存并发配置
 * 2. 查询 API Key 时正确返回并发配置
 * 3. 验证时正确解析并发配置
 */

const apiKeyService = require('../src/services/apiKeyService')
const logger = require('../src/utils/logger')
const redis = require('../src/models/redis')

async function testConcurrencyConfig() {
  console.log('\n🧪 开始测试 API Key 并发配置...\n')

  // 连接 Redis
  console.log('📡 连接 Redis...')
  await redis.connect()
  console.log('✅ Redis 连接成功\n')

  try {
    // ========== 测试 1: 创建 API Key（启用并发控制）==========
    console.log('📝 测试 1: 创建 API Key（启用并发控制）')
    const createData = {
      name: 'Test-Concurrency-Enabled',
      description: '测试并发控制配置',
      concurrencyConfig: {
        enabled: true,
        maxConcurrency: 5,
        queueSize: 10,
        queueTimeout: 30
      }
    }

    const result1 = await apiKeyService.generateApiKey(createData)
    console.log('✅ API Key 创建成功:', result1.id)
    console.log('   并发配置:', JSON.stringify(result1.concurrencyConfig, null, 2))

    // 验证保存的配置
    if (
      result1.concurrencyConfig.enabled === true &&
      result1.concurrencyConfig.maxConcurrency === 5 &&
      result1.concurrencyConfig.queueSize === 10 &&
      result1.concurrencyConfig.queueTimeout === 30
    ) {
      console.log('✅ 并发配置保存正确\n')
    } else {
      console.error('❌ 并发配置保存错误:', result1.concurrencyConfig)
      process.exit(1)
    }

    // ========== 测试 2: 创建 API Key（禁用并发控制）==========
    console.log('📝 测试 2: 创建 API Key（禁用并发控制）')
    const result2 = await apiKeyService.generateApiKey({
      name: 'Test-Concurrency-Disabled',
      description: '测试禁用并发控制',
      concurrencyConfig: {
        enabled: false,
        maxConcurrency: 1,
        queueSize: 0,
        queueTimeout: 60
      }
    })

    console.log('✅ API Key 创建成功:', result2.id)
    console.log('   并发配置:', JSON.stringify(result2.concurrencyConfig, null, 2))

    if (result2.concurrencyConfig.enabled === false) {
      console.log('✅ 禁用状态保存正确\n')
    } else {
      console.error('❌ 禁用状态保存错误')
      process.exit(1)
    }

    // ========== 测试 3: 查询 API Key（验证返回数据）==========
    console.log('📝 测试 3: 查询 API Key（验证返回数据）')
    const validation = await apiKeyService.validateApiKey(result1.apiKey)

    if (!validation.valid) {
      console.error('❌ API Key 验证失败:', validation.error)
      process.exit(1)
    }

    console.log('✅ API Key 验证成功')
    console.log('   返回的并发配置:', JSON.stringify(validation.keyData.concurrencyConfig, null, 2))

    if (
      validation.keyData.concurrencyConfig.enabled === true &&
      validation.keyData.concurrencyConfig.maxConcurrency === 5 &&
      validation.keyData.concurrencyConfig.queueSize === 10 &&
      validation.keyData.concurrencyConfig.queueTimeout === 30
    ) {
      console.log('✅ 查询返回的配置正确\n')
    } else {
      console.error('❌ 查询返回的配置错误')
      process.exit(1)
    }

    // ========== 测试 4: 更新 API Key 并发配置 ==========
    console.log('📝 测试 4: 更新 API Key 并发配置')
    await apiKeyService.updateApiKey(result1.id, {
      concurrencyConfig: {
        enabled: true,
        maxConcurrency: 10,
        queueSize: 20,
        queueTimeout: 60
      }
    })

    const validation2 = await apiKeyService.validateApiKey(result1.apiKey)
    console.log('✅ 配置更新成功')
    console.log('   更新后的配置:', JSON.stringify(validation2.keyData.concurrencyConfig, null, 2))

    if (
      validation2.keyData.concurrencyConfig.maxConcurrency === 10 &&
      validation2.keyData.concurrencyConfig.queueSize === 20 &&
      validation2.keyData.concurrencyConfig.queueTimeout === 60
    ) {
      console.log('✅ 更新后的配置正确\n')
    } else {
      console.error('❌ 更新后的配置错误')
      process.exit(1)
    }

    // ========== 测试 5: 获取所有 API Keys（验证列表返回）==========
    console.log('📝 测试 5: 获取所有 API Keys（验证列表返回）')
    const allKeys = await apiKeyService.getAllApiKeys()
    const createdKey = allKeys.find((k) => k.id === result1.id)

    if (createdKey && createdKey.concurrencyConfig) {
      console.log('✅ 列表查询成功')
      console.log('   列表中的配置:', JSON.stringify(createdKey.concurrencyConfig, null, 2))

      if (
        createdKey.concurrencyConfig.enabled === true &&
        createdKey.concurrencyConfig.maxConcurrency === 10
      ) {
        console.log('✅ 列表返回的配置正确\n')
      } else {
        console.error('❌ 列表返回的配置错误')
        process.exit(1)
      }
    } else {
      console.error('❌ 在列表中未找到创建的 API Key')
      process.exit(1)
    }

    // ========== 测试 6: 测试默认值（未提供配置时）==========
    console.log('📝 测试 6: 创建 API Key（未提供并发配置）')
    const result3 = await apiKeyService.generateApiKey({
      name: 'Test-Default-Config',
      description: '测试默认配置'
      // 不提供 concurrencyConfig
    })

    console.log('✅ API Key 创建成功:', result3.id)
    console.log('   默认并发配置:', JSON.stringify(result3.concurrencyConfig, null, 2))

    if (
      result3.concurrencyConfig.enabled === false &&
      result3.concurrencyConfig.maxConcurrency === 1 &&
      result3.concurrencyConfig.queueSize === 0 &&
      result3.concurrencyConfig.queueTimeout === 60
    ) {
      console.log('✅ 默认配置正确\n')
    } else {
      console.error('❌ 默认配置错误')
      process.exit(1)
    }

    // ========== 清理测试数据 ==========
    console.log('🧹 清理测试数据...')
    await apiKeyService.deleteApiKey(result1.id)
    await apiKeyService.deleteApiKey(result2.id)
    await apiKeyService.deleteApiKey(result3.id)
    console.log('✅ 测试数据清理完成\n')

    // ========== 测试完成 ==========
    console.log('🎉 所有测试通过！\n')
    console.log('✅ 创建时正确保存并发配置')
    console.log('✅ 查询时正确返回并发配置')
    console.log('✅ 更新时正确修改并发配置')
    console.log('✅ 列表查询时正确返回并发配置')
    console.log('✅ 默认配置正确应用')

    // 关闭 Redis 连接
    console.log('📡 关闭 Redis 连接...')
    await redis.disconnect()
    console.log('✅ Redis 连接已关闭\n')

    process.exit(0)
  } catch (error) {
    console.error('\n❌ 测试失败:', error)
    console.error(error.stack)

    // 关闭 Redis 连接
    try {
      await redis.disconnect()
    } catch (e) {
      // 忽略关闭错误
    }

    process.exit(1)
  }
}

// 运行测试
testConcurrencyConfig()
