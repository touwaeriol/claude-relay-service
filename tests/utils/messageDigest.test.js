const digestHelper = require('../../src/utils/messageDigest')
const crypto = require('crypto')

describe('MessageDigestHelper', () => {
  // 辅助函数：生成 MD5 哈希
  const md5 = (content) => crypto.createHash('md5').update(content).digest('hex')

  describe('generateDigest', () => {
    test('应该只哈希 user 文本消息', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' }
      ]

      const digest = digestHelper.generateDigest(messages)

      // 应该只包含 2 个 user 消息的哈希
      const expectedDigest = md5('Hello') + md5('How are you?')
      expect(digest).toBe(expectedDigest)
      expect(digest.length).toBe(64) // 2 个 MD5 哈希 = 64 字符
    })

    test('应该处理 user 消息中的 tool_result', () => {
      const messages = [
        { role: 'user', content: 'Search for something' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me search' },
            { type: 'tool_use', id: 't1', name: 'search', input: { query: 'test' } }
          ]
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Found it!' }]
        }
      ]

      const digest = digestHelper.generateDigest(messages)

      // 应该包含 2 个 user 消息的哈希
      const expectedDigest = md5('Search for something') + md5('Found it!')
      expect(digest).toBe(expectedDigest)
    })

    test('应该完全忽略 assistant 消息', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Response 1' },
        { role: 'assistant', content: 'Response 2' },
        { role: 'assistant', content: 'Response 3' }
      ]

      const digest = digestHelper.generateDigest(messages)

      // 只包含 1 个 user 消息
      const expectedDigest = md5('Hello')
      expect(digest).toBe(expectedDigest)
      expect(digest.length).toBe(32) // 1 个 MD5 哈希
    })

    test('应该处理空数组', () => {
      const digest = digestHelper.generateDigest([])
      expect(digest).toBe('')
    })

    test('应该处理只有 assistant 消息的数组', () => {
      const messages = [
        { role: 'assistant', content: 'Only assistant' },
        { role: 'assistant', content: 'Another assistant' }
      ]

      const digest = digestHelper.generateDigest(messages)
      expect(digest).toBe('')
    })

    test('应该处理 user 消息中的数组 content', () => {
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First part' },
            { type: 'text', text: 'Second part' }
          ]
        }
      ]

      const digest = digestHelper.generateDigest(messages)

      // 应该包含 2 个 text block 的哈希
      const expectedDigest = md5('First part') + md5('Second part')
      expect(digest).toBe(expectedDigest)
    })
  })

  describe('validateDigestUpdate', () => {
    test('应该允许首次创建（1个user消息）', () => {
      const newDigest = md5('Hello')
      const result = digestHelper.validateDigestUpdate(null, newDigest)

      expect(result.valid).toBe(true)
      expect(result.action).toBe('create')
    })

    test('应该允许首次创建（多个user消息）', () => {
      const newDigest = md5('A') + md5('B') + md5('C') + md5('D')
      const result = digestHelper.validateDigestUpdate(null, newDigest)

      expect(result.valid).toBe(true)
      expect(result.action).toBe('create')
    })

    test('应该允许首次创建（包含重复内容的user消息）', () => {
      const newDigest = md5('A') + md5('A') + md5('B') + md5('C') + md5('D')
      const result = digestHelper.validateDigestUpdate(null, newDigest)

      expect(result.valid).toBe(true)
      expect(result.action).toBe('create')
    })

    test('应该允许摘要不变', () => {
      const digest = md5('Hello') + md5('World')
      const result = digestHelper.validateDigestUpdate(digest, digest)

      expect(result.valid).toBe(true)
      expect(result.action).toBe('unchanged')
    })

    test('应该允许合法增长（前缀匹配）', () => {
      const oldDigest = md5('Hello')
      const newDigest = md5('Hello') + md5('World')

      const result = digestHelper.validateDigestUpdate(oldDigest, newDigest)

      expect(result.valid).toBe(true)
      expect(result.action).toBe('grow')
    })

    test('应该允许标准回滚（删除后面的消息）', () => {
      const oldDigest = md5('Hello') + md5('World') + md5('!')
      const newDigest = md5('Hello') + md5('World')

      const result = digestHelper.validateDigestUpdate(oldDigest, newDigest)

      expect(result.valid).toBe(true)
      expect(result.action).toBe('rollback')
    })

    test('应该允许修改最后一个block (ABC → ABD)', () => {
      const oldDigest = md5('A') + md5('B') + md5('C')
      const newDigest = md5('A') + md5('B') + md5('D') // 修改最后一个

      const result = digestHelper.validateDigestUpdate(oldDigest, newDigest)

      expect(result.valid).toBe(true)
      expect(result.action).toBe('modify_last')
    })

    test('应该允许修改唯一的block (A → B)', () => {
      const oldDigest = md5('A')
      const newDigest = md5('B') // 修改唯一的block

      const result = digestHelper.validateDigestUpdate(oldDigest, newDigest)

      expect(result.valid).toBe(true)
      expect(result.action).toBe('modify_last')
    })

    test('应该允许回滚N个+修改最后一个 (ABCDEFG → ABCE)', () => {
      const oldDigest =
        md5('A') + md5('B') + md5('C') + md5('D') + md5('E') + md5('F') + md5('G')
      const newDigest = md5('A') + md5('B') + md5('C') + md5('E') // 回滚3个,修改最后一个

      const result = digestHelper.validateDigestUpdate(oldDigest, newDigest)

      expect(result.valid).toBe(true)
      expect(result.action).toBe('rollback_and_modify')
    })

    test('应该允许回滚N个+修改最后一个 (ABCDEFG → AD)', () => {
      const oldDigest =
        md5('A') + md5('B') + md5('C') + md5('D') + md5('E') + md5('F') + md5('G')
      const newDigest = md5('A') + md5('D') // 回滚5个,修改最后一个

      const result = digestHelper.validateDigestUpdate(oldDigest, newDigest)

      expect(result.valid).toBe(true)
      expect(result.action).toBe('rollback_and_modify')
    })

    test('应该允许回滚N个+修改最后一个 (ABC → AD)', () => {
      const oldDigest = md5('A') + md5('B') + md5('C')
      const newDigest = md5('A') + md5('D') // 回滚1个,修改最后一个

      const result = digestHelper.validateDigestUpdate(oldDigest, newDigest)

      expect(result.valid).toBe(true)
      expect(result.action).toBe('rollback_and_modify')
    })

    test('应该拒绝修改开头的block (ABC → XBC)', () => {
      const oldDigest = md5('A') + md5('B') + md5('C')
      const newDigest = md5('X') + md5('B') + md5('C')

      const result = digestHelper.validateDigestUpdate(oldDigest, newDigest)

      expect(result.valid).toBe(false)
      expect(result.reason).toContain('prefix mismatch')
    })

    test('应该拒绝修改中间的block (ABC → AXC)', () => {
      const oldDigest = md5('A') + md5('B') + md5('C')
      const newDigest = md5('A') + md5('X') + md5('C')

      const result = digestHelper.validateDigestUpdate(oldDigest, newDigest)

      expect(result.valid).toBe(false)
      expect(result.reason).toContain('prefix mismatch')
    })

    test('应该拒绝完全不同的摘要', () => {
      const oldDigest = md5('A') + md5('B') + md5('C')
      const newDigest = md5('X') + md5('Y') + md5('Z')

      const result = digestHelper.validateDigestUpdate(oldDigest, newDigest)

      expect(result.valid).toBe(false)
    })
  })

  describe('getDigestRedisKey', () => {
    test('应该生成正确的 Redis 键名', () => {
      const key = digestHelper.getDigestRedisKey('account123', 'session456')
      expect(key).toBe('session_digest:account123:session456')
    })
  })

  describe('splitDigestToBlocks', () => {
    test('应该正确分割摘要为 blocks', () => {
      const digest = md5('Hello') + md5('World')
      const blocks = digestHelper.splitDigestToBlocks(digest)

      expect(blocks).toHaveLength(2)
      expect(blocks[0]).toBe(md5('Hello'))
      expect(blocks[1]).toBe(md5('World'))
    })

    test('应该处理空摘要', () => {
      const blocks = digestHelper.splitDigestToBlocks('')
      expect(blocks).toEqual([])
    })

    test('应该处理 null 或 undefined', () => {
      expect(digestHelper.splitDigestToBlocks(null)).toEqual([])
      expect(digestHelper.splitDigestToBlocks(undefined)).toEqual([])
    })
  })

  describe('_getBlockHashContent', () => {
    test('应该提取 text block 的内容', () => {
      const block = { type: 'text', text: 'Hello world' }
      const content = digestHelper._getBlockHashContent(block)
      expect(content).toBe('Hello world')
    })

    test('应该提取 tool_result 的 content（字符串）', () => {
      const block = {
        type: 'tool_result',
        tool_use_id: 't1',
        content: 'Result data'
      }
      const content = digestHelper._getBlockHashContent(block)
      expect(content).toBe('Result data')
    })

    test('应该序列化 tool_result 的 content（对象）', () => {
      const block = {
        type: 'tool_result',
        tool_use_id: 't1',
        content: { data: 'value' }
      }
      const content = digestHelper._getBlockHashContent(block)
      expect(content).toBe(JSON.stringify({ data: 'value' }))
    })

    test('应该提取 image 的 source.data', () => {
      const block = {
        type: 'image',
        source: { type: 'base64', data: 'iVBORw0KGgo...' }
      }
      const content = digestHelper._getBlockHashContent(block)
      expect(content).toBe('iVBORw0KGgo...')
    })

    test('应该提取 image 的 source.url（如果没有 data）', () => {
      const block = {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/image.jpg' }
      }
      const content = digestHelper._getBlockHashContent(block)
      expect(content).toBe('https://example.com/image.jpg')
    })

    test('应该处理字符串 block', () => {
      const content = digestHelper._getBlockHashContent('Simple string')
      expect(content).toBe('Simple string')
    })

    test('应该序列化未知类型的 block', () => {
      const block = { type: 'unknown_type', data: 'something' }
      const content = digestHelper._getBlockHashContent(block)
      expect(content).toBe(JSON.stringify(block))
    })
  })
})
