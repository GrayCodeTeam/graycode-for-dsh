/**
 * C4 notifications surface — node 环境纯逻辑测试（不 import React）：
 * - fold：tool/call + tool/result → 通知意图（生命周期/防御性 readers）；
 * - presenter：参数映射（tag/body/silent）、权限请求/拒绝降级、show 失败收敛；
 * - source：bus 订阅/退订、fixture 回放；
 * - locale：zh/en 平衡 + ja 占位 key 集镜像。
 */
import { describe, expect, it } from 'vitest'
import {
  NOTIFY_TOOL_NAME,
  notificationId,
  notificationsFromWindow,
  createNotificationFoldSession,
  parseNotifyArgs,
  readNotifyToolCall,
  readNotifyToolResult,
  type NotificationEventLike,
  type NotificationStreamWindow,
} from '../src/client/notifications/fold.ts'
import {
  BrowserNotificationPresenter,
  NOTIFICATION_TAG_PREFIX,
  createBrowserNotificationPort,
  notificationShowOptions,
  notificationTag,
  shouldPresent,
} from '../src/client/notifications/presenter.ts'
import {
  createFixtureNotificationSource,
  createNotificationBus,
} from '../src/client/notifications/source.ts'
import {
  GRAYCODE_NOTIFICATIONS_NS,
  graycodeNotificationsDictionaries,
  graycodeNotificationsJaPlaceholder,
} from '../src/client/notifications/locales.ts'
import type {
  NotificationApiPort,
  NotificationIntent,
  NotificationPermissionState,
} from '../src/client/notifications/types.ts'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function toolCall(callId: string, name: string, args: string, time = 1000): NotificationEventLike {
  return { type: 'tool/call', seq: 1, time, data: { callId, name, turn: 0, step: 0, arguments: args } }
}

function toolResult(
  callId: string,
  error?: { name: string; code: string },
  time = 2000,
): NotificationEventLike {
  return {
    type: 'tool/result',
    seq: 2,
    time,
    data: {
      turn: 0,
      step: 0,
      message: {
        role: 'tool',
        source: { callId },
        content: [{ type: 'text', text: '{}' }],
      },
      ...(error !== undefined ? { error } : {}),
    },
  }
}

function windowOf(...entries: NotificationEventLike[]): NotificationStreamWindow {
  return { entries }
}

const NOTIFY_ARGS = JSON.stringify({ title: 'Build passed', message: 'all green', level: 'success', silent: true })

function intent(overrides: Partial<NotificationIntent> = {}): NotificationIntent {
  return {
    id: 'call:c1',
    title: 'Build passed',
    body: 'all green',
    level: 'success',
    silent: false,
    at: 1000,
    status: 'completed',
    ...overrides,
  }
}

function portOf(
  overrides: Partial<{
    permission: NotificationPermissionState | undefined
    request: NotificationPermissionState
    showResult: boolean
  }> = {},
): {
  port: NotificationApiPort
  calls: { show: Array<{ title: string; options: unknown }>; requests: number }
} {
  const calls = { show: [] as Array<{ title: string; options: unknown }>, requests: 0 }
  // 注意：必须用 in 判断而非 ??——调用方显式传 permission: undefined 表示
  // 「环境不支持」（port 返回 undefined），?? 会把它兜底成 granted 掩盖该场景。
  const permission = 'permission' in overrides ? overrides.permission : 'granted'
  const port: NotificationApiPort = {
    permission: () => permission,
    requestPermission: async () => {
      calls.requests += 1
      return overrides.request ?? 'granted'
    },
    show: (title, options) => {
      calls.show.push({ title, options })
      return overrides.showResult ?? true
    },
  }
  return { port, calls }
}

// ---------------------------------------------------------------------------
// fold
// ---------------------------------------------------------------------------

describe('fold readers', () => {
  it('readNotifyToolCall 只认 notify 且字段完整', () => {
    const call = readNotifyToolCall({ callId: 'c1', name: 'notify', turn: 0, step: 0, arguments: '{}' })
    expect(call).toEqual({ callId: 'c1', arguments: '{}' })
    expect(readNotifyToolCall({ callId: 'c1', name: 'get_activity_stats', turn: 0, step: 0, arguments: '{}' })).toBeNull()
    expect(readNotifyToolCall({ name: 'notify', turn: 0, step: 0, arguments: '{}' })).toBeNull()
    expect(readNotifyToolCall('nope')).toBeNull()
    expect(readNotifyToolCall(null)).toBeNull()
  })

  it('readNotifyToolResult 经 message.source.callId 关联', () => {
    const ok = readNotifyToolResult({ turn: 0, step: 0, message: { source: { callId: 'c1' }, content: [] } })
    expect(ok).toEqual({ callId: 'c1', error: undefined })
    const err = readNotifyToolResult({
      turn: 0,
      step: 0,
      message: { source: { callId: 'c1' }, content: [] },
      error: { name: 'NotificationError', code: 'GRAY_NOTIFY_INVALID_INPUT' },
    })
    expect(err?.error).toEqual({ name: 'NotificationError', code: 'GRAY_NOTIFY_INVALID_INPUT' })
    expect(readNotifyToolResult({ turn: 0, step: 0, message: { source: {}, content: [] } })).toBeNull()
    expect(readNotifyToolResult('nope')).toBeNull()
  })

  it('缺 message.source.callId 时用 meta.callId 兜底（4.7-M2）', () => {
    const viaMeta = readNotifyToolResult({
      turn: 0,
      step: 0,
      meta: { callId: 'c9' },
      message: { source: {}, content: [] },
    })
    expect(viaMeta).toEqual({ callId: 'c9', error: undefined })
  })

  it('source/meta 皆缺时用 fallbackId 兜底，不产生 undefined 键（4.7-M2）', () => {
    const viaFallback = readNotifyToolResult({ turn: 0, step: 0, message: { source: {}, content: [] } }, 'seq:42')
    expect(viaFallback).toEqual({ callId: 'seq:42', error: undefined })
    // 未提供 fallbackId 时仍保持原语义：无关联键 → null
    expect(readNotifyToolResult({ turn: 0, step: 0, message: { source: {}, content: [] } })).toBeNull()
  })

  it('parseNotifyArgs 默认值 / 防御性收窄', () => {
    expect(parseNotifyArgs(JSON.stringify({ title: 'T', message: ' M ', level: 'warning', silent: true }))).toEqual({
      title: 'T',
      body: 'M',
      level: 'warning',
      silent: true,
    })
    expect(parseNotifyArgs(JSON.stringify({ title: 'T' }))).toEqual({
      title: 'T',
      body: null,
      level: 'info',
      silent: false,
    })
    const degraded = parseNotifyArgs(JSON.stringify({ title: 'T', level: 'bogus' }))
    expect(degraded?.level).toBe('info')
    const silent = parseNotifyArgs(JSON.stringify({ title: 'T', silent: 'yes' }))
    expect(silent?.silent).toBe(false)
    expect(parseNotifyArgs('not-json')).toBeNull()
    expect(parseNotifyArgs('[]')).toBeNull()
    expect(parseNotifyArgs(JSON.stringify({ message: 'no title' }))).toBeNull()
    expect(parseNotifyArgs('')).toBeNull()
  })
})

describe('notificationsFromWindow', () => {
  it('notify 调用 + 成功 result → completed 意图（字段映射完整）', () => {
    const intents = notificationsFromWindow(
      windowOf(toolCall('c1', NOTIFY_TOOL_NAME, NOTIFY_ARGS, 1234), toolResult('c1')),
    )
    expect(intents).toEqual([
      {
        id: 'call:c1',
        title: 'Build passed',
        body: 'all green',
        level: 'success',
        silent: true,
        at: 1234,
        status: 'completed',
      },
    ])
  })

  it('仅有 tool/call → active（未定论）', () => {
    const intents = notificationsFromWindow(windowOf(toolCall('c1', NOTIFY_TOOL_NAME, NOTIFY_ARGS)))
    expect(intents).toHaveLength(1)
    expect(intents[0]!.status).toBe('active')
  })

  it('非取消错误 → failed；GRAY_CANCELLED → cancelled', () => {
    const failed = notificationsFromWindow(
      windowOf(
        toolCall('c1', NOTIFY_TOOL_NAME, NOTIFY_ARGS),
        toolResult('c1', { name: 'NotificationError', code: 'GRAY_NOTIFY_INVALID_INPUT' }),
      ),
    )
    expect(failed[0]!.status).toBe('failed')

    const cancelled = notificationsFromWindow(
      windowOf(
        toolCall('c1', NOTIFY_TOOL_NAME, NOTIFY_ARGS),
        toolResult('c1', { name: 'Error', code: 'GRAY_CANCELLED' }),
      ),
    )
    expect(cancelled[0]!.status).toBe('cancelled')
  })

  it('非 notify 工具 / 参数非法的调用被忽略', () => {
    expect(notificationsFromWindow(windowOf(toolCall('c1', 'get_activity_stats', '{}')))).toEqual([])
    expect(notificationsFromWindow(windowOf(toolCall('c1', NOTIFY_TOOL_NAME, '{}')))).toEqual([])
    expect(notificationsFromWindow(windowOf(toolCall('c1', NOTIFY_TOOL_NAME, 'not-json')))).toEqual([])
  })

  it('窗口内无对应 call 的 result 不产生意图（start-less 不渲染）', () => {
    expect(notificationsFromWindow(windowOf(toolResult('c1')))).toEqual([])
  })

  it('多次调用按窗口顺序输出，互不串扰', () => {
    const intents = notificationsFromWindow(
      windowOf(
        toolCall('c1', NOTIFY_TOOL_NAME, NOTIFY_ARGS, 100),
        toolCall('c2', NOTIFY_TOOL_NAME, JSON.stringify({ title: 'Second' }), 200),
        toolResult('c1'),
      ),
    )
    expect(intents.map((i) => i.id)).toEqual(['call:c1', 'call:c2'])
    expect(intents[1]!.status).toBe('active')
  })

  it('notificationId 稳定', () => {
    expect(notificationId('c1')).toBe('call:c1')
  })
})

describe('createNotificationFoldSession（跨窗口关联，4.7-M1）', () => {
  it('tool/call 与 tool/result 跨窗口仍能关联并终结（不再永停 active）', () => {
    const session = createNotificationFoldSession()
    const w1 = session.push(windowOf(toolCall('c1', NOTIFY_TOOL_NAME, NOTIFY_ARGS, 1000)))
    expect(w1).toHaveLength(1)
    expect(w1[0]!.id).toBe('call:c1')
    expect(w1[0]!.status).toBe('active')

    // result 在下一个窗口到达：仍能关联到上一个窗口的 call
    const w2 = session.push(windowOf(toolResult('c1', undefined, 2000)))
    expect(w2).toHaveLength(1)
    expect(w2[0]!.id).toBe('call:c1')
    expect(w2[0]!.status).toBe('completed')
    expect(w2[0]!.title).toBe('Build passed')
    expect(w2[0]!.at).toBe(1000) // 时间取自 tool/call
  })

  it('跨窗口错误结果 → failed / cancelled，同样终结 active', () => {
    const session = createNotificationFoldSession()
    session.push(windowOf(toolCall('c1', NOTIFY_TOOL_NAME, NOTIFY_ARGS, 1000)))
    const out = session.push(
      windowOf(toolResult('c1', { name: 'NotificationError', code: 'GRAY_NOTIFY_INVALID_INPUT' }, 2000)),
    )
    expect(out[0]!.status).toBe('failed')

    const session2 = createNotificationFoldSession()
    session2.push(windowOf(toolCall('c2', NOTIFY_TOOL_NAME, NOTIFY_ARGS, 1000)))
    const out2 = session2.push(windowOf(toolResult('c2', { name: 'Error', code: 'GRAY_CANCELLED' }, 2000)))
    expect(out2[0]!.status).toBe('cancelled')
  })

  it('同一窗口 call+result 只输出终结态（与 notificationsFromWindow 一致）', () => {
    const session = createNotificationFoldSession()
    const out = session.push(windowOf(toolCall('c1', NOTIFY_TOOL_NAME, NOTIFY_ARGS, 1000), toolResult('c1')))
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('call:c1')
    expect(out[0]!.status).toBe('completed')
  })

  it('会话内仍不渲染 start-less result；非 notify / 非法参数忽略', () => {
    const session = createNotificationFoldSession()
    expect(session.push(windowOf(toolResult('c1')))).toEqual([])
    expect(session.push(windowOf(toolCall('c1', 'get_activity_stats', '{}')))).toEqual([])
    expect(session.push(windowOf(toolCall('c1', NOTIFY_TOOL_NAME, '{}')))).toEqual([])
  })

  it('notificationsFromWindow 遇无 callId 的 result 不产生 undefined 键（不崩溃）', () => {
    const intents = notificationsFromWindow(
      windowOf({
        type: 'tool/result',
        seq: 3,
        time: 3000,
        data: { turn: 0, step: 0, message: { source: {}, content: [] } },
      }),
    )
    expect(intents).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// presenter
// ---------------------------------------------------------------------------

describe('shouldPresent / 参数映射', () => {
  it('只有 completed 展示', () => {
    expect(shouldPresent(intent({ status: 'completed' }))).toBe(true)
    expect(shouldPresent(intent({ status: 'active' }))).toBe(false)
    expect(shouldPresent(intent({ status: 'failed' }))).toBe(false)
    expect(shouldPresent(intent({ status: 'cancelled' }))).toBe(false)
  })

  it('notificationTag / notificationShowOptions 参数映射', () => {
    expect(notificationTag(intent())).toBe(`${NOTIFICATION_TAG_PREFIX}:call:c1`)
    expect(notificationShowOptions(intent({ silent: true }))).toEqual({
      tag: `${NOTIFICATION_TAG_PREFIX}:call:c1`,
      silent: true,
      body: 'all green',
    })
    expect(notificationShowOptions(intent({ body: null }))).toEqual({
      tag: `${NOTIFICATION_TAG_PREFIX}:call:c1`,
      silent: false,
    })
  })
})

describe('BrowserNotificationPresenter 权限生命周期', () => {
  it('granted → show 被调用（title + 映射 options），返回 shown', async () => {
    const { port, calls } = portOf({ permission: 'granted' })
    const presenter = new BrowserNotificationPresenter(port)
    const result = await presenter.present(intent())
    expect(result).toEqual({ status: 'shown', intentId: 'call:c1' })
    expect(calls.requests).toBe(0)
    expect(calls.show).toHaveLength(1)
    expect(calls.show[0]!.title).toBe('Build passed')
    expect(calls.show[0]!.options).toEqual({
      tag: `${NOTIFICATION_TAG_PREFIX}:call:c1`,
      silent: false,
      body: 'all green',
    })
  })

  it('default → 先请求权限；granted 后展示', async () => {
    const { port, calls } = portOf({ permission: 'default', request: 'granted' })
    const presenter = new BrowserNotificationPresenter(port)
    const result = await presenter.present(intent())
    expect(result.status).toBe('shown')
    expect(calls.requests).toBe(1)
    expect(calls.show).toHaveLength(1)
  })

  it('default → 请求后被拒 → denied（不 show，降级应用内列表）', async () => {
    const { port, calls } = portOf({ permission: 'default', request: 'denied' })
    const presenter = new BrowserNotificationPresenter(port)
    const result = await presenter.present(intent())
    expect(result).toEqual({ status: 'denied', intentId: 'call:c1' })
    expect(calls.requests).toBe(1)
    expect(calls.show).toHaveLength(0)
  })

  it('已 denied → 不请求不展示，直接 denied', async () => {
    const { port, calls } = portOf({ permission: 'denied' })
    const presenter = new BrowserNotificationPresenter(port)
    const result = await presenter.present(intent())
    expect(result).toEqual({ status: 'denied', intentId: 'call:c1' })
    expect(calls.requests).toBe(0)
    expect(calls.show).toHaveLength(0)
  })

  it('环境不支持（permission undefined）→ unsupported', async () => {
    const { port } = portOf({ permission: undefined })
    const presenter = new BrowserNotificationPresenter(port)
    expect(await presenter.present(intent())).toEqual({ status: 'unsupported', intentId: 'call:c1' })
  })

  it('show 返回 false / 抛异常 → failed（绝不 reject）', async () => {
    const { port } = portOf({ showResult: false })
    const presenter = new BrowserNotificationPresenter(port)
    expect(await presenter.present(intent())).toEqual({ status: 'failed', intentId: 'call:c1' })

    const throwingPort: NotificationApiPort = {
      permission: () => 'granted',
      requestPermission: async () => 'granted',
      show: () => {
        throw new Error('notification boom')
      },
    }
    const presenter2 = new BrowserNotificationPresenter(throwingPort)
    expect(await presenter2.present(intent())).toEqual({ status: 'failed', intentId: 'call:c1' })
  })

  it('requestPermission 抛异常 → failed', async () => {
    const port: NotificationApiPort = {
      permission: () => 'default',
      requestPermission: async () => {
        throw new Error('permission boom')
      },
      show: () => true,
    }
    const presenter = new BrowserNotificationPresenter(port)
    expect(await presenter.present(intent())).toEqual({ status: 'failed', intentId: 'call:c1' })
  })

  it('requestPermission 返回非标准值 → 按拒绝处理（4.7-L4）', async () => {
    const bogusPort: NotificationApiPort = {
      permission: () => 'default',
      // 旧式浏览器可能返回 'prompt' 或其它非标准值
      requestPermission: async () => 'prompt' as unknown as NotificationPermissionState,
      show: () => true,
    }
    const presenter = new BrowserNotificationPresenter(bogusPort)
    expect(await presenter.present(intent())).toEqual({ status: 'denied', intentId: 'call:c1' })

    const undefinedPort: NotificationApiPort = {
      permission: () => 'default',
      requestPermission: async () => undefined as unknown as NotificationPermissionState,
      show: () => true,
    }
    const presenter2 = new BrowserNotificationPresenter(undefinedPort)
    expect(await presenter2.present(intent())).toEqual({ status: 'denied', intentId: 'call:c1' })
  })

  it('非 completed 意图 → failed 且不触碰端口', async () => {
    const { port, calls } = portOf({ permission: 'granted' })
    const presenter = new BrowserNotificationPresenter(port)
    expect(await presenter.present(intent({ status: 'failed' }))).toEqual({
      status: 'failed',
      intentId: 'call:c1',
    })
    expect(calls.show).toHaveLength(0)
  })

  it('node 环境 createBrowserNotificationPort → unsupported / 拒绝 / 不展示', async () => {
    const port = createBrowserNotificationPort()
    expect(port.permission()).toBeUndefined()
    expect(port.show('x', {})).toBe(false)
    expect(await port.requestPermission()).toBe('denied')
  })
})

// ---------------------------------------------------------------------------
// source
// ---------------------------------------------------------------------------

describe('createNotificationBus', () => {
  it('subscribe 收到 push；退订后不再收到', () => {
    const bus = createNotificationBus()
    const received: string[] = []
    const detach = bus.source.subscribe((item) => received.push(item.id))
    bus.push(intent({ id: 'a' }))
    bus.push(intent({ id: 'b' }))
    detach()
    bus.push(intent({ id: 'c' }))
    expect(received).toEqual(['a', 'b'])
  })

  it('subscribe 前 push 不投递（无历史回放）', () => {
    const bus = createNotificationBus()
    bus.push(intent({ id: 'a' }))
    const received: string[] = []
    bus.source.subscribe((item) => received.push(item.id))
    expect(received).toEqual([])
  })

  it('单个订阅者抛异常不中断其余订阅者，也不上抛（4.7-L3）', () => {
    const bus = createNotificationBus()
    const received: string[] = []
    bus.source.subscribe(() => {
      throw new Error('boom')
    })
    bus.source.subscribe((item) => received.push(item.id))
    expect(() => bus.push(intent({ id: 'x' }))).not.toThrow()
    expect(received).toEqual(['x'])
  })
})

describe('createFixtureNotificationSource', () => {
  it('subscribe 时同步回放全部意图', () => {
    const source = createFixtureNotificationSource([intent({ id: 'a' }), intent({ id: 'b' })])
    const received: string[] = []
    source.subscribe((item) => received.push(item.id))
    expect(received).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// locale
// ---------------------------------------------------------------------------

describe('notifications locale', () => {
  it('zh/en 字典平衡（key 集一致）且命名空间正确', () => {
    const zh = Object.keys(graycodeNotificationsDictionaries.zh).sort()
    const en = Object.keys(graycodeNotificationsDictionaries.en).sort()
    expect(zh).toEqual(en)
    expect(GRAYCODE_NOTIFICATIONS_NS).toBe('graycode.notifications')
    expect(graycodeNotificationsDictionaries.zh['level.error']).toBe('错误')
    expect(graycodeNotificationsDictionaries.en['state.empty']).toBe('No notifications')
  })

  it('ja 占位 key 集镜像 zh/en', () => {
    const zh = Object.keys(graycodeNotificationsDictionaries.zh).sort()
    const ja = Object.keys(graycodeNotificationsJaPlaceholder).sort()
    expect(ja).toEqual(zh)
    expect(graycodeNotificationsJaPlaceholder.title).toBe('システム通知')
  })
})
