/**
 * 分支组外部存储 — 全会话单例的 branches/list 缓存。
 *
 * turnTail 链条目按轮挂载，如果每个实例各自拉取 branches/list 会放大成
 * N 次 Remote 调用；这里做一个 useSyncExternalStore 友好的迷你外部存储：
 * - `ensureBranchGroups`：按 sessionId 幂等拉取（会话切换即重置重拉）；
 * - `invalidateBranchGroups`：reroll / editRetry 成功后由入口按钮调用，
 *   立即重拉（新候选即时出现在切换器里）；
 * - `subscribeBranchGroups` / `branchGroupsSnapshot`：外部存储两面。
 *
 * 防御式：Remote 失败只把状态置为 failed（组件不渲染 + console.warn 一次），
 * 绝不 reject、绝不炸聊天流。
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { GrayRemoteInvoke } from '../settings/types.ts'

export interface BranchGroupsState {
  readonly status: 'idle' | 'loading' | 'ready' | 'failed'
  readonly items: readonly unknown[]
}

const IDLE: BranchGroupsState = { status: 'idle', items: [] }

let state: BranchGroupsState = IDLE
let loadedSessionId: string | undefined
let lastRemote: GrayRemoteInvoke | undefined
let failureLogged = false
const listeners = new Set<() => void>()

function publish(next: BranchGroupsState): void {
  state = next
  for (const listener of listeners) listener()
}

/** 外部存储订阅面（useSyncExternalStore）。 */
export function subscribeBranchGroups(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 外部存储快照面（useSyncExternalStore；引用稳定，变更才 publish）。 */
export function branchGroupsSnapshot(): BranchGroupsState {
  return state
}

async function fetchGroups(remote: GrayRemoteInvoke, sessionId: string): Promise<void> {
  publish({ status: 'loading', items: state.items })
  try {
    const result = await remote<unknown>('branches', 'list', {})
    if (loadedSessionId !== sessionId) return // 会话已切走，结果作废
    if (result.ok) {
      const items = (result.value as { items?: unknown } | undefined)?.items
      publish({ status: 'ready', items: Array.isArray(items) ? items : [] })
      failureLogged = false
      return
    }
    if (loadedSessionId !== sessionId) return
    publish({ status: 'failed', items: [] })
    if (!failureLogged) {
      failureLogged = true
      console.warn(`[graycode.branchSwitch] branches/list failed: ${result.error.code}: ${result.error.message}`)
    }
  } catch (error) {
    if (loadedSessionId !== sessionId) return
    publish({ status: 'failed', items: [] })
    if (!failureLogged) {
      failureLogged = true
      console.warn('[graycode.branchSwitch] branches/list transport failure:', error)
    }
  }
}

/**
 * 幂等拉取当前会话的分支组：会话未变且已 ready/loading 则不重复拉；会话
 * 变化则重置后重拉。组件挂载时调用（effect 内），无返回值。
 */
export function ensureBranchGroups(remote: GrayRemoteInvoke | undefined, sessionId: string | undefined): void {
  if (remote === undefined || sessionId === undefined || sessionId.length === 0) return
  if (loadedSessionId === sessionId && (state.status === 'ready' || state.status === 'loading')) return
  lastRemote = remote
  const switched = loadedSessionId !== sessionId
  loadedSessionId = sessionId
  if (switched) publish(IDLE)
  void fetchGroups(remote, sessionId)
}

/**
 * reroll / editRetry 成功后失效缓存并立即重拉（沿用最近一次的 remote 与
 * 会话；没有可重拉上下文时仅重置为 idle，等待下一次挂载拉取）。
 */
export function invalidateBranchGroups(): void {
  const sessionId = loadedSessionId
  const remote = lastRemote
  if (sessionId === undefined || remote === undefined) {
    publish(IDLE)
    return
  }
  void fetchGroups(remote, sessionId)
}

/**
 * React 订阅钩子：订阅外部存储并按会话幂等拉取。返回当前状态（idle/
 * loading 期间组件渲染 nothing）。
 */
export function useBranchGroups(remote: GrayRemoteInvoke | undefined, sessionId: string | undefined): BranchGroupsState {
  useEffect(() => {
    ensureBranchGroups(remote, sessionId)
  }, [remote, sessionId])
  return useSyncExternalStore(subscribeBranchGroups, branchGroupsSnapshot, branchGroupsSnapshot)
}
