const claudeSessionAnalyzer = require('./claudeSessionAnalyzer')
const claudeSessionService = require('../services/claudeSessionService')

async function buildSessionContext(sessionId, requestBody) {
  if (!sessionId) {
    return {
      sessionId: null,
      userNodes: [],
      isNewSession: false,
      canonicalExists: false,
      canonical: null
    }
  }

  const analysis = claudeSessionAnalyzer.analyzeSessionMessages(requestBody)
  const userNodes = analysis.userNodes || []
  const normalizedNodes = claudeSessionService.normalizeNodes(userNodes)
  const canonical = await claudeSessionService.getCanonicalSession(sessionId)

  if (!canonical && !analysis.isNewSession) {
    const error = new Error('Session must start as a new conversation')
    error.code = 'SESSION_NOT_NEW'
    throw error
  }

  if (canonical && !claudeSessionService.nodesEqual(canonical.nodes || {}, normalizedNodes)) {
    const error = new Error('Session content does not match existing conversation')
    error.code = 'SESSION_CONTENT_MISMATCH'
    throw error
  }

  return {
    sessionId,
    userNodes,
    isNewSession: !canonical,
    canonicalExists: !!canonical,
    canonical
  }
}

async function registerSessionForAccount(selection, sessionContext) {
  if (!selection || !selection.account || !sessionContext || !sessionContext.sessionId) {
    return
  }

  const { account } = selection
  const accountId = account.accountId || account.id
  const retentionSeconds = parseInt(account.sessionRetentionSeconds || '0', 10)

  await claudeSessionService.ensureCanonicalSession(
    sessionContext.sessionId,
    sessionContext.userNodes,
    retentionSeconds,
    accountId
  )

  await claudeSessionService.ensureAccountSession(account, sessionContext, retentionSeconds)
}

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
