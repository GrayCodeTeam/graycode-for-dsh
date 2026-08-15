/**
 * Restore progress merging (P4-05).
 *
 * Pure logic over the {@link RestoreProgress} view model: merges host
 * progress patches (cumulative counters), folds the final `RestoreResult`
 * (authoritative counts + per-file failures) and derives display values
 * (percent, failure groups).
 *
 * COUNTER SEMANTICS: host progress events are cumulative — merges take the
 * max per counter so out-of-order or duplicated events never regress the UI.
 * The final result REPLACES restored/deleted/skipped and the failure list
 * (it is the authoritative terminal snapshot).
 */
import type { RestoreFailureReason, RestoreFailureWire, RestoreProgress, RestoreResultWire } from './types.ts'
import { RESTORE_FAILURE_REASONS } from './types.ts'

/** Create the initial progress for a restore run. */
export function createRestoreProgress(options: { total: number; at: number }): RestoreProgress {
  return {
    total: options.total > 0 ? Math.floor(options.total) : 0,
    processed: 0,
    restored: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
    failedItems: [],
    phase: 'preparing',
    startedAt: options.at,
    updatedAt: options.at,
  }
}

/** One cumulative progress patch (structural subset of host operation progress). */
export interface RestoreProgressPatch {
  readonly processed?: number
  readonly total?: number
  readonly restored?: number
  readonly deleted?: number
  readonly skipped?: number
  readonly failed?: number
  readonly phase?: string
  /** Per-file failures observed since the last patch (deduped by path on merge). */
  readonly failedItems?: readonly RestoreFailureWire[]
  /** Event timestamp; defaults to the current updatedAt when absent. */
  readonly at?: number
}

/**
 * Merge a cumulative progress patch into the current progress (max-merge;
 * invalid values fall back to the current ones). `failedItems` from the patch
 * are appended (deduped by path) so streaming per-item failures are never
 * silently dropped (4.6-L2); the failed counter never drops below the number
 * of recorded items.
 */
export function mergeRestoreProgress(current: RestoreProgress, patch: RestoreProgressPatch): RestoreProgress {
  const pick = (value: number | undefined, fallback: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
    return Math.max(fallback, Math.floor(value))
  }
  const failedItems = mergeFailureLists(current.failedItems, patch.failedItems)
  return {
    ...current,
    total: pick(patch.total, current.total),
    processed: pick(patch.processed, current.processed),
    restored: pick(patch.restored, current.restored),
    deleted: pick(patch.deleted, current.deleted),
    skipped: pick(patch.skipped, current.skipped),
    failed: Math.max(pick(patch.failed, current.failed), failedItems.length),
    failedItems,
    phase: typeof patch.phase === 'string' && patch.phase.length > 0 ? patch.phase : current.phase,
    updatedAt: patch.at ?? current.updatedAt,
  }
}

/** Append incoming failures not already recorded, deduped by path. */
function mergeFailureLists(
  current: readonly RestoreFailureWire[],
  incoming: readonly RestoreFailureWire[] | undefined,
): readonly RestoreFailureWire[] {
  if (incoming === undefined || incoming.length === 0) return current
  const known = new Set(current.map(item => item.path))
  const out = [...current]
  for (const failure of incoming) {
    if (known.has(failure.path)) continue
    known.add(failure.path)
    out.push(failure)
  }
  return out
}

/**
 * Merge one per-file failure into the progress (逐项失败归并): appends the
 * item when its path is not already recorded and bumps the failed counter.
 * @param at - event timestamp; defaults to the current updatedAt.
 */
export function mergeFailureItem(
  progress: RestoreProgress,
  failure: RestoreFailureWire,
  at: number = progress.updatedAt,
): RestoreProgress {
  if (progress.failedItems.some(item => item.path === failure.path)) return progress
  return {
    ...progress,
    failedItems: [...progress.failedItems, failure],
    failed: progress.failed + 1,
    updatedAt: at,
  }
}

/**
 * Fold the final restore result into the progress: counters and the failure
 * list become authoritative (replace, not max — the result is terminal).
 * @param at - result timestamp; defaults to the current updatedAt.
 */
export function mergeRestoreResult(
  progress: RestoreProgress,
  result: RestoreResultWire,
  at: number = progress.updatedAt,
): RestoreProgress {
  const failedItems = result.failures
  const finished = result.restored + result.deleted + result.skipped + failedItems.length
  return {
    ...progress,
    total: Math.max(progress.total, finished),
    processed: Math.max(progress.processed, finished),
    restored: result.restored,
    deleted: result.deleted,
    skipped: result.skipped,
    failed: failedItems.length,
    failedItems,
    phase: result.success ? 'done' : 'failed',
    updatedAt: at,
  }
}

/** Display percent 0..100 (0 when the total is unknown). */
export function progressPercent(progress: RestoreProgress): number {
  if (progress.total <= 0) return 0
  const percent = Math.floor((progress.processed / progress.total) * 100)
  return Math.min(100, Math.max(0, percent))
}

/**
 * Aggregate per-file failures by reason, in canonical reason order.
 * @returns only non-empty groups.
 */
export function groupFailuresByReason(
  failures: readonly RestoreFailureWire[],
): ReadonlyArray<{ reason: RestoreFailureReason; count: number }> {
  const counts = new Map<RestoreFailureReason, number>()
  for (const failure of failures) {
    counts.set(failure.reason, (counts.get(failure.reason) ?? 0) + 1)
  }
  return RESTORE_FAILURE_REASONS
    .map(reason => ({ reason, count: counts.get(reason) ?? 0 }))
    .filter(entry => entry.count > 0)
}
