const { v5: uuidv5 } = require('uuid')
const logger = require('./logger')

const USER_ID_REGEX = /^(user_[a-f0-9]{64}_account__session_)(.+)$/i
const UUID_FIELDS = ['session_id', 'sessionId', 'conversation_id', 'conversationId']
const ACCOUNT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRewriteEnabled(account) {
  if (!account) {
    return false
  }

  const platform = (account.platform || '').toLowerCase()
  const rewriteEnabled = account.rewriteSessionId === true || account.rewriteSessionId === 'true'

  return platform === 'claude' && rewriteEnabled
}

function rewriteUuid(value, accountId) {
  const match = typeof value === 'string' ? value.match(USER_ID_REGEX) : null
  if (!match) {
    return null
  }

  if (!accountId || typeof accountId !== 'string' || !ACCOUNT_UUID_PATTERN.test(accountId)) {
    throw new Error(`Account ${accountId || 'unknown'} must be a valid UUID for session rewrite`)
  }

  const originalSessionId = match[2]
  const rewritten = uuidv5(originalSessionId, accountId)

  return {
    rewrittenUserId: `${match[1]}${rewritten}`,
    originalSessionId,
    rewrittenSessionId: rewritten
  }
}

function rewriteAdditionalFields(body, original, rewritten) {
  UUID_FIELDS.forEach((field) => {
    if (body[field] && body[field] === original) {
      body[field] = rewritten
    }
  })
}

function rewriteSessionId(body, { account }) {
  if (!body || !isRewriteEnabled(account)) {
    return
  }

  const userId = body?.metadata?.user_id
  if (!userId) {
    return
  }

  const rewriteResult = rewriteUuid(userId, account.id)
  if (!rewriteResult) {
    return
  }

  body.metadata.user_id = rewriteResult.rewrittenUserId
  rewriteAdditionalFields(body, rewriteResult.originalSessionId, rewriteResult.rewrittenSessionId)

  logger.debug('🪄 Rewrote session ID for request', {
    accountId: account.id,
    originalSessionId: rewriteResult.originalSessionId,
    rewrittenSessionId: rewriteResult.rewrittenSessionId
  })
}

module.exports = rewriteSessionId
