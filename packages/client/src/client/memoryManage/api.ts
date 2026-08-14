/**
 * P4-03 memory management — contract-driven consumption points (transport).
 *
 * The UI surface never performs I/O itself. Every read/write goes through a
 * {@link MemoryManageTransport} injected by the wiring:
 *
 * - {@link createRemoteMemoryTransport} wraps the host `ctx.grayRemote.invoke`
 *   (structural stand-in, see the README) — the real consumption point once a
 *   browser→host channel exists;
 * - {@link createMockMemoryTransport} is an in-memory demo transport (no I/O)
 *   for unwired hosts / previews — `wired: false` so the panel can flag
 *   "demo data".
 *
 * All transports return the unified `GrayRemoteResult<T>` envelope and never
 * reject with business errors (mirrors host `GrayRemoteService.invoke`).
 */
import {
  GRAY_REMOTE_ERROR_CODES,
  isGrayRemoteResult,
  makeInternalFailure,
  readMemoryEntryView,
  readMemoryForgetResult,
  readMemoryListResult,
  type GrayMemoryEditParams,
  type GrayMemoryEntryView,
  type GrayMemoryForgetParams,
  type GrayMemoryForgetResult,
  type GrayMemoryListParams,
  type GrayMemoryListResult,
  type GrayMemoryScope,
  type GrayRemoteArgs,
  type GrayRemoteResult,
} from './types.ts'
import { normalizeMemoryLimit, toMemoryFailure } from './logic.ts'

/** Endpoint names consumed by the memory surface (namespace `memory`). */
export const MEMORY_ENDPOINTS = {
  list: 'memory/list',
  edit: 'memory/edit',
  forget: 'memory/forget',
} as const

export type MemoryEndpoint = (typeof MEMORY_ENDPOINTS)[keyof typeof MEMORY_ENDPOINTS]

/**
 * Typed transport the panel talks to (declarative; the component itself never
 * performs I/O). Business errors arrive as `ok:false` envelopes — never as
 * thrown exceptions.
 */
export interface MemoryManageTransport {
  /** True when backed by the real host channel; false for in-memory demo data. */
  readonly wired: boolean
  list(params: GrayMemoryListParams, signal?: AbortSignal): Promise<GrayRemoteResult<GrayMemoryListResult>>
  edit(params: GrayMemoryEditParams, signal?: AbortSignal): Promise<GrayRemoteResult<GrayMemoryEntryView>>
  forget(params: GrayMemoryForgetParams, signal?: AbortSignal): Promise<GrayRemoteResult<GrayMemoryForgetResult>>
}

/**
 * Structural stand-in for the host `GrayRemoteService.invoke` signature
 * (`packages/plugin/src/remote/service.ts`): `invoke(namespace, method, args,
 * signal)` → envelope. The wiring supplies a real bridge when one exists.
 */
export type GrayRemoteInvoker = (
  namespace: string,
  method: string,
  args: GrayRemoteArgs,
  signal?: AbortSignal,
) => Promise<unknown>

/**
 * Wrap a host invoker as a typed transport — the single consumption point for
 * the three memory endpoints. Defensive: unknown/non-envelope results and
 * thrown invoker errors become `GRAY_INTERNAL` envelopes (never reject).
 */
export function createRemoteMemoryTransport(invoker: GrayRemoteInvoker): MemoryManageTransport {
  return {
    wired: true,
    list: (params, signal) =>
      callMemoryEndpoint(invoker, 'memory', 'list', params, signal, readMemoryListResult),
    edit: (params, signal) =>
      callMemoryEndpoint(invoker, 'memory', 'edit', params, signal, readMemoryEntryView),
    forget: (params, signal) =>
      callMemoryEndpoint(invoker, 'memory', 'forget', params, signal, readMemoryForgetResult),
  }
}

async function callMemoryEndpoint<T>(
  invoker: GrayRemoteInvoker,
  namespace: string,
  method: string,
  args: object,
  signal: AbortSignal | undefined,
  readValue: (value: unknown) => T | null,
): Promise<GrayRemoteResult<T>> {
  let raw: unknown
  try {
    raw = await invoker(namespace, method, args as GrayRemoteArgs, signal)
  } catch (err) {
    return { ok: false, error: toMemoryFailure(err, signal) }
  }
  if (!isGrayRemoteResult(raw)) {
    return { ok: false, error: makeInternalFailure('unexpected transport result') }
  }
  if (!raw.ok) return raw
  const value = readValue(raw.value)
  if (value === null) {
    return { ok: false, error: makeInternalFailure(`malformed ${namespace}/${method} value`) }
  }
  return { ok: true, value }
}

// ==================== Mock transport (demo / unwired host) ====================

/** Seed entry for the mock store; entries without a scope default to 'global'. */
export interface MockMemorySeedEntry extends GrayMemoryEntryView {
  readonly scope?: GrayMemoryScope
}

export interface MockMemoryTransportOptions {
  /** Mock store workspace root; required for scope=workspace calls (mirrors host). */
  readonly workspace?: string
}

/**
 * In-memory demo transport. Simulates the host endpoint semantics
 * (search/scope filtering, id-desc ordering, cursor pagination, edit keeping
 * id/date, forget requiring `confirm: true`) without any I/O. `wired: false`
 * so the panel flags the demo badge.
 */
export function createMockMemoryTransport(
  seed: readonly MockMemorySeedEntry[],
  options: MockMemoryTransportOptions = {},
): MemoryManageTransport {
  // Internal store: mutable copies (the mock simulates the host store).
  const store: Array<{ id: number; date: string; text: string; scope: GrayMemoryScope }> = seed.map(entry => ({
    id: entry.id,
    date: entry.date,
    text: entry.text,
    scope: entry.scope ?? 'global',
  }))
  const workspaceRoot = options.workspace

  const cancelled = (): GrayRemoteResult<never> => ({
    ok: false,
    error: { code: GRAY_REMOTE_ERROR_CODES.CANCELLED, message: 'operation cancelled', details: {} },
  })

  const invalid = (message: string, details: Readonly<Record<string, unknown>>): GrayRemoteResult<never> => ({
    ok: false,
    error: { code: GRAY_REMOTE_ERROR_CODES.INVALID_INPUT, message, details },
  })

  const notFound = (message: string, details: Readonly<Record<string, unknown>>): GrayRemoteResult<never> => ({
    ok: false,
    error: { code: GRAY_REMOTE_ERROR_CODES.NOT_FOUND, message, details },
  })

  return {
    wired: false,
    async list(params, signal) {
      if (signal?.aborted) return cancelled()
      if (params.scope === 'workspace' && workspaceRoot === undefined) {
        return invalid('workspace scope requires a workspace (absolute path)', {})
      }
      let entries = store.filter(entry => params.scope === undefined || entry.scope === params.scope)
      const search = params.search?.trim()
      if (search !== undefined && search.length > 0) {
        const needle = search.toLowerCase()
        entries = entries.filter(entry => entry.text.toLowerCase().includes(needle))
      }
      entries = [...entries].sort((a, b) => b.id - a.id) // newest first (id monotonic)
      const limit = normalizeMemoryLimit(params.limit)
      let start = 0
      if (params.cursor !== undefined) {
        const index = entries.findIndex(entry => entry.id === params.cursor)
        if (index >= 0) start = index + 1
      }
      const page = entries.slice(start, start + limit)
      const nextCursor =
        start + limit < entries.length && page.length > 0 ? String(page[page.length - 1]!.id) : undefined
      const items = page.map(entry => ({ id: entry.id, date: entry.date, text: entry.text }))
      return { ok: true, value: { items, total: entries.length, ...(nextCursor !== undefined ? { nextCursor } : {}) } }
    },

    async edit(params, signal) {
      if (signal?.aborted) return cancelled()
      if (params.text.trim().length === 0) {
        return invalid('text must be a non-empty string', { field: 'text' })
      }
      const entry = store.find(
        item => item.id === params.id && (params.scope === undefined || item.scope === params.scope),
      )
      if (entry === undefined) {
        return notFound(`memory entry #${params.id} not found`, { id: params.id })
      }
      entry.text = params.text // in-memory overwrite; id/date preserved
      return { ok: true, value: { id: entry.id, date: entry.date, text: entry.text } }
    },

    async forget(params, signal) {
      if (signal?.aborted) return cancelled()
      if (params.confirm !== true) {
        return {
          ok: false,
          error: {
            code: GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED,
            message: 'memory.forget is destructive; pass confirm: true',
            details: { blockId: params.blockId },
          },
        }
      }
      if (/^\d+$/.test(params.blockId)) {
        const id = parseInt(params.blockId, 10)
        const index = store.findIndex(
          item => item.id === id && (params.scope === undefined || item.scope === params.scope),
        )
        if (index < 0) return notFound(`memory entry #${id} not found`, { id })
        store.splice(index, 1)
        return { ok: true, value: { mode: 'single', removed: 1 } }
      }
      if (/^\d+,\d+$/.test(params.blockId)) {
        const [loRaw, hiRaw] = params.blockId.split(',')
        const lo = parseInt(loRaw!, 10)
        const hi = parseInt(hiRaw!, 10)
        if (lo > hi) return invalid(`invalid range: lo(${lo}) > hi(${hi})`, { blockId: params.blockId })
        const kept = store.filter(item => {
          const inScope = params.scope === undefined || item.scope === params.scope
          const inRange = item.id >= lo && item.id <= hi
          return !(inScope && inRange)
        })
        const removed = store.length - kept.length
        if (removed === 0) return notFound(`no memories in range #${lo}-#${hi}`, { blockId: params.blockId })
        store.splice(0, store.length, ...kept)
        return { ok: true, value: { mode: 'range', removed } }
      }
      // Summary mode ("lo-hi") — the mock store has no summary tree.
      return invalid('invalid blockId (mock has no summary tree)', { blockId: params.blockId })
    },
  }
}
