/**
 * P4-05 restore preview — pure-logic tests.
 *
 * Covers: defensive wire readers, file classification + conflict judgement,
 * the confirmation state machine (idle → preview → confirm → running →
 * done/failed, with binding/ack guards and retry/re-preview), progress
 * merging, error-code → hint mapping, the gateway (remote + mock binding
 * semantics) and locale key alignment.
 *
 * React is intentionally not imported: these are node-environment tests of
 * the replay-safe pure logic (components are not rendered here).
 */
import { describe, expect, it } from 'vitest'
import {
  GRAY_RESTORE_REMOTE_CODES,
  RESTORE_CLIENT_ERROR_CODES,
  readPreviewOutcome,
  readPreviewWire,
  readRestoreFailure,
  readRestoreFailures,
  readRestoreRemoteFailure,
  readRestoreResult,
  type RestorePreviewOutcomeWire,
  type RestorePreviewWire,
  type RestoreRemoteEnvelope,
  type RestoreResultWire,
} from '../src/client/restorePreview/types.ts'
import {
  classifyPreviewFiles,
  previewConflicts,
  previewDeletionRequiresAck,
  previewHasBlockingConflicts,
  summarizePreview,
} from '../src/client/restorePreview/model.ts'
import {
  canConfirm,
  canPreview,
  canRestoreWith,
  confirmRequiresUntrackedAck,
  createRestoreMachine,
  restoreMachineStep,
} from '../src/client/restorePreview/stateMachine.ts'
import {
  createRestoreProgress,
  groupFailuresByReason,
  mergeFailureItem,
  mergeRestoreProgress,
  mergeRestoreResult,
  progressPercent,
} from '../src/client/restorePreview/progress.ts'
import {
  RESTORE_STALE_CODES,
  isPreviewStaleError,
  restoreErrorHint,
} from '../src/client/restorePreview/errors.ts'
import {
  createMockRestoreGateway,
  createRestoreGateway,
  type RestoreRemoteInvoke,
} from '../src/client/restorePreview/gateway.ts'
import {
  GRAYCODE_RESTORE_PREVIEW_NS,
  graycodeRestorePreviewDictionaries,
  graycodeRestorePreviewJaPlaceholder,
} from '../src/client/restorePreview/locales.ts'
import { restoreFailureLocaleKey } from '../src/client/restorePreview/labels.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function previewWire(overrides: Partial<RestorePreviewWire> = {}): RestorePreviewWire {
  return {
    success: true,
    restored: 2,
    deleted: 1,
    deletedIfUnconfirmed: 0,
    skipped: 5,
    deletablePaths: ['src/a.ts', 'src/b.ts'],
    untrackedPaths: ['notes/tmp.md'],
    unbackedPaths: ['data/huge.bin'],
    failures: [],
    missingBackupDirs: [],
    ...overrides,
  }
}

function outcome(overrides: Partial<RestorePreviewOutcomeWire> = {}): RestorePreviewOutcomeWire {
  return {
    preview: previewWire(),
    previewToken: 'tok-1',
    baselineDigest: 'digest-1',
    ...overrides,
  }
}

function resultWire(overrides: Partial<RestoreResultWire> = {}): RestoreResultWire {
  return {
    success: true,
    restored: 2,
    deleted: 1,
    skipped: 5,
    failures: [],
    unbackedPaths: [],
    ...overrides,
  }
}

function failure(code: string, message = 'boom'): { code: string; message: string; details: Record<string, unknown> } {
  return { code, message, details: {} }
}

// ---------------------------------------------------------------------------
// Defensive wire readers
// ---------------------------------------------------------------------------

describe('defensive wire readers', () => {
  it('readPreviewWire accepts a valid preview and sanitises counts', () => {
    const preview = readPreviewWire({ ...previewWire(), restored: -3, skipped: 'x' })
    expect(preview).not.toBeNull()
    expect(preview!.restored).toBe(0)
    expect(preview!.skipped).toBe(0)
    expect(preview!.deletablePaths).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('readPreviewWire rejects payloads without success', () => {
    expect(readPreviewWire({ restored: 1 })).toBeNull()
    expect(readPreviewWire(null)).toBeNull()
    expect(readPreviewWire('nope')).toBeNull()
  })

  it('readPreviewOutcome requires a readable preview and drops empty tokens', () => {
    const valid = readPreviewOutcome(outcome())
    expect(valid).not.toBeNull()
    expect(valid!.previewToken).toBe('tok-1')
    expect(readPreviewOutcome(outcome({ previewToken: '' }))!.previewToken).toBeUndefined()
    expect(readPreviewOutcome({ preview: 'bad' })).toBeNull()
  })

  it('readRestoreResult rejects payloads without success and keeps failures', () => {
    const ok = readRestoreResult(resultWire())
    expect(ok!.success).toBe(true)
    expect(readRestoreResult({ restored: 1 })).toBeNull()
    const partial = readRestoreResult({
      ...resultWire({ success: false }),
      // 'nonsense' is intentionally invalid: the reader must filter it.
      failures: [{ path: 'a.txt', reason: 'copy_failed' }, { path: 'b.txt', reason: 'nonsense' }] as unknown,
    })
    expect(partial!.failures).toHaveLength(1)
  })

  it('readRestoreFailure / readRestoreFailures filter invalid entries', () => {
    expect(readRestoreFailure({ path: 'a.txt', reason: 'copy_failed' })).not.toBeNull()
    expect(readRestoreFailure({ path: '', reason: 'copy_failed' })).toBeNull()
    expect(readRestoreFailure({ path: 'a.txt', reason: 'mystery' })).toBeNull()
    expect(readRestoreFailures([{ path: 'a', reason: 'delete_failed' }, 'junk', null])).toHaveLength(1)
  })

  it('readRestoreRemoteFailure requires a non-empty code', () => {
    expect(readRestoreRemoteFailure(failure('GRAY_X'))!.code).toBe('GRAY_X')
    expect(readRestoreRemoteFailure({ message: 'no code' })).toBeNull()
    expect(readRestoreRemoteFailure({ code: '' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('preview classification', () => {
  it('groups files in canonical order with counts', () => {
    const classification = classifyPreviewFiles(previewWire(), { deleteUntrackedFiles: false })
    // Zero-count buckets are dropped; delete=0 (flag off) and conflict=0 are absent.
    expect(classification.groups.map(group => group.cls)).toEqual([
      'restore', 'untracked', 'unbacked',
    ])
    const byClass = Object.fromEntries(classification.groups.map(group => [group.cls, group]))
    expect(byClass.restore!.count).toBe(2)
    expect(byClass.restore!.items).toEqual([]) // wire carries count only
    expect(byClass.untracked!.count).toBe(1)
    expect(byClass.unbacked!.count).toBe(1)
    expect(byClass.unbacked!.items[0]!.reason).toBe('unbacked')
    expect(classification.totalAffected).toBe(4) // 2 + 1 + 1
    expect(classification.operationCount).toBe(2) // restored + deleted(flag off)
    expect(classification.blocking).toBe(false)
  })

  it('delete count follows the deleteUntrackedFiles flag', () => {
    const off = classifyPreviewFiles(previewWire(), { deleteUntrackedFiles: false })
    const on = classifyPreviewFiles(previewWire(), { deleteUntrackedFiles: true })
    expect(off.groups.find(group => group.cls === 'delete')).toBeUndefined() // 0 deletions unconfirmed
    expect(on.groups.find(group => group.cls === 'delete')!.count).toBe(1)
    expect(on.groups.find(group => group.cls === 'delete')!.items.map(item => item.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(on.operationCount).toBe(3)
  })

  it('surfaces preflight failures and missing backup dirs as blocking conflicts', () => {
    const conflicted = previewWire({
      failures: [{ path: 'src/a.ts', reason: 'missing_in_chain' }],
      missingBackupDirs: ['backups/cp_x'],
    })
    const classification = classifyPreviewFiles(conflicted, { deleteUntrackedFiles: false })
    expect(previewHasBlockingConflicts(conflicted)).toBe(true)
    expect(classification.blocking).toBe(true)
    expect(classification.conflicts.map(item => item.path)).toEqual(['src/a.ts', 'backups/cp_x'])
    expect(classification.conflicts[0]!.reason).toBe('missing_in_chain')
    expect(classification.conflicts[1]!.reason).toBe('missing_backup_dir')
    expect(previewConflicts(conflicted)).toHaveLength(2)
  })

  it('no blocking conflicts for clean previews', () => {
    expect(previewHasBlockingConflicts(previewWire())).toBe(false)
  })

  it('empty preview yields no groups', () => {
    const classification = classifyPreviewFiles(previewWire({ restored: 0, deletablePaths: [], untrackedPaths: [], unbackedPaths: [] }), {
      deleteUntrackedFiles: false,
    })
    expect(classification.groups).toEqual([])
    expect(classification.totalAffected).toBe(0)
    expect(classification.operationCount).toBe(0)
  })

  it('untracked deletion requires explicit ack only when enabled and untracked exist', () => {
    const withUntracked = previewWire()
    const withoutUntracked = previewWire({ untrackedPaths: [] })
    expect(previewDeletionRequiresAck(withUntracked, { deleteUntrackedFiles: true })).toBe(true)
    expect(previewDeletionRequiresAck(withUntracked, { deleteUntrackedFiles: false })).toBe(false)
    expect(previewDeletionRequiresAck(withoutUntracked, { deleteUntrackedFiles: true })).toBe(false)
  })

  it('summarizePreview reports deleted per flag and legacy', () => {
    const summary = summarizePreview(previewWire({ legacy: true }), { deleteUntrackedFiles: true })
    expect(summary.deleted).toBe(1)
    expect(summary.restored).toBe(2)
    expect(summary.skipped).toBe(5)
    expect(summary.untracked).toBe(1)
    expect(summary.unbacked).toBe(1)
    expect(summary.conflicts).toBe(0)
    expect(summary.legacy).toBe(true)
    expect(summarizePreview(previewWire(), { deleteUntrackedFiles: false }).deleted).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe('restore confirmation state machine', () => {
  it('runs the happy path idle → preview → confirm → running → done', () => {
    let step = createRestoreMachine()
    expect(step.phase).toBe('idle')
    expect(canPreview(step)).toBe(true)

    step = restoreMachineStep(step, { type: 'PREVIEW_STARTED', checkpointId: 'cp_1', deleteUntrackedFiles: false, at: 1 })
    expect(step.phase).toBe('preview')
    expect(canPreview(step)).toBe(false)
    expect(canConfirm(step)).toBe(false)

    step = restoreMachineStep(step, { type: 'PREVIEW_OK', outcome: outcome(), at: 2 })
    expect(step.phase).toBe('preview')
    expect(step.session!.previewId).toBe('tok-1')
    expect(step.session!.checkpointId).toBe('cp_1')
    expect(step.previewAt).toBe(2)
    expect(canConfirm(step)).toBe(true)

    step = restoreMachineStep(step, { type: 'CONFIRM', acknowledgeUntracked: false, at: 3 })
    expect(step.phase).toBe('confirm')
    expect(canRestoreWith(step, 'tok-1')).toBe(true)
    expect(canRestoreWith(step, 'tok-2')).toBe(false)

    step = restoreMachineStep(step, { type: 'RESTORE_STARTED', previewId: 'tok-1', at: 4 })
    expect(step.phase).toBe('running')
    expect(step.progress!.total).toBe(2) // operationCount

    step = restoreMachineStep(step, {
      type: 'PROGRESS',
      progress: mergeRestoreProgress(step.progress!, { processed: 1, restored: 1, at: 5 }),
      at: 5,
    })
    expect(step.progress!.processed).toBe(1)

    step = restoreMachineStep(step, { type: 'RESTORE_OK', result: resultWire(), at: 6 })
    expect(step.phase).toBe('done')
    expect(step.result!.success).toBe(true)
    expect(step.progress!.restored).toBe(2)
    expect(canRestoreWith(step, 'tok-1')).toBe(false)
  })

  it('rejects out-of-order actions as immutable no-ops', () => {
    let step = createRestoreMachine()
    const before = step
    step = restoreMachineStep(step, { type: 'CONFIRM', acknowledgeUntracked: false, at: 1 })
    expect(step).toBe(before)
    step = restoreMachineStep(step, { type: 'RESTORE_STARTED', previewId: 'x', at: 2 })
    expect(step).toBe(before)
    step = restoreMachineStep(step, { type: 'PROGRESS', progress: createRestoreProgress({ total: 1, at: 3 }), at: 3 })
    expect(step).toBe(before)
    step = restoreMachineStep(step, { type: 'RESTORE_OK', result: resultWire(), at: 4 })
    expect(step).toBe(before)
    step = restoreMachineStep(step, { type: 'PREVIEW_OK', outcome: outcome(), at: 5 })
    expect(step).toBe(before) // PREVIEW_OK before PREVIEW_STARTED is a no-op
  })

  it('binds restore to the preview id (mismatched token rejected)', () => {
    let step = createRestoreMachine()
    step = restoreMachineStep(step, { type: 'PREVIEW_STARTED', checkpointId: 'cp_1', deleteUntrackedFiles: false, at: 1 })
    step = restoreMachineStep(step, { type: 'PREVIEW_OK', outcome: outcome({ previewToken: 'tok-1' }), at: 2 })
    step = restoreMachineStep(step, { type: 'CONFIRM', acknowledgeUntracked: false, at: 3 })
    const armed = step
    step = restoreMachineStep(step, { type: 'RESTORE_STARTED', previewId: 'forged', at: 4 })
    expect(step).toBe(armed) // no-op: wrong previewId
  })

  it('requires the untracked-deletion ack before confirming', () => {
    let step = createRestoreMachine()
    step = restoreMachineStep(step, { type: 'PREVIEW_STARTED', checkpointId: 'cp_1', deleteUntrackedFiles: true, at: 1 })
    step = restoreMachineStep(step, { type: 'PREVIEW_OK', outcome: outcome(), at: 2 })
    expect(confirmRequiresUntrackedAck(step)).toBe(true)
    const previewPhase = step
    step = restoreMachineStep(step, { type: 'CONFIRM', acknowledgeUntracked: false, at: 3 })
    expect(step).toBe(previewPhase) // ack missing → no-op
    step = restoreMachineStep(step, { type: 'CONFIRM', acknowledgeUntracked: true, at: 4 })
    expect(step.phase).toBe('confirm')
    expect(step.session!.acknowledgedUntracked).toBe(true)
    step = restoreMachineStep(step, { type: 'RESTORE_STARTED', previewId: 'tok-1', at: 5 })
    expect(step.phase).toBe('running')
  })

  it('treats preview success:false as failed with re-preview required', () => {
    let step = createRestoreMachine()
    step = restoreMachineStep(step, { type: 'PREVIEW_STARTED', checkpointId: 'cp_1', deleteUntrackedFiles: false, at: 1 })
    step = restoreMachineStep(step, {
      type: 'PREVIEW_OK',
      outcome: outcome({ preview: previewWire({ success: false, error: 'chain broken' }) }),
      at: 2,
    })
    expect(step.phase).toBe('failed')
    expect(step.error!.code).toBe(RESTORE_CLIENT_ERROR_CODES.PREVIEW_FAILED)
    expect(step.retryable).toBe(false)
    expect(step.rePreviewRequired).toBe(true)
    expect(step.session).toBeNull()
    expect(step.preview).not.toBeNull() // conflicts remain visible
  })

  it('treats a missing preview token as approval-required failure', () => {
    let step = createRestoreMachine()
    step = restoreMachineStep(step, { type: 'PREVIEW_STARTED', checkpointId: 'cp_1', deleteUntrackedFiles: false, at: 1 })
    step = restoreMachineStep(step, { type: 'PREVIEW_OK', outcome: outcome({ previewToken: undefined }), at: 2 })
    expect(step.phase).toBe('failed')
    expect(step.error!.code).toBe(GRAY_RESTORE_REMOTE_CODES.APPROVAL_REQUIRED)
    expect(step.rePreviewRequired).toBe(true)
  })

  it('keeps partial restore failures visible and retryable', () => {
    let step = createRestoreMachine()
    step = restoreMachineStep(step, { type: 'PREVIEW_STARTED', checkpointId: 'cp_1', deleteUntrackedFiles: false, at: 1 })
    step = restoreMachineStep(step, { type: 'PREVIEW_OK', outcome: outcome(), at: 2 })
    step = restoreMachineStep(step, { type: 'CONFIRM', acknowledgeUntracked: false, at: 3 })
    step = restoreMachineStep(step, { type: 'RESTORE_STARTED', previewId: 'tok-1', at: 4 })
    step = restoreMachineStep(step, {
      type: 'RESTORE_OK',
      result: resultWire({ success: false, restored: 1, failures: [{ path: 'b.txt', reason: 'copy_failed' }] }),
      at: 5,
    })
    expect(step.phase).toBe('failed')
    expect(step.error!.code).toBe(RESTORE_CLIENT_ERROR_CODES.RESTORE_PARTIAL)
    expect(step.retryable).toBe(true)
    expect(step.result!.failures).toHaveLength(1) // per-item failures visible
    expect(step.progress!.failedItems).toHaveLength(1)
  })

  it('maps envelope failures and allows retry with the same token', () => {
    let step = createRestoreMachine()
    step = restoreMachineStep(step, { type: 'PREVIEW_STARTED', checkpointId: 'cp_1', deleteUntrackedFiles: false, at: 1 })
    step = restoreMachineStep(step, { type: 'PREVIEW_OK', outcome: outcome(), at: 2 })
    step = restoreMachineStep(step, { type: 'CONFIRM', acknowledgeUntracked: false, at: 3 })
    step = restoreMachineStep(step, { type: 'RESTORE_STARTED', previewId: 'tok-1', at: 4 })

    step = restoreMachineStep(step, {
      type: 'RESTORE_FAILED',
      error: failure(GRAY_RESTORE_REMOTE_CODES.CANCELLED),
      at: 5,
    })
    expect(step.phase).toBe('failed')
    expect(step.retryable).toBe(true)
    expect(step.rePreviewRequired).toBe(false)

    // Retry restore with the SAME previewId from failed → running.
    step = restoreMachineStep(step, { type: 'RESTORE_STARTED', previewId: 'tok-1', at: 6 })
    expect(step.phase).toBe('running')
    step = restoreMachineStep(step, { type: 'RESTORE_OK', result: resultWire(), at: 7 })
    expect(step.phase).toBe('done')
  })

  it('requires re-preview for stale approval/conflict failures', () => {
    let step = createRestoreMachine()
    step = restoreMachineStep(step, { type: 'PREVIEW_STARTED', checkpointId: 'cp_1', deleteUntrackedFiles: false, at: 1 })
    step = restoreMachineStep(step, { type: 'PREVIEW_OK', outcome: outcome(), at: 2 })
    step = restoreMachineStep(step, { type: 'CONFIRM', acknowledgeUntracked: false, at: 3 })
    step = restoreMachineStep(step, { type: 'RESTORE_STARTED', previewId: 'tok-1', at: 4 })
    step = restoreMachineStep(step, {
      type: 'RESTORE_FAILED',
      error: failure(GRAY_RESTORE_REMOTE_CODES.CONFLICT),
      at: 5,
    })
    expect(step.phase).toBe('failed')
    expect(step.retryable).toBe(false)
    expect(step.rePreviewRequired).toBe(true)
    // Retry with the same token is NOT allowed for stale previews.
    const failedStep = step
    step = restoreMachineStep(step, { type: 'RESTORE_STARTED', previewId: 'tok-1', at: 6 })
    expect(step).toBe(failedStep)
    // Re-preview resets to idle for a fresh token.
    step = restoreMachineStep(step, { type: 'RE_PREVIEW', at: 7 })
    expect(step.phase).toBe('idle')
    expect(step.session).toBeNull()
  })

  it('supports paste-token mode (confirm with an external token)', () => {
    let step = createRestoreMachine()
    step = restoreMachineStep(step, {
      type: 'CONFIRM_WITH_TOKEN',
      token: ' external-token ',
      checkpointId: 'cp_2',
      deleteUntrackedFiles: false,
      at: 1,
    })
    expect(step.phase).toBe('confirm')
    expect(step.session!.previewId).toBe('external-token') // trimmed
    expect(canRestoreWith(step, 'external-token')).toBe(true)
    expect(canRestoreWith(step, 'other')).toBe(false)

    // Empty token is rejected.
    const before = createRestoreMachine()
    const after = restoreMachineStep(before, {
      type: 'CONFIRM_WITH_TOKEN',
      token: '   ',
      checkpointId: 'cp_2',
      deleteUntrackedFiles: false,
      at: 1,
    })
    expect(after).toBe(before)
  })

  it('reset returns to idle from done', () => {
    let step = createRestoreMachine()
    step = restoreMachineStep(step, { type: 'PREVIEW_STARTED', checkpointId: 'cp_1', deleteUntrackedFiles: false, at: 1 })
    step = restoreMachineStep(step, { type: 'PREVIEW_OK', outcome: outcome(), at: 2 })
    step = restoreMachineStep(step, { type: 'CONFIRM', acknowledgeUntracked: false, at: 3 })
    step = restoreMachineStep(step, { type: 'RESTORE_STARTED', previewId: 'tok-1', at: 4 })
    step = restoreMachineStep(step, { type: 'RESTORE_OK', result: resultWire(), at: 5 })
    expect(canPreview(step)).toBe(true)
    step = restoreMachineStep(step, { type: 'RESET', at: 6 })
    expect(step.phase).toBe('idle')
    expect(step.result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Progress merging
// ---------------------------------------------------------------------------

describe('restore progress merging', () => {
  it('percent is 0 when total unknown and clamps to 100', () => {
    expect(progressPercent(createRestoreProgress({ total: 0, at: 1 }))).toBe(0)
    const full = mergeRestoreProgress(createRestoreProgress({ total: 10, at: 1 }), { processed: 10, at: 2 })
    expect(progressPercent(full)).toBe(100)
    const half = mergeRestoreProgress(createRestoreProgress({ total: 10, at: 1 }), { processed: 5, at: 2 })
    expect(progressPercent(half)).toBe(50)
  })

  it('merges cumulative patches by max and ignores invalid values', () => {
    let progress = createRestoreProgress({ total: 10, at: 1 })
    progress = mergeRestoreProgress(progress, { processed: 3, restored: 2, phase: 'restoring', at: 2 })
    progress = mergeRestoreProgress(progress, { processed: 2, restored: 1, at: 3 }) // regressions ignored
    progress = mergeRestoreProgress(progress, { processed: -5, total: -1, at: 4 }) // invalid ignored
    expect(progress.processed).toBe(3)
    expect(progress.restored).toBe(2)
    expect(progress.total).toBe(10)
    expect(progress.phase).toBe('restoring')
    expect(progress.updatedAt).toBe(4)
  })

  it('dedupes per-file failures by path', () => {
    let progress = createRestoreProgress({ total: 3, at: 1 })
    progress = mergeFailureItem(progress, { path: 'a.txt', reason: 'copy_failed' }, 2)
    progress = mergeFailureItem(progress, { path: 'a.txt', reason: 'copy_failed' }, 3)
    progress = mergeFailureItem(progress, { path: 'b.txt', reason: 'delete_failed' }, 4)
    expect(progress.failedItems).toHaveLength(2)
    expect(progress.failed).toBe(2)
  })

  it('folds the final result as authoritative', () => {
    const progress = mergeRestoreResult(
      createRestoreProgress({ total: 5, at: 1 }),
      resultWire({ success: false, restored: 1, deleted: 1, skipped: 2, failures: [{ path: 'x', reason: 'hash_mismatch' }] }),
      9,
    )
    expect(progress.restored).toBe(1)
    expect(progress.deleted).toBe(1)
    expect(progress.skipped).toBe(2)
    expect(progress.failed).toBe(1)
    expect(progress.phase).toBe('failed')
    expect(progress.processed).toBe(5)
    expect(progress.updatedAt).toBe(9)
  })

  it('groups failures by reason in canonical order', () => {
    const groups = groupFailuresByReason([
      { path: 'a', reason: 'copy_failed' },
      { path: 'b', reason: 'delete_failed' },
      { path: 'c', reason: 'copy_failed' },
    ])
    expect(groups).toEqual([
      { reason: 'copy_failed', count: 2 },
      { reason: 'delete_failed', count: 1 },
    ])
  })
})

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('error-code → hint mapping', () => {
  it('maps every host code to a stable hint', () => {
    expect(restoreErrorHint(failure(GRAY_RESTORE_REMOTE_CODES.APPROVAL_REQUIRED))).toMatchObject({
      severity: 'warning', retryable: false, rePreviewRequired: true, key: 'error.approvalRequired',
    })
    expect(restoreErrorHint(failure(GRAY_RESTORE_REMOTE_CODES.CONFLICT))).toMatchObject({
      severity: 'warning', retryable: false, rePreviewRequired: true, key: 'error.conflict',
    })
    expect(restoreErrorHint(failure(GRAY_RESTORE_REMOTE_CODES.CANCELLED))).toMatchObject({
      severity: 'info', retryable: true, rePreviewRequired: false, key: 'error.cancelled',
    })
    expect(restoreErrorHint(failure(GRAY_RESTORE_REMOTE_CODES.NOT_FOUND))).toMatchObject({
      severity: 'error', retryable: false, rePreviewRequired: true, key: 'error.notFound',
    })
    expect(restoreErrorHint(failure(GRAY_RESTORE_REMOTE_CODES.STORAGE_CORRUPT))).toMatchObject({
      severity: 'error', key: 'error.storageCorrupt',
    })
    expect(restoreErrorHint(failure(GRAY_RESTORE_REMOTE_CODES.INVALID_INPUT))).toMatchObject({
      severity: 'error', key: 'error.invalidInput',
    })
    expect(restoreErrorHint(failure(GRAY_RESTORE_REMOTE_CODES.ENDPOINT_NOT_FOUND))).toMatchObject({
      severity: 'error', key: 'error.endpointNotFound',
    })
    expect(restoreErrorHint(failure(GRAY_RESTORE_REMOTE_CODES.INTERNAL))).toMatchObject({
      severity: 'error', retryable: true, key: 'error.internal',
    })
  })

  it('maps client-local codes', () => {
    expect(restoreErrorHint(failure(RESTORE_CLIENT_ERROR_CODES.PREVIEW_FAILED))).toMatchObject({
      severity: 'error', retryable: false, rePreviewRequired: true, key: 'error.previewFailed',
    })
    expect(restoreErrorHint(failure(RESTORE_CLIENT_ERROR_CODES.RESTORE_PARTIAL))).toMatchObject({
      severity: 'warning', retryable: true, rePreviewRequired: false, key: 'error.partial',
    })
    expect(restoreErrorHint(failure(RESTORE_CLIENT_ERROR_CODES.MALFORMED_RESPONSE))).toMatchObject({
      severity: 'error', key: 'error.malformed',
    })
  })

  it('falls back to unknown for unrecognised codes and null', () => {
    expect(restoreErrorHint(failure('GRAY_WHATEVER'))).toMatchObject({ code: 'GRAY_WHATEVER', key: 'error.unknown' })
    expect(restoreErrorHint(null)).toMatchObject({ key: 'error.unknown' })
  })

  it('identifies stale-preview codes', () => {
    expect(RESTORE_STALE_CODES).toEqual([
      GRAY_RESTORE_REMOTE_CODES.APPROVAL_REQUIRED,
      GRAY_RESTORE_REMOTE_CODES.CONFLICT,
    ])
    expect(isPreviewStaleError(GRAY_RESTORE_REMOTE_CODES.APPROVAL_REQUIRED)).toBe(true)
    expect(isPreviewStaleError(GRAY_RESTORE_REMOTE_CODES.CONFLICT)).toBe(true)
    expect(isPreviewStaleError(GRAY_RESTORE_REMOTE_CODES.CANCELLED)).toBe(false)
  })

  it('every mapped hint key exists in the locale dictionaries', () => {
    const codes = [
      ...Object.values(GRAY_RESTORE_REMOTE_CODES),
      ...Object.values(RESTORE_CLIENT_ERROR_CODES),
      'GRAY_WHATEVER',
    ]
    for (const code of codes) {
      const key = restoreErrorHint({ code, message: '', details: {} }).key
      expect(Object.keys(graycodeRestorePreviewDictionaries.en)).toContain(key)
    }
  })
})

// ---------------------------------------------------------------------------
// Gateway (remote + mock)
// ---------------------------------------------------------------------------

describe('restore gateway', () => {
  it('dispatches previewRestore/restore through the invoke bridge and unwraps', async () => {
    const calls: Array<{ ns: string; method: string; args: Record<string, unknown> }> = []
    const invoke: RestoreRemoteInvoke = async (ns, method, args) => {
      calls.push({ ns, method, args: args as Record<string, unknown> })
      if (method === 'previewRestore') return { ok: true, value: outcome() }
      return { ok: true, value: resultWire() }
    }
    const gateway = createRestoreGateway(invoke)
    expect(gateway.kind).toBe('remote')

    const preview = await gateway.preview({ checkpointId: 'cp_1', workspace: '/ws', deleteUntrackedFiles: true })
    expect(preview.ok).toBe(true)
    if (preview.ok) expect(preview.value.previewToken).toBe('tok-1')
    expect(calls[0]).toMatchObject({ ns: 'checkpoints', method: 'previewRestore', args: { checkpointId: 'cp_1' } })

    const restore = await gateway.restore({ checkpointId: 'cp_1', previewToken: 'tok-1' })
    expect(restore.ok).toBe(true)
    if (restore.ok) expect(restore.value.success).toBe(true)
    expect(calls[1]).toMatchObject({ ns: 'checkpoints', method: 'restore', args: { previewToken: 'tok-1' } })
  })

  it('passes envelope failures through unchanged', async () => {
    const invoke: RestoreRemoteInvoke = async () => ({ ok: false, error: failure(GRAY_RESTORE_REMOTE_CODES.APPROVAL_REQUIRED) })
    const gateway = createRestoreGateway(invoke)
    const result = await gateway.restore({ checkpointId: 'cp_1', previewToken: 'forged' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(GRAY_RESTORE_REMOTE_CODES.APPROVAL_REQUIRED)
  })

  it('maps unreadable payloads to GRAY_MALFORMED_RESPONSE', async () => {
    const invoke: RestoreRemoteInvoke = async () => ({ ok: true, value: { preview: 'not-a-preview' } })
    const gateway = createRestoreGateway(invoke)
    const result = await gateway.preview({ checkpointId: 'cp_1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(RESTORE_CLIENT_ERROR_CODES.MALFORMED_RESPONSE)
  })

  it('mock enforces the preview/restore binding (forged or stale tokens denied)', async () => {
    const gateway = createMockRestoreGateway()
    expect(gateway.kind).toBe('mock')

    // Restore without preview → APPROVAL_REQUIRED.
    const early = await gateway.restore({ checkpointId: 'cp_1', previewToken: 'mock-preview-cp_1' })
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.error.code).toBe(GRAY_RESTORE_REMOTE_CODES.APPROVAL_REQUIRED)

    const preview = await gateway.preview({ checkpointId: 'cp_1' })
    expect(preview.ok).toBe(true)
    const token = preview.ok ? preview.value.previewToken : undefined
    expect(token).toBe('mock-preview-cp_1')

    // Forged token → APPROVAL_REQUIRED.
    const forged = await gateway.restore({ checkpointId: 'cp_1', previewToken: 'forged' })
    expect(forged.ok).toBe(false)
    if (!forged.ok) expect(forged.error.code).toBe(GRAY_RESTORE_REMOTE_CODES.APPROVAL_REQUIRED)

    // Correct token → success; token consumed afterwards.
    const ok = await gateway.restore({ checkpointId: 'cp_1', previewToken: token! })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.value.success).toBe(true)
    const again = await gateway.restore({ checkpointId: 'cp_1', previewToken: token! })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.code).toBe(GRAY_RESTORE_REMOTE_CODES.APPROVAL_REQUIRED)
  })

  it('mock does not consume the token on failure (retry allowed)', async () => {
    const gateway = createMockRestoreGateway({
      restore: { success: false, restored: 1, deleted: 0, skipped: 0, failures: [{ path: 'a.txt', reason: 'copy_failed' }], unbackedPaths: [] },
    })
    const preview = await gateway.preview({ checkpointId: 'cp_1' })
    const token = preview.ok ? preview.value.previewToken : undefined
    const partial = await gateway.restore({ checkpointId: 'cp_1', previewToken: token! })
    expect(partial.ok).toBe(true)
    if (partial.ok) expect(partial.value.success).toBe(false)

    const retry = await gateway.restore({ checkpointId: 'cp_1', previewToken: token! })
    expect(retry.ok).toBe(true)
    if (retry.ok) expect(retry.value.success).toBe(false) // still the scripted partial
  })

  it('mock surfaces simulated envelope errors', async () => {
    const gateway = createMockRestoreGateway({
      previewError: failure(GRAY_RESTORE_REMOTE_CODES.NOT_FOUND, 'cp gone'),
    })
    const preview = await gateway.preview({ checkpointId: 'cp_missing' })
    expect(preview.ok).toBe(false)
    if (!preview.ok) expect(preview.error.code).toBe(GRAY_RESTORE_REMOTE_CODES.NOT_FOUND)
  })
})

// ---------------------------------------------------------------------------
// Locale alignment
// ---------------------------------------------------------------------------

describe('graycode.restorePreview locale dictionaries', () => {
  it('keeps zh/en dictionaries balanced (identical key sets)', () => {
    const en = Object.keys(graycodeRestorePreviewDictionaries.en).sort()
    const zh = Object.keys(graycodeRestorePreviewDictionaries.zh).sort()
    expect(zh).toEqual(en)
  })

  it('keeps the ja placeholder on the same key set', () => {
    expect(Object.keys(graycodeRestorePreviewJaPlaceholder).sort()).toEqual(
      Object.keys(graycodeRestorePreviewDictionaries.en).sort(),
    )
  })

  it('fills every shipped locale with non-empty text', () => {
    for (const dict of Object.values(graycodeRestorePreviewDictionaries)) {
      for (const text of Object.values(dict)) {
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })

  it('exposes the expected namespace', () => {
    expect(GRAYCODE_RESTORE_PREVIEW_NS).toBe('graycode.restorePreview')
  })

  it('maps every failure reason to an existing locale key', () => {
    const keys = Object.keys(graycodeRestorePreviewDictionaries.en)
    for (const reason of ['missing_in_chain', 'hash_mismatch', 'copy_failed', 'delete_failed', 'missing_backup_dir', 'unbacked'] as const) {
      expect(keys).toContain(restoreFailureLocaleKey(reason))
    }
  })
})

// ---------------------------------------------------------------------------
// Full flow sanity (machine + gateway together)
// ---------------------------------------------------------------------------

describe('end-to-end flow with the mock gateway', () => {
  it('previews, confirms twice, runs and finishes', async () => {
    const gateway = createMockRestoreGateway()
    let step = createRestoreMachine()

    step = restoreMachineStep(step, { type: 'PREVIEW_STARTED', checkpointId: 'cp_1', deleteUntrackedFiles: false, at: 9 })
    expect(step.phase).toBe('preview')

    const preview = await gateway.preview({ checkpointId: 'cp_1' })
    expect(preview.ok).toBe(true)
    if (preview.ok) {
      step = restoreMachineStep(step, { type: 'PREVIEW_OK', outcome: preview.value, at: 10 })
    }
    expect(step.phase).toBe('preview')

    step = restoreMachineStep(step, { type: 'CONFIRM', acknowledgeUntracked: false, at: 11 })
    expect(step.phase).toBe('confirm')

    const token = step.session!.previewId
    step = restoreMachineStep(step, { type: 'RESTORE_STARTED', previewId: token, at: 12 })
    expect(step.phase).toBe('running')

    const restore = await gateway.restore({ checkpointId: 'cp_1', previewToken: token })
    expect(restore.ok).toBe(true)
    if (restore.ok) {
      step = restoreMachineStep(step, { type: 'RESTORE_OK', result: restore.value, at: 13 })
    }
    expect(step.phase).toBe('done')
    expect(step.result!.success).toBe(true)
    expect(step.progress!.restored).toBe(2)
  })
})
