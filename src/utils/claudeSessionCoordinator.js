/**
 * 构建会话上下文
 * @param {string} sessionHash - 会话hash（用于sticky session）
 * @param {Object} requestBody - 请求体
 * @returns {Object} 会话上下文
 */
async function buildSessionContext(sessionHash, requestBody) {
  // 判断是否为新会话（只有user消息）
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : []
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

  return {
    sessionHash,
    isNewSession
  }
}

module.exports = {
  buildSessionContext
}
