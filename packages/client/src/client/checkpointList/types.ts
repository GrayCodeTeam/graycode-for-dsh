/**
 * Checkpoint list surface (P4-04) — structural wire types, view models, store
 * state and the injected data-source port.
 *
 * CONTRACT SOURCE: the host half (packages/plugin) registers `checkpoints/list`,
 * `checkpoints/verify`, `checkpoints/previewRestore`, `checkpoints/restore`
 * into `ctx.grayRemote` (see `src/checkpoints/index.ts` and
 * `src/checkpoints/adapters/dsh/remote.ts`) and answers every call with the
 * `GrayRemoteResult` envelope
 * (`{ ok: true, value } | { ok: false, error: { code, message, details } }` —
 * business errors never reject; an unregistered endpoint returns
 * GRAY_ENDPOINT_NOT_FOUND). The list item is
 * `GrayCheckpointItemView = CheckpointSummary & { verifyState: 'unknown' }`
 * (rc.6 does not persist verify results — the UI may call `checkpoints/verify`
 * on demand; list rendering stays read-only).
 *
 * The client cannot import the plugin (bundle purity gate) and has no direct
 * channel to `ctx.grayRemote` (a Node cordis service) today — so the wire
 * shapes are re-declared structurally and every consumer narrows them with the
 * defensive `read*` helpers below (the same pattern workflowNode uses for
 * session events). A future bridge (host projection → client replay, or a
 * Typert remote client channel) feeds the same shapes into
 * {@link CheckpointListDataSource}.
 *
 * CLIENT BOUNDARY RULES (PLAN_V2 §5.6):
 * - replay-safe: nothing here performs I/O or touches the workspace — data
 *   arrives only through the injected data source;
 * - pagination: one page per request, cursor-based; the store never pulls the
 *   full list (host clamps limit to 1..100, default 20);
 * - verify state is read-only display only;
 * - errors are stable machine codes (GRAY_*) mapped to locale hints — the UI
 *   never parses error text (see errors.ts).
 */
import type { CheckpointListHint } from './errors.ts'

// ==================== wire shapes (structural re-declarations) ====================

/** Snapshot kind ('incremental' chains from a base checkpoint). */
export type CheckpointType = 'full' | 'incremental'

/** Snapshot phase relative to the triggering tool call. */
export type CheckpointPhase = 'before' | 'after'

/**
 * Verify state of one list item. rc.6 list responses are always 'unknown'
 * (the host does not persist verify results); 'ok'/'failed' are reserved for
 * a future host and are read-only display states here.
 */
export type CheckpointVerifyState = 'unknown' | 'ok' | 'failed'

/**
 * Snapshot origin. 'auto' = created by the automatic checkpoint pipeline;
 * 'manual' = created on demand. Old list data predates the field and is
 * treated as 'manual' (the badge only renders for 'auto').
 */
export type CheckpointOrigin = 'auto' | 'manual'

/** Wire list item (host `GrayCheckpointItemView`, structural re-declaration). */
export interface CheckpointListItemWire {
  readonly id: string
  readonly conversationId: string
  readonly messageNodeId?: string
  readonly messageIndex: number
  readonly toolName: string
  readonly phase: CheckpointPhase
  /** Unix epoch ms of the snapshot. */
  readonly timestamp: number
  readonly type: CheckpointType
  /** Incremental parent id; absent = full snapshot (chain root). */
  readonly baseCheckpointId?: string
  readonly contentHash: string
  readonly fileCount: number
  /** Bytes the snapshot occupies in the blob pool. */
  readonly backupBytes: number
  readonly excludedCount: number
  readonly manifestVersion: number
  readonly verifyState: CheckpointVerifyState
  /** Snapshot origin ('auto' = automatic pipeline); absent = 'manual' (old data). */
  readonly origin?: CheckpointOrigin
}

/** One wire page (host `GrayCheckpointListResult`). */
export interface CheckpointListPageWire {
  readonly items: readonly CheckpointListItemWire[]
  readonly total: number
  /** Id of the last listed item; absent when no more pages exist. */
  readonly nextCursor?: string
}

/** Wire verify result (host `CheckpointVerifyResult`). */
export interface CheckpointVerifyResultWire {
  readonly ok: boolean
  readonly checkpointId: string
  readonly issues: readonly string[]
  readonly checkedFiles: number
  readonly chainLength: number
  readonly filesRevisionPaired: boolean
}

/** Wire failure envelope (host `GrayRemoteFailure`). */
export interface CheckpointRemoteFailureWire {
  readonly code: string
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
}

// ==================== data source port (contract-driven consumer point) ====================

/** Query params for one list page (host `GrayCheckpointListParams`). */
export interface CheckpointListQueryParams {
  /** Workspace root (absolute path on the host bridge). */
  readonly workspaceId: string
  readonly cursor?: string
  readonly limit?: number
}

/** Envelope of one list call — mirrors the host `GrayRemoteResult` (never rejects). */
export type CheckpointListQueryOutcome =
  | { readonly ok: true; readonly value: CheckpointListPageWire }
  | { readonly ok: false; readonly error: CheckpointRemoteFailureWire }

/** Envelope of one verify call. */
export type CheckpointVerifyOutcome =
  | { readonly ok: true; readonly value: CheckpointVerifyResultWire }
  | { readonly ok: false; readonly error: CheckpointRemoteFailureWire }

/**
 * Injected consumer port for the checkpoint archive. The browser half cannot
 * reach `ctx.grayRemote` (Node cordis service) in rc.6, so the host/main
 * session wires a real implementation through a bridge (projection replay /
 * future Typert remote client channel); `createMockCheckpointListDataSource`
 * (dataSource.ts) is the I/O-free stand-in for preview and tests.
 */
export interface CheckpointListDataSource {
  /** Port identity — 'mock' makes the list render a dev notice. */
  readonly kind?: 'remote' | 'mock'
  /** Fetch one page (never the full list). Business errors are returned, not thrown. */
  list(params: CheckpointListQueryParams, signal?: AbortSignal): Promise<CheckpointListQueryOutcome>
  /** Read-only integrity check (optional until the host bridge exists). */
  verify?(checkpointId: string, signal?: AbortSignal): Promise<CheckpointVerifyOutcome>
}

// ==================== view models ====================

/** One parent-chain step (newest → oldest). */
export interface CheckpointChainLink {
  readonly id: string
  /** 1-based position from the item. */
  readonly depth: number
  /** True when this parent id is outside the loaded pages (resolve by loading more). */
  readonly beyondWindow: boolean
}

/** Chain resolution against the loaded pages. */
export interface CheckpointChainResolution {
  readonly links: readonly CheckpointChainLink[]
  /** True when ancestors exist beyond the loaded pages or the display bound. */
  readonly truncated: boolean
}

/** Display view model of one checkpoint list item. */
export interface CheckpointListItemVM {
  readonly id: string
  readonly conversationId: string
  readonly messageIndex: number
  readonly toolName: string
  readonly phase: CheckpointPhase
  readonly timestamp: number
  readonly type: CheckpointType
  /** baseCheckpointId ?? null (null = full snapshot root). */
  readonly parentId: string | null
  readonly fileCount: number
  readonly backupBytes: number
  readonly excludedCount: number
  readonly contentHash: string
  readonly verifyState: CheckpointVerifyState
  /** Normalized origin ('manual' when the wire field is absent). */
  readonly origin: CheckpointOrigin
  /** Parent chain, bounded for display (see viewModel.ts). */
  readonly chain: readonly CheckpointChainLink[]
  readonly chainTruncated: boolean
}

/** Load lifecycle of the list store. */
export type CheckpointListLoadState = 'idle' | 'loading' | 'ready' | 'error'

/** Immutable store snapshot (revision bumps on every change). */
export interface CheckpointListStoreState {
  readonly workspaceId: string
  readonly entries: readonly CheckpointListItemVM[]
  /** Filtered total from the host; null before the first page. */
  readonly total: number | null
  readonly nextCursor: string | null
  readonly hasMore: boolean
  readonly loadState: CheckpointListLoadState
  /** Locale-keyed error hint; null while not in error. */
  readonly error: CheckpointListHint | null
  /** Detail-expand selection (UI-local, kept here so components stay stateless). */
  readonly expandedId: string | null
  /** Data source identity — 'mock' renders a dev notice. */
  readonly sourceKind: 'remote' | 'mock'
  /** Monotonic mutation counter (subscription-friendly). */
  readonly revision: number
}

// ==================== defensive wire readers ====================

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readOptionalInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readType(value: unknown): CheckpointType | null {
  return value === 'full' || value === 'incremental' ? value : null
}

function readPhase(value: unknown): CheckpointPhase | null {
  return value === 'before' || value === 'after' ? value : null
}

const VERIFY_STATES: ReadonlySet<string> = new Set(['unknown', 'ok', 'failed'])

function readVerifyState(value: unknown): CheckpointVerifyState {
  return typeof value === 'string' && VERIFY_STATES.has(value) ? (value as CheckpointVerifyState) : 'unknown'
}

/** Narrow an origin value; anything but 'auto'/'manual' (incl. missing) → 'manual'. */
function readOrigin(value: unknown): CheckpointOrigin {
  return value === 'auto' || value === 'manual' ? value : 'manual'
}

/**
 * Narrow one raw list item to the wire shape.
 * @param data - raw payload (unknown by contract; narrowed defensively).
 * @returns the wire item, or null when the identity fields are unusable.
 */
export function readCheckpointListItem(data: unknown): CheckpointListItemWire | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0) return null
  const type = readType(record.type)
  const phase = readPhase(record.phase)
  if (type === null || phase === null) return null
  return {
    id: record.id,
    conversationId: readOptionalString(record.conversationId) ?? '',
    messageNodeId: readOptionalString(record.messageNodeId),
    messageIndex: readOptionalInt(record.messageIndex) ?? 0,
    toolName: readOptionalString(record.toolName) ?? '',
    phase,
    timestamp: readOptionalNumber(record.timestamp) ?? 0,
    type,
    baseCheckpointId: readOptionalString(record.baseCheckpointId),
    contentHash: readOptionalString(record.contentHash) ?? '',
    fileCount: readOptionalInt(record.fileCount) ?? 0,
    backupBytes: readOptionalNumber(record.backupBytes) ?? 0,
    excludedCount: readOptionalInt(record.excludedCount) ?? 0,
    manifestVersion: readOptionalInt(record.manifestVersion) ?? 0,
    verifyState: readVerifyState(record.verifyState),
    origin: readOrigin(record.origin),
  }
}

/**
 * Narrow one raw page to the wire shape. Invalid items are skipped; a missing
 * `total` falls back to the narrowed item count.
 * @param data - raw payload.
 */
export function readCheckpointListPage(data: unknown): CheckpointListPageWire | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  if (!Array.isArray(record.items)) return null
  const items: CheckpointListItemWire[] = []
  for (const raw of record.items) {
    const item = readCheckpointListItem(raw)
    if (item !== null) items.push(item)
  }
  const total = readOptionalInt(record.total) ?? items.length
  return { items, total, nextCursor: readOptionalString(record.nextCursor) }
}

/**
 * Narrow one raw failure envelope (host `GrayRemoteFailure`).
 * @param data - raw payload.
 */
export function readCheckpointRemoteFailure(data: unknown): CheckpointRemoteFailureWire | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  if (typeof record.code !== 'string' || record.code.length === 0) return null
  return {
    code: record.code,
    message: readOptionalString(record.message) ?? '',
    details:
      typeof record.details === 'object' && record.details !== null
        ? (record.details as Readonly<Record<string, unknown>>)
        : {},
  }
}

/**
 * Narrow one raw envelope to a list query outcome (host `GrayRemoteResult`).
 * @param data - raw payload.
 */
export function readCheckpointListOutcome(data: unknown): CheckpointListQueryOutcome | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  if (record.ok === true) {
    const value = readCheckpointListPage(record.value)
    return value === null ? null : { ok: true, value }
  }
  if (record.ok === false) {
    const error = readCheckpointRemoteFailure(record.error)
    return error === null ? null : { ok: false, error }
  }
  return null
}

/**
 * Narrow one raw verify result (host `CheckpointVerifyResult`).
 * @param data - raw payload.
 */
export function readCheckpointVerifyResult(data: unknown): CheckpointVerifyResultWire | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  if (typeof record.checkpointId !== 'string' || record.checkpointId.length === 0) return null
  return {
    ok: record.ok === true,
    checkpointId: record.checkpointId,
    issues: Array.isArray(record.issues) ? record.issues.filter((issue): issue is string => typeof issue === 'string') : [],
    checkedFiles: readOptionalInt(record.checkedFiles) ?? 0,
    chainLength: readOptionalInt(record.chainLength) ?? 0,
    filesRevisionPaired: record.filesRevisionPaired === true,
  }
}
