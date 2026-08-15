/**
 * Shared locale-key helpers for the restore preview surface (P4-05).
 */
import type { GrayCodeRestorePreviewLocaleKey } from './locales.ts'
import type { PreviewConflictReason, RestoreFailureReason } from './types.ts'

/** Host restore progress phase vocabulary (mirror of the plugin domain type). */
const PROGRESS_PHASE_KEYS: Readonly<Record<string, GrayCodeRestorePreviewLocaleKey>> = {
  pending: 'phaseProgress.pending',
  preparing: 'phaseProgress.preparing',
  restoring: 'phaseProgress.restoring',
  done: 'phaseProgress.done',
  failed: 'phaseProgress.failed',
  cancelled: 'phaseProgress.cancelled',
}

/**
 * Locale key for a host progress phase string (4.6-L4). Unknown phases fall
 * back to `phaseProgress.unknown` — the UI never renders the raw host string.
 */
export function progressPhaseLocaleKey(phase: string): GrayCodeRestorePreviewLocaleKey {
  return PROGRESS_PHASE_KEYS[phase] ?? 'phaseProgress.unknown'
}

/**
 * Locale key for a failure/conflict reason. Covers the four restore failure
 * reasons plus the client-side conflict reasons.
 */
export function restoreFailureLocaleKey(reason: RestoreFailureReason | PreviewConflictReason): GrayCodeRestorePreviewLocaleKey {
  switch (reason) {
    case 'missing_in_chain':
      return 'failure.missing_in_chain'
    case 'hash_mismatch':
      return 'failure.hash_mismatch'
    case 'copy_failed':
      return 'failure.copy_failed'
    case 'delete_failed':
      return 'failure.delete_failed'
    case 'missing_backup_dir':
      return 'failure.missing_backup_dir'
    case 'unbacked':
      return 'failure.unbacked'
  }
}
