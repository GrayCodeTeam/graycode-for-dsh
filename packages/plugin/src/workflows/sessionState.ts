/**
 * Review 会话门闸（DSH 进程内实现）
 *
 * 源实现存会话 conversation metadata（vscode 持久化）。DSH 下改为进程内
 * Map<sessionId, 状态>（key = exec.agent.session.header.id）：
 * 进程重启后状态丢失（会话门闸退化为仅文档自身状态约束——reviewDocumentSection
 * 仍会在 finalize 后拒绝追加里程碑、reopen 仅允许 finalized 文档）。
 */

import type { ConversationReviewSessionState } from './domain/review/schema.ts'

export const REVIEW_SESSION_METADATA_KEY = 'reviewSession'

const sessionStates = new Map<string, ConversationReviewSessionState>()

/** 测试与诊断用：清空全部进程内会话状态 */
export function resetReviewSessionStatesForTest(): void {
  sessionStates.clear()
}

export function loadReviewSessionState(sessionId?: string): ConversationReviewSessionState | null {
  if (!sessionId) return null
  return sessionStates.get(sessionId) || null
}

export function saveReviewSessionState(
  sessionId: string | undefined,
  state: ConversationReviewSessionState | null
): void {
  if (!sessionId) return
  if (state === null) {
    sessionStates.delete(sessionId)
    return
  }
  sessionStates.set(sessionId, state)
}

export function clearReviewSessionState(sessionId?: string): void {
  saveReviewSessionState(sessionId, null)
}

export function ensureNoActiveReviewSession(
  sessionId: string | undefined,
  requestedPath: string
): { ok: true } | { ok: false; error: string; session: ConversationReviewSessionState } {
  const session = loadReviewSessionState(sessionId)
  if (!session || session.status !== 'in_progress') {
    return { ok: true }
  }

  return {
    ok: false,
    error: `An active review session already exists for this conversation: ${session.reviewPath}. Finish or reopen that review before creating another review document. Requested path: ${requestedPath}`,
    session,
  }
}

export function ensureMatchingActiveReviewSession(
  sessionId: string | undefined,
  requestedPath: string
): { ok: true; session?: ConversationReviewSessionState } | { ok: false; error: string; session?: ConversationReviewSessionState } {
  const session = loadReviewSessionState(sessionId)
  if (!session) {
    return { ok: true }
  }

  if (session.reviewPath !== requestedPath) {
    return {
      ok: false,
      error: `Active review session path mismatch. Active review: ${session.reviewPath}. Requested path: ${requestedPath}`,
      session,
    }
  }

  if (session.status === 'completed') {
    return {
      ok: false,
      error: `The active review session is already finalized for path: ${requestedPath}. Reopen the review before writing more milestones.`,
      session,
    }
  }

  return { ok: true, session }
}
