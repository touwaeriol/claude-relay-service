const {
  initHasher,
  generateSessionDigest,
  validateDigestUpdate
} = require('../../src/utils/sessionDigestHelper')

describe('sessionDigestHelper', () => {
  beforeAll(async () => {
    // 初始化hasher
    await initHasher()
  })

  describe('generateSessionDigest', () => {
    test('应该为空数组返回空字符串', () => {
      expect(generateSessionDigest([])).toBe('')
    })

    test('应该跳过system消息', () => {
      const messages = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' }
      ]
      const digest = generateSessionDigest(messages)
      // 只有一条user消息，所以长度应该是9（前缀1位+hash8位）
      expect(digest.length).toBe(9)
      // 用户消息应该以'-'开头
      expect(digest.charAt(0)).toBe('-')
    })

    test('应该为相同消息生成相同的digest', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' }
      ]
      const digest1 = generateSessionDigest(messages)
      const digest2 = generateSessionDigest(messages)
      expect(digest1).toBe(digest2)
    })

    test('应该为不同顺序的消息生成不同的digest', () => {
      const messages1 = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' }
      ]
      const messages2 = [
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'Hello' }
      ]
      const digest1 = generateSessionDigest(messages1)
      const digest2 = generateSessionDigest(messages2)
      expect(digest1).not.toBe(digest2)
    })

    test('应该为空消息生成唯一的hash（基于索引）', () => {
      const messages = [
        { role: 'user', content: '' },
        { role: 'user', content: '' },
        { role: 'user', content: '' }
      ]
      const digest = generateSessionDigest(messages)
      // 3条消息 = 27位（每条9位）
      expect(digest.length).toBe(27)

      // 每9位应该不同（因为使用索引），且都应该以'-'开头（用户消息）
      const hash1 = digest.substring(0, 9)
      const hash2 = digest.substring(9, 18)
      const hash3 = digest.substring(18, 27)
      expect(hash1).not.toBe(hash2)
      expect(hash2).not.toBe(hash3)
      expect(hash1.charAt(0)).toBe('-')
      expect(hash2.charAt(0)).toBe('-')
      expect(hash3.charAt(0)).toBe('-')
    })

    test('应该处理content为数组的消息', () => {
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: ' World' }
          ]
        }
      ]
      const digest = generateSessionDigest(messages)
      expect(digest.length).toBe(9)
      expect(digest.charAt(0)).toBe('-')
    })

    test('应该包含所有类型的content（包括tool_use）', () => {
      const messages1 = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check' },
            { type: 'tool_use', id: 'xxx', name: 'get_weather', input: { city: 'Beijing' } }
          ]
        }
      ]
      const messages2 = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check' }
            // 缺少tool_use
          ]
        }
      ]
      const digest1 = generateSessionDigest(messages1)
      const digest2 = generateSessionDigest(messages2)
      // 应该生成不同的digest
      expect(digest1).not.toBe(digest2)
    })

    test('应该包含tool_result', () => {
      const messages = [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'xxx', content: '22°C' }]
        }
      ]
      const digest = generateSessionDigest(messages)
      expect(digest.length).toBe(9)
      expect(digest.charAt(0)).toBe('-')
    })

    test('应该包含image内容', () => {
      const messages1 = [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', data: 'aaa...' } }]
        }
      ]
      const messages2 = [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', data: 'bbb...' } }]
        }
      ]
      const digest1 = generateSessionDigest(messages1)
      const digest2 = generateSessionDigest(messages2)
      // 不同的图片应该生成不同的digest
      expect(digest1).not.toBe(digest2)
    })

    test('用户消息和助手消息应该有不同的前缀', () => {
      const userMessage = [{ role: 'user', content: 'Hello' }]
      const assistantMessage = [{ role: 'assistant', content: 'Hello' }]

      const userDigest = generateSessionDigest(userMessage)
      const assistantDigest = generateSessionDigest(assistantMessage)

      expect(userDigest.charAt(0)).toBe('-') // 用户消息前缀
      expect(assistantDigest.charAt(0)).toBe('_') // 助手消息前缀
      expect(userDigest.substring(1)).toBe(assistantDigest.substring(1)) // hash部分相同
    })
  })

  describe('validateDigestUpdate', () => {
    test('新会话应该通过验证', () => {
      const newDigest = '-12345678'
      const result = validateDigestUpdate(null, newDigest)
      expect(result.valid).toBe(true)
      expect(result.action).toBe('create')
      expect(result.messageCount).toBe(1)
    })

    test('追加：恰好+1条消息应该成功', () => {
      const oldDigest = '-12345678_abcdefgh'
      const newDigest = '-12345678_abcdefgh-99999999'
      const result = validateDigestUpdate(oldDigest, newDigest)
      expect(result.valid).toBe(true)
      expect(result.action).toBe('append')
      expect(result.oldCount).toBe(2)
      expect(result.newCount).toBe(3)
    })

    test('追加：+2条消息应该失败', () => {
      const oldDigest = '-12345678'
      const newDigest = '-12345678_abcdefgh-99999999'
      const result = validateDigestUpdate(oldDigest, newDigest)
      expect(result.valid).toBe(false)
      expect(result.error.code).toBe('SESSION_APPEND_VIOLATION')
    })

    test('回退：结束于用户消息应该成功', () => {
      const oldDigest = '-12345678_abcdefgh-99999999_fedcba98'
      const newDigest = '-12345678_abcdefgh-99999999'
      const result = validateDigestUpdate(oldDigest, newDigest)
      expect(result.valid).toBe(true)
      expect(result.action).toBe('rollback')
      expect(result.oldCount).toBe(4)
      expect(result.newCount).toBe(3)
    })

    test('回退：结束于助手消息应该失败', () => {
      const oldDigest = '-12345678_abcdefgh-99999999_fedcba98'
      const newDigest = '-12345678_abcdefgh'
      const result = validateDigestUpdate(oldDigest, newDigest)
      expect(result.valid).toBe(false)
      expect(result.error.code).toBe('SESSION_ROLLBACK_VIOLATION')
    })

    test('分支：从用户消息开始应该成功', () => {
      // 公共前缀是'-12345678'（1条用户消息），然后分支
      const oldDigest = '-12345678_abcdefgh'
      const newDigest = '-12345678_xxxxxxxx'
      const result = validateDigestUpdate(oldDigest, newDigest)
      expect(result.valid).toBe(true)
      expect(result.action).toBe('branch')
    })

    test('分支：从助手消息开始应该失败', () => {
      // 公共前缀是'-12345678_abcdefgh'（最后是助手消息'_'），然后分支
      const oldDigest = '-12345678_abcdefgh-99999999'
      const newDigest = '-12345678_abcdefgh-aaaaaaaa'
      const result = validateDigestUpdate(oldDigest, newDigest)
      expect(result.valid).toBe(false)
      expect(result.error.code).toBe('SESSION_BRANCH_VIOLATION')
    })

    test('无公共前缀应该失败', () => {
      const oldDigest = '-12345678_abcdefgh'
      const newDigest = '-aaaaaaaa_bbbbbbbb'
      const result = validateDigestUpdate(oldDigest, newDigest)
      expect(result.valid).toBe(false)
      expect(result.error.code).toBe('SESSION_CONTENT_MISMATCH')
    })

    test('完全相同应该刷新', () => {
      const digest = '-12345678_abcdefgh'
      const result = validateDigestUpdate(digest, digest)
      expect(result.valid).toBe(true)
      expect(result.action).toBe('refresh')
    })
  })

  describe('边界情况', () => {
    test('应该处理null或undefined消息', () => {
      const messages = [null, undefined, { role: 'user', content: 'Hello' }]
      const digest = generateSessionDigest(messages)
      expect(digest.length).toBe(9)
      expect(digest.charAt(0)).toBe('-')
    })

    test('应该处理非数组输入', () => {
      expect(generateSessionDigest(null)).toBe('')
      expect(generateSessionDigest(undefined)).toBe('')
      expect(generateSessionDigest('not an array')).toBe('')
    })

    test('应该处理大量消息', () => {
      const messages = Array.from({ length: 100 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`
      }))
      const digest = generateSessionDigest(messages)
      // 100条消息 = 900位（每条9位）
      expect(digest.length).toBe(900)

      // 验证前缀：偶数索引（用户）应该是'-'，奇数索引（助手）应该是'_'
      for (let i = 0; i < 100; i++) {
        const prefix = digest.charAt(i * 9)
        if (i % 2 === 0) {
          expect(prefix).toBe('-') // 用户消息
        } else {
          expect(prefix).toBe('_') // 助手消息
        }
      }
    })
  })
})
