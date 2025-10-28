/**
 * 会话并发控制检查助手
 *
 * 封装重复的会话并发检查逻辑，避免在多个relay服务中重复代码。
 * 支持流式和非流式请求的统一处理。
 *
 * @module utils/sessionConcurrencyHelper
 */

const logger = require('./logger')
const sessionConcurrencyManager = require('../services/sessionConcurrencyManager')
const { normalizeConfig } = require('./sessionConcurrencyConfigHelper')

/**
 * 检查账户的会话并发限制
 *
 * 统一处理会话并发检查逻辑，支持流式和非流式请求。
 *
 * 工作流程：
 * 1. 检查是否配置了会话并发控制
 * 2. 解析并标准化配置
 * 3. 调用sessionConcurrencyManager检查限制
 * 4. 处理检查结果（允许/拒绝）
 * 5. 流式请求：直接写入响应流
 * 6. 非流式请求：返回错误对象
 *
 * @param {Object} options - 检查选项
 * @param {Object} options.account - 账户对象（包含sessionConcurrencyConfig）
 * @param {string} options.sessionHash - 会话哈希值
 * @param {boolean} [options.isStreaming=false] - 是否为流式请求
 * @param {Object} [options.responseStream=null] - 响应流对象（流式请求必需）
 * @returns {Promise<{allowed: boolean, error?: Object}>}
 *
 * @example
 * // 非流式请求
 * const result = await checkAccountSessionLimit({
 *   account: accountData,
 *   sessionHash: '1a2b3c4d...'
 * })
 * if (!result.allowed) {
 *   return result.error // 返回429错误响应
 * }
 *
 * @example
 * // 流式请求
 * const result = await checkAccountSessionLimit({
 *   account: accountData,
 *   sessionHash: '1a2b3c4d...',
 *   isStreaming: true,
 *   responseStream: res
 * })
 * if (!result.allowed) {
 *   return // 已经写入错误响应到流
 * }
 */
async function checkAccountSessionLimit(options) {
  const { account, sessionHash, isStreaming = false, responseStream = null } = options

  // 前置检查：无sessionHash或无配置时跳过检查
  if (!sessionHash || !account?.sessionConcurrencyConfig) {
    return { allowed: true }
  }

  try {
    // 标准化配置（支持字符串和对象格式）
    const normalizedConfig = normalizeConfig(account.sessionConcurrencyConfig)

    // 配置未启用时跳过检查
    if (!normalizedConfig.enabled) {
      logger.debug(`🔓 [SessionConcurrency] Disabled for account ${account.id || 'unknown'}`)
      return { allowed: true }
    }

    // 记录调试信息
    logger.debug(
      `🔐 [SessionConcurrency]${isStreaming ? '[Stream]' : ''} Checking session limit for ${account.id || 'unknown'}, config:`,
      normalizedConfig
    )

    // 执行会话并发检查
    const sessionCheck = await sessionConcurrencyManager.checkSessionLimit(
      account.id,
      sessionHash,
      normalizedConfig
    )

    // 检查通过
    if (sessionCheck.allowed) {
      logger.debug(
        `✅ [SessionConcurrency]${isStreaming ? '[Stream]' : ''} Session check passed for ${account.id || 'unknown'}`
      )
      return { allowed: true }
    }

    // 检查失败：构建错误响应
    logger.warn(
      `🚫 [SessionConcurrency]${isStreaming ? '[Stream]' : ''} Session limit exceeded for ${account.id || 'unknown'}:`,
      sessionCheck.error.message
    )

    const errorResponse = {
      error: sessionCheck.error.code,
      message: sessionCheck.error.message,
      details: sessionCheck.error.details
    }

    // 流式请求：直接写入响应流
    if (isStreaming && responseStream) {
      responseStream.writeHead(429, {
        'Content-Type': 'text/event-stream',
        'Retry-After': '5'
      })
      responseStream.write(`event: error\ndata: ${JSON.stringify(errorResponse)}\n\n`)
      responseStream.end()
      return { allowed: false, streamHandled: true }
    }

    // 非流式请求：返回错误对象
    return {
      allowed: false,
      error: {
        statusCode: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '5'
        },
        body: JSON.stringify(errorResponse),
        accountId: account.id
      }
    }
  } catch (error) {
    // SESSION_LIMIT_EXCEEDED 错误已在上面处理
    if (error.code === 'SESSION_LIMIT_EXCEEDED') {
      // 不应该到这里，但为了安全性还是处理一下
      logger.error(
        `❌ [SessionConcurrency] Unexpected SESSION_LIMIT_EXCEEDED error:`,
        error.message
      )
      return {
        allowed: false,
        error: {
          statusCode: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
          body: JSON.stringify({
            error: error.code,
            message: error.message,
            details: error.details
          })
        }
      }
    }

    // 其他错误：记录日志但允许请求（降级策略）
    logger.error(
      `❌ [SessionConcurrency]${isStreaming ? '[Stream]' : ''} Check failed for ${account.id || 'unknown'}:`,
      error
    )
    return { allowed: true }
  }
}

/**
 * 获取账户的会话统计信息（便捷函数）
 * @param {string} accountId - 账户ID
 * @returns {Promise<Object|null>} 会话统计信息
 */
async function getAccountSessionStats(accountId) {
  return sessionConcurrencyManager.getAccountStats(accountId)
}

/**
 * 手动移除会话（便捷函数）
 * @param {string} accountId - 账户ID
 * @param {string} sessionHash - 会话哈希
 * @returns {Promise<boolean>}
 */
async function removeAccountSession(accountId, sessionHash) {
  return sessionConcurrencyManager.removeSession(accountId, sessionHash)
}

/**
 * 清空账户的所有会话（便捷函数）
 * @param {string} accountId - 账户ID
 * @returns {Promise<boolean>}
 */
async function clearAccountSessions(accountId) {
  return sessionConcurrencyManager.clearAccount(accountId)
}

module.exports = {
  checkAccountSessionLimit,
  getAccountSessionStats,
  removeAccountSession,
  clearAccountSessions
}
