/**
 * Restore error mapping — stable code → user-facing hint (P4-05).
 *
 * UI never parses English error text (PLAN_V2 §5.6): every failure the
 * restore surface can hit maps through this single table to a locale key +
 * retry semantics. The mapping covers host codes (GRAY_*) and the client-local
 * codes (see types.ts) used for defensive paths the envelope cannot carry.
 */
import type { GrayCodeRestorePreviewLocaleKey } from './locales.ts'
import {
  GRAY_RESTORE_REMOTE_CODES,
  RESTORE_CLIENT_ERROR_CODES,
  type RestoreRemoteFailure,
} from './types.ts'

/** Visual severity of a restore error hint. */
export type RestoreErrorSeverity = 'info' | 'warning' | 'error'

/** Structured hint for one restore failure. */
export interface RestoreErrorHint {
  readonly code: string
  readonly severity: RestoreErrorSeverity
  /** Whether retrying restore with the SAME session/token is allowed. */
  readonly retryable: boolean
  /** Whether a fresh preview (new token) is required before retrying. */
  readonly rePreviewRequired: boolean
  /** Locale key of the user-facing message. */
  readonly key: GrayCodeRestorePreviewLocaleKey
}

/** Codes that mean "the preview (token) is no longer valid". */
export const RESTORE_STALE_CODES: readonly string[] = [
  GRAY_RESTORE_REMOTE_CODES.APPROVAL_REQUIRED,
  GRAY_RESTORE_REMOTE_CODES.CONFLICT,
]

/** Whether a code means the preview/token went stale and must be re-run. */
export function isPreviewStaleError(code: string): boolean {
  return RESTORE_STALE_CODES.includes(code)
}

const HINT_TABLE: Readonly<Record<string, RestoreErrorHint>> = {
  [GRAY_RESTORE_REMOTE_CODES.APPROVAL_REQUIRED]: {
    code: GRAY_RESTORE_REMOTE_CODES.APPROVAL_REQUIRED,
    severity: 'warning',
    retryable: false,
    rePreviewRequired: true,
    key: 'error.approvalRequired',
  },
  [GRAY_RESTORE_REMOTE_CODES.CONFLICT]: {
    code: GRAY_RESTORE_REMOTE_CODES.CONFLICT,
    severity: 'warning',
    retryable: false,
    rePreviewRequired: true,
    key: 'error.conflict',
  },
  [GRAY_RESTORE_REMOTE_CODES.CANCELLED]: {
    code: GRAY_RESTORE_REMOTE_CODES.CANCELLED,
    severity: 'info',
    retryable: true,
    rePreviewRequired: false,
    key: 'error.cancelled',
  },
  [GRAY_RESTORE_REMOTE_CODES.NOT_FOUND]: {
    code: GRAY_RESTORE_REMOTE_CODES.NOT_FOUND,
    severity: 'error',
    retryable: false,
    rePreviewRequired: true,
    key: 'error.notFound',
  },
  [GRAY_RESTORE_REMOTE_CODES.STORAGE_CORRUPT]: {
    code: GRAY_RESTORE_REMOTE_CODES.STORAGE_CORRUPT,
    severity: 'error',
    retryable: false,
    rePreviewRequired: true,
    key: 'error.storageCorrupt',
  },
  [GRAY_RESTORE_REMOTE_CODES.INVALID_INPUT]: {
    code: GRAY_RESTORE_REMOTE_CODES.INVALID_INPUT,
    severity: 'error',
    retryable: false,
    rePreviewRequired: false,
    key: 'error.invalidInput',
  },
  [GRAY_RESTORE_REMOTE_CODES.ENDPOINT_NOT_FOUND]: {
    code: GRAY_RESTORE_REMOTE_CODES.ENDPOINT_NOT_FOUND,
    severity: 'error',
    retryable: false,
    rePreviewRequired: false,
    key: 'error.endpointNotFound',
  },
  [GRAY_RESTORE_REMOTE_CODES.INTERNAL]: {
    code: GRAY_RESTORE_REMOTE_CODES.INTERNAL,
    severity: 'error',
    // The host adapter maps partial-restore failures to INTERNAL; the token
    // is NOT consumed on failure, so retrying with the same session is safe.
    retryable: true,
    rePreviewRequired: false,
    key: 'error.internal',
  },
  [RESTORE_CLIENT_ERROR_CODES.PREVIEW_FAILED]: {
    code: RESTORE_CLIENT_ERROR_CODES.PREVIEW_FAILED,
    severity: 'error',
    retryable: false,
    rePreviewRequired: true,
    key: 'error.previewFailed',
  },
  [RESTORE_CLIENT_ERROR_CODES.RESTORE_PARTIAL]: {
    code: RESTORE_CLIENT_ERROR_CODES.RESTORE_PARTIAL,
    severity: 'warning',
    retryable: true,
    rePreviewRequired: false,
    key: 'error.partial',
  },
  [RESTORE_CLIENT_ERROR_CODES.MALFORMED_RESPONSE]: {
    code: RESTORE_CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
    severity: 'error',
    retryable: false,
    rePreviewRequired: false,
    key: 'error.malformed',
  },
  [RESTORE_CLIENT_ERROR_CODES.TIMEOUT]: {
    code: RESTORE_CLIENT_ERROR_CODES.TIMEOUT,
    severity: 'error',
    // The host may still be mid-flight (or the operation may have finished) —
    // a blind retry could double-apply a destructive restore, so require a
    // fresh preview before attempting again.
    retryable: false,
    rePreviewRequired: true,
    key: 'error.timeout',
  },
}

const FALLBACK_HINT: RestoreErrorHint = {
  code: 'unknown',
  severity: 'error',
  retryable: false,
  rePreviewRequired: false,
  key: 'error.unknown',
}

/**
 * Map any restore failure (or raw code) to a structured hint.
 * Unknown codes fall back to `error.unknown` (never a raw English message).
 */
export function restoreErrorHint(
  error: RestoreRemoteFailure | { readonly code: string } | null | undefined,
): RestoreErrorHint {
  const code = error?.code ?? ''
  const hint = HINT_TABLE[code]
  if (hint === undefined) return { ...FALLBACK_HINT, code }
  return hint
}
