/**
 * C4 多平台系统通知 — 会话事件 → 通知意图（纯折叠，replay-safe）。
 *
 * host→client 通道结论（README）：rc.6 无通用 host→client 推送通道，唯一可用的
 * host→client 数据流是会话事件流（`tool/call` / `tool/result` 经
 * `ctx.conversationEvents.register` 分发给已注册 Definition）。本模块把一段
 * 会话事件窗口折叠为 {@link NotificationIntent} 列表——纯函数、零 I/O、
 * 防御性收窄（不信任事件载荷），供测试与任何「把事件流接进通知展示」的接线方使用。
 *
 * 跨窗口关联（4.7-M1）：会话事件流按窗口喂给 {@link createNotificationFoldSession}
 * 时，在途 `tool/call` 的状态跨窗口保留，晚到的 `tool/result` 仍能终结对应意图
 * （`notificationsFromWindow` 本身仍是单窗口纯函数，行为不变）。
 */

import {
  NOTIFICATION_LEVELS,
  type NotificationIntent,
  type NotificationIntentStatus,
  type NotificationLevel,
} from './types.ts'

/** host 侧 notify 工具名（镜像 packages/plugin/src/notifications/tools.ts）。 */
export const NOTIFY_TOOL_NAME = 'notify'

/** 会话事件的结构化视图（与 dsh-client-runtime 会话事件的超类型同构）。 */
export interface NotificationEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

export interface NotificationStreamWindow {
  readonly entries: readonly NotificationEventLike[]
}

/** 收窄后的 `notify` tool/call 载荷。 */
export interface NotifyCallLike {
  readonly callId: string
  /** 模型直传的 JSON 参数字符串。 */
  readonly arguments: string
}

/**
 * 从 `tool/call` 事件载荷读 notify 调用（非 notify / 结构非法 → null）。
 * @param data - 原始事件 data（unknown；按契约防御性收窄）。
 */
export function readNotifyToolCall(data: unknown): NotifyCallLike | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  if (typeof record.callId !== 'string' || record.callId.length === 0) return null
  if (typeof record.name !== 'string' || record.name !== NOTIFY_TOOL_NAME) return null
  return {
    callId: record.callId,
    arguments: typeof record.arguments === 'string' ? record.arguments : '',
  }
}

/** 收窄后的 `tool/result` 载荷（callId 经 message.source.callId 关联）。 */
export interface NotifyResultLike {
  readonly callId: string
  readonly error: { readonly name: string; readonly code: string } | undefined
}

function readResultCallId(record: Record<string, unknown>): string | null {
  const message = record.message
  if (typeof message === 'object' && message !== null) {
    const source = (message as Record<string, unknown>).source
    if (typeof source === 'object' && source !== null) {
      const callId = (source as Record<string, unknown>).callId
      if (typeof callId === 'string' && callId.length > 0) return callId
    }
  }
  // 4.7-M2 兜底：message.source.callId 缺失时读 meta.callId（workflowNode 已验证
  // 宿主会在 meta 上挂 callId），避免结果因缺少关联键而无法终结对应通知。
  const meta = record.meta
  if (typeof meta === 'object' && meta !== null) {
    const callId = (meta as Record<string, unknown>).callId
    if (typeof callId === 'string' && callId.length > 0) return callId
  }
  return null
}

/**
 * 从 `tool/result` 事件载荷读结果关联（无 callId / 结构非法 → null）。
 *
 * 4.7-M2：`message.source.callId` 与 `meta.callId` 都缺失时用事件层兜底键
 * `fallbackId`（如事件 seq），绝不产生 `undefined` 关联键。
 * @param data - 原始事件 data。
 * @param fallbackId - 可选兜底关联键（调用方传事件 `seq` 派生的稳定键）。
 */
export function readNotifyToolResult(data: unknown, fallbackId?: string): NotifyResultLike | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  const callId = readResultCallId(record)
  const resolvedCallId =
    callId ?? (fallbackId !== undefined && fallbackId.length > 0 ? fallbackId : null)
  if (resolvedCallId === null) return null
  const errorValue = record.error
  let error: { readonly name: string; readonly code: string } | undefined
  if (typeof errorValue === 'object' && errorValue !== null) {
    const err = errorValue as Record<string, unknown>
    if (typeof err.name === 'string' && typeof err.code === 'string') {
      error = { name: err.name, code: err.code }
    }
  }
  return { callId: resolvedCallId, error }
}

/** 通知意图稳定 id（`call:<callId>`，与窗口外 result 的无 start 语义解耦）。 */
export function notificationId(callId: string): string {
  return `call:${callId}`
}

/** 解析后的 notify 参数（与 host 校验语义对齐的客户端收窄）。 */
export interface ParsedNotifyArgs {
  readonly title: string
  readonly body: string | null
  readonly level: NotificationLevel
  readonly silent: boolean
}

/**
 * 解析 `tool/call.arguments`（模型直传 JSON 字符串；防御性）。
 * title 缺失/非字符串 → null（该调用不产生通知意图）；level 非法 → info；
 * silent 仅严格 true。
 * @param raw - verbatim arguments 字符串。
 */
export function parseNotifyArgs(raw: string): ParsedNotifyArgs | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const title = typeof record.title === 'string' && record.title.trim().length > 0
    ? record.title.trim()
    : null
  if (title === null) return null
  const body = typeof record.message === 'string' && record.message.trim().length > 0
    ? record.message.trim()
    : null
  const level = typeof record.level === 'string' && (NOTIFICATION_LEVELS as readonly string[]).includes(record.level)
    ? record.level as NotificationLevel
    : 'info'
  const silent = record.silent === true
  return { title, body, level, silent }
}

/**
 * 把一段会话事件窗口折叠为通知意图列表（window 顺序、纯函数、replay-safe）。
 *
 * 语义（与 workflowNode 引擎折叠一致）：
 * - `tool/call`（notify）→ 开始一条意图（status active）；
 * - `tool/result`（按 callId 关联）→ 终结状态（completed/failed/cancelled）；
 * - 窗口内无对应 `tool/call` 的 result 不产生意图（start-less 不渲染）；
 * - 非 notify 事件、参数非法的调用一律忽略。
 *
 * @param window - 会话事件窗口（结构性视图）。
 */
export function notificationsFromWindow(window: NotificationStreamWindow): NotificationIntent[] {
  const calls = new Map<string, { args: ParsedNotifyArgs; time: number }>()
  const results = new Map<string, { readonly name: string; readonly code: string } | null>()

  for (const event of window.entries) {
    if (event.type === 'tool/call') {
      const call = readNotifyToolCall(event.data)
      if (call === null) continue
      const args = parseNotifyArgs(call.arguments)
      if (args === null) continue
      calls.set(call.callId, { args, time: event.time })
    } else if (event.type === 'tool/result') {
      // 4.7-M2：callId 缺失时用事件 seq 兜底，保证 results 绝不出现 undefined 键。
      const result = readNotifyToolResult(event.data, `seq:${event.seq}`)
      if (result === null) continue
      results.set(result.callId, result.error ?? null)
    }
  }

  const intents: NotificationIntent[] = []
  for (const [callId, call] of calls) {
    const error = results.get(callId)
    const status: NotificationIntentStatus =
      error === undefined
        ? 'active'
        : error === null
          ? 'completed'
          : error.code === 'GRAY_CANCELLED'
            ? 'cancelled'
            : 'failed'
    intents.push({
      id: notificationId(callId),
      title: call.args.title,
      body: call.args.body,
      level: call.args.level,
      silent: call.args.silent,
      at: call.time,
      status,
    })
  }
  return intents
}

/**
 * 跨窗口折叠会话（4.7-M1 修复）。
 *
 * `notificationsFromWindow` 只折叠单个窗口：tool/call 与 tool/result 跨窗口时
 * 关联丢失，通知会永久停在 active、系统 toast 永不弹。本会话在窗口之间保留在途
 * `tool/call` 的关联状态（按 callId 关联——同一会话事件流内 callId 唯一），使
 * 晚到的 `tool/result` 仍能终结对应意图；start-less result（会话内无对应 call）
 * 依旧不渲染。
 *
 * 用法（主会话接线）：
 * ```ts
 * const fold = createNotificationFoldSession()
 * // on each session window: for (const i of fold.push(window)) bus.push(i)
 * ```
 */
export interface NotificationFoldSession {
  /** 处理一段事件窗口；返回本窗口内新增/更新的意图（同一 id 只返回最终状态）。 */
  push(window: NotificationStreamWindow): NotificationIntent[]
}

/** 创建一个跨窗口折叠会话（把整个会话事件流按窗口喂入）。 */
export function createNotificationFoldSession(): NotificationFoldSession {
  // 在途 notify 调用（callId → 参数 + 时间）；跨窗口保留 → result 晚到也能关联。
  const inflight = new Map<string, { args: ParsedNotifyArgs; time: number }>()

  return {
    push(window) {
      // 按 callId 去重：同一 id 在窗口内最后状态胜出（call + result 同窗口只发终结态）。
      const emitted = new Map<string, NotificationIntent>()
      for (const event of window.entries) {
        if (event.type === 'tool/call') {
          const call = readNotifyToolCall(event.data)
          if (call === null) continue
          const args = parseNotifyArgs(call.arguments)
          if (args === null) continue
          inflight.set(call.callId, { args, time: event.time })
          emitted.set(notificationId(call.callId), {
            id: notificationId(call.callId),
            title: args.title,
            body: args.body,
            level: args.level,
            silent: args.silent,
            at: event.time,
            status: 'active',
          })
        } else if (event.type === 'tool/result') {
          // 4.7-M2：callId 缺失时用事件 seq 兜底，绝不产生 undefined 关联键。
          const result = readNotifyToolResult(event.data, `seq:${event.seq}`)
          if (result === null) continue
          const call = inflight.get(result.callId)
          if (call === undefined) continue // start-less：会话内无对应 call → 不渲染
          inflight.delete(result.callId)
          const status: NotificationIntentStatus =
            result.error === undefined || result.error === null
              ? 'completed'
              : result.error.code === 'GRAY_CANCELLED'
                ? 'cancelled'
                : 'failed'
          emitted.set(notificationId(result.callId), {
            id: notificationId(result.callId),
            title: call.args.title,
            body: call.args.body,
            level: call.args.level,
            silent: call.args.silent,
            at: call.time,
            status,
          })
        }
      }
      return [...emitted.values()]
    },
  }
}
