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
  readMemoryForgetBatchResult,
  readMemoryForgetResult,
  readMemoryListResult,
  readMemoryScopesResult,
  type GrayMemoryConfig,
  type GrayMemoryConfigGetParams,
  type GrayMemoryEditParams,
  type GrayMemoryEntryView,
  type GrayMemoryForgetBatchParams,
  type GrayMemoryForgetBatchResult,
  type GrayMemoryForgetParams,
  type GrayMemoryForgetResult,
  type GrayMemoryListParams,
  type GrayMemoryListResult,
  type GrayMemoryNoteParams,
  type GrayMemoryScope,
  type GrayMemoryScopeInfo,
  type GrayMemoryScopesResult,
  type GrayRemoteArgs,
  type GrayRemoteResult,
} from './types.ts'
import { normalizeMemoryLimit, toMemoryFailure, workspacePathName } from './logic.ts'

/** Endpoint names consumed by the memory surface (namespace `memory`). */
export const MEMORY_ENDPOINTS = {
  list: 'memory/list',
  note: 'memory/note',
  edit: 'memory/edit',
  forget: 'memory/forget',
  forgetBatch: 'memory/forgetBatch',
  scopes: 'memory/scopes',
  configGet: 'memory/configGet',
} as const

export type MemoryEndpoint = (typeof MEMORY_ENDPOINTS)[keyof typeof MEMORY_ENDPOINTS]

/** Host call timeout: a hung host must settle as a failure instead of wedging the panel. */
export const MEMORY_TRANSPORT_TIMEOUT_MS = 30_000

/** Options for the remote transport (currently just the host-call timeout). */
export interface RemoteMemoryTransportOptions {
  /** Max time a host call may take before it fails as GRAY_INTERNAL (default 30s). */
  readonly timeoutMs?: number
}

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
  /** M-03: batch forget of selected ids (partial successes surface `notFound`). */
  forgetBatch(params: GrayMemoryForgetBatchParams, signal?: AbortSignal): Promise<GrayRemoteResult<GrayMemoryForgetBatchResult>>
  /** M-02: enumerate all memory scopes (global + initialized workspaces). */
  listScopes(signal?: AbortSignal): Promise<GrayRemoteResult<GrayMemoryScopesResult>>
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
export function createRemoteMemoryTransport(
  invoker: GrayRemoteInvoker,
  options: RemoteMemoryTransportOptions = {},
): MemoryManageTransport {
  const timeoutMs = options.timeoutMs ?? MEMORY_TRANSPORT_TIMEOUT_MS
  return {
    wired: true,
    list: (params, signal) =>
      callMemoryEndpoint(invoker, 'memory', 'list', params, signal, readMemoryListResult, timeoutMs),
    add: (params, signal) =>
      callMemoryEndpoint(invoker, 'memory', 'note', params, signal, readMemoryEntryView, timeoutMs),
    edit: (params, signal) =>
      callMemoryEndpoint(invoker, 'memory', 'edit', params, signal, readMemoryEntryView, timeoutMs),
    forget: (params, signal) =>
      callMemoryEndpoint(invoker, 'memory', 'forget', params, signal, readMemoryForgetResult, timeoutMs),
    forgetBatch: (params, signal) =>
      callMemoryEndpoint(invoker, 'memory', 'forgetBatch', params, signal, readMemoryForgetBatchResult, timeoutMs),
    listScopes: (signal) =>
      callMemoryEndpoint(invoker, 'memory', 'scopes', {}, signal, readMemoryScopesResult, timeoutMs),
    configGet: (params, signal) =>
      callMemoryEndpoint(invoker, 'memory', 'configGet', params, signal, readMemoryConfig, timeoutMs),
  }
}

async function callMemoryEndpoint<T>(
  invoker: GrayRemoteInvoker,
  namespace: string,
  method: string,
  args: object,
  signal: AbortSignal | undefined,
  readValue: (value: unknown) => T | null,
  timeoutMs: number,
): Promise<GrayRemoteResult<T>> {
  let raw: unknown
  try {
    raw = await withMemoryTimeout(invoker(namespace, method, args as GrayRemoteArgs, signal), timeoutMs)
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

/**
 * Race a host call against a deadline. A hung host must settle (as a
 * GRAY_INTERNAL failure) rather than wedge the panel or hold the `memory/note`
 * gate lease forever (3.4-M3). The caller may abort via its own signal; the
 * underlying invoker promise is left running (best-effort — the host channel
 * is not cancellable at this layer).
 */
function withMemoryTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => {
      reject(makeInternalFailure(`memory transport timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    promise.then(
      value => { clearTimeout(handle); resolve(value) },
      err => { clearTimeout(handle); reject(err) },
    )
  })
}

/** UTF-8 byte length of a string (TextEncoder in browsers; fallback for node). */
function utf8Bytes(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length
  return text.length
}

// ==================== Mock transport (demo / unwired host) ====================

/** Seed entry for the mock store; entries without a scope default to 'global'. */
export interface MockMemorySeedEntry extends GrayMemoryEntryView {
  readonly scope?: GrayMemoryScope
  /** Mock-only: workspace root when scope = 'workspace' (defaults to `options.workspace`). */
  readonly workspace?: string
}

export interface MockMemoryTransportOptions {
  /** Mock store workspace root; required for scope=workspace calls (mirrors host). */
  readonly workspace?: string
  /** Effective config returned by `memory/configGet`. */
  readonly config?: GrayMemoryConfig
  /**
   * Scope enumeration returned by `memory/scopes` (defaults to global + the
   * `workspace` root; multi-workspace demos seed several entries here).
   */
  readonly scopes?: readonly GrayMemoryScopeInfo[]
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
  // Internal store: mutable copies (the mock simulates the host store; each
  // workspace store renumbers ids independently, mirroring the host).
  const store: Array<{ id: number; date: string; text: string; scope: GrayMemoryScope; workspace?: string }> =
    seed.map(entry => ({
      id: entry.id,
      date: entry.date,
      text: entry.text,
      scope: entry.scope ?? 'global',
      ...(entry.scope === 'workspace' ? { workspace: entry.workspace ?? options.workspace } : {}),
    }))
  const workspaceRoot = options.workspace
  const config = options.config ?? DEFAULT_MOCK_MEMORY_CONFIG
  let storeRevision = 0
  let cursorSequence = 0
  const cursors = new Map<string, { readonly revision: number; readonly context: string; readonly offset: number }>()

  /** Workspace root of a stored entry (seeds may omit it and inherit the mock root). */
  const entryWorkspace = (entry: { readonly scope: GrayMemoryScope; readonly workspace?: string }): string | undefined =>
    entry.scope === 'workspace' ? entry.workspace ?? workspaceRoot : undefined

  /** Workspace root a call targets (param wins; falls back to the mock root). */
  const targetWorkspaceOf = (params: { readonly workspace?: string }): string | undefined =>
    workspaceRoot === undefined ? undefined : params.workspace ?? workspaceRoot

  /** Store membership test: scope + (for workspace) the workspace root. */
  const inStore = (
    entry: { readonly scope: GrayMemoryScope; readonly workspace?: string },
    scope: GrayMemoryScope,
    workspace: string | undefined,
  ): boolean => entry.scope === scope && (scope !== 'workspace' || entryWorkspace(entry) === workspace)

  /** Scope enumeration served by `memory/scopes` (global + the mock workspace root). */
  const scopeOptions: readonly GrayMemoryScopeInfo[] = options.scopes !== undefined
    ? options.scopes.map(info => ({ ...info }))
    : [
        { scope: 'global', id: 'global', name: 'Global', path: '' },
        ...(workspaceRoot !== undefined
          ? [{
              scope: 'workspace' as const,
              id: workspacePathName(workspaceRoot),
              name: workspacePathName(workspaceRoot),
              path: workspaceRoot,
              cwd: workspaceRoot,
            }]
          : []),
      ]

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

  /** Renumber ids within one store (scope + workspace; mirroring the host's per-store ids). */
  const renumberStore = (scope: GrayMemoryScope, workspace: string | undefined): void => {
    const entries = store.filter(entry => inStore(entry, scope, workspace)).sort((a, b) => a.id - b.id)
    entries.forEach((entry, id) => { entry.id = id })
  }

  return {
    wired: false,
    async list(params, signal) {
      if (signal?.aborted) return cancelled()
      const targetScope = params.scope ?? 'global'
      const workspace = targetScope === 'workspace' ? targetWorkspaceOf(params) : undefined
      if (targetScope === 'workspace' && workspace === undefined) {
        return invalid('workspace scope requires a workspace (absolute path)', {})
      }
      let entries = store.filter(entry => inStore(entry, targetScope, workspace))
      const search = params.search?.trim()
      if (search !== undefined && search.length > 0) {
        const needle = search.toLowerCase()
        entries = entries.filter(entry => entry.text.toLowerCase().includes(needle))
      }
      entries = [...entries].sort((a, b) => b.id - a.id) // newest first (id monotonic)
      const limit = normalizeMemoryLimit(params.limit)
      const context = JSON.stringify([
        params.scope ?? 'global',
        params.scope === 'workspace' ? workspace ?? '' : '',
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
      if (text.includes('\n') || text.includes('\r')) {
        // Host `memory/note` contract: "A memory is one line." (4.4-L4).
        return invalid('a memory is one line of text', { field: 'text' })
      }
      if (utf8Bytes(text) > config.entryChars) {
        return invalid(`text exceeds entryChars (${config.entryChars} bytes)`, {
          field: 'text',
          actualBytes: utf8Bytes(text),
          limit: config.entryChars,
        })
      }
      const scope = params.scope ?? 'global'
      const workspace = scope === 'workspace' ? targetWorkspaceOf(params) : undefined
      if (scope === 'workspace' && workspace === undefined) {
        return invalid('workspace scope requires a workspace (absolute path)', {})
      }
      const id = store
        .filter(entry => inStore(entry, scope, workspace))
        .reduce((max, entry) => Math.max(max, entry.id), -1) + 1
      const date = new Date().toISOString().slice(0, 10)
      store.push({ id, date, text, scope, ...(workspace !== undefined ? { workspace } : {}) })
      storeRevision += 1
      return { ok: true, value: { id, date, text } }
    },

    async edit(params, signal) {
      if (signal?.aborted) return cancelled()
      const text = params.text.trim()
      if (text.length === 0) {
        return invalid('text must be a non-empty string', { field: 'text' })
      }
      if (text.includes('\n') || text.includes('\r')) {
        // Host `memory/edit` contract: "A memory is one line." (4.4-L4).
        return invalid('a memory is one line of text', { field: 'text' })
      }
      if (utf8Bytes(text) > config.entryChars) {
        return invalid(`text exceeds entryChars (${config.entryChars} bytes)`, {
          field: 'text',
          actualBytes: utf8Bytes(text),
          limit: config.entryChars,
        })
      }
      const targetScope = params.scope ?? 'global'
      const workspace = targetScope === 'workspace' ? targetWorkspaceOf(params) : undefined
      if (targetScope === 'workspace' && workspace === undefined) {
        return invalid('workspace scope requires a workspace (absolute path)', {})
      }
      if (params.expectedRevision !== currentRevision()) return staleRevision()
      const entry = store.find(
        item => item.id === params.id && inStore(item, targetScope, workspace),
      )
      if (entry === undefined) {
        return notFound(`memory entry #${params.id} not found`, { id: params.id })
      }
      entry.text = text // in-memory overwrite; id/date preserved (host stores trimmed)
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
        const targetScope = params.scope ?? 'global'
        const workspace = targetScope === 'workspace' ? targetWorkspaceOf(params) : undefined
        if (targetScope === 'workspace' && workspace === undefined) {
          return invalid('workspace scope requires a workspace (absolute path)', {})
        }
        if (params.expectedRevision !== currentRevision()) return staleRevision()
        const id = parseInt(params.blockId, 10)
        const index = store.findIndex(
          item => item.id === id && inStore(item, targetScope, workspace),
        )
        if (index < 0) return notFound(`memory entry #${id} not found`, { id })
        store.splice(index, 1)
        renumberStore(targetScope, workspace)
        storeRevision += 1
        return { ok: true, value: { mode: 'single', removed: 1 } }
      }
      if (/^\d+,\d+$/.test(params.blockId)) {
        const targetScope = params.scope ?? 'global'
        const workspace = targetScope === 'workspace' ? targetWorkspaceOf(params) : undefined
        if (targetScope === 'workspace' && workspace === undefined) {
          return invalid('workspace scope requires a workspace (absolute path)', {})
        }
        if (params.expectedRevision !== currentRevision()) return staleRevision()
        const [loRaw, hiRaw] = params.blockId.split(',')
        const lo = parseInt(loRaw!, 10)
        const hi = parseInt(hiRaw!, 10)
        if (lo > hi) return invalid(`invalid range: lo(${lo}) > hi(${hi})`, { blockId: params.blockId })
        const kept = store.filter(item => {
          const inRange = item.id >= lo && item.id <= hi
          return !(inStore(item, targetScope, workspace) && inRange)
        })
        const removed = store.length - kept.length
        if (removed === 0) return notFound(`no memories in range #${lo}-#${hi}`, { blockId: params.blockId })
        store.splice(0, store.length, ...kept)
        renumberStore(targetScope, workspace)
        storeRevision += 1
        return { ok: true, value: { mode: 'range', removed } }
      }
      // Summary mode ("lo-hi") — the mock store has no summary tree.
      return invalid('invalid blockId (mock has no summary tree)', { blockId: params.blockId })
    },

    async forgetBatch(params, signal) {
      if (signal?.aborted) return cancelled()
      // Confirmation gate mirrors `memory/forget`.
      if (params.confirm !== true) {
        return {
          ok: false,
          error: {
            code: GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED,
            message: 'memory.forgetBatch is destructive; pass confirm: true',
            details: { ids: params.ids },
          },
        }
      }
      if (!Array.isArray(params.ids) || params.ids.length === 0 || params.ids.some(id => !Number.isSafeInteger(id))) {
        return invalid('ids must be a non-empty array of integers', { field: 'ids' })
      }
      const targetScope = params.scope ?? 'global'
      const workspace = targetScope === 'workspace' ? targetWorkspaceOf(params) : undefined
      if (targetScope === 'workspace' && workspace === undefined) {
        return invalid('workspace scope requires a workspace (absolute path)', {})
      }
      if (params.expectedRevision !== currentRevision()) return staleRevision()
      // One pass over the requested ids (deduplicated): remove what exists,
      // report the rest as notFound — partial success is a normal result.
      const removed: number[] = []
      const notFound: number[] = []
      for (const id of [...new Set(params.ids)]) {
        const index = store.findIndex(item => item.id === id && inStore(item, targetScope, workspace))
        if (index < 0) {
          notFound.push(id)
          continue
        }
        store.splice(index, 1)
        removed.push(id)
      }
      if (removed.length > 0) {
        renumberStore(targetScope, workspace)
        storeRevision += 1
      }
      return { ok: true, value: { removed: removed.length, notFound } }
    },

    async listScopes(signal) {
      if (signal?.aborted) return cancelled()
      return { ok: true, value: { items: scopeOptions.map(info => ({ ...info })) } }
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
