const redis = require('../models/redis')
const logger = require('../utils/logger')

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
async function registerAccountSession(account, sessionId, retentionSeconds) {
  if (!account || !sessionId) {
    return null
  }

  const meta = {
    accountId: account.accountId || account.id,
    sessionId,
    exclusive: account.exclusiveSessionOnly === true || account.exclusiveSessionOnly === 'true',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  }

  await redis.setAccountSessionMeta(meta.accountId, sessionId, meta, retentionSeconds)

  logger.info(
    `📝 Registered session for account: ${meta.accountId.substring(0, 8)}... session: ${sessionId.substring(0, 8)}...`
  )

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
  const { sessionId } = sessionContext
  if (!sessionId) {
    return null
  }

  const existing = await redis.getAccountSessionMeta(accountId, sessionId)

  if (existing) {
    existing.lastSeenAt = new Date().toISOString()
    await redis.setAccountSessionMeta(accountId, sessionId, existing, retentionSeconds)
    return existing
  }

  return await registerAccountSession(account, sessionId, retentionSeconds)
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
  getAccountSession,
  registerAccountSession,
  touchAccountSession,
  ensureAccountSession,
  evaluateAccountEligibility
}
