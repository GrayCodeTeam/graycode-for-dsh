/**
 * Review 会话门闸（DSH 持久化实现，审计项 W-M2）
 *
 * 源实现存会话 conversation metadata（vscode 持久化）。DSH rc.6 无 storageDomain
 * API（已核实 @deepseek-ai/* 包无该符号），按 ADR-0002 §2 sidecar 模式把会话状态
 * 落到插件私有目录：`<dataRoot>/workflows/review-sessions.json`（原子 tmp+rename，
 * Windows rename-overwrite 重试，损坏文件备份隔离后重建空库）。
 *
 * 对外 API 保持同步签名（load/save/clear + 门闸函数），现有 tools 调用方无需改动：
 * - 进程内 Map 是同步缓存（key = exec.agent.session.header.id）；
 * - 首次访问（load/save）时同步兜底 hydration（readFileSync 一次），保证门闸在
 *   任何时序下读到磁盘真相，不存在「重启后门闸退化」窗口；
 * - 每次 save 把整库异步序列化写盘（同一条 promise 链，单进程内顺序一致）；
 *   插件卸载时经 initReviewSessionStore 返回的 disposer flush 在途写入。
 *
 * 行为不变式（与旧版一致）：
 * - 进程重启后同一会话的活跃 review 门闸仍然生效（可继续拦截第二个 active
 *   review、路径不匹配、finalize 后追加）；
 * - 无 dataRoot（空串）时退化为纯内存（与原进程内实现一致，不落盘）。
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { ConversationReviewSessionState } from './domain/review/schema.ts'

export const REVIEW_SESSION_METADATA_KEY = 'reviewSession'

/** sidecar 信封（版本化；损坏/形状非法 → 隔离后重建空库） */
interface ReviewSessionsStoreFile {
  version: 1
  sessions: Record<string, ConversationReviewSessionState>
}

const REVIEW_SESSIONS_STORE_VERSION = 1
const REVIEW_SESSIONS_STORE_FILE = 'review-sessions.json'

/** 会话级互斥队列：把「门闸检查 → 写文档 → 保存会话状态」按 sessionId 串行化 */
const sessionLocks = new Map<string, Promise<unknown>>()

/** 进程内同步缓存（对外 API 的读取面） */
const sessionStates = new Map<string, ConversationReviewSessionState>()

let storeDir: string | undefined
let storePath: string | undefined
let hydrated = false
/** 持久化串行链：hydration 与每次保存都进同一条链，单进程内顺序一致 */
let persistChain: Promise<unknown> = Promise.resolve()

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

/** 测试与诊断用：清空全部进程内会话状态与持久化配置（下次访问回到未 hydration 状态） */
export function resetReviewSessionStatesForTest(): void {
  sessionStates.clear()
  storeDir = undefined
  storePath = undefined
  hydrated = false
}

/**
 * 初始化会话状态持久化（workflows 插件 apply 时调用；dataRoot 为空则纯内存）。
 *
 * 返回 disposer：插件卸载时 flush 在途写入（best-effort）。
 */
export function initReviewSessionStore(dataRoot: string): () => void {
  if (!dataRoot) {
    // 无私有数据根：退化为纯内存（与原进程内实现一致）
    return () => undefined
  }
  const nextStoreDir = path.join(dataRoot, 'workflows')
  const nextStorePath = path.join(nextStoreDir, REVIEW_SESSIONS_STORE_FILE)
  if (storePath !== nextStorePath) {
    // dataRoot 切换：丢弃旧库的内存状态（按 dataRoot 隔离，避免旧状态残留串扰）；
    // 同 root 的 HMR 重载不清空——清空会让在途 flush 把空库写回磁盘（丢数据）
    sessionStates.clear()
  }
  storeDir = nextStoreDir
  storePath = nextStorePath
  hydrated = false
  // 异步预取（可选优化）；首次同步访问（load/save）也会兜底 hydration，两者幂等
  persistChain = persistChain
    .catch(() => undefined)
    .then(() => hydrateFromDisk())
    .catch(() => undefined)
  return () => {
    void flushReviewSessionStore()
  }
}

/** 等待在途持久化写入完成（测试与卸载 flush 用；无持久化配置时立即返回） */
export async function flushReviewSessionStore(): Promise<void> {
  await persistChain.catch(() => undefined)
}

export function loadReviewSessionState(sessionId?: string): ConversationReviewSessionState | null {
  if (!sessionId) return null
  ensureHydratedSync()
  return sessionStates.get(sessionId) || null
}

export function saveReviewSessionState(
  sessionId: string | undefined,
  state: ConversationReviewSessionState | null
): void {
  if (!sessionId) return
  ensureHydratedSync()
  if (state === null) {
    sessionStates.delete(sessionId)
  } else {
    sessionStates.set(sessionId, state)
  }
  queuePersist()
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

// ─── 持久化内部实现 ─────────────────────────────────────────

/** 首次同步访问兜底：从磁盘一次性 hydration（幂等；无配置或已 hydration 直接返回） */
function ensureHydratedSync(): void {
  if (hydrated || !storePath) return
  try {
    const raw = fs.readFileSync(storePath, 'utf8')
    const parsed = parseStore(JSON.parse(raw))
    for (const [id, state] of Object.entries(parsed.sessions)) {
      sessionStates.set(id, state)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // 损坏/解析失败：备份坏文件（保留证据）后重建空库，不崩溃
      quarantineCorruptSync()
    }
  }
  hydrated = true
}

/** 异步 hydration（init 预取；已 hydration 时为空操作，避免与同步兜底互相覆盖） */
async function hydrateFromDisk(): Promise<void> {
  if (hydrated || !storePath) return
  try {
    const raw = await fsp.readFile(storePath, 'utf8')
    const parsed = parseStore(JSON.parse(raw))
    for (const [id, state] of Object.entries(parsed.sessions)) {
      sessionStates.set(id, state)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await quarantineCorruptAsync()
    }
  }
  hydrated = true
}

/** 把整库异步序列化写盘（tmp + rename；失败静默，进程内状态仍有效，下次保存重试） */
function queuePersist(): void {
  if (!storePath || !storeDir) return
  const targetPath = storePath
  const targetDir = storeDir
  persistChain = persistChain
    .catch(() => undefined)
    .then(async () => {
      await fsp.mkdir(targetDir, { recursive: true })
      const tmpPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`
      await fsp.writeFile(tmpPath, JSON.stringify(serializeStore(), null, 2), 'utf8')
      await renameStoreOverwrite(tmpPath, targetPath)
    })
    .catch(() => undefined)
}

function serializeStore(): ReviewSessionsStoreFile {
  const sessions: Record<string, ConversationReviewSessionState> = {}
  for (const [id, state] of sessionStates) {
    sessions[id] = { ...state }
  }
  return { version: REVIEW_SESSIONS_STORE_VERSION, sessions }
}

/** 解析并校验 sidecar；形状非法抛错（由调用方隔离处理） */
function parseStore(value: unknown): ReviewSessionsStoreFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid review-sessions store shape')
  }
  const record = value as Record<string, unknown>
  const sessionsRaw = record.sessions
  if (!sessionsRaw || typeof sessionsRaw !== 'object' || Array.isArray(sessionsRaw)) {
    throw new Error('invalid review-sessions store: sessions must be an object')
  }
  const sessions: Record<string, ConversationReviewSessionState> = {}
  for (const [id, raw] of Object.entries(sessionsRaw as Record<string, unknown>)) {
    const state = parseSessionState(raw)
    if (state) sessions[id] = state
  }
  return { version: REVIEW_SESSIONS_STORE_VERSION, sessions }
}

/** 单条会话状态校验/归一化（与旧 loadReviewSessionState 的清洗逻辑一致；非法返回 null） */
function parseSessionState(value: unknown): ConversationReviewSessionState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const reviewRunId = typeof record.reviewRunId === 'string' ? record.reviewRunId.trim() : ''
  const reviewPath = typeof record.reviewPath === 'string' ? record.reviewPath.trim() : ''
  const status = record.status === 'completed' ? 'completed' : 'in_progress'
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt.trim() : ''
  const finalizedAt = typeof record.finalizedAt === 'string' && record.finalizedAt.trim()
    ? record.finalizedAt.trim()
    : null

  if (!reviewRunId || !reviewPath || !createdAt) return null

  return { reviewRunId, reviewPath, status, createdAt, finalizedAt }
}

/** 备份损坏文件（同步；best-effort，失败不阻塞恢复） */
function quarantineCorruptSync(): void {
  if (!storePath) return
  try {
    const backupPath = `${storePath}.corrupt-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    fs.renameSync(storePath, backupPath)
  } catch {
    // best-effort
  }
}

/** 备份损坏文件（异步；best-effort，失败不阻塞恢复） */
async function quarantineCorruptAsync(): Promise<void> {
  if (!storePath) return
  try {
    const backupPath = `${storePath}.corrupt-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    await fsp.rename(storePath, backupPath)
  } catch {
    // best-effort
  }
}

/**
 * Windows rename-overwrite 重试（与 stagedDiff/adapters/storage.ts 同款模式）：
 * 瞬态 EPERM/EACCES/EBUSY/EEXIST 退避重试；耗尽后对 EEXIST/EPERM 先删旧再最后一次 rename。
 */
async function renameStoreOverwrite(tmpPath: string, targetPath: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(tmpPath, targetPath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'EEXIST') {
        throw error
      }
      if (attempt >= 4) {
        if (code === 'EEXIST' || code === 'EPERM') {
          try {
            await fsp.unlink(targetPath)
          } catch {
            // 目标不存在或删除失败：最后一次 rename 会暴露真实错误
          }
          await fsp.rename(tmpPath, targetPath)
          return
        }
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 30 * attempt))
    }
  }
}
