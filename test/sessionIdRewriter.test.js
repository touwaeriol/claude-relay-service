/**
 * sessionIdRewriter 单元测试
 *
 * 测试会话ID重写功能，确保：
 * - UUID v5 生成的确定性（同输入得到同输出）
 * - 未开启 rewriteSessionId 或非 claude 平台时不作修改
 * - metadata.user_id 缺失或不匹配正则时保持原样
 * - 多个UUID字段同步替换（session_id, sessionId, conversation_id, conversationId）
 */
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const { v5: uuidv5 } = require('uuid')

// 直接导入 sessionIdRewriter 模块
const rewriteSessionId = require('../src/utils/sessionIdRewriter')

describe('sessionIdRewriter', () => {
  const validAccountId = '11111111-1111-4111-8111-111111111111'
  const originalSessionId = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff'
  const validUserId = `user_${'a'.repeat(64)}_account__session_${originalSessionId}`

  describe('isRewriteEnabled', () => {
    test('未启用 rewriteSessionId 时不重写', () => {
      const body = {
        metadata: { user_id: validUserId }
      }
      const account = {
        id: validAccountId,
        platform: 'claude',
        rewriteSessionId: false
      }

      const originalBody = JSON.stringify(body)
      rewriteSessionId(body, { account })

      expect(JSON.stringify(body)).toBe(originalBody)
    })

    test('非 claude 平台时不重写', () => {
      const body = {
        metadata: { user_id: validUserId }
      }
      const account = {
        id: validAccountId,
        platform: 'openai',
        rewriteSessionId: true
      }

      const originalBody = JSON.stringify(body)
      rewriteSessionId(body, { account })

      expect(JSON.stringify(body)).toBe(originalBody)
    })

    test('平台名称大小写不敏感', () => {
      const body = {
        metadata: { user_id: validUserId }
      }
      const account = {
        id: validAccountId,
        platform: 'CLAUDE',
        rewriteSessionId: true
      }

      rewriteSessionId(body, { account })

      // 应该被重写
      expect(body.metadata.user_id).not.toBe(validUserId)
    })
  })

  describe('UUID v5 确定性', () => {
    test('相同输入生成相同输出', () => {
      const body1 = {
        metadata: { user_id: validUserId }
      }
      const body2 = {
        metadata: { user_id: validUserId }
      }
      const account = {
        id: validAccountId,
        platform: 'claude',
        rewriteSessionId: true
      }

      rewriteSessionId(body1, { account })
      rewriteSessionId(body2, { account })

      expect(body1.metadata.user_id).toBe(body2.metadata.user_id)

      // 验证生成的UUID格式正确
      const rewrittenSessionId = body1.metadata.user_id.match(
        /user_[a-f0-9]{64}_account__session_([a-f0-9-]{36})$/
      )[1]
      expect(rewrittenSessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )
    })

    test('不同 accountId 生成不同输出', () => {
      const body1 = {
        metadata: { user_id: validUserId }
      }
      const body2 = {
        metadata: { user_id: validUserId }
      }
      const account1 = {
        id: '11111111-1111-4111-8111-111111111111',
        platform: 'claude',
        rewriteSessionId: true
      }
      const account2 = {
        id: '22222222-2222-4222-8222-222222222222',
        platform: 'claude',
        rewriteSessionId: true
      }

      rewriteSessionId(body1, { account: account1 })
      rewriteSessionId(body2, { account: account2 })

      expect(body1.metadata.user_id).not.toBe(body2.metadata.user_id)
    })

    test('不同 sessionId 生成不同输出', () => {
      const sessionId1 = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff'
      const sessionId2 = 'bbbbcccc-dddd-eeee-ffff-000000000000'
      const userId1 = `user_${'a'.repeat(64)}_account__session_${sessionId1}`
      const userId2 = `user_${'a'.repeat(64)}_account__session_${sessionId2}`

      const body1 = {
        metadata: { user_id: userId1 }
      }
      const body2 = {
        metadata: { user_id: userId2 }
      }
      const account = {
        id: validAccountId,
        platform: 'claude',
        rewriteSessionId: true
      }

      rewriteSessionId(body1, { account })
      rewriteSessionId(body2, { account })

      expect(body1.metadata.user_id).not.toBe(body2.metadata.user_id)
    })

    test('生成的UUID与直接调用 uuidv5 结果一致', () => {
      const body = {
        metadata: { user_id: validUserId }
      }
      const account = {
        id: validAccountId,
        platform: 'claude',
        rewriteSessionId: true
      }

      rewriteSessionId(body, { account })

      const rewrittenSessionId = body.metadata.user_id.match(
        /user_[a-f0-9]{64}_account__session_([a-f0-9-]{36})$/
      )[1]
      const expectedSessionId = uuidv5(originalSessionId, validAccountId)

      expect(rewrittenSessionId).toBe(expectedSessionId)
    })
  })

  describe('metadata.user_id 验证', () => {
    test('缺失 metadata 时保持原样', () => {
      const body = {}
      const account = {
        id: validAccountId,
        platform: 'claude',
        rewriteSessionId: true
      }

      const originalBody = JSON.stringify(body)
      rewriteSessionId(body, { account })

      expect(JSON.stringify(body)).toBe(originalBody)
    })

    test('缺失 user_id 时保持原样', () => {
      const body = {
        metadata: {}
      }
      const account = {
        id: validAccountId,
        platform: 'claude',
        rewriteSessionId: true
      }

      const originalBody = JSON.stringify(body)
      rewriteSessionId(body, { account })

      expect(JSON.stringify(body)).toBe(originalBody)
    })

    test('user_id 不匹配正则时保持原样', () => {
      const invalidUserIds = [
        'invalid_format',
        'user_short_account__session_abc',
        `user_${'a'.repeat(63)}_account__session_${originalSessionId}`, // 少一位
        `user_${'a'.repeat(65)}_account__session_${originalSessionId}` // 多一位
      ]

      invalidUserIds.forEach((invalidUserId) => {
        const body = {
          metadata: { user_id: invalidUserId }
        }
        const account = {
          id: validAccountId,
          platform: 'claude',
          rewriteSessionId: true
        }

        const originalBody = JSON.stringify(body)
        rewriteSessionId(body, { account })

        expect(JSON.stringify(body)).toBe(originalBody)
      })
    })

    test('非 UUID 的 session 值仍会生成新 UUID', () => {
      const customSessionId = 'custom-session-token-001'
      const nonUuidUserId = `user_${'a'.repeat(64)}_account__session_${customSessionId}`
      const body = {
        metadata: { user_id: nonUuidUserId },
        session_id: customSessionId,
        sessionId: customSessionId,
        conversation_id: customSessionId,
        conversationId: customSessionId
      }
      const account = {
        id: validAccountId,
        platform: 'claude',
        rewriteSessionId: true
      }

      rewriteSessionId(body, { account })

      const match = body.metadata.user_id.match(
        /user_[a-f0-9]{64}_account__session_([a-f0-9-]{36})$/
      )
      expect(match).not.toBeNull()
      const rewrittenSessionId = match[1]

      expect(body.session_id).toBe(rewrittenSessionId)
      expect(body.sessionId).toBe(rewrittenSessionId)
      expect(body.conversation_id).toBe(rewrittenSessionId)
      expect(body.conversationId).toBe(rewrittenSessionId)
    })
  })

  describe('多字段同步替换', () => {
    test('session_id 字段同步替换', () => {
      const body = {
        metadata: { user_id: validUserId },
        session_id: originalSessionId
      }
      const account = {
        id: validAccountId,
        platform: 'claude',
        rewriteSessionId: true
      }

      rewriteSessionId(body, { account })

      const rewrittenSessionId = body.metadata.user_id.match(
        /user_[a-f0-9]{64}_account__session_([a-f0-9-]{36})$/
      )[1]

      expect(body.session_id).toBe(rewrittenSessionId)
      expect(body.session_id).not.toBe(originalSessionId)
    })

    test('sessionId 字段同步替换', () => {
      const body = {
        metadata: { user_id: validUserId },
        sessionId: originalSessionId
      }
      const account = {
        id: validAccountId,
        platform: 'claude',
        rewriteSessionId: true
      }

      rewriteSessionId(body, { account })

      const rewrittenSessionId = body.metadata.user_id.match(
        /user_[a-f0-9]{64}_account__session_([a-f0-9-]{36})$/
      )[1]

      expect(body.sessionId).toBe(rewrittenSessionId)
    })

    test('conversation_id 字段同步替换', () => {
      const body = {
        metadata: { user_id: validUserId },
        conversation_id: originalSessionId
      }
      const account = {
        id: validAccountId,
        platform: 'claude',
        rewriteSessionId: true
      }

      rewriteSessionId(body, { account })

      const rewrittenSessionId = body.metadata.user_id.match(
        /user_[a-f0-9]{64}_account__session_([a-f0-9-]{36})$/
      )[1]

      expect(body.conversation_id).toBe(rewrittenSessionId)
    })

    test('conversationId 字段同步替换', () => {
      const body = {
        metadata: { user_id: validUserId },
        conversationId: originalSessionId
      }
      const account = {
        id: validAccountId,
        platform: 'claude',
        rewriteSessionId: true
      }

      rewriteSessionId(body, { account })

      const rewrittenSessionId = body.metadata.user_id.match(
        /user_[a-f0-9]{64}_account__session_([a-f0-9-]{36})$/
      )[1]

      expect(body.conversationId).toBe(rewrittenSessionId)
    })

    test('多个字段同时替换', () => {
      const body = {
        metadata: { user_id: validUserId },
        session_id: originalSessionId,
        sessionId: originalSessionId,
        conversation_id: originalSessionId,
        conversationId: originalSessionId
      }
      const account = {
        id: validAccountId,
        platform: 'claude',
        rewriteSessionId: true
      }

      rewriteSessionId(body, { account })

      const rewrittenSessionId = body.metadata.user_id.match(
        /user_[a-f0-9]{64}_account__session_([a-f0-9-]{36})$/
      )[1]

      expect(body.session_id).toBe(rewrittenSessionId)
      expect(body.sessionId).toBe(rewrittenSessionId)
      expect(body.conversation_id).toBe(rewrittenSessionId)
      expect(body.conversationId).toBe(rewrittenSessionId)
    })

    test('字段值不匹配时不替换', () => {
      const differentSessionId = 'bbbbcccc-dddd-eeee-ffff-000000000000'
      const body = {
        metadata: { user_id: validUserId },
        session_id: differentSessionId
      }
      const account = {
        id: validAccountId,
        platform: 'claude',
        rewriteSessionId: true
      }

      rewriteSessionId(body, { account })

      // user_id 被重写了
      expect(body.metadata.user_id).not.toBe(validUserId)

      // 但 session_id 不匹配原始值，所以不被替换
      expect(body.session_id).toBe(differentSessionId)
    })
  })

  describe('边缘情况', () => {
    test('account 为 null 时保持原样', () => {
      const body = {
        metadata: { user_id: validUserId }
      }

      const originalBody = JSON.stringify(body)
      rewriteSessionId(body, { account: null })

      expect(JSON.stringify(body)).toBe(originalBody)
    })

    test('account 缺失 platform 时保持原样', () => {
      const body = {
        metadata: { user_id: validUserId }
      }
      const account = {
        id: validAccountId,
        rewriteSessionId: true
      }

      const originalBody = JSON.stringify(body)
      rewriteSessionId(body, { account })

      expect(JSON.stringify(body)).toBe(originalBody)
    })

    test('accountId 不是有效 UUID 时抛出错误', () => {
      const body = {
        metadata: { user_id: validUserId }
      }
      const account = {
        id: 'invalid-uuid',
        platform: 'claude',
        rewriteSessionId: true
      }

      expect(() => {
        rewriteSessionId(body, { account })
      }).toThrow(/must be a valid UUID/)
    })

    test('accountId 为空时抛出错误', () => {
      const body = {
        metadata: { user_id: validUserId }
      }
      const account = {
        id: '',
        platform: 'claude',
        rewriteSessionId: true
      }

      expect(() => {
        rewriteSessionId(body, { account })
      }).toThrow(/must be a valid UUID/)
    })

    test('body 为 null 时不报错', () => {
      const account = {
        id: validAccountId,
        platform: 'claude',
        rewriteSessionId: true
      }

      expect(() => {
        rewriteSessionId(null, { account })
      }).not.toThrow()
    })
  })
})
