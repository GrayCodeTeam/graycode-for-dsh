/**
 * notifications 域参数校验测试：title 必填/trim/长度边界、message 长度边界、
 * level 枚举、silent 布尔、非法参数稳定错误码（GRAY_NOTIFY_INVALID_INPUT）。
 */
import { describe, expect, test } from 'vitest'
import {
  NotificationError,
  NotificationErrorCode,
  type NotifyRequest,
} from '../../src/notifications/domain/types.ts'
import {
  MAX_MESSAGE_LENGTH,
  MAX_TITLE_LENGTH,
  parseNotifyRequest,
} from '../../src/notifications/domain/validate.ts'

/** 返回非法输入的稳定错误码（undefined = 未抛错）。 */
function codeOf(raw: unknown): string | undefined {
  try {
    parseNotifyRequest(raw)
    return undefined
  } catch (error) {
    return error instanceof NotificationError ? error.code : `unexpected:${String(error)}`
  }
}

describe('parseNotifyRequest 合法参数', () => {
  test('仅 title → 默认 level=info / silent=false / message=null，并 trim', () => {
    expect(parseNotifyRequest({ title: '  Build done  ' })).toEqual({
      title: 'Build done',
      message: null,
      level: 'info',
      silent: false,
    })
  })

  test('全部参数透传；message 纯空白归一为 null', () => {
    const parsed = parseNotifyRequest({
      title: 'x',
      message: '   ',
      level: 'error',
      silent: true,
    })
    expect(parsed).toEqual({ title: 'x', message: null, level: 'error', silent: true })
  })

  test('message 保留 trim 后的正文', () => {
    const parsed = parseNotifyRequest({ title: 'x', message: '  hello world  ' })
    expect(parsed.message).toBe('hello world')
  })

  test('合法边界长度不报错', () => {
    expect(() =>
      parseNotifyRequest({ title: 't'.repeat(MAX_TITLE_LENGTH), message: 'm'.repeat(MAX_MESSAGE_LENGTH) }),
    ).not.toThrow()
  })
})

describe('parseNotifyRequest 非法参数 → 稳定错误码', () => {
  test('title 缺失/空/纯空白/非字符串 → GRAY_NOTIFY_INVALID_INPUT', () => {
    for (const raw of [{}, { title: '' }, { title: '   ' }, { title: 42 }, { title: null }, { title: ['x'] }]) {
      expect(codeOf(raw)).toBe(NotificationErrorCode.INVALID_INPUT)
    }
  })

  test('title 超长 → GRAY_NOTIFY_INVALID_INPUT', () => {
    expect(codeOf({ title: 't'.repeat(MAX_TITLE_LENGTH + 1) })).toBe(NotificationErrorCode.INVALID_INPUT)
  })

  test('message 非字符串 / 超长 → GRAY_NOTIFY_INVALID_INPUT', () => {
    expect(codeOf({ title: 'x', message: 42 })).toBe(NotificationErrorCode.INVALID_INPUT)
    expect(codeOf({ title: 'x', message: 'm'.repeat(MAX_MESSAGE_LENGTH + 1) })).toBe(
      NotificationErrorCode.INVALID_INPUT,
    )
    // message 显式 null 合法（空正文）
    expect(() => parseNotifyRequest({ title: 'x', message: null })).not.toThrow()
  })

  test('level 非法 → GRAY_NOTIFY_INVALID_INPUT；合法枚举透传', () => {
    for (const level of ['bogus', 'INFO', 1, null]) {
      expect(codeOf({ title: 'x', level })).toBe(NotificationErrorCode.INVALID_INPUT)
    }
    for (const level of ['info', 'success', 'warning', 'error']) {
      expect(parseNotifyRequest({ title: 'x', level }).level).toBe(level)
    }
  })

  test('silent 非布尔 → GRAY_NOTIFY_INVALID_INPUT', () => {
    for (const silent of ['yes', 1, null]) {
      expect(codeOf({ title: 'x', silent })).toBe(NotificationErrorCode.INVALID_INPUT)
    }
  })

  test('抛出的错误是 NotificationError 且携带稳定 code', () => {
    let caught: unknown
    try {
      parseNotifyRequest({ title: '' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(NotificationError)
    expect((caught as NotificationError).code).toBe(NotificationErrorCode.INVALID_INPUT)
    expect((caught as NotificationError).message.length).toBeGreaterThan(0)
  })
})

describe('parseNotifyRequest 返回类型', () => {
  test('返回规范化 NotifyRequest 形状', () => {
    const parsed: NotifyRequest = parseNotifyRequest({ title: 't' })
    expect(parsed.title).toBe('t')
    expect(parsed.message).toBeNull()
    expect(parsed.level).toBe('info')
    expect(parsed.silent).toBe(false)
  })
})
