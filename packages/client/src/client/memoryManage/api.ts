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
  readMemoryConfig,
  readMemoryEntryView,
  readMemoryForgetResult,
  readMemoryListResult,
  type GrayMemoryConfig,
  type GrayMemoryConfigGetParams,
  type GrayMemoryEditParams,
  type GrayMemoryEntryView,
  type GrayMemoryForgetParams,
  type GrayMemoryForgetResult,
  type GrayMemoryListParams,
  type GrayMemoryListResult,
  type GrayMemoryNoteParams,
  type GrayMemoryScope,
  type GrayRemoteArgs,
  type GrayRemoteResult,
} from './types.ts'
import { normalizeMemoryLimit, toMemoryFailure } from './logic.ts'

/** Endpoint names consumed by the memory surface (namespace `memory`). */
export const MEMORY_ENDPOINTS = {
  list: 'memory/list',
  note: 'memory/note',
  edit: 'memory/edit',
  forget: 'memory/forget',
  configGet: 'memory/configGet',
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
  add(params: GrayMemoryNoteParams, signal?: AbortSignal): Promise<GrayRemoteResult<GrayMemoryEntryView>>
  edit(params: GrayMemoryEditParams, signal?: AbortSignal): Promise<GrayRemoteResult<GrayMemoryEntryView>>
  forget(params: GrayMemoryForgetParams, signal?: AbortSignal): Promise<GrayRemoteResult<GrayMemoryForgetResult>>
  /** Optional for compatibility with replay/custom transports predating configGet. */
  configGet?(params: GrayMemoryConfigGetParams, signal?: AbortSignal): Promise<GrayRemoteResult<GrayMemoryConfig>>
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
    add: (params, signal) =>
      callMemoryEndpoint(invoker, 'memory', 'note', params, signal, readMemoryEntryView),
    edit: (params, signal) =>
      callMemoryEndpoint(invoker, 'memory', 'edit', params, signal, readMemoryEntryView),
    forget: (params, signal) =>
      callMemoryEndpoint(invoker, 'memory', 'forget', params, signal, readMemoryForgetResult),
    configGet: (params, signal) =>
      callMemoryEndpoint(invoker, 'memory', 'configGet', params, signal, readMemoryConfig),
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
  /** Effective config returned by `memory/configGet`. */
  readonly config?: GrayMemoryConfig
}

const DEFAULT_MOCK_MEMORY_CONFIG: GrayMemoryConfig = {
  wakeLines: 96,
  entryChars: 280,
  partChars: 20_000,
  partLines: 500,
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
  const config = options.config ?? DEFAULT_MOCK_MEMORY_CONFIG
  let storeRevision = 0
  let cursorSequence = 0
  const cursors = new Map<string, { readonly revision: number; readonly context: string; readonly offset: number }>()

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

  const staleCursor = (): GrayRemoteResult<never> => ({
    ok: false,
    error: {
      code: GRAY_REMOTE_ERROR_CODES.CONFLICT,
      message: 'memory cursor belongs to a stale snapshot',
      details: { kind: 'memory-cursor', reason: 'stale', restartRequired: true },
    },
  })

  const staleRevision = (): GrayRemoteResult<never> => ({
    ok: false,
    error: {
      code: GRAY_REMOTE_ERROR_CODES.CONFLICT,
      message: 'memory changed since it was listed; refresh and retry',
      details: { kind: 'memory-revision', reason: 'stale', restartRequired: true },
    },
  })

  const currentRevision = () => `mock:${storeRevision}`

  const renumberScope = (scope: GrayMemoryScope): void => {
    const entries = store.filter(entry => entry.scope === scope).sort((a, b) => a.id - b.id)
    entries.forEach((entry, id) => { entry.id = id })
  }

  return {
    wired: false,
    async list(params, signal) {
      if (signal?.aborted) return cancelled()
      if (params.scope === 'workspace' && workspaceRoot === undefined) {
        return invalid('workspace scope requires a workspace (absolute path)', {})
      }
      const targetScope = params.scope ?? 'global'
      let entries = store.filter(entry => entry.scope === targetScope)
      const search = params.search?.trim()
      if (search !== undefined && search.length > 0) {
        const needle = search.toLowerCase()
        entries = entries.filter(entry => entry.text.toLowerCase().includes(needle))
      }
      entries = [...entries].sort((a, b) => b.id - a.id) // newest first (id monotonic)
      const limit = normalizeMemoryLimit(params.limit)
      const context = JSON.stringify([
        params.scope ?? 'global',
        params.scope === 'workspace' ? params.workspace ?? workspaceRoot ?? '' : '',
        search ?? '',
      ])
      let start = 0
      if (params.cursor !== undefined) {
        const cursor = cursors.get(params.cursor)
        if (cursor === undefined) {
          return invalid('malformed memory cursor', { kind: 'memory-cursor', reason: 'malformed' })
        }
        if (cursor.revision !== storeRevision || cursor.context !== context) return staleCursor()
        start = cursor.offset
      }
      const page = entries.slice(start, start + limit)
      let nextCursor: string | undefined
      if (start + page.length < entries.length && page.length > 0) {
        nextCursor = `mock-memory-cursor-${++cursorSequence}`
        cursors.set(nextCursor, { revision: storeRevision, context, offset: start + page.length })
      }
      const items = page.map(entry => ({ id: entry.id, date: entry.date, text: entry.text }))
      return {
        ok: true,
        value: {
          items,
          total: entries.length,
          revision: currentRevision(),
          ...(nextCursor !== undefined ? { nextCursor } : {}),
        },
      }
    },

    async add(params, signal) {
      if (signal?.aborted) return cancelled()
      const text = params.text.trim()
      if (text.length === 0) {
        return invalid('text must be a non-empty string', { field: 'text' })
      }
      if (params.scope === 'workspace' && workspaceRoot === undefined) {
        return invalid('workspace scope requires a workspace (absolute path)', {})
      }
      const scope = params.scope ?? 'global'
      const id = store
        .filter(entry => entry.scope === scope)
        .reduce((max, entry) => Math.max(max, entry.id), -1) + 1
      const date = new Date().toISOString().slice(0, 10)
      store.push({ id, date, text, scope })
      storeRevision += 1
      return { ok: true, value: { id, date, text } }
    },

    async edit(params, signal) {
      if (signal?.aborted) return cancelled()
      if (params.text.trim().length === 0) {
        return invalid('text must be a non-empty string', { field: 'text' })
      }
      if (params.expectedRevision !== currentRevision()) return staleRevision()
      const targetScope = params.scope ?? 'global'
      const entry = store.find(
        item => item.id === params.id && item.scope === targetScope,
      )
      if (entry === undefined) {
        return notFound(`memory entry #${params.id} not found`, { id: params.id })
      }
      entry.text = params.text // in-memory overwrite; id/date preserved
      storeRevision += 1
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
        if (params.expectedRevision !== currentRevision()) return staleRevision()
        const targetScope = params.scope ?? 'global'
        const id = parseInt(params.blockId, 10)
        const index = store.findIndex(
          item => item.id === id && item.scope === targetScope,
        )
        if (index < 0) return notFound(`memory entry #${id} not found`, { id })
        const storedScope = store[index]!.scope
        store.splice(index, 1)
        renumberScope(storedScope)
        storeRevision += 1
        return { ok: true, value: { mode: 'single', removed: 1 } }
      }
      if (/^\d+,\d+$/.test(params.blockId)) {
        if (params.expectedRevision !== currentRevision()) return staleRevision()
        const targetScope = params.scope ?? 'global'
        const [loRaw, hiRaw] = params.blockId.split(',')
        const lo = parseInt(loRaw!, 10)
        const hi = parseInt(hiRaw!, 10)
        if (lo > hi) return invalid(`invalid range: lo(${lo}) > hi(${hi})`, { blockId: params.blockId })
        const kept = store.filter(item => {
          const inScope = item.scope === targetScope
          const inRange = item.id >= lo && item.id <= hi
          return !(inScope && inRange)
        })
        const removed = store.length - kept.length
        if (removed === 0) return notFound(`no memories in range #${lo}-#${hi}`, { blockId: params.blockId })
        store.splice(0, store.length, ...kept)
        renumberScope(targetScope)
        storeRevision += 1
        return { ok: true, value: { mode: 'range', removed } }
      }
      // Summary mode ("lo-hi") — the mock store has no summary tree.
      return invalid('invalid blockId (mock has no summary tree)', { blockId: params.blockId })
    },

    async configGet(params, signal) {
      if (signal?.aborted) return cancelled()
      if (params.scope === 'workspace' && workspaceRoot === undefined) {
        return notFound('workspace memory store not found (never written before)', {
          kind: 'workspace-store',
          ...(params.workspace === undefined ? {} : { workspace: params.workspace }),
        })
      }
      return { ok: true, value: config }
    },
  }
}
