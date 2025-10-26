const xxhash = require('xxhash-wasm')
const logger = require('./logger')

let hasherInstance = null

/**
 * 摘要格式常量
 */
const HASH_HEX_LENGTH = 8 // hash部分长度（hex字符数）
const ROLE_PREFIX_LENGTH = 1 // 角色前缀长度
const DIGEST_UNIT_LENGTH = HASH_HEX_LENGTH + ROLE_PREFIX_LENGTH // 完整单元长度 = 9
const PERFORMANCE_WARNING_THRESHOLD = 100 // 性能监控：摘要生成超过此毫秒数时警告

const ROLE_PREFIX = {
  USER: '-', // 用户消息前缀
  OTHER: '_' // 其他消息前缀（assistant、tool等）
}

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
 * 对单条消息进行hash（9位：前缀+8位hex）
 * 使用 h32() 原生生成32位hash，转为8位hex，并添加角色前缀
 * @param {Object} message - 消息对象
 * @param {number} index - 消息索引（用于空消息生成唯一hash）
 * @returns {string} 9位字符串：角色前缀(1位) + hash(8位)
 */
function hashMessage(message, index = 0) {
  if (!hasherInstance) {
    throw new Error('Hasher not initialized. Call initHasher() first.')
  }

  const content = extractMessageContent(message)
  const hashContent = content || `__empty_message_${index}__`

  // 使用 h32() 生成32位hash，转为8位hex
  const hash32 = hasherInstance.h32(hashContent)
  const hashHex = hash32.toString(16).padStart(HASH_HEX_LENGTH, '0')

  // 添加角色前缀：用户消息用'-'，其他消息用'_'
  const prefix = message && message.role === 'user' ? ROLE_PREFIX.USER : ROLE_PREFIX.OTHER

  return prefix + hashHex
}

/**
 * 生成完整会话摘要串
 * 每条消息（除system）独立hash，直接拼接
 * 格式：每条消息9位（前缀1位+hash8位）
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

  // 性能监控：超过阈值时警告
  if (duration > PERFORMANCE_WARNING_THRESHOLD) {
    logger.warn(
      `⚠️ Slow digest generation: ${duration}ms for ${index} messages ` +
        `(avg ${(duration / Math.max(index, 1)).toFixed(2)}ms per message)`
    )
  }

  return digests.join('') // 直接拼接，无分隔符
}

/**
 * 计算公共前缀长度（以9位为单元）
 * 遍历两个摘要串，以DIGEST_UNIT_LENGTH（9位）为单元进行比较
 * 一旦发现不匹配的单元，返回之前匹配的单元数量
 * @param {string} oldDigest - 旧摘要串
 * @param {string} newDigest - 新摘要串
 * @returns {number} 匹配的消息数量（单元数）
 */
function findCommonPrefixLength(oldDigest, newDigest) {
  const minLength = Math.min(oldDigest.length, newDigest.length)
  const maxUnits = Math.floor(minLength / DIGEST_UNIT_LENGTH)

  for (let i = 0; i < maxUnits; i++) {
    const start = i * DIGEST_UNIT_LENGTH
    const oldUnit = oldDigest.substring(start, start + DIGEST_UNIT_LENGTH)
    const newUnit = newDigest.substring(start, start + DIGEST_UNIT_LENGTH)

    if (oldUnit !== newUnit) {
      return i // 返回匹配的消息数
    }
  }

  return maxUnits
}

/**
 * 验证摘要更新是否合法
 * @param {string|null} oldDigest - 旧摘要（null表示新会话）
 * @param {string} newDigest - 新摘要
 * @returns {Object} 验证结果 { valid: boolean, error?: {code, message}, action, ...details }
 */
function validateDigestUpdate(oldDigest, newDigest) {
  if (!oldDigest) {
    // 新会话，直接通过
    return {
      valid: true,
      action: 'create',
      messageCount: newDigest.length / DIGEST_UNIT_LENGTH
    }
  }

  const oldCount = oldDigest.length / DIGEST_UNIT_LENGTH
  const newCount = newDigest.length / DIGEST_UNIT_LENGTH
  const commonUnits = findCommonPrefixLength(oldDigest, newDigest)

  // 无公共前缀：拒绝
  if (commonUnits === 0) {
    return {
      valid: false,
      error: {
        code: 'SESSION_CONTENT_MISMATCH',
        message: `No common prefix found. Old: ${oldDigest.substring(0, 18)}..., New: ${newDigest.substring(0, 18)}...`
      }
    }
  }

  // 规则1: 追加（新摘要更长）- 必须恰好+1且旧摘要是完整前缀
  if (newCount > oldCount) {
    if (newCount !== oldCount + 1) {
      return {
        valid: false,
        error: {
          code: 'SESSION_APPEND_VIOLATION',
          message: `Must add exactly 1 message, got +${newCount - oldCount} (old: ${oldCount}, new: ${newCount})`
        }
      }
    }
    if (commonUnits !== oldCount) {
      return {
        valid: false,
        error: {
          code: 'SESSION_APPEND_VIOLATION',
          message: `Old digest must be complete prefix (common: ${commonUnits}, old: ${oldCount})`
        }
      }
    }
    return {
      valid: true,
      action: 'append',
      oldCount,
      newCount,
      commonUnits
    }
  }

  // 规则2: 回退（新摘要更短）- 新摘要必须是完整前缀且最后是用户消息
  if (newCount < oldCount) {
    if (commonUnits !== newCount) {
      return {
        valid: false,
        error: {
          code: 'SESSION_ROLLBACK_VIOLATION',
          message: `New digest must be complete prefix of old (common: ${commonUnits}, new: ${newCount})`
        }
      }
    }

    // 检查最后一条消息是否为用户消息（检查前缀）
    const lastUnitStart = (newCount - 1) * DIGEST_UNIT_LENGTH
    const lastPrefix = newDigest.charAt(lastUnitStart)

    if (lastPrefix !== ROLE_PREFIX.USER) {
      return {
        valid: false,
        error: {
          code: 'SESSION_ROLLBACK_VIOLATION',
          message: `Must rollback to user message (prefix '${ROLE_PREFIX.USER}'), got '${lastPrefix}'`
        }
      }
    }

    return {
      valid: true,
      action: 'rollback',
      oldCount,
      newCount,
      commonUnits
    }
  }

  // 规则3: 分支（长度相同但内容不同）- 公共前缀最后必须是用户消息
  if (commonUnits < newCount) {
    // 检查分支点是否为用户消息（检查公共前缀最后一个单元的前缀）
    const branchUnitStart = (commonUnits - 1) * DIGEST_UNIT_LENGTH
    const branchPrefix = oldDigest.charAt(branchUnitStart)

    if (branchPrefix !== ROLE_PREFIX.USER) {
      return {
        valid: false,
        error: {
          code: 'SESSION_BRANCH_VIOLATION',
          message: `Must branch from user message (prefix '${ROLE_PREFIX.USER}'), got '${branchPrefix}' at position ${commonUnits - 1}`
        }
      }
    }

    return {
      valid: true,
      action: 'branch',
      oldCount,
      newCount,
      commonUnits
    }
  }

  // 刷新（完全相同）
  return {
    valid: true,
    action: 'refresh',
    oldCount,
    newCount
  }
}

module.exports = {
  initHasher,
  generateSessionDigest,
  validateDigestUpdate
}
