/**
 * Restore confirmation state machine (P4-05).
 *
 * Pure reducer over {@link RestoreStep}: `idle → preview → confirm → running
 * → done | failed`, with guarded transitions and a retry/re-preview surface
 * on `failed`. The machine is the single place that enforces the CLIENT
 * BOUNDARY RULES for destructive restore:
 *
 * - EXPLICIT DOUBLE CONFIRMATION: `CONFIRM` (armed) is only accepted from
 *   `preview` when the preview succeeded, carries a token and has no blocking
 *   conflicts; `RESTORE_STARTED` is only accepted from `confirm` (or from
 *   `failed` as an explicit retry of the SAME session).
 * - PREVIEW/RESTORE BINDING: restore actions must echo the session's
 *   `previewId` (= the approval token). A mismatched id is a no-op.
 * - UNTRACKED DELETION ACK: when `deleteUntrackedFiles` is on and the preview
 *   lists untracked paths, `CONFIRM` additionally requires
 *   `acknowledgeUntracked: true` and the session records it.
 * - NO CACHE-AS-SUCCESS: progress only ever merges host-reported counters;
 *   a `RESTORE_OK` with `success:false` lands on `failed` and keeps the
 *   result so per-item failures stay visible.
 *
 * Every rejected transition returns the SAME state object (immutable no-op);
 * the exported `can*`/`confirmRequires*` helpers let the UI consult the
 * guards without dispatching.
 */
import type {
  RestorePendingPreview,
  RestorePreviewOutcomeWire,
  RestorePreviewWire,
  RestoreProgress,
  RestoreRemoteFailure,
  RestoreResultWire,
  RestoreSession,
  RestoreStep,
} from './types.ts'
import {
  GRAY_RESTORE_REMOTE_CODES,
  RESTORE_CLIENT_ERROR_CODES,
} from './types.ts'
import { restoreErrorHint } from './errors.ts'
import {
  classifyPreviewFiles,
  previewDeletionRequiresAck,
  previewHasBlockingConflicts,
} from './model.ts'
import {
  createRestoreProgress,
  mergeRestoreProgress,
  mergeRestoreResult,
} from './progress.ts'

/** One action the restore state machine accepts. */
export type RestoreAction =
  | { readonly type: 'PREVIEW_STARTED'; readonly checkpointId: string; readonly workspace?: string; readonly deleteUntrackedFiles: boolean; readonly at: number }
  | { readonly type: 'PREVIEW_OK'; readonly outcome: RestorePreviewOutcomeWire; readonly at: number }
  | { readonly type: 'PREVIEW_FAILED'; readonly error: RestoreRemoteFailure; readonly at: number }
  | { readonly type: 'CONFIRM'; readonly acknowledgeUntracked: boolean; readonly at: number }
  | { readonly type: 'CONFIRM_WITH_TOKEN'; readonly token: string; readonly checkpointId: string; readonly workspace?: string; readonly deleteUntrackedFiles: boolean; readonly at: number }
  | { readonly type: 'RESTORE_STARTED'; readonly previewId: string; readonly at: number }
  | { readonly type: 'PROGRESS'; readonly progress: RestoreProgress; readonly at: number }
  | { readonly type: 'RESTORE_OK'; readonly result: RestoreResultWire; readonly at: number }
  | { readonly type: 'RESTORE_FAILED'; readonly error: RestoreRemoteFailure; readonly at: number }
  | { readonly type: 'RE_PREVIEW'; readonly at: number }
  | { readonly type: 'RESET'; readonly at: number }

/** Initial machine state. */
export function createRestoreMachine(): RestoreStep {
  return {
    phase: 'idle',
    pending: null,
    session: null,
    preview: null,
    progress: null,
    result: null,
    error: null,
    previewAt: null,
    updatedAt: 0,
    retryable: false,
    rePreviewRequired: false,
  }
}

/** Whether a fresh preview may start from this state. */
export function canPreview(state: RestoreStep): boolean {
  return state.phase === 'idle' || state.phase === 'failed' || state.phase === 'done'
}

/**
 * Whether the loaded preview may be confirmed (armed).
 * Requires: preview phase, loaded session with a token, successful preview,
 * no blocking conflicts.
 */
export function canConfirm(state: RestoreStep): boolean {
  if (state.phase !== 'preview') return false
  if (state.session === null || state.preview === null) return false
  if (state.session.previewId.length === 0) return false
  if (!state.preview.success) return false
  if (previewHasBlockingConflicts(state.preview)) return false
  return true
}

/**
 * Whether a restore may run with the given previewId (the binding guard).
 * Accepted from `confirm`, or from `failed` as a retry of the same session
 * when the step is retryable.
 */
export function canRestoreWith(state: RestoreStep, previewId: string): boolean {
  if (state.session === null || previewId !== state.session.previewId) return false
  if (state.phase !== 'confirm' && !(state.phase === 'failed' && state.retryable)) return false
  if (state.session.deleteUntrackedFiles && !state.session.acknowledgedUntracked) return false
  return true
}

/** Whether confirming the loaded preview requires the untracked-deletion ack. */
export function confirmRequiresUntrackedAck(state: RestoreStep): boolean {
  if (state.session === null || state.preview === null) return false
  return previewDeletionRequiresAck(state.preview, { deleteUntrackedFiles: state.session.deleteUntrackedFiles })
}

/** Apply one action to the machine state (immutable; rejected transitions are no-ops). */
export function restoreMachineStep(state: RestoreStep, action: RestoreAction): RestoreStep {
  switch (action.type) {
    case 'PREVIEW_STARTED': {
      if (!canPreview(state)) return state
      const pending: RestorePendingPreview = {
        checkpointId: action.checkpointId,
        workspace: action.workspace,
        deleteUntrackedFiles: action.deleteUntrackedFiles,
      }
      return {
        ...state,
        phase: 'preview',
        pending,
        session: null,
        preview: null,
        progress: null,
        result: null,
        error: null,
        previewAt: null,
        retryable: false,
        rePreviewRequired: false,
        updatedAt: action.at,
      }
    }

    case 'PREVIEW_OK': {
      if (state.phase !== 'preview' || state.pending === null) return state
      const preview = action.outcome.preview
      if (!preview.success) {
        return previewFailed(state, {
          code: RESTORE_CLIENT_ERROR_CODES.PREVIEW_FAILED,
          message: preview.error ?? 'preview failed',
          details: {},
        }, preview, action.at)
      }
      if (action.outcome.previewToken === undefined || action.outcome.previewToken.length === 0) {
        // A successful preview without a token cannot be confirmed — treat as
        // approval missing (the host contract guarantees a token, defensively).
        return previewFailed(state, {
          code: GRAY_RESTORE_REMOTE_CODES.APPROVAL_REQUIRED,
          message: 'preview succeeded but no previewToken was issued',
          details: {},
        }, preview, action.at)
      }
      const session: RestoreSession = {
        previewId: action.outcome.previewToken,
        checkpointId: state.pending.checkpointId,
        workspace: state.pending.workspace,
        deleteUntrackedFiles: state.pending.deleteUntrackedFiles,
        acknowledgedUntracked: false,
        baselineDigest: action.outcome.baselineDigest,
      }
      return {
        ...state,
        phase: 'preview',
        session,
        preview,
        error: null,
        retryable: false,
        rePreviewRequired: false,
        previewAt: action.at,
        updatedAt: action.at,
      }
    }

    case 'PREVIEW_FAILED': {
      if (state.phase !== 'preview') return state
      return previewFailed(state, action.error, null, action.at)
    }

    case 'CONFIRM': {
      if (!canConfirm(state)) return state
      if (state.session === null || state.preview === null) return state
      const needsAck = previewDeletionRequiresAck(state.preview, {
        deleteUntrackedFiles: state.session.deleteUntrackedFiles,
      })
      if (needsAck && !action.acknowledgeUntracked) return state
      return {
        ...state,
        phase: 'confirm',
        session: { ...state.session, acknowledgedUntracked: state.session.acknowledgedUntracked || needsAck },
        updatedAt: action.at,
      }
    }

    case 'CONFIRM_WITH_TOKEN': {
      // Paste-token mode: the user brings a token from another surface (e.g. a
      // checkpoint_preview run in chat). The host validates it at restore time
      // (missing/expired → GRAY_APPROVAL_REQUIRED); binding is enforced by
      // session.previewId === token.
      if (state.phase !== 'idle' && state.phase !== 'failed' && state.phase !== 'preview') return state
      const token = action.token.trim()
      if (token.length === 0) return state
      const session: RestoreSession = {
        previewId: token,
        checkpointId: action.checkpointId,
        workspace: action.workspace,
        deleteUntrackedFiles: action.deleteUntrackedFiles,
        acknowledgedUntracked: false,
      }
      return {
        ...state,
        phase: 'confirm',
        pending: null,
        session,
        preview: null,
        progress: null,
        result: null,
        error: null,
        previewAt: null,
        retryable: false,
        rePreviewRequired: false,
        updatedAt: action.at,
      }
    }

    case 'RESTORE_STARTED': {
      if (!canRestoreWith(state, action.previewId)) return state
      if (state.session === null) return state
      const classification = state.preview === null
        ? null
        : classifyPreviewFiles(state.preview, { deleteUntrackedFiles: state.session.deleteUntrackedFiles })
      return {
        ...state,
        phase: 'running',
        progress: createRestoreProgress({ total: classification?.operationCount ?? 0, at: action.at }),
        result: null,
        error: null,
        retryable: false,
        rePreviewRequired: false,
        updatedAt: action.at,
      }
    }

    case 'PROGRESS': {
      if (state.phase !== 'running' || state.progress === null) return state
      return {
        ...state,
        progress: mergeRestoreProgress(state.progress, action.progress),
        updatedAt: action.at,
      }
    }

    case 'RESTORE_OK': {
      if (state.phase !== 'running' || state.progress === null) return state
      if (action.result.success) {
        return {
          ...state,
          phase: 'done',
          result: action.result,
          progress: mergeRestoreResult(state.progress, action.result),
          error: null,
          retryable: false,
          rePreviewRequired: false,
          updatedAt: action.at,
        }
      }
      // Partial failure: keep the result (per-item failures must stay visible)
      // and allow retry — the host consumes the token only on success.
      return {
        ...state,
        phase: 'failed',
        result: action.result,
        progress: mergeRestoreResult(state.progress, action.result),
        error: {
          code: RESTORE_CLIENT_ERROR_CODES.RESTORE_PARTIAL,
          message: action.result.error ?? 'restore completed with per-file failures',
          details: {},
        },
        retryable: true,
        rePreviewRequired: false,
        updatedAt: action.at,
      }
    }

    case 'RESTORE_FAILED': {
      if (state.phase !== 'running') return state
      const hint = restoreErrorHint(action.error)
      return {
        ...state,
        phase: 'failed',
        error: action.error,
        retryable: hint.retryable,
        rePreviewRequired: hint.rePreviewRequired,
        updatedAt: action.at,
      }
    }

    case 'RE_PREVIEW': {
      if (state.phase !== 'preview' && state.phase !== 'confirm' && state.phase !== 'failed') return state
      return { ...createRestoreMachine(), updatedAt: action.at }
    }

    case 'RESET': {
      return { ...createRestoreMachine(), updatedAt: action.at }
    }
  }
}

/** Shared transition for previews that ended without a usable token. */
function previewFailed(
  state: RestoreStep,
  error: RestoreRemoteFailure,
  preview: RestorePreviewWire | null,
  at: number,
): RestoreStep {
  return {
    ...state,
    phase: 'failed',
    session: null,
    preview: preview ?? state.preview,
    error,
    retryable: false,
    rePreviewRequired: true,
    updatedAt: at,
  }
}
