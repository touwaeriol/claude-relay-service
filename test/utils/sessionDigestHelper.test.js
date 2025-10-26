const { initHasher, generateSessionDigest, findCommonPrefixLength } = require('../../src/utils/sessionDigestHelper')

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
      // 只有一条user消息，所以长度应该是8
      expect(digest.length).toBe(8)
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
      // 3条消息 = 24位hex
      expect(digest.length).toBe(24)

      // 每8位应该不同（因为使用索引）
      const hash1 = digest.substring(0, 8)
      const hash2 = digest.substring(8, 16)
      const hash3 = digest.substring(16, 24)
      expect(hash1).not.toBe(hash2)
      expect(hash2).not.toBe(hash3)
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
      expect(digest.length).toBe(8)
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
          content: [
            { type: 'tool_result', tool_use_id: 'xxx', content: '22°C' }
          ]
        }
      ]
      const digest = generateSessionDigest(messages)
      expect(digest.length).toBe(8)
    })

    test('应该包含image内容', () => {
      const messages1 = [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', data: 'aaa...' } }
          ]
        }
      ]
      const messages2 = [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', data: 'bbb...' } }
          ]
        }
      ]
      const digest1 = generateSessionDigest(messages1)
      const digest2 = generateSessionDigest(messages2)
      // 不同的图片应该生成不同的digest
      expect(digest1).not.toBe(digest2)
    })
  })

  describe('findCommonPrefixLength', () => {
    test('应该返回0当两个digest完全不同时', () => {
      const result = findCommonPrefixLength('abcdefgh12345678', '12345678abcdefgh')
      expect(result).toBe(0)
    })

    test('应该返回0当digest为空时', () => {
      expect(findCommonPrefixLength('', '')).toBe(0)
      expect(findCommonPrefixLength('abcdefgh', '')).toBe(0)
      expect(findCommonPrefixLength('', 'abcdefgh')).toBe(0)
    })

    test('应该返回正确的公共前缀长度（消息数）', () => {
      // 两条消息完全相同
      const oldDigest = 'abcdefgh12345678'
      const newDigest = 'abcdefgh12345678'
      expect(findCommonPrefixLength(oldDigest, newDigest)).toBe(2)
    })

    test('应该返回正确的公共前缀长度（部分相同）', () => {
      // 前两条消息相同，第三条不同
      const oldDigest = 'abcdefgh12345678xxxxxxxx'
      const newDigest = 'abcdefgh12345678yyyyyyyy'
      expect(findCommonPrefixLength(oldDigest, newDigest)).toBe(2)
    })

    test('应该处理长度不同的digest', () => {
      const oldDigest = 'abcdefgh'
      const newDigest = 'abcdefgh12345678'
      expect(findCommonPrefixLength(oldDigest, newDigest)).toBe(1)
    })

    test('应该返回0当第一条消息就不同时', () => {
      const oldDigest = 'abcdefgh'
      const newDigest = '12345678'
      expect(findCommonPrefixLength(oldDigest, newDigest)).toBe(0)
    })

    test('应该处理不完整的hash单元', () => {
      // 长度不是8的倍数
      const oldDigest = 'abcdefgh123'
      const newDigest = 'abcdefgh456'
      // 只有一个完整单元匹配
      expect(findCommonPrefixLength(oldDigest, newDigest)).toBe(1)
    })
  })

  describe('边界情况', () => {
    test('应该处理null或undefined消息', () => {
      const messages = [
        null,
        undefined,
        { role: 'user', content: 'Hello' }
      ]
      const digest = generateSessionDigest(messages)
      expect(digest.length).toBe(8)
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
      // 100条消息 = 800位hex
      expect(digest.length).toBe(800)
    })
  })
})
