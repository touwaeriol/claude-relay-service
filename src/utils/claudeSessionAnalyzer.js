/**
 * 分析会话消息
 * @param {Object} requestBody - 请求体，包含 messages 数组
 * @returns {Object} 分析结果
 */
function analyzeSessionMessages(requestBody = {}) {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : []

  // 判断是否为新会话（只有user消息）
  let isNewSession = true
  for (const msg of messages) {
    if (!msg || msg.role === 'system') {
      continue
    }
    if (msg.role !== 'user') {
      isNewSession = false
      break
    }
  }

  // 计算消息数量（除 system）
  const messageCount = messages.filter((m) => m && m.role !== 'system').length

  return {
    isNewSession,
    messageCount
  }
}

module.exports = {
  analyzeSessionMessages
}
