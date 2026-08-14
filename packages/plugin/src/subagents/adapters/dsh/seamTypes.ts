/**
 * GrayCode - dsh-subagent 公开 API 的结构化子集（SessionPersistenceLike 先例）
 *
 * src 不 import `@deepseek-ai/dsh-subagent`（devDep，src 不直接依赖）；本文件按
 * dsh-subagent@0.1.0-rc.6 的 .d.ts（lib/types/index.d.ts / continuation.d.ts /
 * list-children.d.ts / types.d.ts）取「守卫实际消费」的公开方法形状，字段用宽类型，
 * 运行时经 `ctx.subagents as unknown as SubagentsSeamLike` 注入真实 seam。
 * 涉及的底层类型（Agent / ContentBlock / MessageId / SessionId）均为 peerDependencies。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** SubagentFollowupOptions 的消费子集（透传，不做结构消费）。 */
export interface SubagentFollowupOptionsLike {
  readonly source?: unknown
  readonly signal?: AbortSignal
}

/** SubagentReportOptions 的消费子集（delivery 是公开枚举，其余透传）。 */
export interface SubagentReportOptionsLike {
  readonly delivery?: 'quiet' | 'wakeup'
  readonly signal?: AbortSignal
}

/** SubagentStartRequest 的消费子集（guard 只读 parent 做并发计数）。 */
export interface SubagentStartRequestLike {
  readonly parent: Agent
  readonly signal: AbortSignal
}

/** ContinuableStartSpec 的消费子集（guard 只读 request.parent）。 */
export interface SubagentStartContinuableSpecLike {
  readonly provider: string
  readonly label: string
  readonly request: { readonly parent: Agent }
  readonly signal: AbortSignal
}

/** SubagentRun 的消费子集（透传，不消费形状）。 */
export interface SubagentRunLike {
  readonly id: SessionId
  readonly result: Promise<unknown>
  dispose(): Promise<void>
}

/** ContinuableStart 的消费子集（透传）。 */
export interface SubagentContinuableStartLike {
  readonly childId: SessionId
  readonly messageId: MessageId
}

/** SubagentListEntry 的消费子集（G3 只读 kind/activity 统计运行中数量）。 */
export interface SubagentListEntryLike {
  readonly kind: 'child' | 'diagnostic'
  readonly id: SessionId
  readonly activity?: 'running' | 'inactive'
}

/** ctx.subagents 的结构化子集：guard 包装的全部公开方法。 */
export interface SubagentsSeamLike {
  followup(
    parent: Agent,
    childId: SessionId,
    content: readonly ContentBlock[],
    options: SubagentFollowupOptionsLike,
  ): Promise<MessageId>
  reportFrom(
    child: Agent,
    content: readonly ContentBlock[],
    options: SubagentReportOptionsLike,
  ): Promise<MessageId>
  start(name: string, request: SubagentStartRequestLike): Promise<SubagentRunLike>
  startContinuable(spec: SubagentStartContinuableSpecLike): Promise<SubagentContinuableStartLike>
  listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntryLike[]>
}
