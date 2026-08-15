/**
 * GrayCode - migration conversations seed 构造（DSH 公开 session API 的 seed 载荷）
 *
 * 把 legacy 规范化会话视图（meta + Content[]，见 validator.validateConversation 的
 * data 形状）翻译为 DSH session 事件种子，供 conversationTarget.ts 通过
 * `ctx.sessions.create(id, { seed, meta })` 公开 API 创建会话：
 *
 * - 每个用户文本消息开启一个 turn（turn/start → user/message → … → turn/end），
 *   turn 编号 1-based（与 dsh-agent-loop 一致）；
 * - model 文本 → assistant/message（source.kind='model'，provider='migrated'，
 *   model 取 legacy modelVersion 或 'legacy'）；
 * - model functionCall → assistant/message（tool-call 内容块）+ log-only tool/call；
 * - user functionResponse → tool/result（tool-result 块，callId 与 functionCall 配对）；
 * - 未知 role / 未知 part 类型 / 缺 id 的 functionResponse 不进入事件日志，
 *   记入 unmapped（调用方随附 artifact 只读展示，§T4：未知工具调用保留为只读节点）；
 * - 标题 / updatedAt / workspaceUri / custom / subagents / branches 无公开 API
 *   字段，由调用方随附 artifact（本模块只负责事件日志与 header meta）。
 *
 * 确定性：消息 id / callId / 时间戳 / turn 编号全部由 legacy 内容派生
 * （不使用随机 UUID），同一 legacyId + 同一历史 → 逐字节相同的 seed，
 * 幂等重跑不产生差异。事件 seq 从 0 连续递增（Session 构造器强制校验）。
 */

import { createHash } from 'crypto'
import * as path from 'path'
import {
  CallId,
  MessageId,
  freezeMessage,
  type ContentBlock,
  type ToolResultBlock,
  type ToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  SurfaceIntent,
} from '@deepseek-ai/dsh-session'
import { deriveWorkspaceUriCwd as deriveCwdFromWorkspaceUri } from '../../domain/scopeMap.ts'

// 兼容导出：cwd 派生逻辑已下沉到 domain/scopeMap.ts（纯函数，供报告事实复用）；
// decodeFileWorkspaceUri 为跨平台纯函数（4.20-L4：测试可确定性覆盖 Windows 盘符 URI 解码）
export {
  deriveWorkspaceUriCwd as deriveCwdFromWorkspaceUri,
  decodeFileWorkspaceUri,
} from '../../domain/scopeMap.ts'

// ─── 输入视图（validator 规范化负载的宽松视图） ─────────────

export interface LegacyContent {
  role?: unknown
  parts?: unknown
  index?: unknown
  id?: unknown
  parentId?: unknown
  timestamp?: unknown
  modelVersion?: unknown
  usageMetadata?: unknown
  [key: string]: unknown
}

export interface ConversationDataView {
  conversationId?: unknown
  title?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  workspaceUri?: unknown
  custom?: unknown
  history?: unknown
  historyFormat?: unknown
  subagents?: unknown
  branches?: unknown
  [key: string]: unknown
}

// ─── 结果形状 ─────────────────────────

export interface ConversationSeedStats {
  turns: number
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  /** 未进入事件日志的 Content 条目/part 数 */
  unmapped: number
  /** seed 事件总数（不含 Session 构造器自动追加的 session/end-seed） */
  totalEvents: number
}

export interface UnmappedContent {
  /** 在原始 history 数组中的下标 */
  index: number
  reason: string
  content?: unknown
}

export interface ConversationSeed {
  events: SessionEvent[]
  /** 传给 ctx.sessions.create 的 meta（SessionHeader 的调用方字段子集） */
  meta: { cwd?: string; createdAt?: number; seedLength?: number }
  stats: ConversationSeedStats
  unmapped: UnmappedContent[]
}

// ─── 公共构造 ─────────────────────────

/**
 * 确定性会话 id：同 legacyId → 同 session id（幂等重跑不重复创建）。
 * 安全字符直接保留（可读），否则退化为 sha256 前缀。
 */
export function conversationSessionId(legacyId: string): string {
  if (/^[A-Za-z0-9_.-]{1,80}$/.test(legacyId)) return `migrated-${legacyId}`
  return `migrated-${createHash('sha256').update(legacyId).digest('hex').slice(0, 16)}`
}

/**
 * 把规范化会话负载翻译为确定性 DSH 事件种子 + header meta。
 * 不创建会话、不写盘（纯函数；调用方负责 ctx.sessions.create）。
 */
export function buildConversationSeed(data: unknown, options: { legacyId: string }): ConversationSeed {
  const record = (data ?? {}) as ConversationDataView
  const history = Array.isArray(record.history) ? (record.history as unknown[]) : []
  const createdAt = safeTimestamp(record.createdAt)
  const cwd = deriveCwdFromWorkspaceUri(typeof record.workspaceUri === 'string' ? record.workspaceUri : undefined)

  const events: SessionEvent[] = []
  const unmapped: UnmappedContent[] = []
  let seq = 0
  let nextTurn = 1
  let currentTurn: number | undefined
  let turns = 0
  let userMessages = 0
  let assistantMessages = 0
  let toolCalls = 0
  let toolResults = 0
  let lastTime = createdAt ?? 0

  const timeOf = (content: LegacyContent): number => safeTimestamp(content.timestamp) ?? createdAt ?? 0

  const openTurn = (time: number): void => {
    if (currentTurn !== undefined) return
    currentTurn = nextTurn++
    turns += 1
    events.push(makeEvent('turn/start', seq++, time, { turn: currentTurn }))
  }
  const closeTurn = (time: number): void => {
    if (currentTurn === undefined) return
    events.push(makeEvent('turn/end', seq++, time, { turn: currentTurn, reason: { kind: 'completed' } }))
    currentTurn = undefined
  }

  for (const [index, raw] of history.entries()) {
    const content = raw as LegacyContent
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      unmapped.push({ index, reason: '非对象 Content 条目（无法映射为事件）', content: raw })
      continue
    }
    if (content.role !== 'user' && content.role !== 'model') {
      unmapped.push({ index, reason: `未知 role: ${String(content.role)}`, content: raw })
      continue
    }
    const parts = Array.isArray(content.parts) ? (content.parts as unknown[]) : []
    const time = timeOf(content)
    lastTime = time

    if (content.role === 'user') {
      const textParts = parts.filter((p): p is Record<string, unknown> => isRecord(p) && p.type === 'text')
      const fnResponses = parts.filter((p): p is Record<string, unknown> => isRecord(p) && p.type === 'functionResponse')

      if (textParts.length > 0) {
        closeTurn(time)
        openTurn(time)
        const message = freezeMessage({
          id: MessageId(messageIdOf(content, index, options.legacyId)),
          role: 'user' as const,
          content: textParts.map(p => ({ type: 'text' as const, text: String(p.text ?? '') })),
          source: { kind: 'user' as const },
        })
        events.push(makeEvent('user/message', seq++, time, message, { surfaceOp: 'append' }))
        userMessages += 1
      }
      if (fnResponses.length > 0) {
        openTurn(time)
        // 4.14-L7：同一条 user 消息同时含 text 与 functionResponse 时，tool/result
        // 消息不得复用 user 文本消息的 MessageId（DSH 强制消息 id 唯一）——按 part
        // 序号派生独立 id（确定性；同一 Content 内多个 functionResponse 也不冲突）。
        for (const [partIndex, part] of fnResponses.entries()) {
          const id = typeof part.id === 'string' && part.id.length > 0 ? part.id : undefined
          if (!id) {
            unmapped.push({ index, reason: 'functionResponse 缺少 id，无法与调用配对', content: part })
            continue
          }
          const resultBlock: ToolResultBlock = {
            type: 'tool-result',
            toolCallId: CallId(id),
            content: toolResultBlocksOf(part.response),
          }
          const message = freezeMessage<ToolResultMessage>({
            id: MessageId(`${messageIdOf(content, index, options.legacyId)}::tool-result-${partIndex}`),
            role: 'user',
            content: [resultBlock],
            source: { kind: 'tool', callId: CallId(id) },
          })
          events.push(makeEvent('tool/result', seq++, time, { turn: currentTurn!, step: 1, message }, { surfaceOp: 'append' }))
          toolResults += 1
        }
      }
      for (const part of parts) {
        if (!isRecord(part) || (part.type !== 'text' && part.type !== 'functionResponse')) {
          unmapped.push({ index, reason: `未知 user part 类型: ${String(partTypeOf(part))}`, content: part })
        }
      }
      continue
    }

    // role === 'model'
    openTurn(time)
    const textParts = parts.filter((p): p is Record<string, unknown> => isRecord(p) && p.type === 'text')
    const fnCalls = parts.filter((p): p is Record<string, unknown> => isRecord(p) && p.type === 'functionCall')
    const blocks: ContentBlock[] = [
      ...textParts.map(p => ({ type: 'text' as const, text: String(p.text ?? '') })),
      ...fnCalls.map(p => ({
        type: 'tool-call' as const,
        id: CallId(String(p.id ?? `migrated-fc-${options.legacyId}-${index}`)),
        name: String(p.name ?? 'unknown'),
        arguments: argumentsStringOf(p.args),
      })),
    ]
    for (const part of parts) {
      if (!isRecord(part) || (part.type !== 'text' && part.type !== 'functionCall')) {
        unmapped.push({ index, reason: `未知 model part 类型: ${String(partTypeOf(part))}`, content: part })
      }
    }
    if (blocks.length === 0) {
      unmapped.push({ index, reason: 'model 消息无可映射 parts', content: raw })
      continue
    }
    const usage = toTokenUsage(content.usageMetadata)
    const message = freezeMessage({
      id: MessageId(messageIdOf(content, index, options.legacyId)),
      role: 'assistant' as const,
      content: blocks,
      source: {
        kind: 'model' as const,
        provider: 'migrated',
        model: typeof content.modelVersion === 'string' && content.modelVersion.length > 0 ? content.modelVersion : 'legacy',
      },
    })
    events.push(
      makeEvent(
        'assistant/message',
        seq++,
        time,
        { turn: currentTurn!, step: 1, message, ...(usage ? { usage } : {}) },
        { surfaceOp: 'append' },
      ),
    )
    assistantMessages += 1
    for (const part of fnCalls) {
      events.push(
        makeEvent('tool/call', seq++, time, {
          turn: currentTurn!,
          step: 1,
          callId: CallId(String(part.id ?? `migrated-fc-${options.legacyId}-${index}`)),
          name: String(part.name ?? 'unknown'),
          arguments: argumentsStringOf(part.args),
        }),
      )
      toolCalls += 1
    }
  }

  closeTurn(lastTime)

  return {
    events,
    meta: {
      ...(cwd ? { cwd } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(events.length > 0 ? { seedLength: events.length } : {}),
    },
    stats: { turns, userMessages, assistantMessages, toolCalls, toolResults, unmapped: unmapped.length, totalEvents: events.length },
    unmapped,
  }
}

// ─── 内部工具 ─────────────────────────

function makeEvent<T extends SessionEventType>(
  type: T,
  seq: number,
  time: number,
  data: SessionEventMap[T],
  surface?: SurfaceIntent,
): SessionEvent<T> {
  return {
    type,
    seq,
    time,
    data,
    ...(surface?.surfaceOp !== undefined ? { surfaceOp: surface.surfaceOp } : {}),
    ...(surface?.sourceEventSeqs !== undefined ? { sourceEventSeqs: surface.sourceEventSeqs } : {}),
  } as SessionEvent<T>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function partTypeOf(part: unknown): unknown {
  return isRecord(part) ? part.type : undefined
}

function safeTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function messageIdOf(content: LegacyContent, index: number, legacyId: string): string {
  return typeof content.id === 'string' && content.id.length > 0 ? content.id : `migrated-${legacyId}-${index}`
}

function argumentsStringOf(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function toolResultBlocksOf(response: unknown): ContentBlock[] {
  if (isRecord(response) && typeof response.content === 'string' && response.content.length > 0) {
    return [{ type: 'text', text: response.content }]
  }
  if (response === undefined || response === null) return []
  const text = typeof response === 'string' ? response : JSON.stringify(response)
  return text ? [{ type: 'text', text }] : []
}

function toTokenUsage(value: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (!isRecord(value)) return undefined
  const input =
    typeof value.promptTokenCount === 'number'
      ? value.promptTokenCount
      : typeof value.totalTokenCount === 'number'
        ? value.totalTokenCount
        : undefined
  const output = typeof value.candidatesTokenCount === 'number' ? value.candidatesTokenCount : undefined
  return input === undefined && output === undefined ? undefined : { inputTokens: input ?? 0, outputTokens: output ?? 0 }
}
