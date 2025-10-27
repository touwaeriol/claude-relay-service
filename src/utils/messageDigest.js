const crypto = require('crypto')
const logger = require('./logger')

const HASH_BLOCK_LENGTH = 32 // MD5 完整哈希 32位16进制

class MessageDigestHelper {
  /**
   * 为消息数组生成摘要（只处理 user 消息）
   * @param {Array} messages - 消息数组
   * @returns {string} - 摘要字符串
   */
  generateDigest(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return ''
    }

    let digest = ''

    for (const message of messages) {
      // 只处理 user 消息
      if (message.role !== 'user') {
        continue
      }

      const messageDigest = this._generateMessageDigest(message)
      digest += messageDigest
    }

    return digest
  }

  /**
   * 为单个消息生成摘要
   * @param {Object} message - 消息对象
   * @returns {string} - 消息的摘要
   */
  _generateMessageDigest(message) {
    const { content } = message
    let digest = ''

    // 处理字符串content
    if (typeof content === 'string') {
      return this._hashBlock(content)
    }

    // 处理数组content
    if (Array.isArray(content)) {
      content.forEach((block) => {
        const hashContent = this._getBlockHashContent(block)
        digest += this._hashBlock(hashContent)
      })
    }

    return digest
  }

  /**
   * 提取 block 的核心内容用于哈希
   * @param {Object|string} block - content block
   * @returns {string} - 用于哈希的内容
   */
  _getBlockHashContent(block) {
    if (typeof block === 'string') {
      return block
    }

    switch (block.type) {
      case 'text':
        return block.text || ''

      case 'tool_result':
        return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)

      case 'image':
        return block.source?.data || block.source?.url || ''

      default:
        logger.warn(`Unknown block type: ${block.type}, using full object`)
        return JSON.stringify(block)
    }
  }

  /**
   * 对内容生成哈希值
   * @param {string} content - 要哈希的内容
   * @returns {string} - 32位16进制 MD5 哈希字符串
   */
  _hashBlock(content) {
    return crypto.createHash('md5').update(content).digest('hex')
  }

  /**
   * 验证摘要更新是否合法
   * @param {string|null} oldDigest - 旧摘要
   * @param {string} newDigest - 新摘要
   * @returns {{valid: boolean, action?: string, reason?: string}}
   */
  validateDigestUpdate(oldDigest, newDigest) {
    // 情况1：首次创建
    if (!oldDigest) {
      return { valid: true, action: 'create' }
    }

    // 情况2：摘要完全相同
    if (oldDigest === newDigest) {
      return { valid: true, action: 'unchanged' }
    }

    const oldBlocks = this.splitDigestToBlocks(oldDigest)
    const newBlocks = this.splitDigestToBlocks(newDigest)

    // 情况3：增长（旧摘要是新摘要的前缀）
    if (newDigest.startsWith(oldDigest)) {
      return { valid: true, action: 'grow' }
    }

    // 情况4：新摘要更短或相等长度（可能是回滚或修改）
    if (newBlocks.length <= oldBlocks.length) {
      // 4.1 标准回滚：新摘要是旧摘要的完整前缀
      if (oldDigest.startsWith(newDigest)) {
        return { valid: true, action: 'rollback' }
      }

      // 4.2 回滚N个 + 修改最后一个
      // 比较前 (新长度 - 1) 个blocks
      const compareCount = newBlocks.length - 1
      if (compareCount >= 0) {
        let prefixMatches = true
        for (let i = 0; i < compareCount; i++) {
          if (oldBlocks[i] !== newBlocks[i]) {
            prefixMatches = false
            break
          }
        }

        if (prefixMatches) {
          const rolledBackCount = oldBlocks.length - newBlocks.length
          return {
            valid: true,
            action: rolledBackCount > 0 ? 'rollback_and_modify' : 'modify_last'
          }
        }
      }
    }

    // 情况5：前缀不匹配（非法修改）
    return {
      valid: false,
      reason: `Digest prefix mismatch. Client modified historical messages.`
    }
  }

  /**
   * 获取 Redis 键名
   * @param {string} accountId - 账户ID
   * @param {string} sessionHash - 会话哈希
   * @returns {string} - Redis键名
   */
  getDigestRedisKey(accountId, sessionHash) {
    return `session_digest:${accountId}:${sessionHash}`
  }

  /**
   * 分割摘要为 blocks（用于调试）
   * @param {string} digest - 摘要字符串
   * @returns {Array<string>} - 分割后的block数组
   */
  splitDigestToBlocks(digest) {
    if (!digest || typeof digest !== 'string') {
      return []
    }

    const blocks = []
    for (let i = 0; i < digest.length; i += HASH_BLOCK_LENGTH) {
      blocks.push(digest.substring(i, i + HASH_BLOCK_LENGTH))
    }

    return blocks
  }
}

module.exports = new MessageDigestHelper()
