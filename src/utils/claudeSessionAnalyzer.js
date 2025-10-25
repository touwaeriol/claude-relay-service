const crypto = require('crypto')

function extractTextFromMessage(message) {
  if (!message) {
    return ''
  }

  if (typeof message.content === 'string') {
    return message.content
  }

  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
  }

  return ''
}

function hashText(text) {
  if (!text) {
    return ''
  }

  return crypto.createHash('sha256').update(text).digest('hex')
}

function analyzeSessionMessages(requestBody = {}) {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : []
  const result = {
    isNewSession: true,
    userNodes: []
  }

  let index = 0
  for (const message of messages) {
    if (!message || message.role === 'system') {
      continue
    }

    const { role } = message
    if (role !== 'user') {
      result.isNewSession = false
    }

    if (role === 'user') {
      const text = extractTextFromMessage(message)
      result.userNodes.push({
        index,
        hash: hashText(text)
      })
    }

    index += 1
  }

  return result
}

module.exports = {
  analyzeSessionMessages
}
