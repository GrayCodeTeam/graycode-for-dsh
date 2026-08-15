/**
 * 编辑用户消息的 chat 节点 Definition（F2 重构：编辑入口贴近用户消息）。
 *
 * DSH rc.6 的 `conversation.chat.*` 座位清单里没有「用户消息操作行」座位
 * （assistant-actions 只挂最终化 assistant 消息的 IconActions 行；用户气泡
 * 的 MessageIconActions 不透传任何座位），但 `ChatNodeDataMap` 是可合并扩展
 * 的渲染器注册表：本文件向其注册 `graycode.editAction` 载荷，并实现
 * `ConversationNodeDefinition`，为每个 append 型 `user/message` 事件物化一个
 * 锚定在该消息 seq + 0.05 的 chat 节点——渲染位置紧跟用户气泡之后（宿主
 * 的 maxTokensNotice 用同一偏移惯例插在 closing Assistant 与 turn-tail 之间）。
 * key 化座位 `conversation.chat.node` 的对应渲染器（EditUserAction.tsx）把它
 * 画成小铅笔按钮，视觉上属于用户消息。
 *
 * 引擎契约（对照 dsh-client-runtime conversation.d.ts / workflowNode 模式）：
 * - `match` 只收原始事件——append 型判定按 dsh-session/surface 的
 *   `isAppendSurfaceEvent` 语义做结构化复刻（type ∈ 消息型事件集合且
 *   `surfaceOp === 'append'`），避免跨插件值导入；
 * - `start` 从 match.location 解析轮号（turn/start 先于 user/message 落盘，
 *   引擎必能给到 turn/step 位置）；
 * - 不实现 `buildLocationData`：Location key 冲突会被引擎拒绝，同一轮内的
 *   steering 消息会重复发布同 key；编辑入口不需要 Location 业务值；
 * - `buildViewNode` 返回 `node.key === context.key`（引擎强校验）。
 */
import type {
  ChatConversationViewNode,
  ConversationLocation,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { textOfBlocks, type ContentBlockLike } from './logic.ts'

/** 本 Definition 的稳定 kind（同时是 key 化渲染器注册表的 key）。 */
export const EDIT_ACTION_KIND = 'graycode.editAction'

/**
 * 锚定在用户消息后的编辑入口载荷。`turn` 来自引擎解析的事件位置（罕见
 * 情况下 unresolved 则为 undefined，渲染器直接不渲染）；`seq` 是用户消息
 * 事件的持久 seq，渲染器用它比对「本轮开轮消息」排除 steering/注入消息。
 */
export interface EditActionNodeData {
  readonly turn: number | undefined
  readonly seq: number
  readonly time: number
  readonly messageId: string
  readonly sourceKind: string
  readonly text: string
}

/** 结构化事件视图（宿主类型在浏览器侧不可值导入，全部按形状收窄）。 */
export interface EditActionEventLike {
  readonly type?: unknown
  readonly seq?: unknown
  readonly time?: unknown
  /** dsh-session 的事件信封标记：'append' | 'replace'（surface 层）。 */
  readonly surfaceOp?: unknown
  readonly data?: unknown
}

export interface EditActionMatchLike {
  readonly id: string
  readonly role: 'start' | 'update'
}

/** `user/message` 事件载荷（UserMessage：id/content/source）。 */
interface UserMessagePayload {
  readonly id?: unknown
  readonly content?: unknown
  readonly source?: { readonly kind?: unknown } | null | undefined
}

function readUserMessagePayload(data: unknown): UserMessagePayload | null {
  if (typeof data !== 'object' || data === null) return null
  return data as UserMessagePayload
}

/**
 * 识别一条会话事件是否是 append 型用户消息。
 * 复刻宿主 messageDefinition 的匹配前提：`user/message` + append 面（替换型
 * 副本只在模型面生效，不属于人类可编辑的对话流）。
 */
export function matchEditActionEvent(event: EditActionEventLike): EditActionMatchLike | null {
  if (event.type !== 'user/message') return null
  if (event.surfaceOp !== 'append') return null
  const data = readUserMessagePayload(event.data)
  if (data === null) return null
  const id = data.id
  if (typeof id !== 'string' && typeof id !== 'number') return null
  return { id: `edit:${String(id)}`, role: 'start' }
}

/** 从引擎位置解析轮号（与宿主 turnLocation 帮助函数同语义）。 */
export function turnOfLocation(location: ConversationLocation | undefined): number | undefined {
  if (location === undefined) return undefined
  if (location.kind !== 'turn' && location.kind !== 'step') return undefined
  const turn = location.turn.turn
  return typeof turn === 'number' ? turn : undefined
}

/** 由唯一 start Match 创建 State（消息事实快照，可重放）。 */
export function startEditActionNode(match: { readonly event: EditActionEventLike }): EditActionNodeData {
  const event = match.event
  const data = readUserMessagePayload(event.data)
  const id = data?.id
  const sourceKind = typeof data?.source?.kind === 'string' ? data.source.kind : ''
  const content = Array.isArray(data?.content) ? data.content as readonly (ContentBlockLike | null | undefined)[] : undefined
  return {
    turn: undefined,
    seq: typeof event.seq === 'number' ? event.seq : 0,
    time: typeof event.time === 'number' ? event.time : 0,
    messageId: typeof id === 'string' || typeof id === 'number' ? String(id) : '',
    sourceKind,
    text: textOfBlocks(content),
  }
}

/** start 阶段：消息事实快照 + 引擎位置解析出的轮号（模块级具名函数，保证 Definition 工厂跨调用引用稳定——reloadStability 的 apply() 纯度测试按结构深比较注册序列）。 */
const startEditActionDefinition: ConversationNodeDefinition<EditActionNodeData>['start'] = (
  context,
  match,
): EditActionNodeData => {
  const state = startEditActionNode(match as unknown as { readonly event: EditActionEventLike })
  const turn = turnOfLocation(match.location)
  return context.state === undefined ? { ...state, turn } : context.state
}

/** update 阶段：消息事实不可变，透传当前 State。 */
const updateEditActionDefinition: ConversationNodeDefinition<EditActionNodeData>['update'] = (context) => context.state

/** match 阶段的窄化适配（模块级具名函数，见 startEditActionDefinition 注释）。 */
const matchEditActionDefinition: ConversationNodeDefinition<EditActionNodeData>['match'] = (event) =>
  matchEditActionEvent(event as unknown as EditActionEventLike)

/** The registered Definition（见 editNode.ts 文件头）的工厂：纯函数、可测试。 */
export function createEditActionDefinition(): ConversationNodeDefinition<EditActionNodeData> {
  return {
    kind: EDIT_ACTION_KIND,
    target: 'chat',
    match: matchEditActionDefinition,
    start: startEditActionDefinition,
    update: updateEditActionDefinition,
    buildViewNode: buildEditActionViewNode,
  }
}

/** 本节点类型的最终 chat 视图节点。 */
export type EditActionChatNode = ChatConversationViewNode & {
  readonly kind: typeof EDIT_ACTION_KIND
  readonly data: EditActionNodeData
}

/** 宿主 key 化渲染器注册表的载荷声明（EditUserAction 的 keyProps 来源）。 */
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** 用户消息编辑入口（铅笔按钮，F2）。 */
    [EDIT_ACTION_KIND]: EditActionNodeData
  }
}

/**
 * 物化最终 chat 节点：锚定 seq + 0.05（紧跟用户气泡之后、本轮其余节点
 * 之前），State 缺失（start 事件不在窗口内）返回 null。
 */
export function buildEditActionViewNode(
  context: ConversationNodeContext<EditActionNodeData>,
): EditActionChatNode | null {
  const state = context.state
  if (state === undefined) return null
  const anchorEvent = context.start?.event ?? context.matches[0]?.event
  if (anchorEvent === undefined) return null
  const anchorSeq = typeof (anchorEvent as { readonly seq?: unknown }).seq === 'number'
    ? (anchorEvent as { readonly seq: number }).seq + 0.05
    : state.seq + 0.05
  return {
    key: context.key,
    kind: EDIT_ACTION_KIND,
    id: context.id,
    target: 'chat',
    data: state,
    anchorSeq,
    location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
    visibility: 'visible',
  }
}
