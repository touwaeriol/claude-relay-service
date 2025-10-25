const redis = require('../models/redis')
const logger = require('../utils/logger')

function normalizeNodes(nodes = []) {
  const map = {}
  for (const node of nodes) {
    if (!node || typeof node.index !== 'number') {
      continue
    }
    map[node.index] = {
      hash: node.hash || '',
      preview: node.preview || ''
    }
  }
  return map
}

function nodesEqual(a = {}, b = {}) {
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) {
    return false
  }
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) {
      return false
    }
    if (a[key].hash !== b[key].hash) {
      return false
    }
  }
  return true
}

async function getCanonicalSession(sessionId) {
  if (!sessionId) {
    return null
  }
  return await redis.getCanonicalSession(sessionId)
}

async function ensureCanonicalSession(sessionId, userNodes, retentionSeconds, accountId = null) {
  if (!sessionId) {
    return null
  }

  const canonical = await redis.getCanonicalSession(sessionId)
  const normalizedNodes = normalizeNodes(userNodes)

  if (!canonical) {
    const payload = {
      nodes: normalizedNodes,
      accounts: {},
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    }
    if (accountId) {
      payload.accounts[accountId] = {
        firstSeenAt: payload.createdAt,
        lastSeenAt: payload.lastSeenAt
      }
    }
    await redis.setCanonicalSession(sessionId, payload, retentionSeconds)
    return payload
  }

  if (!nodesEqual(canonical.nodes || {}, normalizedNodes)) {
    const error = new Error('Session content mismatch with canonical record')
    error.code = 'SESSION_CONTENT_MISMATCH'
    throw error
  }

  canonical.lastSeenAt = new Date().toISOString()
  if (accountId) {
    canonical.accounts = canonical.accounts || {}
    canonical.accounts[accountId] = canonical.accounts[accountId] || {
      firstSeenAt: canonical.createdAt || new Date().toISOString()
    }
    canonical.accounts[accountId].lastSeenAt = canonical.lastSeenAt
  }
  await redis.setCanonicalSession(sessionId, canonical, retentionSeconds)
  return canonical
}

async function getAccountSession(accountId, sessionId) {
  if (!accountId || !sessionId) {
    return null
  }
  return await redis.getAccountSessionMeta(accountId, sessionId)
}

async function registerAccountSession(account, sessionId, userNodes, retentionSeconds) {
  if (!account || !sessionId) {
    return null
  }

  const normalizedNodes = normalizeNodes(userNodes)
  const meta = {
    accountId: account.accountId || account.id,
    sessionId,
    nodes: normalizedNodes,
    exclusive: account.exclusiveSessionOnly === true || account.exclusiveSessionOnly === 'true',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  }

  await redis.setAccountSessionMeta(meta.accountId, sessionId, meta, retentionSeconds)
  return meta
}

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

async function ensureAccountSession(account, sessionContext, retentionSeconds) {
  const accountId = account.accountId || account.id
  const sessionId = sessionContext.sessionId
  if (!sessionId) {
    return null
  }

  const existing = await redis.getAccountSessionMeta(accountId, sessionId)
  const normalizedNodes = normalizeNodes(sessionContext.userNodes)

  if (existing) {
    if (!nodesEqual(existing.nodes || {}, normalizedNodes)) {
      const error = new Error('Session content mismatch for account')
      error.code = 'SESSION_CONTENT_MISMATCH'
      throw error
    }
    existing.lastSeenAt = new Date().toISOString()
    await redis.setAccountSessionMeta(accountId, sessionId, existing, retentionSeconds)
    return existing
  }

  return await registerAccountSession(account, sessionId, sessionContext.userNodes, retentionSeconds)
}

function canExclusiveAccountHandle(account, sessionContext, accountSession) {
  if (!sessionContext.sessionId) {
    return false
  }

  if (accountSession) {
    return true
  }

  return sessionContext.isNewSession === true
}

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
    return canExclusiveAccountHandle(account, sessionContext, accountSession)
  }

  if (sessionContext.isNewSession) {
    return true
  }

  return true
}

module.exports = {
  normalizeNodes,
  nodesEqual,
  getCanonicalSession,
  ensureCanonicalSession,
  getAccountSession,
  ensureAccountSession,
  touchAccountSession,
  registerAccountSession,
  evaluateAccountEligibility
}
