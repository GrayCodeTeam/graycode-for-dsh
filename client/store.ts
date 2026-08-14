/**
 * Browser-side Gray Code config store. The only transport is the plugin's
 * `/graycode` Connection RPC channel — the native settings scope would answer
 * `settings-not-exposed` for a third-party namespace (see README).
 */

import { useSyncExternalStore } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { GrayCodeConfig, GrayCodePatch } from '../shared/config.ts'
import { DEFAULTS } from '../shared/defaults.ts'

/** Channel prefix + endpoints shared with the Host half. */
export const GRAYCODE_CHANNEL = '/graycode'

export type GrayCodeStoreState =
  | { status: 'loading' }
  | { status: 'ready'; config: GrayCodeConfig }
  | { status: 'error'; message: string }

export interface GrayCodeStore {
  readonly state: GrayCodeStoreState
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

  /** Re-fetch the config (also triggered by `connection/reset`). */
  refresh(): Promise<void> {
    this.invalidated = true
    return this.pump()
  }

  /** Push a shallow top-level patch; the Host merges and re-resolves. */
  async patch(patch: GrayCodePatch): Promise<void> {
    await this.call('config.update', { patch })
  }

  /** Replace the whole user layer with one imported document. */
  async replace(config: GrayCodeConfig): Promise<void> {
    await this.call('config.replace', config)
  }

  /** Drop the user layer; the document falls back to defaults. */
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
        // a throwing subscriber must not wedge the store
      }
    }
  }
}

export function createGrayCodeStore(connection: ConnectionHandle): GrayCodeStore {
  const store = new StoreImpl(connection)
  return {
    state: store.state,
    refresh: () => store.refresh(),
    patch: patch => store.patch(patch),
    replace: config => store.replace(config),
    reset: () => store.reset(),
  }
}

/** React binding: subscribe to the store snapshot. */
export function useGrayCodeStore(store: GrayCodeStore): GrayCodeStoreState {
  const internal = store as unknown as StoreImpl
  return useSyncExternalStore(
    listener => internal.subscribe(listener),
    () => internal.getSnapshot(),
  )
}

/** Read a value at a dotted path such as `["sound", "cues", "warning"]`. */
export function getAtPath(config: GrayCodeConfig, path: readonly string[]): unknown {
  let value: unknown = config
  for (const part of path) {
    if (typeof value !== 'object' || value === null) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/** Clone the config, set one path, and return the changed top-level keys patch. */
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
