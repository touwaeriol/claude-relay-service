const redis = require('../models/redis')
const config = require('../../config/config')
const logger = require('./logger')

/**
 * 构建会话上下文
 * @param {string} sessionHash - 会话hash（用于sticky session）
 * @param {Object} requestBody - 请求体
 * @returns {Object} 会话上下文
 */
async function buildSessionContext(sessionHash, requestBody) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : []

  let hasOnlyUserMessages = true
  for (const msg of messages) {
    if (!msg || msg.role === 'system') {
      continue
    }
    if (msg.role !== 'user') {
      hasOnlyUserMessages = false
      break
    }
  }

  let stickyAccountId = null
  if (sessionHash) {
    try {
      stickyAccountId = await redis.getSessionAccountMapping(sessionHash)
    } catch (error) {
      logger.warn('⚠️ Failed to read sticky session mapping when building context:', error)
    }
  }

  const metadata = requestBody?.metadata || {}
  const explicitResumeIndicators =
    metadata.resume === true ||
    metadata.resume === 'true' ||
    metadata.isResume === true ||
    metadata.isResume === 'true' ||
    metadata.sessionType === 'resume' ||
    metadata.sessionType === 'existing'

  const requestCarriesSessionInfo =
    Boolean(requestBody?.conversation_id) ||
    Boolean(requestBody?.conversationId) ||
    Boolean(requestBody?.session_id) ||
    Boolean(requestBody?.sessionId)

  const hasSessionArtifacts = Boolean(stickyAccountId)
  const resumeRequested = Boolean(
    explicitResumeIndicators || (hasSessionArtifacts && requestCarriesSessionInfo)
  )
  const shouldTreatAsExisting = hasSessionArtifacts || resumeRequested || requestCarriesSessionInfo

  const isNewSession = !shouldTreatAsExisting && hasOnlyUserMessages

  logger.debug(
    `🧭 Session context resolved: session=${sessionHash ? sessionHash.substring(0, 8) + '...' : 'none'}, ` +
      `new=${isNewSession}, sticky=${stickyAccountId ? stickyAccountId.substring(0, 8) + '...' : 'none'}`
  )

  return {
    sessionHash,
    isNewSession
  }
}

/**
 * 为账户注册会话（建立粘性会话绑定）
 * @param {Object} selection - 账户选择结果 { accountId, accountType, account }
 * @param {Object} sessionContext - 会话上下文 { sessionHash, isNewSession }
 */
async function registerSessionForAccount(selection, sessionContext) {
  if (!sessionContext?.sessionHash) {
    return
  }

  // 获取账户ID
  let accountId = selection?.accountId || selection?.account?.id

  if (!accountId && sessionContext.sessionHash) {
    try {
      accountId = await redis.getSessionAccountMapping(sessionContext.sessionHash)
    } catch (error) {
      logger.warn('⚠️ Failed to read existing session mapping:', error)
    }
  }

  if (!accountId) {
    logger.warn('⚠️ registerSessionForAccount: No accountId resolved for session binding')
    return
  }

  // 计算 TTL（秒）：从配置读取，默认 7 天（168 小时）
  const stickyTtlHours = config.session?.stickyTtlHours || 168
  const ttl = stickyTtlHours * 3600

  try {
    // 建立粘性会话绑定
    await redis.setSessionAccountMapping(sessionContext.sessionHash, accountId, ttl)
    logger.debug(
      `✅ Registered session ${sessionContext.sessionHash.substring(0, 8)}... to account ${accountId.substring(0, 8)}... (TTL: ${stickyTtlHours}h)`
    )
  } catch (error) {
    logger.error('❌ Failed to register session for account:', error)
  }
}

/**
 * 刷新会话保留时间（延长粘性会话绑定的 TTL）
 *
 * @param {Object} selection - 账户选择结果 { accountId, accountType, account }
 * @param {Object} sessionContext - 会话上下文 { sessionHash, isNewSession }
 */
async function refreshSessionRetention(selection, sessionContext) {
  // 新会话不需要刷新
  if (!sessionContext?.sessionHash || sessionContext.isNewSession) {
    return
  }

  // 检查续期阈值配置
  const renewalThresholdMinutes = config.session?.renewalThresholdMinutes || 0
  if (renewalThresholdMinutes <= 0) {
    // 未配置续期阈值，不进行续期
    return
  }

  try {
    const renewed = await redis.extendSessionAccountMappingTTL(sessionContext.sessionHash)
    if (renewed) {
      logger.debug(
        `🔄 Refreshed session ${sessionContext.sessionHash.substring(0, 8)}... retention via Redis helper`
      )
    }
  } catch (error) {
    logger.error('❌ Failed to refresh session retention:', error)
  }
}

module.exports = {
  buildSessionContext,
  registerSessionForAccount,
  refreshSessionRetention
}
