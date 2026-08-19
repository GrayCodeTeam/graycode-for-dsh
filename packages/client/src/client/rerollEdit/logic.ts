/**
 * Reroll / edit-turn (F1/F2) — 纯决策逻辑，无 React、无 I/O。
 *
 * 功能 1（重新生成）：挂在 `conversation.chat.turnTail` 链座位（每个已完成轮次
 * 渲染一次），链选择器直接给出该轮的会话轮号；`isRerollableTurn` 承担
 * 轮次防御（仅正整数可用）；第一轮由宿主从空 seed 重新发送原消息。
 *
 * 功能 2（编辑用户消息）：编辑入口以独立 chat 节点（见 editNode.ts）锚定在
 * 用户消息正后方，渲染器经 `editTargetOfTurn` 从会话快照解析该轮「开轮」
 * 的用户消息：Chat 快照 Location 索引（`chat.locations.getTurn(turn)`）给出
 * 该轮的节点 key 列表，其中渲染 kind 与载荷 kind 均为 `user` 的第一个节点即
 * 可编辑消息；返回的 `seq` 用于与节点锚定的用户消息事件比对（steering /
 * 注入上下文消息不渲染编辑铅笔）。可编辑文本为其 `text` 内容块拼接。
 *
 * CLIENT BOUNDARY RULES：这里的一切都可重放且防御式——宿主快照形状漂变时
 * 一律降级为 `undefined`（按钮随之不渲染），绝不炸聊天流。
 */

export interface ContentBlockLike {
  readonly type?: unknown
  readonly text?: unknown
}

/** Host branch-domain code for “the target turn is the first turn (nothing to fork before it)”. */
export const BRANCH_NO_PREVIOUS_TURN_CODE = 'GRAY_BRANCH_NO_PREVIOUS_TURN'

/**
 * True when a completed turn can be rerolled / edit-retried. The first turn
 * is valid: it forks an empty seed and resends that turn's user message.
 */
export function isRerollableTurn(turn: unknown): turn is number {
  if (typeof turn !== 'number') return false
  if (!Number.isInteger(turn)) return false
  return turn >= 1
}

/**
 * True when a remote failure envelope carries the host's
 * `GRAY_BRANCH_NO_PREVIOUS_TURN` domain error (mapped to `GRAY_INVALID_INPUT`
 * with `details.causeCode` preserved). The UI shows a localized message for
 * this well-known case instead of the raw English error text.
 */
export function isNoPreviousTurnFailure(
  error: { readonly details?: Readonly<Record<string, unknown>> } | undefined,
): boolean {
  return error?.details?.causeCode === BRANCH_NO_PREVIOUS_TURN_CODE
}

/** Plain text of the `text` blocks of a message, in source order. */
export function textOfBlocks(content: readonly (ContentBlockLike | null | undefined)[] | undefined): string {
  if (content === undefined) return ''
  let text = ''
  for (const block of content) {
    if (block === null || block === undefined) continue
    if (block.type !== 'text') continue
    if (typeof block.text === 'string') text += block.text
  }
  return text
}

export interface EditChatNodeLike {
  readonly kind?: unknown
  /** Opaque renderer payload (the host types it as unknown); narrowed defensively below. */
  readonly data?: unknown
}

export interface EditSnapshotLike {
  readonly chat?: {
    readonly locations?: { getTurn(turn: number): readonly string[] | undefined }
    readonly nodes?: { get(key: string): EditChatNodeLike | undefined }
  }
}

export interface EditTurnTarget {
  readonly turn: number
  /** Durable event seq of the turn-opening user message (steering/context guard). */
  readonly seq: number
  readonly text: string
}

/**
 * Resolve the editable user message that opened `turn`. Only the Chat node
 * whose renderer kind AND payload kind are both `user` qualifies (steering /
 * injected-context messages are not user-editable). `undefined` when the
 * turn's user message is outside the loaded window or the snapshot drifted.
 */
export function editTargetOfTurn(snapshot: EditSnapshotLike | undefined, turn: number): EditTurnTarget | undefined {
  if (snapshot === undefined) return undefined
  const locations = snapshot.chat?.locations
  const nodes = snapshot.chat?.nodes
  if (locations === undefined || nodes === undefined) return undefined
  const keys = locations.getTurn(turn)
  if (keys === undefined) return undefined
  for (const key of keys) {
    const node = nodes.get(key)
    if (node === undefined) continue
    if (node.kind !== 'user') continue
    if (typeof node.data !== 'object' || node.data === null) continue
    const data = node.data as { readonly kind?: unknown; readonly seq?: unknown; readonly content?: unknown }
    if (data.kind !== 'user') continue
    if (typeof data.seq !== 'number' || !Number.isInteger(data.seq)) continue
    const content = Array.isArray(data.content) ? data.content as readonly (ContentBlockLike | null | undefined)[] : undefined
    return { turn, seq: data.seq, text: textOfBlocks(content) }
  }
  return undefined
}
