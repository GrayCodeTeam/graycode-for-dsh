/**
 * Staged-diff error-code mapping (P4-06).
 *
 * The host returns failures as `GrayRemoteFailure` envelopes with stable
 * machine codes (`GRAY_*`); stagedDiff domain errors additionally carry
 * `details.causeCode` (`GRAY_STAGED_*`) and, for conflicts, an authoritative
 * `details.entry` snapshot (see `packages/plugin/src/remote/errors.ts`).
 *
 * This module maps an envelope to a display-level `StagedDiffCardError`
 * (kind + retryable + refreshRequired). The UI never parses error message
 * text (PLAN_V2 §5.6) — machine codes are the only contract.
 */
import {
  GRAY_REMOTE_ERROR_CODES,
  GRAY_STAGED_CAUSE_CODES,
  isStagedEntryLike,
  type GrayRemoteFailure,
  type StagedEntry,
} from './contract.ts'

/** Display-level error classes the card can render (each has a locale key). */
export type StagedDiffErrorKind =
  | 'revisionConflict'
  | 'rejectConflict'
  | 'applyFailed'
  | 'illegalTransition'
  | 'workspaceConflict'
  | 'conflict'
  | 'notFound'
  | 'endpointNotFound'
  | 'approvalRequired'
  | 'cancelled'
  | 'timeout'
  | 'storageCorrupt'
  | 'invalidInput'
  | 'internal'

/** Display-ready failure for one entry decision. */
export interface StagedDiffCardError {
  readonly kind: StagedDiffErrorKind
  /** Original stable code (envelope `GRAY_*` code, or the cause code). */
  readonly code: string
  /** Domain cause code when the envelope refines it (`GRAY_STAGED_*`). */
  readonly causeCode?: string
  /** Authoritative entry snapshot the host attached on conflict failures. */
  readonly entry?: StagedEntry
  /** Safe to retry as-is (e.g. disk apply failed, entry stays `accepted`). */
  readonly retryable: boolean
  /** Entry/list changed — refresh before deciding again. */
  readonly refreshRequired: boolean
}

/** Locale key of a display error (drives `error.<kind>` copy). */
export function stagedDiffErrorLocaleKey(error: StagedDiffCardError): `error.${StagedDiffErrorKind}` {
  return `error.${error.kind}`
}

function causeCodeOf(failure: GrayRemoteFailure): string | undefined {
  const value = failure.details.causeCode
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function entryOf(failure: GrayRemoteFailure): StagedEntry | undefined {
  const value = failure.details.entry
  return isStagedEntryLike(value) ? value : undefined
}

function makeError(
  kind: StagedDiffErrorKind,
  code: string,
  failure: GrayRemoteFailure,
  extra: { retryable?: boolean; refreshRequired?: boolean } = {},
): StagedDiffCardError {
  return {
    kind,
    code,
    causeCode: causeCodeOf(failure),
    entry: entryOf(failure),
    retryable: extra.retryable ?? false,
    refreshRequired: extra.refreshRequired ?? false,
  }
}

/**
 * Map a host failure envelope to a display error.
 *
 * `GRAY_CONFLICT` is refined by `details.causeCode`:
 * - `GRAY_STAGED_REVISION_CONFLICT` — the entry changed since the CAS read;
 * - `GRAY_STAGED_REJECT_CONFLICT` — the target file was modified after
 *   staging (resolve before rejecting);
 * - `GRAY_STAGED_APPLY_FAILED` — disk write failed; the entry stays
 *   `accepted` and the decision can be retried as-is;
 * - `GRAY_STAGED_WORKSPACE_CONFLICT` — the decision targets a workspace the
 *   entry does not belong to; refuse and prompt;
 * - `GRAY_STAGED_ILLEGAL_TRANSITION` — the entry moved past the decision
 *   point; refresh.
 */
export function mapStagedDiffFailure(failure: GrayRemoteFailure): StagedDiffCardError {
  const code = failure.code
  const cause = causeCodeOf(failure)

  if (code === GRAY_REMOTE_ERROR_CODES.CONFLICT) {
    if (cause === GRAY_STAGED_CAUSE_CODES.REVISION_CONFLICT) {
      return makeError('revisionConflict', code, failure, { refreshRequired: true })
    }
    if (cause === GRAY_STAGED_CAUSE_CODES.REJECT_CONFLICT) {
      return makeError('rejectConflict', code, failure, { refreshRequired: true })
    }
    if (cause === GRAY_STAGED_CAUSE_CODES.APPLY_FAILED) {
      return makeError('applyFailed', code, failure, { retryable: true })
    }
    if (cause === GRAY_STAGED_CAUSE_CODES.WORKSPACE_CONFLICT) {
      return makeError('workspaceConflict', code, failure)
    }
    if (cause === GRAY_STAGED_CAUSE_CODES.ILLEGAL_TRANSITION) {
      return makeError('illegalTransition', code, failure, { refreshRequired: true })
    }
    return makeError('conflict', code, failure, { refreshRequired: true })
  }
  if (code === GRAY_REMOTE_ERROR_CODES.NOT_FOUND) {
    return makeError('notFound', code, failure, { refreshRequired: true })
  }
  if (code === GRAY_REMOTE_ERROR_CODES.ENDPOINT_NOT_FOUND) {
    return makeError('endpointNotFound', code, failure)
  }
  if (code === GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED) {
    return makeError('approvalRequired', code, failure)
  }
  if (code === GRAY_REMOTE_ERROR_CODES.CANCELLED) {
    return makeError('cancelled', code, failure)
  }
  if (code === GRAY_REMOTE_ERROR_CODES.STORAGE_CORRUPT) {
    return makeError('storageCorrupt', code, failure)
  }
  if (code === GRAY_REMOTE_ERROR_CODES.INVALID_INPUT) {
    return makeError('invalidInput', code, failure)
  }
  return makeError('internal', code, failure)
}
