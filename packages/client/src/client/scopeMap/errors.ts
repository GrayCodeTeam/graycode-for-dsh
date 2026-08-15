/**
 * Migration workspace memory mapping (D-1/D-2) — error code → user hint
 * mapping (pure).
 *
 * PLAN_V2 §5.6: remote errors carry stable machine codes (`GRAY_*`); the UI
 * never parses English error text. This module maps a code to a locale key of
 * the `graycode.scopeMap` namespace plus a retryable flag (drives the error
 * state's retry button).
 */

/** Locale keys of the error hints (subset of the `graycode.scopeMap` dictionary). */
export type ScopeMapErrorKey =
  | 'error.invalidInput'
  | 'error.conflict'
  | 'error.approvalRequired'
  | 'error.cancelled'
  | 'error.storageCorrupt'
  | 'error.notFound'
  | 'error.endpointNotFound'
  | 'error.internal'
  | 'error.unknown'
  | 'error.sourceDirMissing'

/** A user-facing hint for one stable error code. */
export interface ScopeMapErrorHint {
  /** Locale key to translate in the `graycode.scopeMap` namespace. */
  readonly key: ScopeMapErrorKey
  /** Whether retrying the same request can plausibly succeed. */
  readonly retryable: boolean
}

/** Stable code → hint table (unknown codes fall back to {@link SCOPE_MAP_UNKNOWN_HINT}). */
const SCOPE_MAP_ERROR_HINTS: Readonly<Record<string, ScopeMapErrorHint>> = {
  GRAY_INVALID_INPUT: { key: 'error.invalidInput', retryable: false },
  GRAY_CONFLICT: { key: 'error.conflict', retryable: false },
  GRAY_APPROVAL_REQUIRED: { key: 'error.approvalRequired', retryable: false },
  GRAY_CANCELLED: { key: 'error.cancelled', retryable: false },
  GRAY_STORAGE_CORRUPT: { key: 'error.storageCorrupt', retryable: false },
  GRAY_NOT_FOUND: { key: 'error.notFound', retryable: false },
  GRAY_ENDPOINT_NOT_FOUND: { key: 'error.endpointNotFound', retryable: false },
  GRAY_INTERNAL: { key: 'error.internal', retryable: true },
  // 4.7-L5：client 侧缺省 sourceDir（remote 未配置）→ 明确「未配置源目录」提示，
  // 而非误导性的「内部错误」；输入无效不可重试。
  GRAY_SOURCE_DIR_MISSING: { key: 'error.sourceDirMissing', retryable: false },
}

const SCOPE_MAP_UNKNOWN_HINT: ScopeMapErrorHint = { key: 'error.unknown', retryable: true }

/** Locale key for a stable error code. */
export function scopeMapErrorKey(code: string | undefined | null): ScopeMapErrorKey {
  if (code === undefined || code === null) return SCOPE_MAP_UNKNOWN_HINT.key
  return SCOPE_MAP_ERROR_HINTS[code]?.key ?? SCOPE_MAP_UNKNOWN_HINT.key
}

/** Full hint (locale key + retryable) for a stable error code. */
export function scopeMapErrorHint(code: string | undefined | null): ScopeMapErrorHint {
  if (code === undefined || code === null) return SCOPE_MAP_UNKNOWN_HINT
  return SCOPE_MAP_ERROR_HINTS[code] ?? SCOPE_MAP_UNKNOWN_HINT
}

/** Whether a stable error code is worth retrying. */
export function isScopeMapErrorRetryable(code: string | undefined | null): boolean {
  return scopeMapErrorHint(code).retryable
}
