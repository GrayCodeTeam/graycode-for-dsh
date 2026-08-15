/**
 * Reroll / edit-turn (F1/F2) — pure decision logic, no React, no I/O.
 *
 * Feature 1 (regenerate): the `conversation.chat.assistant-actions` seat only
 * hands the addressed assistant `messageId`. The `branches/reroll` contract
 * needs the session turn number, which is resolved from the conversation
 * snapshot's `nodes` list (the legacy top-level mirror of the Chat
 * definitions): an `assistant` node carries both its durable `messageId` and
 * the owning `turn`.
 *
 * Feature 2 (edit user message): the `conversation.chat.turnTail` seat hands
 * the completed turn's `TurnLocation` (its `.turn` is the session turn
 * number). `UserMessageNode` itself carries no `turn` field, so the
 * turn → user-message mapping goes through the Chat snapshot's Location index
 * (`chat.locations.getTurn(turn)` → keyed Chat nodes): the `user/message`
 * event lands inside the turn it opens, so the resolved node with `kind:
 * 'user'` is the editable message. The editable text is the concatenation of
 * its `text` content blocks.
 *
 * CLIENT BOUNDARY RULES: everything here is replay-safe and defensive — a
 * drifted host snapshot shape degrades to `undefined` (the buttons then
 * render nothing) instead of crashing the chat flow.
 */

export interface RerollNodeLike {
  readonly kind?: unknown
  readonly messageId?: unknown
  readonly turn?: unknown
}

export interface RerollSnapshotLike {
  readonly nodes?: readonly (RerollNodeLike | null | undefined)[] | undefined
}

/**
 * Resolve the session turn number of the finalized assistant message
 * addressed by `messageId`. Defensive: only `assistant` nodes with a
 * non-negative integer `turn` qualify; absent or drifted rows yield
 * `undefined`. Turns ≤ 1 have no earlier turn to fork before — the host
 * rejects them with `GRAY_BRANCH_NO_PREVIOUS_TURN` — so they also resolve to
 * `undefined` and the regenerate action renders nothing on the first turn.
 */
export function turnOfMessage(snapshot: RerollSnapshotLike | undefined, messageId: unknown): number | undefined {
  if (snapshot === undefined) return undefined
  const want = String(messageId)
  for (const node of snapshot.nodes ?? []) {
    if (node === null || node === undefined) continue
    if (node.kind !== 'assistant') continue
    if (node.messageId === undefined) continue
    if (String(node.messageId) !== want) continue
    if (typeof node.turn === 'number' && Number.isInteger(node.turn) && node.turn >= 0) {
      // 首轮（turn ≤ 1）没有可 fork 的前缀，宿主必报 GRAY_BRANCH_NO_PREVIOUS_TURN；
      // 直接视为不可重生成（按钮不渲染），避免点击后暴露英文原文错误。
      if (node.turn <= 1) return undefined
      return node.turn
    }
  }
  return undefined
}

export interface ContentBlockLike {
  readonly type?: unknown
  readonly text?: unknown
}

/** Host branch-domain code for “the target turn is the first turn (nothing to fork before it)”. */
export const BRANCH_NO_PREVIOUS_TURN_CODE = 'GRAY_BRANCH_NO_PREVIOUS_TURN'

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
    const data = node.data as { readonly kind?: unknown; readonly content?: unknown }
    if (data.kind !== 'user') continue
    const content = Array.isArray(data.content) ? data.content as readonly (ContentBlockLike | null | undefined)[] : undefined
    return { turn, text: textOfBlocks(content) }
  }
  return undefined
}
