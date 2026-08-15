/**
 * P4-03 memory management — contract snapshot (client half).
 *
 * These types mirror the host-side Remote contract in
 * `packages/plugin/src/remote/types.ts` (memory section, §"memory（P4-03
 * memory 管理）") and the endpoint semantics of
 * `packages/plugin/src/memory/adapters/dsh/remote.ts`. They are hand-synced
 * STRUCTURAL copies: the client bundle must not import the plugin package
 * (the bundle purity gate forbids cross-plugin value imports and
 * `@graycode/dsh-client` does not depend on `@graycode/dsh-plugin`).
 *
 * CLIENT BOUNDARY RULES (PLAN_V2 §5.6):
 * - The wire is `unknown`; every `read*` helper below narrows defensively
 *   instead of trusting the shape (mirrors workflowNode/types.ts).
 * - Stable error codes (`GRAY_*`) are the only contract — the UI never parses
 *   error message text (see logic.ts `mapMemoryFailure`).
 * - Page-limit numbers are asserted against the host contract by tests.
 */

/** Valid memory scopes (mirrors `GrayMemoryScope` on the host). */
export const GRAY_MEMORY_SCOPES = ['global', 'workspace'] as const
export type GrayMemoryScope = (typeof GRAY_MEMORY_SCOPES)[number]

/** Page limits (mirrors `GRAY_PAGE_LIMIT_DEFAULT` / `GRAY_PAGE_LIMIT_MAX`). */
export const GRAY_PAGE_LIMIT_DEFAULT = 20
export const GRAY_PAGE_LIMIT_MAX = 100

/** Single memory entry view (mirrors `GrayMemoryEntryView`). */
export interface GrayMemoryEntryView {
  readonly id: number
  readonly date: string
  readonly text: string
}

/** memory/list params (mirrors `GrayMemoryListParams`). */
export interface GrayMemoryListParams {
  /** Default 'global'; workspace requires a workspace root (read-only). */
  readonly scope?: GrayMemoryScope
  /** Workspace root (absolute path) when scope = 'workspace'. */
  readonly workspace?: string
  /** Substring search, case-insensitive. */
  readonly search?: string
  /** Opaque host-issued cursor. Clients must return it verbatim. */
  readonly cursor?: string
  readonly limit?: number
}

/** memory/list result (mirrors `GrayMemoryListResult` / `GrayPage`). */
export interface GrayMemoryListResult {
  readonly items: readonly GrayMemoryEntryView[]
  readonly total: number
  /** Opaque full-store snapshot revision used for edit/delete CAS. */
  readonly revision: string
  /** Last item id; absent when there are no more pages. */
  readonly nextCursor?: string
}

/** memory/note params (mirrors `GrayMemoryNoteParams`). */
export interface GrayMemoryNoteParams {
  readonly scope?: GrayMemoryScope
  readonly workspace?: string
  /** Single line; trimmed before storage, bounded by entryChars bytes. */
  readonly text: string
}

/** Scope selector shared by `memory/configGet`. */
export interface GrayMemoryConfigGetParams {
  readonly scope?: GrayMemoryScope
  readonly workspace?: string
}

/** Effective memory-store configuration returned by `memory/configGet`. */
export interface GrayMemoryConfig {
  readonly wakeLines: number
  readonly entryChars: number
  readonly partChars: number
  readonly partLines: number
}

/** memory/edit params (mirrors `GrayMemoryEditParams`). */
export interface GrayMemoryEditParams {
  readonly scope?: GrayMemoryScope
  readonly workspace?: string
  readonly id: number
  readonly text: string
  /** `memory/list` revision for the row being edited. */
  readonly expectedRevision: string
}

/** memory/forget params (mirrors `GrayMemoryForgetParams`). */
export interface GrayMemoryForgetParams {
  readonly scope?: GrayMemoryScope
  readonly workspace?: string
  /**
   * `"16-31"` drops a tree summary; `"5"` deletes a single raw memory;
   * `"1,3"` deletes the closed interval. This surface only issues single
   * `"<id>"` blockIds (entry-level forget).
   */
  readonly blockId: string
  /** Required by the host for raw single/range deletion. */
  readonly expectedRevision?: string
  /** Destructive confirmation: must be true, else GRAY_APPROVAL_REQUIRED. */
  readonly confirm: boolean
}

/** memory/forget result (mirrors `GrayMemoryForgetResult`). */
export interface GrayMemoryForgetResult {
  readonly mode: 'summary' | 'single' | 'range'
  /** single/range mode: deleted entry count. */
  readonly removed?: number
  /** summary mode: dropped summary blocks. */
  readonly gone?: number
  /** summary mode: first affected block id ("lo-hi"). */
  readonly firstId?: string
}

/**
 * One enumerated memory scope (mirrors the host `memory/scopes` item; audit
 * M-02「ScopeInfo」). `global` is always present; each initialized workspace
 * store contributes one `workspace` entry.
 */
export interface GrayMemoryScopeInfo {
  readonly scope: GrayMemoryScope
  /** Stable scope id: 'global' for the global store, directory name for workspaces. */
  readonly id: string
  /** Human-readable display name. */
  readonly name: string
  /** Workspace root (absolute path) for workspace scopes; '' for global. */
  readonly path: string
  /** Optional working-directory hint for workspace scopes. */
  readonly cwd?: string
}

/** `memory/scopes` result (mirrors the host enumeration). */
export interface GrayMemoryScopesResult {
  readonly items: readonly GrayMemoryScopeInfo[]
}

/**
 * `memory/forgetBatch` params (mirrors the host endpoint; audit M-03). The
 * ids are store-local (each workspace store renumbers independently), so the
 * current view's scope travels explicitly like every other memory endpoint.
 */
export interface GrayMemoryForgetBatchParams {
  /** Entry ids to delete (this surface never issues summary/range ids). */
  readonly ids: readonly number[]
  /** `memory/list` full-store revision captured with the selected rows. */
  readonly expectedRevision: string
  /** Destructive confirmation: must be true, else GRAY_APPROVAL_REQUIRED. */
  readonly confirm: boolean
  /** Scope the ids belong to (default 'global'). */
  readonly scope?: GrayMemoryScope
  /** Workspace root when scope = 'workspace'. */
  readonly workspace?: string
}

/** `memory/forgetBatch` result (mirrors the host response). */
export interface GrayMemoryForgetBatchResult {
  /** Entries actually removed. */
  readonly removed: number
  /** Requested ids that were not present in the store (partial success). */
  readonly notFound: readonly number[]
}

// ==================== Remote envelope (mirrors remote/types.ts) ====================

/** Stable Remote error machine codes (mirrors `GRAY_REMOTE_ERROR_CODES`). */
export const GRAY_REMOTE_ERROR_CODES = {
  INVALID_INPUT: 'GRAY_INVALID_INPUT',
  CONFLICT: 'GRAY_CONFLICT',
  APPROVAL_REQUIRED: 'GRAY_APPROVAL_REQUIRED',
  CANCELLED: 'GRAY_CANCELLED',
  STORAGE_CORRUPT: 'GRAY_STORAGE_CORRUPT',
  NOT_FOUND: 'GRAY_NOT_FOUND',
  ENDPOINT_NOT_FOUND: 'GRAY_ENDPOINT_NOT_FOUND',
  INTERNAL: 'GRAY_INTERNAL',
} as const

export type GrayRemoteErrorCode = (typeof GRAY_REMOTE_ERROR_CODES)[keyof typeof GRAY_REMOTE_ERROR_CODES]

const GRAY_REMOTE_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(
  Object.values(GRAY_REMOTE_ERROR_CODES),
)

/** Whether a string is a known stable error code. */
export function isGrayRemoteErrorCode(value: unknown): value is GrayRemoteErrorCode {
  return typeof value === 'string' && GRAY_REMOTE_ERROR_CODE_SET.has(value)
}

/** A failed Remote call (mirrors `GrayRemoteFailure`). */
export interface GrayRemoteFailure {
  readonly code: GrayRemoteErrorCode
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
}

/** Unified Remote envelope (mirrors `GrayRemoteResult<T>`). */
export type GrayRemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GrayRemoteFailure }

/** Named wire args (mirrors `GrayRemoteArgs`). */
export type GrayRemoteArgs = Readonly<Record<string, unknown>>

/** Internal failure helper (never exposes stack traces or internal paths). */
export function makeInternalFailure(message = 'unexpected internal error', cause?: unknown): GrayRemoteFailure {
  return {
    code: GRAY_REMOTE_ERROR_CODES.INTERNAL,
    message,
    details: cause instanceof Error ? { causeName: cause.name } : {},
  }
}

// ==================== Defensive wire readers ====================

/** Narrow an unknown value to the Remote envelope shape. */
export function isGrayRemoteResult(value: unknown): value is GrayRemoteResult<unknown> {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.ok === true) return 'value' in record
  if (record.ok === false) return readGrayRemoteFailure(record.error) !== null
  return false
}

/** Narrow an unknown error payload to a stable failure. */
export function readGrayRemoteFailure(value: unknown): GrayRemoteFailure | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (!isGrayRemoteErrorCode(record.code)) return null
  if (typeof record.message !== 'string') return null
  const details =
    typeof record.details === 'object' && record.details !== null
      ? (record.details as Readonly<Record<string, unknown>>)
      : {}
  return { code: record.code, message: record.message, details }
}

/** Narrow an unknown value to a memory entry view. */
export function readMemoryEntryView(value: unknown): GrayMemoryEntryView | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'number' || !Number.isSafeInteger(record.id)) return null
  if (typeof record.date !== 'string') return null
  if (typeof record.text !== 'string') return null
  return { id: record.id, date: record.date, text: record.text }
}

/** Narrow an unknown value to a memory list page (strict: one bad item voids the page). */
export function readMemoryListResult(value: unknown): GrayMemoryListResult | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.items)) return null
  const items: GrayMemoryEntryView[] = []
  for (const item of record.items) {
    const entry = readMemoryEntryView(item)
    if (entry === null) return null
    items.push(entry)
  }
  if (typeof record.total !== 'number' || !Number.isSafeInteger(record.total) || record.total < 0) {
    return null
  }
  if (typeof record.revision !== 'string' || record.revision.trim().length === 0) return null
  const nextCursor =
    typeof record.nextCursor === 'string' && record.nextCursor.length > 0 ? record.nextCursor : undefined
  return {
    items,
    total: record.total,
    revision: record.revision,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  }
}

function readBoundedPositiveInteger(value: unknown, max: number): number | null {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= max
    ? value
    : null
}

/** Narrow the effective config returned by `memory/configGet`. */
export function readMemoryConfig(value: unknown): GrayMemoryConfig | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const wakeLines = readBoundedPositiveInteger(record.wakeLines, 10_000)
  const entryChars = readBoundedPositiveInteger(record.entryChars, 1_000)
  const partChars = readBoundedPositiveInteger(record.partChars, 1_000_000)
  const partLines = readBoundedPositiveInteger(record.partLines, 100_000)
  if (wakeLines === null || entryChars === null || partChars === null || partLines === null) return null
  return { wakeLines, entryChars, partChars, partLines }
}

/** Narrow an unknown value to a forget result. */
export function readMemoryForgetResult(value: unknown): GrayMemoryForgetResult | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const mode = record.mode
  if (mode !== 'summary' && mode !== 'single' && mode !== 'range') return null
  return {
    mode,
    ...(typeof record.removed === 'number' && Number.isSafeInteger(record.removed)
      ? { removed: record.removed }
      : {}),
    ...(typeof record.gone === 'number' && Number.isSafeInteger(record.gone) ? { gone: record.gone } : {}),
    ...(typeof record.firstId === 'string' && record.firstId.length > 0 ? { firstId: record.firstId } : {}),
  }
}

/** Narrow an unknown value to one scope-info entry (strict). */
export function readMemoryScopeInfo(value: unknown): GrayMemoryScopeInfo | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.scope !== 'global' && record.scope !== 'workspace') return null
  if (typeof record.id !== 'string' || record.id.trim().length === 0) return null
  if (typeof record.name !== 'string') return null
  if (typeof record.path !== 'string') return null
  return {
    scope: record.scope,
    id: record.id,
    name: record.name,
    path: record.path,
    ...(typeof record.cwd === 'string' && record.cwd.length > 0 ? { cwd: record.cwd } : {}),
  }
}

/** Narrow an unknown value to the `memory/scopes` result (strict: one bad item voids it). */
export function readMemoryScopesResult(value: unknown): GrayMemoryScopesResult | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.items)) return null
  const items: GrayMemoryScopeInfo[] = []
  for (const item of record.items) {
    const info = readMemoryScopeInfo(item)
    if (info === null) return null
    items.push(info)
  }
  return { items }
}

/** Narrow an unknown value to a `memory/forgetBatch` result (strict). */
export function readMemoryForgetBatchResult(value: unknown): GrayMemoryForgetBatchResult | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.removed !== 'number' || !Number.isSafeInteger(record.removed) || record.removed < 0) {
    return null
  }
  if (!Array.isArray(record.notFound)) return null
  const notFound: number[] = []
  for (const id of record.notFound) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null
    notFound.push(id)
  }
  return { removed: record.removed, notFound }
}
