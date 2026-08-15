/**
 * GrayCode - autoCheckpoints 纯逻辑（零宿主依赖，便于单测）：
 * 触发判定（enabled/开关/tool 命中）、存档标题与 notes、当前轮次推导、
 * 同一 turn 内同类型去重。
 */

export type AutoCheckpointKind =
  | { readonly type: 'user-message' }
  | { readonly type: 'tool'; readonly toolName: string }

export interface AutoCheckpointPolicyConfig {
  readonly enabled: boolean
  readonly beforeUserMessage: boolean
  readonly beforeMajorChange: boolean
  readonly majorChangeTools: readonly string[]
}

/** 用户消息提交前存档开关（enabled 与 beforeUserMessage 同时为 true）。 */
export function shouldCreateUserCheckpoint(config: Pick<AutoCheckpointPolicyConfig, 'enabled' | 'beforeUserMessage'>): boolean {
  return config.enabled && config.beforeUserMessage
}

/** 大改动前存档判定：enabled + beforeMajorChange + 工具名命中 majorChangeTools。 */
export function shouldCreateToolCheckpoint(
  config: Pick<AutoCheckpointPolicyConfig, 'enabled' | 'beforeMajorChange' | 'majorChangeTools'>,
  toolName: string
): boolean {
  return config.enabled && config.beforeMajorChange && config.majorChangeTools.includes(toolName)
}

/** 存档标题：`auto: user message before` / `auto: tool <name> before`。 */
export function checkpointTitleFor(kind: AutoCheckpointKind): string {
  return kind.type === 'user-message' ? 'auto: user message before' : `auto: tool ${kind.toolName} before`
}

/** 存档 notes：携带会话 id 与轮次。 */
export function checkpointNotesFor(sessionId: string, turn: number | undefined): string {
  return turn === undefined ? `session: ${sessionId}` : `session: ${sessionId}, turn: ${turn}`
}

/** 去重键中的类型段（turnKey + type）。 */
export function checkpointKindKey(kind: AutoCheckpointKind): string {
  return kind.type === 'user-message' ? 'user' : `tool:${kind.toolName}`
}

/** turnKey：会话 id + 轮次（轮次未知时用 'open' 兜底，避免跨 turn 串键）。 */
export function dedupeKeyFor(sessionId: string, turn: number | undefined, kind: AutoCheckpointKind): string {
  return `${sessionId}:${turn === undefined ? 'open' : turn}:${checkpointKindKey(kind)}`
}

/**
 * 同一 turn 内同类型只建一次（Map 记 turnKey+type）。容量超限整体重置
 * （单 turn 的建点数远小于上限，重置不可能拆散同一 turn 的去重窗口）。
 */
export class AutoCheckpointDedupe {
  static readonly MAX_KEYS = 2048

  private readonly claimed = new Set<string>()

  /** 已记录过该 (session, turn, kind) 时返回 false；否则记录并返回 true。 */
  claim(sessionId: string, turn: number | undefined, kind: AutoCheckpointKind): boolean {
    if (this.claimed.size >= AutoCheckpointDedupe.MAX_KEYS) this.claimed.clear()
    const key = dedupeKeyFor(sessionId, turn, kind)
    if (this.claimed.has(key)) return false
    this.claimed.add(key)
    return true
  }
}

/** 从会话事件日志推导当前开放轮次（最后一条 turn/start 的 turn；无则 undefined）。 */
export function currentTurnOf(events: readonly { type: string; data?: unknown }[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start') {
      const data = event.data as { turn?: number } | undefined
      return data?.turn
    }
  }
  return undefined
}

/** user/message 事件是否为直接用户消息（source.kind === 'user'，与 branches 域同口径）。 */
export function isDirectUserMessage(event: { type: string; data?: { source?: { kind?: string } } }): boolean {
  return event.type === 'user/message' && event.data?.source?.kind === 'user'
}
