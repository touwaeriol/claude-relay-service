const redis = require('../models/redis')
const config = require('../../config/config')
const logger = require('./logger')
const messageDigestHelper = require('./messageDigest')

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
  let digestExists = false

  if (sessionHash) {
    try {
      stickyAccountId = await redis.getSessionAccountMapping(sessionHash)
    } catch (error) {
      logger.warn('⚠️ Failed to read sticky session mapping when building context:', error)
    }

    if (stickyAccountId) {
      try {
        const redisClient = redis.getClient()
        if (redisClient) {
          const digestKey = messageDigestHelper.getDigestRedisKey(stickyAccountId, sessionHash)
          digestExists = (await redisClient.exists(digestKey)) === 1
        }
      } catch (error) {
        logger.warn('⚠️ Failed to inspect session digest presence:', error)
      }
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

  const hasSessionArtifacts = Boolean(stickyAccountId) || digestExists
  const shouldTreatAsExisting =
    explicitResumeIndicators || (requestCarriesSessionInfo && hasSessionArtifacts)

  const isNewSession = !shouldTreatAsExisting && hasOnlyUserMessages && !hasSessionArtifacts

  logger.debug(
    `🧭 Session context resolved: session=${sessionHash ? sessionHash.substring(0, 8) + '...' : 'none'}, ` +
      `new=${isNewSession}, sticky=${stickyAccountId ? stickyAccountId.substring(0, 8) + '...' : 'none'}, digest=${digestExists}`
  )

  return {
    sessionHash,
    isNewSession,
    requestBody, // ✅ 保留原始请求体，用于摘要验证
    digestValidationCache: {} // 🚀 摘要验证缓存，避免重复验证 { accountId: { valid, shouldClearBinding, action } }
  }
}

/**
 * 为账户注册会话（建立粘性会话绑定）
 * 默认仅在旧会话时建立绑定，但对独占账户在首个请求即绑定并初始化消息摘要
 *
 * @param {Object} selection - 账户选择结果 { accountId, accountType, account }
 * @param {Object} sessionContext - 会话上下文 { sessionHash, isNewSession }
 */
async function registerSessionForAccount(selection, sessionContext) {
  if (!sessionContext?.sessionHash) {
    return
  }

  const accountInfo = selection?.account || {}
  const isExclusive =
    accountInfo?.exclusiveSessionOnly === true || accountInfo?.exclusiveSessionOnly === 'true'

  if (!isExclusive && sessionContext.isNewSession) {
    // 非独占账户保持原有行为：等待会话进入对话阶段后再绑定
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

    // 对启用摘要验证的独占账户，在首个请求时初始化摘要，确保后续消息可以校验
    const digestEnabled =
      accountInfo?.enableMessageDigest === true || accountInfo?.enableMessageDigest === 'true'
    const messages = sessionContext?.requestBody?.messages

    if (isExclusive && digestEnabled && Array.isArray(messages) && messages.length > 0) {
      try {
        const digestResult = await messageDigestHelper.validateAndStoreDigest(
          accountId,
          sessionContext.sessionHash,
          messages,
          { allowCreate: true }
        )

        if (!digestResult.valid) {
          logger.warn(
            `📋 Failed to initialize digest for exclusive session ${sessionContext.sessionHash.substring(0, 8)}...: ${digestResult.reason}`
          )
        }
      } catch (error) {
        logger.error('❌ Failed to initialize session digest:', error)
      }
    }
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
