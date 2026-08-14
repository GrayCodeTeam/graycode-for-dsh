/**
 * Activity heatmap (C6) — error code → user hint mapping (pure).
 *
 * PLAN_V2 §5.6: remote errors carry stable machine codes (`GRAY_*`); the UI
 * never parses English error text. This module maps a code to a locale key of
 * the `graycode.activityHeatmap` namespace plus a retryable flag (drives the
 * error state's retry button).
 */

/** Locale keys of the error hints (subset of the `graycode.activityHeatmap` dictionary). */
export type ActivityStatsErrorKey =
  | 'error.invalidInput'
  | 'error.conflict'
  | 'error.approvalRequired'
  | 'error.cancelled'
  | 'error.storageCorrupt'
  | 'error.notFound'
  | 'error.endpointNotFound'
  | 'error.internal'
  | 'error.unknown'

/** A user-facing hint for one stable error code. */
export interface ActivityErrorHint {
  /** Locale key to translate in the `graycode.activityHeatmap` namespace. */
  readonly key: ActivityStatsErrorKey
  /** Whether retrying the same request can plausibly succeed. */
  readonly retryable: boolean
}

/** Stable code → hint table (unknown codes fall back to {@link UNKNOWN_HINT}). */
const ERROR_HINTS: Readonly<Record<string, ActivityErrorHint>> = {
  GRAY_INVALID_INPUT: { key: 'error.invalidInput', retryable: false },
  GRAY_CONFLICT: { key: 'error.conflict', retryable: false },
  GRAY_APPROVAL_REQUIRED: { key: 'error.approvalRequired', retryable: false },
  GRAY_CANCELLED: { key: 'error.cancelled', retryable: false },
  GRAY_STORAGE_CORRUPT: { key: 'error.storageCorrupt', retryable: false },
  GRAY_NOT_FOUND: { key: 'error.notFound', retryable: false },
  GRAY_ENDPOINT_NOT_FOUND: { key: 'error.endpointNotFound', retryable: false },
  GRAY_INTERNAL: { key: 'error.internal', retryable: true },
}

const UNKNOWN_HINT: ActivityErrorHint = { key: 'error.unknown', retryable: true }

/** Locale key for a stable error code. */
export function activityStatsErrorKey(code: string | undefined | null): ActivityStatsErrorKey {
  if (code === undefined || code === null) return UNKNOWN_HINT.key
  return ERROR_HINTS[code]?.key ?? UNKNOWN_HINT.key
}

/** Full hint (locale key + retryable) for a stable error code. */
export function activityStatsErrorHint(code: string | undefined | null): ActivityErrorHint {
  if (code === undefined || code === null) return UNKNOWN_HINT
  return ERROR_HINTS[code] ?? UNKNOWN_HINT
}

/** Whether a stable error code is worth retrying. */
export function isActivityErrorRetryable(code: string | undefined | null): boolean {
  return activityStatsErrorHint(code).retryable
}
