/**
 * 浏览器侧 Gray Code 配置 store。
 *
 * 唯一传输是插件的 `/graycode` Connection RPC 通道——DSH 原生 settings scope
 * 对第三方 namespace 会回答 `settings-not-exposed`（见本目录 README）。
 * 宿主权威在 `$DSH_HOME/settings.yaml`；面板只持有一个快照：
 *
 * - `refresh()`：重新拉取全量配置（`connection/reset` 时也会触发）；
 * - `patch()`：推送顶层浅补丁，宿主合并后回读全量；
 * - `replace()`：以导入的 JSON 文档整体替换用户层；
 * - `reset()`：丢弃用户层，回落到默认值。
 */

import { useSyncExternalStore } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { DEFAULTS } from './defaults.ts'
import type { GrayCodeConfig, GrayCodePatch } from './types.ts'

/** 通道前缀（与宿主 `/graycode` channel 共享）。 */
export const GRAYCODE_CHANNEL = '/graycode'

export type GrayCodeStoreState =
  | { status: 'loading' }
  | { status: 'ready'; config: GrayCodeConfig }
  | { status: 'error'; message: string }

export interface GrayCodeStore {
  readonly state: GrayCodeStoreState
  /** uSES subscribe 侧（快照变更时通知）。 */
  subscribe(listener: () => void): () => void
  /** uSES getSnapshot 侧。 */
  getSnapshot(): GrayCodeStoreState
  refresh(): Promise<void>
  patch(patch: GrayCodePatch): Promise<void>
  replace(config: GrayCodeConfig): Promise<void>
  reset(): Promise<void>
}

class StoreImpl implements GrayCodeStore {
  private snapshot: GrayCodeStoreState = { status: 'loading' }
  private readonly listeners = new Set<() => void>()
  private invalidated = true
  private queue = Promise.resolve()

  constructor(private readonly connection: ConnectionHandle) {}

  get state(): GrayCodeStoreState {
    return this.snapshot
  }

  getSnapshot(): GrayCodeStoreState {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 重新拉取配置（`connection/reset` 也会触发）。 */
  refresh(): Promise<void> {
    this.invalidated = true
    return this.pump()
  }

  /** 推送顶层浅补丁；宿主合并后回读全量并重新解析。 */
  async patch(patch: GrayCodePatch): Promise<void> {
    await this.call('config.update', { patch })
  }

  /** 以一份导入的文档整体替换用户层。 */
  async replace(config: GrayCodeConfig): Promise<void> {
    await this.call('config.replace', config)
  }

  /** 丢弃用户层；文档回落到默认值。 */
  async reset(): Promise<void> {
    await this.call('config.reset', {})
  }

  private pump(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (!this.invalidated) return
      this.invalidated = false
      try {
        const result = await this.connection.rpc.call(GRAYCODE_CHANNEL, 'config.get', {})
        if (result.ok) {
          this.snapshot = { status: 'ready', config: { ...DEFAULTS, ...(result.value as GrayCodeConfig) } }
        } else {
          this.snapshot = { status: 'error', message: result.error.message }
        }
      } catch (error) {
        this.snapshot = {
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        }
      }
      this.notify()
    })
    return this.queue
  }

  private async call(endpoint: string, payload: unknown): Promise<void> {
    try {
      const result = await this.connection.rpc.call(GRAYCODE_CHANNEL, endpoint, payload)
      if (result.ok) {
        this.snapshot = { status: 'ready', config: result.value as GrayCodeConfig }
        this.invalidated = false
        this.notify()
        return
      }
      throw new Error(result.error.message)
    } catch (error) {
      this.snapshot = {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
      this.notify()
      throw error
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // 抛异常的订阅者不能卡死 store
      }
    }
  }
}

export function createGrayCodeStore(connection: ConnectionHandle): GrayCodeStore {
  const store = new StoreImpl(connection)
  return {
    // 实时 getter：直接值捕获会把初始 loading 快照钉死。
    get state(): GrayCodeStoreState {
      return store.state
    },
    subscribe: listener => store.subscribe(listener),
    getSnapshot: () => store.getSnapshot(),
    refresh: () => store.refresh(),
    patch: patch => store.patch(patch),
    replace: config => store.replace(config),
    reset: () => store.reset(),
  }
}

/** React 绑定：订阅 store 快照。 */
export function useGrayCodeStore(store: GrayCodeStore): GrayCodeStoreState {
  return useSyncExternalStore(
    listener => store.subscribe(listener),
    () => store.getSnapshot(),
  )
}

/** 读取点分路径（如 `["sound", "cues", "warning"]`）上的值。 */
export function getAtPath(config: GrayCodeConfig, path: readonly string[]): unknown {
  let value: unknown = config
  for (const part of path) {
    if (typeof value !== 'object' || value === null) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/**
 * 克隆配置、设置一条路径，并返回变更后的顶层键补丁。
 * 用于表单层：把一次字段编辑折叠成宿主 `config.update` 的浅补丁。
 */
export function setAtPath(
  config: GrayCodeConfig,
  path: readonly string[],
  value: unknown,
): { next: GrayCodeConfig; patch: GrayCodePatch } {
  const next = structuredClone(config) as GrayCodeConfig
  let cursor: Record<string, unknown> = next as unknown as Record<string, unknown>
  for (let index = 0; index < path.length - 1; index += 1) {
    const part = path[index]!
    const child = cursor[part]
    if (typeof child !== 'object' || child === null) {
      cursor[part] = {}
    }
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[path[path.length - 1]!] = value
  const patch: GrayCodePatch = {}
  for (const key of Object.keys(next)) {
    if (JSON.stringify(next[key as keyof GrayCodeConfig]) !== JSON.stringify(config[key as keyof GrayCodeConfig])) {
      ;(patch as Record<string, unknown>)[key] = next[key as keyof GrayCodeConfig]
    }
  }
  return { next, patch }
}
