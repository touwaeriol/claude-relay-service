const claudeSessionService = require('../services/claudeSessionService')

/**
 * 构建会话上下文
 * @param {string} sessionHash - 会话hash（用于sticky session）
 * @param {Object} requestBody - 请求体
 * @returns {Object} 会话上下文
 */
async function buildSessionContext(sessionHash, requestBody) {
  // 获取 sessionId（优先使用 metadata.user_id，否则使用 sessionHash）
  const sessionId = requestBody.metadata?.user_id || sessionHash

  // 判断是否为新会话（只有user消息）
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : []
  let isNewSession = true
  for (const msg of messages) {
    if (!msg || msg.role === 'system') {
      continue
    }
    if (msg.role !== 'user') {
      isNewSession = false
      break
    }
  }

  return {
    sessionId,
    sessionHash,
    isNewSession,
    accountSessions: {} // 缓存账户会话数据
  }
}

/**
 * 为账户注册会话
 */
async function registerSessionForAccount(selection, sessionContext) {
  if (!selection || !selection.account || !sessionContext || !sessionContext.sessionId) {
    return
  }

  const { account } = selection
  const retentionSeconds = parseInt(account.sessionRetentionSeconds || '0', 10)

  if (!retentionSeconds || retentionSeconds <= 0) {
    return
  }

  // 确保账户会话绑定
  await claudeSessionService.ensureAccountSession(account, sessionContext, retentionSeconds)
}

/**
 * 刷新会话保留时间
 */
async function refreshSessionRetention(selection, sessionContext) {
  if (!selection || !selection.account || !sessionContext || !sessionContext.sessionId) {
    return
  }

  const { account } = selection
  const retentionSeconds = parseInt(account.sessionRetentionSeconds || '0', 10)
  if (!retentionSeconds || retentionSeconds <= 0) {
    return
  }

  await claudeSessionService.touchAccountSession(
    account,
    sessionContext.sessionId,
    retentionSeconds
  )
}

module.exports = {
  buildSessionContext,
  registerSessionForAccount,
  refreshSessionRetention
}
