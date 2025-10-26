const redis = require('../models/redis')
const logger = require('../utils/logger')
const { validateDigestUpdate } = require('../utils/sessionDigestHelper')

/**
 * 获取会话摘要
 */
async function getCanonicalSession(sessionId) {
  if (!sessionId) {
    return null
  }
  const digest = await redis.get(`claude:session:digest:${sessionId}`)
  return digest ? { digest } : null
}

/**
 * 确保会话摘要一致性
 * @param {string} sessionId - 会话ID
 * @param {string} newDigest - 新的摘要串
 * @param {number} retentionSeconds - TTL秒数
 * @param {string} accountId - 账户ID（可选，用于日志）
 * @returns {Object} 操作结果
 */
async function ensureCanonicalSession(sessionId, newDigest, retentionSeconds, accountId = null) {
  if (!sessionId || !newDigest) {
    return null
  }

  const key = `claude:session:digest:${sessionId}`
  const oldDigest = await redis.get(key)

  // 使用封装的验证函数
  const validation = validateDigestUpdate(oldDigest, newDigest)

  if (!validation.valid) {
    const error = new Error(
      `${validation.error.message} (Session: ${sessionId.substring(0, 8)}...)`
    )
    error.code = validation.error.code
    throw error
  }

  // 更新摘要
  await redis.set(key, newDigest, 'EX', retentionSeconds)

  // 记录日志
  if (validation.action === 'create') {
    logger.info(
      `📝 New session digest created: ${sessionId.substring(0, 8)}... ` +
        `(${validation.messageCount} messages)${accountId ? ` [account: ${accountId}]` : ''}`
    )
  } else {
    logger.info(
      `🔄 Session digest updated (${validation.action}): ${sessionId.substring(0, 8)}... ` +
        `[${validation.oldCount}→${validation.newCount} messages, ${validation.commonUnits} common]${accountId ? ` [account: ${accountId}]` : ''}`
    )
  }

  return {
    action: validation.action,
    commonMessages: validation.commonUnits || 0,
    oldMessages: validation.oldCount || 0,
    newMessages: validation.newCount || validation.messageCount,
    messageCount: validation.messageCount
  }
}

/**
 * 刷新会话TTL
 */
async function touchCanonicalSession(sessionId, retentionSeconds) {
  if (!sessionId || !retentionSeconds || retentionSeconds <= 0) {
    return null
  }
  await redis.expire(`claude:session:digest:${sessionId}`, retentionSeconds)
  return true
}

/**
 * 获取账户会话元数据
 */
async function getAccountSession(accountId, sessionId) {
  if (!accountId || !sessionId) {
    return null
  }
  return await redis.getAccountSessionMeta(accountId, sessionId)
}

/**
 * 注册账户会话
 */
async function registerAccountSession(account, sessionId, digest, retentionSeconds) {
  if (!account || !sessionId) {
    return null
  }

  const meta = {
    accountId: account.accountId || account.id,
    sessionId,
    digestLength: digest.length, // 存储摘要长度
    digestChecksum: digest.substring(0, Math.min(18, digest.length)), // 存储前2条消息（18位）作为校验和
    exclusive: account.exclusiveSessionOnly === true || account.exclusiveSessionOnly === 'true',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  }

  await redis.setAccountSessionMeta(meta.accountId, sessionId, meta, retentionSeconds)
  return meta
}

/**
 * 刷新账户会话TTL
 */
async function touchAccountSession(account, sessionId, retentionSeconds) {
  const accountId = account.accountId || account.id
  const existing = await redis.getAccountSessionMeta(accountId, sessionId)
  if (!existing) {
    return null
  }
  existing.lastSeenAt = new Date().toISOString()
  await redis.setAccountSessionMeta(accountId, sessionId, existing, retentionSeconds)
  return existing
}

/**
 * 确保账户会话存在
 */
async function ensureAccountSession(account, sessionContext, retentionSeconds) {
  const accountId = account.accountId || account.id
  const { sessionId, digest } = sessionContext
  if (!sessionId) {
    return null
  }

  const existing = await redis.getAccountSessionMeta(accountId, sessionId)

  if (existing) {
    existing.lastSeenAt = new Date().toISOString()
    await redis.setAccountSessionMeta(accountId, sessionId, existing, retentionSeconds)
    return existing
  }

  return await registerAccountSession(account, sessionId, digest, retentionSeconds)
}

/**
 * 评估账户是否有资格处理该会话
 */
async function evaluateAccountEligibility(account, sessionContext) {
  if (!sessionContext || !sessionContext.sessionId) {
    return account.exclusiveSessionOnly !== true && account.exclusiveSessionOnly !== 'true'
  }

  const accountId = account.accountId || account.id
  const cached = sessionContext.accountSessions || {}
  if (!cached[accountId]) {
    cached[accountId] = await redis.getAccountSessionMeta(accountId, sessionContext.sessionId)
    sessionContext.accountSessions = cached
  }

  const exclusive = account.exclusiveSessionOnly === true || account.exclusiveSessionOnly === 'true'
  const accountSession = cached[accountId]

  if (exclusive) {
    // 独占账户：只能处理新会话或已绑定会话
    if (accountSession) {
      return true
    }
    return sessionContext.isNewSession === true
  }

  // 非独占账户：接受所有会话
  return true
}

module.exports = {
  getCanonicalSession,
  ensureCanonicalSession,
  touchCanonicalSession,
  getAccountSession,
  registerAccountSession,
  touchAccountSession,
  ensureAccountSession,
  evaluateAccountEligibility
}
