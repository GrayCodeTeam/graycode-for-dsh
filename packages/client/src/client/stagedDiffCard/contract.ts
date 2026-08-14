/**
 * Staged-diff card contract mirror (P4-06).
 *
 * The client package must not import host plugin code (package boundary /
 * bundle purity gate), so this module mirrors the host wire contract field
 * for field:
 * - `packages/plugin/src/remote/types.ts` — stagedDiff section: the
 *   `stagedDiff/list|preview|accept|reject` endpoints, the
 *   `GrayRemoteResult` envelope, and the stable `GRAY_*` error codes;
 * - `packages/plugin/src/stagedDiff/domain/types.ts` — `StagedEntry`,
 *   `StagedEntryStatus` and the domain cause codes (`GRAY_STAGED_*`);
 * - `packages/plugin/src/stagedDiff/domain/stateMachine.ts` — the
 *   transition table, mirrored so the mock data source and the tests share
 *   the host's state semantics.
 *
 * CLIENT BOUNDARY RULES (PLAN_V2 §5.6): types and pure helpers only — no
 * I/O, no workspace access. The UI reads machine codes only and never
 * parses error message text.
 */

/** Entry status (ADR-0003 §4) — mirrors host `StagedEntryStatus`. */
export type StagedEntryStatus =
  | 'pending'
  | 'reviewing'
  | 'accepted'
  | 'rejected'
  | 'done'
  | 'needs-reapply'

/** All statuses (full-coverage tests + mock validation). */
export const STAGED_ENTRY_STATUSES: readonly StagedEntryStatus[] = [
  'pending',
  'reviewing',
  'accepted',
  'rejected',
  'done',
  'needs-reapply',
]

/** One deferred write intent — mirrors host `StagedEntry`. */
export interface StagedEntry {
  /** Stable entry id (one of the idempotency keys). */
  readonly id: string
  /** Owning workspace id (cwd-derived, same calibre as branches/checkpoints). */
  readonly workspaceId: string
  /** Session id that produced the write intent. */
  readonly sessionId: string
  /** Normalized workspace-relative path (POSIX separators, no leading `/` or `..`). */
  readonly path: string
  /** Pre-write snapshot (`FsWriteOutcome.before` semantics): null = target absent (create). */
  readonly before: string | null
  /** Target content; written to `path` only after acceptance. */
  readonly after: string
  /** Tool call id that produced the intent (idempotency key with `path`). */
  readonly toolCallId?: string
  readonly status: StagedEntryStatus
  /** Unix epoch ms. */
  readonly createdAt: number
  /** Unix epoch ms. */
  readonly updatedAt: number
  /** Monotonic CAS counter, incremented on every change. */
  readonly revision: number
}

/** `stagedDiff/list` parameters — mirrors host `GrayStagedDiffListParams`. */
export interface StagedDiffListParams {
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly statuses?: readonly StagedEntryStatus[]
  readonly cursor?: string
  readonly limit?: number
}

/** `stagedDiff/list` result — mirrors host `GrayStagedDiffListResult` (GrayPage). */
export interface StagedDiffListResult {
  readonly items: readonly StagedEntry[]
  /** Filtered total. */
  readonly total: number
  /** Last item id; absent when there are no more pages. */
  readonly nextCursor?: string
}

/** `stagedDiff/accept|reject` parameters — mirrors host `GrayStagedDiffDecisionParams`. */
export interface StagedDiffDecisionParams {
  readonly entryId: string
  /** CAS optimistic lock: the revision read from the entry, echoed back. */
  readonly expectedRevision: number
  /** Target workspace root (accept needs it to write); host defaults to process.cwd(). */
  readonly workspace?: string
}

/** Stable Remote error codes — mirrors host `GRAY_REMOTE_ERROR_CODES`. */
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

/**
 * Domain cause codes carried in `GrayRemoteFailure.details.causeCode` —
 * mirrors host `StagedDiffErrorCode`. The client only needs the subset that
 * refines the display mapping (conflicts and storage).
 */
export const GRAY_STAGED_CAUSE_CODES = {
  ENTRY_NOT_FOUND: 'GRAY_STAGED_ENTRY_NOT_FOUND',
  ILLEGAL_TRANSITION: 'GRAY_STAGED_ILLEGAL_TRANSITION',
  REVISION_CONFLICT: 'GRAY_STAGED_REVISION_CONFLICT',
  REJECT_CONFLICT: 'GRAY_STAGED_REJECT_CONFLICT',
  APPLY_FAILED: 'GRAY_STAGED_APPLY_FAILED',
  STORAGE_CORRUPT: 'GRAY_STORAGE_CORRUPT',
  STORAGE_WRITE_FAILED: 'GRAY_STAGED_STORAGE_WRITE_FAILED',
} as const

export type GrayStagedCauseCode = (typeof GRAY_STAGED_CAUSE_CODES)[keyof typeof GRAY_STAGED_CAUSE_CODES]

/** A failed Remote call — mirrors host `GrayRemoteFailure`. */
export interface GrayRemoteFailure {
  readonly code: GrayRemoteErrorCode | string
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
}

/** Unified envelope returned by every endpoint — mirrors host `GrayRemoteResult<T>`. */
export type GrayRemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GrayRemoteFailure }

/** Legal transition table (ADR-0003 §4) — mirrors host `STAGED_ENTRY_TRANSITIONS`. */
export const STAGED_ENTRY_TRANSITIONS: Readonly<Record<StagedEntryStatus, readonly StagedEntryStatus[]>> = {
  pending: ['reviewing', 'accepted', 'rejected'],
  reviewing: ['accepted', 'rejected'],
  accepted: ['done'],
  rejected: ['done'],
  done: [],
  'needs-reapply': ['accepted', 'rejected'],
}

/** Whether `from -> to` is legal. */
export function canTransitionStaged(from: StagedEntryStatus, to: StagedEntryStatus): boolean {
  return STAGED_ENTRY_TRANSITIONS[from].includes(to)
}

/**
 * Produce the next entry for a transition (does not mutate the input):
 * status update, `updatedAt = now`, `revision + 1`. Illegal transitions
 * throw — mirrors host `transitionEntry`.
 */
export function transitionStagedEntry(entry: StagedEntry, to: StagedEntryStatus, now: number): StagedEntry {
  if (!canTransitionStaged(entry.status, to)) {
    throw new Error(`illegal staged entry transition "${entry.status}" -> "${to}" (entry "${entry.id}")`)
  }
  return {
    ...entry,
    status: to,
    updatedAt: now,
    revision: entry.revision + 1,
  }
}

/**
 * Defensive narrow of an arbitrary failure-details payload to a real entry.
 * The host attaches `details.entry` (authoritative snapshot) on conflict
 * failures; the client keeps it only when it structurally looks like one.
 */
export function isStagedEntryLike(value: unknown): value is StagedEntry {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string'
    && record.id.length > 0
    && typeof record.workspaceId === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.path === 'string'
    && (record.before === null || typeof record.before === 'string')
    && typeof record.after === 'string'
    && typeof record.status === 'string'
    && (STAGED_ENTRY_STATUSES as readonly string[]).includes(record.status)
    && typeof record.createdAt === 'number'
    && typeof record.updatedAt === 'number'
    && typeof record.revision === 'number'
  )
}
