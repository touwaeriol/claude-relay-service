const claudeSessionAnalyzer = require('./claudeSessionAnalyzer')
const claudeSessionService = require('../services/claudeSessionService')

/**
 * 构建会话上下文
 * @param {string} sessionHash - 会话hash（用于sticky session）
 * @param {Object} requestBody - 请求体
 * @returns {Object} 会话上下文
 */
async function buildSessionContext(sessionHash, requestBody) {
  const analysis = claudeSessionAnalyzer.analyzeSessionMessages(requestBody)

  // 获取 sessionId（优先使用 metadata.user_id，否则使用 sessionHash）
  const sessionId = requestBody.metadata?.user_id || sessionHash

  return {
    sessionId,
    sessionHash,
    digest: analysis.digest, // 新的摘要串
    isNewSession: analysis.isNewSession,
    messageCount: analysis.messageCount,
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

  // 确保全局会话摘要
  await claudeSessionService.ensureCanonicalSession(
    sessionContext.sessionId,
    sessionContext.digest,
    retentionSeconds,
    account.accountId || account.id
  )

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

  await Promise.all([
    claudeSessionService.touchCanonicalSession(sessionContext.sessionId, retentionSeconds),
    claudeSessionService.touchAccountSession(account, sessionContext.sessionId, retentionSeconds)
  ])
}

module.exports = {
  buildSessionContext,
  registerSessionForAccount,
  refreshSessionRetention
}
