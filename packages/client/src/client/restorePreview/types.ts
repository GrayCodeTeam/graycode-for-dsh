/**
 * Restore preview wire contract and domain view model (P4-05).
 *
 * DATA SOURCE: the host-side `checkpoints` Remote endpoints
 * (`packages/plugin/src/remote/types.ts` + `checkpoints/adapters/dsh/remote.ts`,
 * READ-ONLY for this task). The client never imports the plugin package
 * (package boundary + bundle purity gate), so this module mirrors the wire
 * shapes structurally and reads every payload defensively — exactly like the
 * workflowNode surface treats session events.
 *
 * WIRE CONTRACT (host, envelope `GrayRemoteResult<T>`):
 * - `checkpoints/previewRestore` args `{ workspace?, checkpointId,
 *   deleteUntrackedFiles? }` → `CheckpointPreviewOutcome`:
 *   `{ preview: RestorePreviewResult, previewToken?, baselineDigest? }`.
 *   The token IS the previewId (sha256 of checkpointId + workspace
 *   fingerprint); it binds manifest hash + baseline digest, so restore must
 *   echo it verbatim and a drifted workspace invalidates it.
 * - `checkpoints/restore` args `{ workspace?, checkpointId, previewToken,
 *   deleteUntrackedFiles? }` → `RestoreResult`:
 *   `{ success, restored, deleted, skipped, error?, failures?, ... }`.
 *   Missing/expired/mismatched token → `GRAY_APPROVAL_REQUIRED`; workspace
 *   drift or manifest change since preview → `GRAY_CONFLICT`; abort →
 *   `GRAY_CANCELLED`.
 *
 * CLIENT BOUNDARY RULES (PLAN_V2 §5.6): this module is replay-safe — no I/O,
 * no workspace access, no caching-as-success. Restore is a destructive
 * operation: the UI must bind preview and restore to the SAME previewId and
 * demand explicit double confirmation; per-item failures are surfaced, never
 * folded into a bare "failed".
 */

// ==================== wire error codes ====================

/**
 * Stable Remote error machine codes the restore surface consumes. Mirror of
 * `GRAY_REMOTE_ERROR_CODES` in the host contract — duplicated here because the
 * client cannot import the plugin package (see module doc).
 */
export const GRAY_RESTORE_REMOTE_CODES = {
  INVALID_INPUT: 'GRAY_INVALID_INPUT',
  CONFLICT: 'GRAY_CONFLICT',
  APPROVAL_REQUIRED: 'GRAY_APPROVAL_REQUIRED',
  CANCELLED: 'GRAY_CANCELLED',
  STORAGE_CORRUPT: 'GRAY_STORAGE_CORRUPT',
  NOT_FOUND: 'GRAY_NOT_FOUND',
  ENDPOINT_NOT_FOUND: 'GRAY_ENDPOINT_NOT_FOUND',
  INTERNAL: 'GRAY_INTERNAL',
} as const

/**
 * Client-local machine codes (never emitted by the host; they classify
 * defensive paths the host envelope cannot carry):
 * - `GRAY_PREVIEW_FAILED` — preview returned `success:false` with an error
 *   text (the host adapter normally maps this to a stable code itself);
 * - `GRAY_RESTORE_PARTIAL` — restore returned `success:false` with a
 *   per-file `failures` list (host adapter maps it to a single envelope code
 *   and drops the list, so the client keeps the result for per-item display);
 * - `GRAY_MALFORMED_RESPONSE` — endpoint payload did not match the contract.
 */
export const RESTORE_CLIENT_ERROR_CODES = {
  PREVIEW_FAILED: 'GRAY_PREVIEW_FAILED',
  RESTORE_PARTIAL: 'GRAY_RESTORE_PARTIAL',
  MALFORMED_RESPONSE: 'GRAY_MALFORMED_RESPONSE',
} as const

/** A remote call failure (structural copy of `GrayRemoteFailure`). */
export interface RestoreRemoteFailure {
  readonly code: string
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
}

/** Uniform remote envelope: `ok:true + value` or `ok:false + error`. */
export type RestoreRemoteEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RestoreRemoteFailure }

// ==================== wire payloads ====================

/** Canonical per-file restore failure reasons (host `RestoreFailureReason`). */
export const RESTORE_FAILURE_REASONS = [
  'missing_in_chain',
  'hash_mismatch',
  'copy_failed',
  'delete_failed',
] as const

/** One per-file restore failure reason. */
export type RestoreFailureReason = (typeof RESTORE_FAILURE_REASONS)[number]

/** Narrow an unknown value to a failure reason. */
export function isRestoreFailureReason(value: unknown): value is RestoreFailureReason {
  return RESTORE_FAILURE_REASONS.includes(value as RestoreFailureReason)
}

/** One per-file restore failure (host `RestoreFailure`). */
export interface RestoreFailureWire {
  readonly path: string
  readonly reason: RestoreFailureReason
}

/**
 * Restore preview result (host `RestorePreviewResult`, subset the surface
 * consumes). Counts are authoritative; `deletablePaths` / `untrackedPaths` /
 * `unbackedPaths` are display lists the host chose to send (legacy archives
 * may not carry full lists).
 */
export interface RestorePreviewWire {
  readonly success: boolean
  /** Files that WILL be restored (added + modified). */
  readonly restored: number
  /** Files deleted when untracked deletion is CONFIRMED (snapshot paths + created-after-snapshot). */
  readonly deleted: number
  /** Files deleted WITHOUT untracked confirmation (snapshot-recorded paths only). */
  readonly deletedIfUnconfirmed: number
  /** Files already matching the snapshot (no-op). */
  readonly skipped: number
  /** Paths that will be deleted (display list). */
  readonly deletablePaths: readonly string[]
  /** Paths created after the snapshot; kept unless deletion is confirmed. */
  readonly untrackedPaths: readonly string[]
  /** Paths not backed up at snapshot time (protected — never deleted). */
  readonly unbackedPaths: readonly string[]
  /** Legacy archive: exact counts/lists unavailable. */
  readonly legacy?: boolean
  /** Preview error text (host classifies it into a stable code). */
  readonly error?: string
  /** Preflight failures (broken chain etc.) — blocking conflicts. */
  readonly failures: readonly RestoreFailureWire[]
  /** Backup directories missing on disk — blocking conflicts. */
  readonly missingBackupDirs: readonly string[]
  readonly autoPrunedCheckpointCount?: number
}

/** `checkpoints/previewRestore` success value (host `CheckpointPreviewOutcome`). */
export interface RestorePreviewOutcomeWire {
  readonly preview: RestorePreviewWire
  /** Approval token = previewId; MUST be echoed to `checkpoints/restore` unchanged. */
  readonly previewToken?: string
  /** Baseline digest bound to the token (drift after preview invalidates it). */
  readonly baselineDigest?: string
}

/** `checkpoints/restore` success value (host `RestoreResult`, subset). */
export interface RestoreResultWire {
  readonly success: boolean
  readonly restored: number
  readonly deleted: number
  readonly skipped: number
  readonly error?: string
  /** Per-file failures (present when `success === false`). */
  readonly failures: readonly RestoreFailureWire[]
  readonly unbackedPaths: readonly string[]
  readonly autoPrunedCheckpointCount?: number
}

// ==================== defensive readers ====================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/** Narrow one unknown value to a typed restore failure (or null). */
export function readRestoreFailure(value: unknown): RestoreFailureWire | null {
  if (!isRecord(value)) return null
  if (typeof value.path !== 'string' || value.path.length === 0) return null
  if (!isRestoreFailureReason(value.reason)) return null
  return { path: value.path, reason: value.reason }
}

/** Narrow an unknown array to a typed failure list (invalid entries dropped). */
export function readRestoreFailures(value: unknown): readonly RestoreFailureWire[] {
  if (!Array.isArray(value)) return []
  const out: RestoreFailureWire[] = []
  for (const item of value) {
    const failure = readRestoreFailure(item)
    if (failure !== null) out.push(failure)
  }
  return out
}

/** Narrow an unknown value to a preview result (or null). */
export function readPreviewWire(value: unknown): RestorePreviewWire | null {
  if (!isRecord(value)) return null
  if (typeof value.success !== 'boolean') return null
  return {
    success: value.success,
    restored: readCount(value.restored),
    deleted: readCount(value.deleted),
    deletedIfUnconfirmed: readCount(value.deletedIfUnconfirmed),
    skipped: readCount(value.skipped),
    deletablePaths: readStringArray(value.deletablePaths),
    untrackedPaths: readStringArray(value.untrackedPaths),
    unbackedPaths: readStringArray(value.unbackedPaths),
    legacy: value.legacy === true ? true : undefined,
    error: typeof value.error === 'string' && value.error.length > 0 ? value.error : undefined,
    failures: readRestoreFailures(value.failures),
    missingBackupDirs: readStringArray(value.missingBackupDirs),
    autoPrunedCheckpointCount: readCount(value.autoPrunedCheckpointCount) || undefined,
  }
}

/** Narrow an unknown value to a preview outcome (or null). */
export function readPreviewOutcome(value: unknown): RestorePreviewOutcomeWire | null {
  if (!isRecord(value)) return null
  const preview = readPreviewWire(value.preview)
  if (preview === null) return null
  const token = typeof value.previewToken === 'string' && value.previewToken.length > 0
    ? value.previewToken
    : undefined
  const digest = typeof value.baselineDigest === 'string' && value.baselineDigest.length > 0
    ? value.baselineDigest
    : undefined
  return { preview, previewToken: token, baselineDigest: digest }
}

/** Narrow an unknown value to a restore result (or null). */
export function readRestoreResult(value: unknown): RestoreResultWire | null {
  if (!isRecord(value)) return null
  if (typeof value.success !== 'boolean') return null
  return {
    success: value.success,
    restored: readCount(value.restored),
    deleted: readCount(value.deleted),
    skipped: readCount(value.skipped),
    error: typeof value.error === 'string' && value.error.length > 0 ? value.error : undefined,
    failures: readRestoreFailures(value.failures),
    unbackedPaths: readStringArray(value.unbackedPaths),
    autoPrunedCheckpointCount: readCount(value.autoPrunedCheckpointCount) || undefined,
  }
}

/** Narrow an unknown value to a remote failure (or null). */
export function readRestoreRemoteFailure(value: unknown): RestoreRemoteFailure | null {
  if (!isRecord(value)) return null
  if (typeof value.code !== 'string' || value.code.length === 0) return null
  return {
    code: value.code,
    message: typeof value.message === 'string' ? value.message : '',
    details: isRecord(value.details) ? value.details : {},
  }
}

// ==================== domain view model ====================

/** File classification bucket shown in the preview list. */
export type PreviewFileClass = 'restore' | 'delete' | 'untracked' | 'unbacked' | 'conflict'

/** Reason attached to conflict/unbacked items. */
export type PreviewConflictReason = RestoreFailureReason | 'missing_backup_dir' | 'unbacked'

/** One classified file item in the preview list. */
export interface PreviewFileItem {
  readonly path: string
  readonly cls: PreviewFileClass
  readonly reason?: PreviewConflictReason
}

/** One classification group (ordered bucket with count + display items). */
export interface PreviewClassGroup {
  readonly cls: PreviewFileClass
  readonly count: number
  readonly items: readonly PreviewFileItem[]
}

/** File classification of a preview result. */
export interface PreviewClassification {
  /** Non-empty groups in canonical order: restore, delete, untracked, unbacked, conflict. */
  readonly groups: readonly PreviewClassGroup[]
  /** Conflict items only (for the highlighted conflict section). */
  readonly conflicts: readonly PreviewFileItem[]
  /** Total files the preview touches or blocks on (display sum). */
  readonly totalAffected: number
  /** Restore operations the engine will perform (progress total). */
  readonly operationCount: number
  /** True when conflicts block confirmation. */
  readonly blocking: boolean
}

/** Numeric summary of a preview (labels live in the locale fragment). */
export interface PreviewSummary {
  readonly restored: number
  readonly deleted: number
  readonly skipped: number
  readonly untracked: number
  readonly unbacked: number
  readonly conflicts: number
  readonly legacy: boolean
}

/** Progress of an in-flight restore (merged from host progress events + final result). */
export interface RestoreProgress {
  readonly total: number
  readonly processed: number
  readonly restored: number
  readonly deleted: number
  readonly skipped: number
  readonly failed: number
  /** Per-file failures accumulated so far (逐项失败结果). */
  readonly failedItems: readonly RestoreFailureWire[]
  /** Machine-readable phase from the host ('preparing' | 'restoring' | ...). */
  readonly phase: string
  readonly startedAt: number | null
  readonly updatedAt: number
}

/** Parameters of the preview currently being computed (not yet loaded). */
export interface RestorePendingPreview {
  readonly checkpointId: string
  readonly workspace?: string
  readonly deleteUntrackedFiles: boolean
}

/**
 * A confirmed restore session. `previewId` IS the approval token: preview and
 * restore are bound to the same id, and restore actions with a different id
 * are rejected by the state machine (client boundary rule).
 */
export interface RestoreSession {
  readonly previewId: string
  readonly checkpointId: string
  readonly workspace?: string
  readonly deleteUntrackedFiles: boolean
  /** Explicit acknowledgment that untracked files may be deleted. */
  readonly acknowledgedUntracked: boolean
  readonly baselineDigest?: string
}

/** Lifecycle of the restore confirmation surface. */
export type RestorePhase = 'idle' | 'preview' | 'confirm' | 'running' | 'done' | 'failed'

/** Immutable snapshot of the restore confirmation state machine. */
export interface RestoreStep {
  readonly phase: RestorePhase
  readonly pending: RestorePendingPreview | null
  readonly session: RestoreSession | null
  /** Latest preview payload (classification is derived from it). */
  readonly preview: RestorePreviewWire | null
  readonly progress: RestoreProgress | null
  /** Final restore result (kept on partial failure so per-item failures stay visible). */
  readonly result: RestoreResultWire | null
  readonly error: RestoreRemoteFailure | null
  readonly previewAt: number | null
  readonly updatedAt: number
  /** Whether the failed step may retry restore with the same session/token. */
  readonly retryable: boolean
  /** Whether the failed step requires a fresh preview (token invalid/stale). */
  readonly rePreviewRequired: boolean
}
