const xxhash = require('xxhash-wasm')
const logger = require('./logger')

let hasherInstance = null

/**
 * 初始化 xxhash hasher（服务启动时调用一次）
 */
async function initHasher() {
  if (!hasherInstance) {
    hasherInstance = await xxhash()
  }
  return hasherInstance
}

/**
 * 提取消息内容用于hash
 * 序列化整个content（包括text、tool_use、tool_result、image等所有类型）
 */
function extractMessageContent(message) {
  if (!message || !message.content) {
    return ''
  }

  // 直接序列化整个content，确保所有内容都参与hash
  return JSON.stringify(message.content)
}

/**
 * 对单条消息进行hash（8位hex）
 * 使用 h32() 原生生成32位hash，转为8位hex
 * @param {Object} message - 消息对象
 * @param {number} index - 消息索引（用于空消息生成唯一hash）
 */
function hashMessage(message, index = 0) {
  if (!hasherInstance) {
    throw new Error('Hasher not initialized. Call initHasher() first.')
  }

  const content = extractMessageContent(message)
  if (!content) {
    // 空消息使用索引生成唯一hash，避免碰撞
    const emptyContent = `__empty_message_${index}__`
    const hash32 = hasherInstance.h32(emptyContent)
    return hash32.toString(16).padStart(8, '0')
  }

  // 使用 h32() 生成32位hash，转为8位hex
  const hash32 = hasherInstance.h32(content)
  return hash32.toString(16).padStart(8, '0')
}

/**
 * 生成完整会话摘要串
 * 每条消息（除system）独立hash，直接拼接无分隔符
 */
function generateSessionDigest(messages) {
  if (!Array.isArray(messages)) {
    return ''
  }

  const startTime = Date.now()
  const digests = []
  let index = 0

  for (const msg of messages) {
    // 跳过system消息
    if (!msg || msg.role === 'system') {
      continue
    }
    digests.push(hashMessage(msg, index))
    index++
  }

  const duration = Date.now() - startTime

  // 性能监控：超过100ms警告
  if (duration > 100) {
    logger.warn(
      `⚠️ Slow digest generation: ${duration}ms for ${index} messages ` +
        `(avg ${(duration / Math.max(index, 1)).toFixed(2)}ms per message)`
    )
  }

  return digests.join('') // 直接拼接，无分隔符
}

/**
 * 计算公共前缀长度（以8位为单元）
 * @param {string} oldDigest - 旧摘要串
 * @param {string} newDigest - 新摘要串
 * @returns {number} 匹配的消息数量
 */
function findCommonPrefixLength(oldDigest, newDigest) {
  const HASH_LENGTH = 8
  const minLength = Math.min(oldDigest.length, newDigest.length)
  const maxUnits = Math.floor(minLength / HASH_LENGTH)

  for (let i = 0; i < maxUnits; i++) {
    const start = i * HASH_LENGTH
    const oldUnit = oldDigest.substring(start, start + HASH_LENGTH)
    const newUnit = newDigest.substring(start, start + HASH_LENGTH)

    if (oldUnit !== newUnit) {
      return i // 返回匹配的消息数
    }
  }

  return maxUnits
}

module.exports = {
  initHasher,
  hashMessage,
  generateSessionDigest,
  findCommonPrefixLength
}
