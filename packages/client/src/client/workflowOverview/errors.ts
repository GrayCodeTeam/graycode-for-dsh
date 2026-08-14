/**
 * Workflow overview (P4-02) — error code → user hint mapping (pure).
 *
 * PLAN_V2 §5.6 / DSH_MIGRATION_PLAN.md §5.6: remote errors carry stable
 * machine codes (`GRAY_*`, see `GRAY_REMOTE_ERROR_CODES` in
 * packages/plugin/src/remote/types.ts); the UI never parses English error
 * text. This module is the single mapping point from a code to a locale key
 * of the `graycode.workflowOverview` namespace plus a retryable flag (drives
 * whether the error state offers a retry button).
 */

/** Locale keys of the error hints (subset of the `graycode.workflowOverview` dictionary). */
export type WorkflowOverviewErrorKey =
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
export interface WorkflowErrorHint {
  /** Locale key to translate in the `graycode.workflowOverview` namespace. */
  readonly key: WorkflowOverviewErrorKey
  /** Whether retrying the same request can plausibly succeed. */
  readonly retryable: boolean
}

/** Stable code → hint table (unknown codes fall back to {@link UNKNOWN_HINT}). */
const ERROR_HINTS: Readonly<Record<string, WorkflowErrorHint>> = {
  GRAY_INVALID_INPUT: { key: 'error.invalidInput', retryable: false },
  GRAY_CONFLICT: { key: 'error.conflict', retryable: false },
  GRAY_APPROVAL_REQUIRED: { key: 'error.approvalRequired', retryable: false },
  GRAY_CANCELLED: { key: 'error.cancelled', retryable: false },
  GRAY_STORAGE_CORRUPT: { key: 'error.storageCorrupt', retryable: false },
  GRAY_NOT_FOUND: { key: 'error.notFound', retryable: false },
  GRAY_ENDPOINT_NOT_FOUND: { key: 'error.endpointNotFound', retryable: false },
  GRAY_INTERNAL: { key: 'error.internal', retryable: true },
}

const UNKNOWN_HINT: WorkflowErrorHint = { key: 'error.unknown', retryable: true }

/**
 * Locale key for a stable error code.
 * @param code - stable machine code (or absent/unknown for defensive callers).
 */
export function workflowOverviewErrorKey(code: string | undefined | null): WorkflowOverviewErrorKey {
  if (code === undefined || code === null) return UNKNOWN_HINT.key
  return ERROR_HINTS[code]?.key ?? UNKNOWN_HINT.key
}

/**
 * Full hint (locale key + retryable) for a stable error code.
 * @param code - stable machine code (or absent/unknown for defensive callers).
 */
export function workflowOverviewErrorHint(code: string | undefined | null): WorkflowErrorHint {
  if (code === undefined || code === null) return UNKNOWN_HINT
  return ERROR_HINTS[code] ?? UNKNOWN_HINT
}

/** Whether a stable error code is worth retrying. */
export function isWorkflowErrorRetryable(code: string | undefined | null): boolean {
  return workflowOverviewErrorHint(code).retryable
}
