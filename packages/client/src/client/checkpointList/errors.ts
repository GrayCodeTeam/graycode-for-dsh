/**
 * Checkpoint list — stable error-code mapping (P4-04).
 *
 * PLAN_V2 §5.6: the GRAY_* machine codes are the only contract between host
 * and UI; the UI never parses error text. This module maps a failure envelope
 * (or a raw code) to a locale-keyed hint the components can render directly.
 * Unmapped codes fall back to a generic hint so the surface degrades
 * gracefully when the host adds new codes.
 */
import type { GrayCodeCheckpointListLocaleKey } from './locales.ts'
import type { CheckpointRemoteFailureWire } from './types.ts'

/** Stable Remote error codes (mirror of packages/plugin/src/remote/types.ts). */
export const CHECKPOINT_LIST_ERROR_CODES = {
  INVALID_INPUT: 'GRAY_INVALID_INPUT',
  CONFLICT: 'GRAY_CONFLICT',
  APPROVAL_REQUIRED: 'GRAY_APPROVAL_REQUIRED',
  CANCELLED: 'GRAY_CANCELLED',
  STORAGE_CORRUPT: 'GRAY_STORAGE_CORRUPT',
  NOT_FOUND: 'GRAY_NOT_FOUND',
  ENDPOINT_NOT_FOUND: 'GRAY_ENDPOINT_NOT_FOUND',
  INTERNAL: 'GRAY_INTERNAL',
} as const

/** Error kinds the list surface distinguishes (drives hint copy + retry). */
export type CheckpointListErrorKind =
  | 'invalidInput'
  | 'conflict'
  | 'approvalRequired'
  | 'cancelled'
  | 'storageCorrupt'
  | 'notFound'
  | 'endpointNotFound'
  | 'internal'
  | 'unknown'

/** Locale-keyed hint a component can render (never raw host text). */
export interface CheckpointListHint {
  readonly kind: CheckpointListErrorKind
  /** Locale key in the `graycode.checkpointList` namespace. */
  readonly messageKey: GrayCodeCheckpointListLocaleKey
  /** Whether re-querying can plausibly recover (drives the retry affordance). */
  readonly retryable: boolean
}

const UNKNOWN_HINT: CheckpointListHint = {
  kind: 'unknown',
  messageKey: 'error.unknown',
  retryable: false,
}

const CODE_TO_HINT: Readonly<Record<string, CheckpointListHint>> = {
  [CHECKPOINT_LIST_ERROR_CODES.INVALID_INPUT]: {
    kind: 'invalidInput',
    messageKey: 'error.invalidInput',
    retryable: false,
  },
  [CHECKPOINT_LIST_ERROR_CODES.CONFLICT]: {
    kind: 'conflict',
    messageKey: 'error.conflict',
    retryable: true,
  },
  [CHECKPOINT_LIST_ERROR_CODES.APPROVAL_REQUIRED]: {
    kind: 'approvalRequired',
    messageKey: 'error.approvalRequired',
    retryable: false,
  },
  [CHECKPOINT_LIST_ERROR_CODES.CANCELLED]: {
    kind: 'cancelled',
    messageKey: 'error.cancelled',
    retryable: true,
  },
  [CHECKPOINT_LIST_ERROR_CODES.STORAGE_CORRUPT]: {
    kind: 'storageCorrupt',
    messageKey: 'error.storageCorrupt',
    retryable: false,
  },
  [CHECKPOINT_LIST_ERROR_CODES.NOT_FOUND]: {
    kind: 'notFound',
    messageKey: 'error.notFound',
    retryable: false,
  },
  [CHECKPOINT_LIST_ERROR_CODES.ENDPOINT_NOT_FOUND]: {
    kind: 'endpointNotFound',
    messageKey: 'error.endpointNotFound',
    retryable: false,
  },
  [CHECKPOINT_LIST_ERROR_CODES.INTERNAL]: {
    kind: 'internal',
    messageKey: 'error.internal',
    retryable: false,
  },
}

/**
 * Map a raw error code to a renderable hint.
 * @param code - stable GRAY_* machine code (unknown codes → generic hint).
 */
export function mapCheckpointListErrorCode(code: string | null | undefined): CheckpointListHint {
  if (typeof code !== 'string' || code.length === 0) return UNKNOWN_HINT
  return CODE_TO_HINT[code] ?? UNKNOWN_HINT
}

/**
 * Map a host failure envelope to a renderable hint.
 * @param failure - the `error` half of a GrayRemoteResult envelope.
 */
export function checkpointListFailureHint(failure: CheckpointRemoteFailureWire | null | undefined): CheckpointListHint {
  return failure === null || failure === undefined ? UNKNOWN_HINT : mapCheckpointListErrorCode(failure.code)
}

/**
 * Abort/cancellation detection (mirrors the host's `isCancellationError`).
 * @param err - thrown value (the port may throw on transport failure).
 * @param signal - optional external cancellation signal.
 */
export function isCheckpointListCancellation(err: unknown, signal?: AbortSignal): boolean {
  if (signal !== undefined && signal.aborted) return true
  if (err instanceof Error && err.name === 'AbortError') return true
  return false
}
