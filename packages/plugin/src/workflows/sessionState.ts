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

/** 会话级互斥队列：把「门闸检查 → 写文档 → 保存会话状态」按 sessionId 串行化 */
const sessionLocks = new Map<string, Promise<unknown>>()

/**
 * 在 per-session 互斥内执行 `fn`（sessionId 缺省时退化为单条全局队列）。
 *
 * 用途：create_review 的会话门闸是「检查-然后-写」，与文件写锁不在同一临界区时，
 * 同一 sessionId 并发创建不同路径的 review 会双双通过门闸，后写者覆盖先写者的
 * 会话状态，先创建的 review 文档成为孤儿。把「重查门闸 → 写文件 → 保存状态」整体
 * 包进本锁后，同一会话的创建严格串行：第二个创建者重查门闸时必然看到活跃会话并拒绝。
 */
export function withReviewSessionLock<T>(sessionId: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = sessionId || ''
  const previous = sessionLocks.get(key) || Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(fn)
  sessionLocks.set(key, next)
  // 队列排空后清理条目，避免 Map 随会话数无限增长
  next
    .finally(() => {
      if (sessionLocks.get(key) === next) {
        sessionLocks.delete(key)
      }
    })
    .catch(() => undefined)
  return next
}

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
