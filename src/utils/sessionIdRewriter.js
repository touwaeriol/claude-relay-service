const { v5: uuidv5 } = require('uuid')
const config = require('../../config/config')
const logger = require('./logger')

const USER_ID_REGEX = /^(user_[a-f0-9]{64}_account__session_)([a-f0-9-]{36})$/
const UUID_FIELDS = ['session_id', 'sessionId', 'conversation_id', 'conversationId']

function isRewriteEnabled(account) {
  if (!account) {
    return false
  }

  const platform = (account.platform || '').toLowerCase()
  const unifiedEnabled =
    account.useUnifiedClientId === true || account.useUnifiedClientId === 'true'
  const rewriteEnabled =
    account.rewriteSessionId === true || account.rewriteSessionId === 'true'

  return platform === 'claude' && unifiedEnabled && rewriteEnabled
}

function rewriteUuid(value, accountId, apiKeyId, namespace) {
  const match = typeof value === 'string' ? value.match(USER_ID_REGEX) : null
  if (!match) {
    return null
  }

  const originalSessionId = match[2]
  const nameComponents = [accountId || '', apiKeyId || '', originalSessionId]
  const name = nameComponents.join('|')
  const rewritten = uuidv5(name, namespace)

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

function rewriteSessionId(body, { account, apiKeyId }) {
  if (!body || !isRewriteEnabled(account)) {
    return
  }

  const userId = body?.metadata?.user_id
  if (!userId) {
    return
  }

  const namespace =
    config.session?.rewriteNamespaceUuid || '6ba7b812-9dad-11d1-80b4-00c04fd430c8'
  const fallbackNamespace = '6ba7b812-9dad-11d1-80b4-00c04fd430c8'
  let rewriteResult = null

  try {
    rewriteResult = rewriteUuid(userId, account.id, apiKeyId, namespace)
  } catch (error) {
    if (namespace !== fallbackNamespace) {
      logger.warn(
        `⚠️ Failed to rewrite session ID with namespace ${namespace}, falling back to default: ${error.message}`
      )
      rewriteResult = rewriteUuid(userId, account.id, apiKeyId, fallbackNamespace)
    } else {
      logger.warn(
        `⚠️ Failed to rewrite session ID for account ${account.id}: ${error.message}`
      )
      return
    }
  }

  if (!rewriteResult) {
    return
  }

  body.metadata.user_id = rewriteResult.rewrittenUserId
  rewriteAdditionalFields(
    body,
    rewriteResult.originalSessionId,
    rewriteResult.rewrittenSessionId
  )

  logger.debug('🪄 Rewrote session ID for request', {
    accountId: account.id,
    apiKeyId: apiKeyId || null,
    originalSessionId: rewriteResult.originalSessionId,
    rewrittenSessionId: rewriteResult.rewrittenSessionId
  })
}

module.exports = rewriteSessionId
