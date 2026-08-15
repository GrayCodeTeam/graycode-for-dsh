/**
 * P4-06 staged-diff card — pure-logic tests.
 *
 * Covers: contract mirror (transition table, entry narrow), status → action
 * mapping, before/after diff summary, review-batch aggregation + paged
 * loading, failure-envelope → display-error mapping, operation-id
 * idempotency, the actions assembly, the mock data source's host-consistent
 * semantics, and locale key alignment.
 *
 * React is intentionally not imported: these are node-environment tests of
 * the replay-safe pure logic (the card components are not rendered here).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  GRAY_REMOTE_ERROR_CODES,
  GRAY_STAGED_CAUSE_CODES,
  STAGED_ENTRY_STATUSES,
  STAGED_ENTRY_TRANSITIONS,
  canTransitionStaged,
  isStagedEntryLike,
  transitionStagedEntry,
  type GrayRemoteFailure,
  type StagedEntry,
  type StagedEntryStatus,
} from '../src/client/stagedDiffCard/contract.ts'
import {
  STAGED_STATUS_TONE,
  isStagedReapplyStatus,
  stagedEntryActionability,
  stagedStatusLocaleKey,
} from '../src/client/stagedDiffCard/status.ts'
import { summarizeStagedDiff } from '../src/client/stagedDiffCard/summary.ts'
import { REVIEW_BATCH_STATUSES, buildReviewBatch, loadReviewBatch } from '../src/client/stagedDiffCard/batch.ts'
import { mapStagedDiffFailure, type StagedDiffCardError } from '../src/client/stagedDiffCard/errors.ts'
import { MAX_TRACKED_OPERATIONS, createStagedDiffOperationTracker } from '../src/client/stagedDiffCard/idempotency.ts'
import { createStagedDiffActions, type StagedDiffDecisionOutcome } from '../src/client/stagedDiffCard/actions.ts'
import { createMockStagedDiffDataSource, mockWorkspaceIdOf } from '../src/client/stagedDiffCard/mockDataSource.ts'
import type { StagedDiffDataSource } from '../src/client/stagedDiffCard/dataSource.ts'
import { formatStagedSummary } from '../src/client/stagedDiffCard/StagedDiffCard.tsx'
import {
  GRAYCODE_STAGED_DIFF_CARD_NS,
  graycodeStagedDiffCardDictionaries,
  graycodeStagedDiffCardJaPlaceholder,
} from '../src/client/stagedDiffCard/locales.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let entrySeq = 0
function makeEntry(overrides: Partial<StagedEntry> = {}): StagedEntry {
  entrySeq += 1
  return {
    id: `entry-${entrySeq}`,
    workspaceId: 'ws-a',
    sessionId: 'session-1',
    path: 'src/file.ts',
    before: 'line1\nline2',
    after: 'line1\nline2\nline3',
    status: 'pending',
    createdAt: entrySeq * 1000,
    updatedAt: entrySeq * 1000,
    revision: 1,
    ...overrides,
  }
}

function failure(overrides: Partial<GrayRemoteFailure> = {}): GrayRemoteFailure {
  return {
    code: GRAY_REMOTE_ERROR_CODES.CONFLICT,
    message: 'boom',
    details: {},
    ...overrides,
  }
}

function envelopeError(f: GrayRemoteFailure) {
  return { ok: false as const, error: f }
}

// ---------------------------------------------------------------------------
// Contract mirror
// ---------------------------------------------------------------------------

describe('contract mirror (host stagedDiff contract)', () => {
  it('mirrors the host transition table (ADR-0003 §4)', () => {
    expect(STAGED_ENTRY_TRANSITIONS).toEqual({
      pending: ['reviewing', 'accepted', 'rejected'],
      reviewing: ['accepted', 'rejected'],
      accepted: ['done'],
      rejected: ['done'],
      done: [],
      'needs-reapply': ['accepted', 'rejected'],
    })
    // Every status is covered by the table (full-coverage guard).
    for (const status of STAGED_ENTRY_STATUSES) {
      expect(STAGED_ENTRY_TRANSITIONS[status]).toBeDefined()
    }
  })

  it('canTransitionStaged follows the table', () => {
    expect(canTransitionStaged('pending', 'reviewing')).toBe(true)
    expect(canTransitionStaged('pending', 'accepted')).toBe(true)
    expect(canTransitionStaged('reviewing', 'rejected')).toBe(true)
    expect(canTransitionStaged('accepted', 'done')).toBe(true)
    expect(canTransitionStaged('needs-reapply', 'accepted')).toBe(true)
    expect(canTransitionStaged('needs-reapply', 'rejected')).toBe(true)
    expect(canTransitionStaged('accepted', 'rejected')).toBe(false)
    expect(canTransitionStaged('done', 'accepted')).toBe(false)
    expect(canTransitionStaged('rejected', 'accepted')).toBe(false)
  })

  it('transitionStagedEntry produces a new entry (revision +1, updatedAt = now, no mutation)', () => {
    const entry = makeEntry({ revision: 3, updatedAt: 100 })
    const next = transitionStagedEntry(entry, 'reviewing', 999)
    expect(next.status).toBe('reviewing')
    expect(next.revision).toBe(4)
    expect(next.updatedAt).toBe(999)
    expect(entry.status).toBe('pending')
    expect(entry.revision).toBe(3)
  })

  it('transitionStagedEntry throws on illegal transitions', () => {
    expect(() => transitionStagedEntry(makeEntry({ status: 'done' }), 'accepted', 1)).toThrow(/illegal staged entry transition/)
    expect(() => transitionStagedEntry(makeEntry({ status: 'accepted' }), 'rejected', 1)).toThrow(/illegal staged entry transition/)
  })

  it('isStagedEntryLike narrows real entries and rejects garbage', () => {
    expect(isStagedEntryLike(makeEntry())).toBe(true)
    expect(isStagedEntryLike(makeEntry({ toolCallId: 'tc-1' }))).toBe(true)
    expect(isStagedEntryLike(null)).toBe(false)
    expect(isStagedEntryLike({})).toBe(false)
    expect(isStagedEntryLike(makeEntry({ status: 'bogus' as StagedEntryStatus }))).toBe(false)
    expect(isStagedEntryLike(makeEntry({ revision: 'x' as unknown as number }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Status → action mapping
// ---------------------------------------------------------------------------

describe('status → badge/action mapping', () => {
  it('pending/reviewing/needs-reapply are decidable (accept + reject)', () => {
    for (const status of ['pending', 'reviewing', 'needs-reapply'] as const) {
      const a = stagedEntryActionability(status)
      expect(a.canAccept).toBe(true)
      expect(a.canReject).toBe(true)
      expect(a.actionable).toBe(true)
    }
  })

  it('accepted/rejected/done offer no decisions', () => {
    for (const status of ['accepted', 'rejected', 'done'] as const) {
      const a = stagedEntryActionability(status)
      expect(a.canAccept).toBe(false)
      expect(a.canReject).toBe(false)
      expect(a.actionable).toBe(false)
    }
  })

  it('only needs-reapply carries the recovery hint', () => {
    expect(isStagedReapplyStatus('needs-reapply')).toBe(true)
    for (const status of STAGED_ENTRY_STATUSES) {
      if (status !== 'needs-reapply') expect(isStagedReapplyStatus(status)).toBe(false)
    }
  })

  it('has a tone and a locale key for every status', () => {
    for (const status of STAGED_ENTRY_STATUSES) {
      expect(typeof STAGED_STATUS_TONE[status]).toBe('string')
      expect(stagedStatusLocaleKey(status).startsWith('status.')).toBe(true)
    }
    expect(stagedStatusLocaleKey('needs-reapply')).toBe('status.needsReapply')
  })
})

// ---------------------------------------------------------------------------
// Diff summary
// ---------------------------------------------------------------------------

describe('before/after diff summary', () => {
  it('before === null → new file with added lines', () => {
    expect(summarizeStagedDiff(null, 'a\nb\nc')).toEqual({ kind: 'create', addedLines: 3, removedLines: 0 })
    expect(summarizeStagedDiff(null, '')).toEqual({ kind: 'create', addedLines: 0, removedLines: 0 })
  })

  it('after === "" with a before → deletion', () => {
    expect(summarizeStagedDiff('a\nb', '')).toEqual({ kind: 'delete', addedLines: 0, removedLines: 2 })
  })

  it('modify strips the common prefix/suffix and counts the remainder', () => {
    expect(summarizeStagedDiff('keep1\nkeep2\nold\nold2\nkeep3', 'keep1\nkeep2\nnew\nkeep3'))
      .toEqual({ kind: 'modify', addedLines: 1, removedLines: 2 })
  })

  it('identical content is a no-op modify (0/0) and empty-before modify counts additions', () => {
    expect(summarizeStagedDiff('a\nb', 'a\nb')).toEqual({ kind: 'modify', addedLines: 0, removedLines: 0 })
    expect(summarizeStagedDiff('', 'x\ny')).toEqual({ kind: 'modify', addedLines: 2, removedLines: 0 })
  })

  it('does not render a misleading "−0" for an empty deletion or "+0" for an empty create', () => {
    const t = ((key: string) => key) as Parameters<typeof formatStagedSummary>[0]
    expect(formatStagedSummary(t, makeEntry({ before: '', after: '' }))).toBe('summary.delete')
    expect(formatStagedSummary(t, makeEntry({ before: null, after: '' }))).toBe('summary.create')
    expect(formatStagedSummary(t, makeEntry({ before: 'a\nb', after: '' }))).toBe('summary.delete · −2')
  })
})

// ---------------------------------------------------------------------------
// Review-batch aggregation
// ---------------------------------------------------------------------------

describe('review-batch aggregation', () => {
  it('keeps pending/reviewing/needs-reapply of the same workspace+session', () => {
    const entries = [
      makeEntry({ id: 'e1', workspaceId: 'ws-a', sessionId: 's1', status: 'pending', createdAt: 1 }),
      makeEntry({ id: 'e2', workspaceId: 'ws-a', sessionId: 's1', status: 'reviewing', createdAt: 2 }),
      makeEntry({ id: 'e3', workspaceId: 'ws-a', sessionId: 's1', status: 'done', createdAt: 3 }),
      makeEntry({ id: 'e4', workspaceId: 'ws-a', sessionId: 's1', status: 'rejected', createdAt: 4 }),
      makeEntry({ id: 'e5', workspaceId: 'ws-a', sessionId: 's1', status: 'accepted', createdAt: 5 }),
      makeEntry({ id: 'e6', workspaceId: 'ws-a', sessionId: 's1', status: 'needs-reapply', createdAt: 6 }),
      makeEntry({ id: 'e7', workspaceId: 'ws-a', sessionId: 's2', status: 'pending', createdAt: 7 }),
      makeEntry({ id: 'e8', workspaceId: 'ws-b', sessionId: 's1', status: 'pending', createdAt: 8 }),
    ]
    const batch = buildReviewBatch(entries, 'ws-a', 's1')
    // needs-reapply (crash-recovery residue) is surfaced in the batch (4.8-L7)
    // and counted under reviewing (it awaits a fresh decision).
    expect(batch.entries.map(e => e.id)).toEqual(['e1', 'e2', 'e6'])
    expect(batch.pendingCount).toBe(1)
    expect(batch.reviewingCount).toBe(2)
    expect(batch.totalCount).toBe(3)
  })

  it('sorts by createdAt asc then id asc (host reviewBatch order)', () => {
    const entries = [
      makeEntry({ id: 'b', status: 'pending', createdAt: 5 }),
      makeEntry({ id: 'a', status: 'pending', createdAt: 5 }),
      makeEntry({ id: 'c', status: 'pending', createdAt: 1 }),
      makeEntry({ id: 'd', status: 'reviewing', createdAt: 3 }),
    ]
    const batch = buildReviewBatch(entries, 'ws-a', 'session-1')
    expect(batch.entries.map(e => e.id)).toEqual(['c', 'd', 'a', 'b'])
  })

  it('does not mutate the input entries', () => {
    const entry = makeEntry({ status: 'pending' })
    const before = { ...entry }
    buildReviewBatch([entry], 'ws-a', 'session-1')
    expect(entry).toEqual(before)
  })

  it('REVIEW_BATCH_STATUSES covers pending/reviewing plus needs-reapply', () => {
    expect(REVIEW_BATCH_STATUSES).toEqual(['pending', 'reviewing', 'needs-reapply'])
  })
})

describe('loadReviewBatch (contract-driven loader)', () => {
  it('pages through stagedDiff/list and folds pages into the batch view', async () => {
    const entries = [
      makeEntry({ id: 'p1', status: 'pending', createdAt: 1 }),
      makeEntry({ id: 'p2', status: 'pending', createdAt: 2 }),
      makeEntry({ id: 'p3', status: 'reviewing', createdAt: 3 }),
      makeEntry({ id: 'done1', status: 'done', createdAt: 4 }),
    ]
    const dataSource = createMockStagedDiffDataSource(entries)
    // limit 1 forces three pages (cursor pagination).
    const batch = await loadReviewBatch(dataSource, { workspaceId: 'ws-a', sessionId: 'session-1', limit: 1 })
    expect(batch.entries.map(e => e.id)).toEqual(['p1', 'p2', 'p3'])
    expect(batch.pendingCount).toBe(2)
    expect(batch.reviewingCount).toBe(1)
    expect(batch.totalCount).toBe(3)
  })

  it('propagates a failed list call as an error', async () => {
    const dataSource: StagedDiffDataSource = {
      list: async () => envelopeError(failure({ code: GRAY_REMOTE_ERROR_CODES.ENDPOINT_NOT_FOUND })),
      preview: async () => envelopeError(failure()),
      accept: async () => envelopeError(failure()),
      reject: async () => envelopeError(failure()),
    }
    await expect(loadReviewBatch(dataSource, { workspaceId: 'ws-a', sessionId: 's' }))
      .rejects.toThrow(/stagedDiff\/list failed: GRAY_ENDPOINT_NOT_FOUND/)
  })

  it('terminates when the cursor stops advancing instead of looping forever', async () => {
    const item = makeEntry({ id: 'x1', status: 'pending', createdAt: 1 })
    let calls = 0
    const dataSource: StagedDiffDataSource = {
      list: async () => {
        calls += 1
        return { ok: true, value: { items: [item], total: 1, nextCursor: 'x1' } }
      },
      preview: async () => envelopeError(failure()),
      accept: async () => envelopeError(failure()),
      reject: async () => envelopeError(failure()),
    }
    const batch = await loadReviewBatch(dataSource, { workspaceId: 'ws-a', sessionId: 'session-1' })
    // First page + one non-advancing repeat, then the guard terminates.
    expect(calls).toBe(2)
    expect(batch.entries.map(e => e.id)).toEqual(['x1'])
  })

  it('dedupes entries repeated across pages (page-order drift)', async () => {
    const a = makeEntry({ id: 'a', status: 'pending', createdAt: 1 })
    const b = makeEntry({ id: 'b', status: 'pending', createdAt: 2 })
    let calls = 0
    const dataSource: StagedDiffDataSource = {
      list: async () => {
        calls += 1
        if (calls === 1) return { ok: true, value: { items: [b, a], total: 3, nextCursor: 'b' } }
        return { ok: true, value: { items: [b], total: 3 } }
      },
      preview: async () => envelopeError(failure()),
      accept: async () => envelopeError(failure()),
      reject: async () => envelopeError(failure()),
    }
    const batch = await loadReviewBatch(dataSource, { workspaceId: 'ws-a', sessionId: 'session-1' })
    // Repeated 'b' across pages is folded once; final order is the batch sort.
    expect(batch.entries.map(e => e.id)).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('failure envelope → display error mapping', () => {
  it('refines GRAY_CONFLICT by causeCode', () => {
    const entry = makeEntry({ revision: 5 })

    const revision = mapStagedDiffFailure(failure({
      code: GRAY_REMOTE_ERROR_CODES.CONFLICT,
      details: { causeCode: GRAY_STAGED_CAUSE_CODES.REVISION_CONFLICT, entry },
    }))
    expect(revision.kind).toBe('revisionConflict')
    expect(revision.refreshRequired).toBe(true)
    expect(revision.retryable).toBe(false)
    expect(revision.entry).toEqual(entry)

    const reject = mapStagedDiffFailure(failure({
      code: GRAY_REMOTE_ERROR_CODES.CONFLICT,
      details: { causeCode: GRAY_STAGED_CAUSE_CODES.REJECT_CONFLICT, entry },
    }))
    expect(reject.kind).toBe('rejectConflict')
    expect(reject.refreshRequired).toBe(true)

    const apply = mapStagedDiffFailure(failure({
      code: GRAY_REMOTE_ERROR_CODES.CONFLICT,
      details: { causeCode: GRAY_STAGED_CAUSE_CODES.APPLY_FAILED, entry },
    }))
    expect(apply.kind).toBe('applyFailed')
    expect(apply.retryable).toBe(true)
    expect(apply.refreshRequired).toBe(false)

    const illegal = mapStagedDiffFailure(failure({
      code: GRAY_REMOTE_ERROR_CODES.CONFLICT,
      details: { causeCode: GRAY_STAGED_CAUSE_CODES.ILLEGAL_TRANSITION },
    }))
    expect(illegal.kind).toBe('illegalTransition')
    expect(illegal.refreshRequired).toBe(true)

    const workspace = mapStagedDiffFailure(failure({
      code: GRAY_REMOTE_ERROR_CODES.CONFLICT,
      details: { causeCode: GRAY_STAGED_CAUSE_CODES.WORKSPACE_CONFLICT },
    }))
    expect(workspace.kind).toBe('workspaceConflict')

    const bare = mapStagedDiffFailure(failure({ code: GRAY_REMOTE_ERROR_CODES.CONFLICT }))
    expect(bare.kind).toBe('conflict')
    expect(bare.refreshRequired).toBe(true)
  })

  it('maps every remaining envelope code', () => {
    const cases: Array<[string, StagedDiffCardError['kind']]> = [
      [GRAY_REMOTE_ERROR_CODES.NOT_FOUND, 'notFound'],
      [GRAY_REMOTE_ERROR_CODES.ENDPOINT_NOT_FOUND, 'endpointNotFound'],
      [GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED, 'approvalRequired'],
      [GRAY_REMOTE_ERROR_CODES.CANCELLED, 'cancelled'],
      [GRAY_REMOTE_ERROR_CODES.STORAGE_CORRUPT, 'storageCorrupt'],
      [GRAY_REMOTE_ERROR_CODES.INVALID_INPUT, 'invalidInput'],
      [GRAY_REMOTE_ERROR_CODES.INTERNAL, 'internal'],
      ['GRAY_SOMETHING_NEW', 'internal'],
    ]
    for (const [code, kind] of cases) {
      const error = mapStagedDiffFailure(failure({ code }))
      expect(error.kind).toBe(kind)
      expect(error.code).toBe(code)
    }
  })

  it('keeps the authoritative entry only when it looks like one', () => {
    const entry = makeEntry()
    const kept = mapStagedDiffFailure(failure({ details: { entry } }))
    expect(kept.entry).toEqual(entry)

    const dropped = mapStagedDiffFailure(failure({ details: { entry: { id: 42 } } }))
    expect(dropped.entry).toBeUndefined()
  })

  it('carries causeCode when present', () => {
    const error = mapStagedDiffFailure(failure({
      code: GRAY_REMOTE_ERROR_CODES.CONFLICT,
      details: { causeCode: GRAY_STAGED_CAUSE_CODES.REJECT_CONFLICT },
    }))
    expect(error.causeCode).toBe(GRAY_STAGED_CAUSE_CODES.REJECT_CONFLICT)
  })
})

// ---------------------------------------------------------------------------
// Operation-id idempotency
// ---------------------------------------------------------------------------

describe('operation-id tracker', () => {
  it('begins fresh operations and dedupes by id', () => {
    const tracker = createStagedDiffOperationTracker<string>()
    const first = tracker.begin('accept', 'e1')
    expect(first.duplicate).toBe(false)
    expect(first.operationId).toBe('accept:e1')

    const again = tracker.begin('accept', 'e1')
    expect(again.duplicate).toBe(true)
    expect(again.record).toBe(first.record)

    const other = tracker.begin('reject', 'e1')
    expect(other.duplicate).toBe(false)
    expect(other.operationId).toBe('reject:e1')
  })

  it('resolves and returns the recorded result for repeat ids', () => {
    const tracker = createStagedDiffOperationTracker<string>()
    const { operationId } = tracker.begin('accept', 'e1')
    expect(tracker.isInFlight('e1')).toBe(true)
    tracker.resolve(operationId, 'done-result')
    const record = tracker.get(operationId)
    expect(record?.state).toBe('resolved')
    expect(record?.result).toBe('done-result')
    expect(tracker.isInFlight('e1')).toBe(false)
  })

  it('explicit operation ids are honoured (stable caller ids)', () => {
    const tracker = createStagedDiffOperationTracker<string>()
    const a = tracker.begin('accept', 'e1', 'op-toolcall-1')
    const b = tracker.begin('accept', 'e1', 'op-toolcall-1')
    expect(a.operationId).toBe('op-toolcall-1')
    expect(b.duplicate).toBe(true)
    // A different explicit id is a different operation.
    expect(tracker.begin('accept', 'e1', 'op-toolcall-2').duplicate).toBe(false)
  })

  it('reset clears one entry or everything', () => {
    const tracker = createStagedDiffOperationTracker<string>()
    tracker.begin('accept', 'e1')
    tracker.begin('accept', 'e2')
    tracker.reset('e1')
    expect(tracker.get('accept:e1')).toBeUndefined()
    expect(tracker.get('accept:e2')).toBeDefined()
    tracker.reset()
    expect(tracker.get('accept:e2')).toBeUndefined()
  })

  it('forget removes one operation record so the operation can start again', () => {
    const tracker = createStagedDiffOperationTracker<string>()
    const { operationId } = tracker.begin('accept', 'e1')
    tracker.resolve(operationId, 'done-result')
    expect(tracker.get(operationId)?.state).toBe('resolved')
    tracker.forget(operationId)
    expect(tracker.get(operationId)).toBeUndefined()
    expect(tracker.isInFlight('e1')).toBe(false)
    expect(tracker.begin('accept', 'e1').duplicate).toBe(false)
  })

  it('evicts the oldest records when the tracker hits its cap (4.8-L1)', () => {
    const tracker = createStagedDiffOperationTracker<string>()
    for (let i = 0; i <= MAX_TRACKED_OPERATIONS; i += 1) {
      const { operationId } = tracker.begin('accept', `e-${i}`)
      tracker.resolve(operationId, 'ok')
    }
    // The oldest operation was evicted to make room for the newest.
    expect(tracker.get('accept:e-0')).toBeUndefined()
    expect(tracker.get(`accept:e-${MAX_TRACKED_OPERATIONS}`)).toBeDefined()
  })
})

describe('decision actions (assembly)', () => {
  const decisionWorkspace = 'C:\\dev\\alpha'
  function spyDataSource(overrides: Partial<StagedDiffDataSource> = {}): StagedDiffDataSource {
    return {
      list: async () => ({ ok: true, value: { items: [], total: 0 } }),
      preview: vi.fn(async () => envelopeError(failure())),
      accept: vi.fn<StagedDiffDataSource['accept']>(async () => ({ ok: true, value: makeEntry({ status: 'done' }) })),
      reject: vi.fn<StagedDiffDataSource['reject']>(async () => ({ ok: true, value: makeEntry({ status: 'rejected' }) })),
      ...overrides,
    }
  }

  it('dedupes same-entry clicks through the derived operation id', async () => {
    const dataSource = spyDataSource()
    const actions = createStagedDiffActions(dataSource, decisionWorkspace)
    const entry = makeEntry()
    const [a, b] = await Promise.all([actions.accept(entry), actions.accept(entry)])
    expect(a.ok && b.ok).toBe(true)
    // Two clicks, one data-source call.
    expect(dataSource.accept).toHaveBeenCalledTimes(1)
    expect(dataSource.accept).toHaveBeenCalledWith({ entryId: entry.id, expectedRevision: entry.revision, workspace: decisionWorkspace })
  })

  it('repeating an explicit operation id returns the recorded outcome without re-invoking', async () => {
    const dataSource = spyDataSource()
    const actions = createStagedDiffActions(dataSource, decisionWorkspace)
    const entry = makeEntry()
    const first = await actions.acceptWithOperationId(entry, 'op-stable')
    const second = await actions.acceptWithOperationId(entry, 'op-stable')
    expect(first.ok && second.ok).toBe(true)
    expect(dataSource.accept).toHaveBeenCalledTimes(1)
  })

  it('different entries are independent operations', async () => {
    const dataSource = spyDataSource()
    const actions = createStagedDiffActions(dataSource, decisionWorkspace)
    await Promise.all([actions.accept(makeEntry()), actions.accept(makeEntry())])
    expect(dataSource.accept).toHaveBeenCalledTimes(2)
  })

  it('maps failure envelopes to display errors (retryable apply failure)', async () => {
    const entry = makeEntry()
    const dataSource = spyDataSource({
      accept: vi.fn(async () => envelopeError(failure({
        code: GRAY_REMOTE_ERROR_CODES.CONFLICT,
        details: { causeCode: GRAY_STAGED_CAUSE_CODES.APPLY_FAILED, entry },
      }))),
    })
    const actions = createStagedDiffActions(dataSource, decisionWorkspace)
    const outcome: StagedDiffDecisionOutcome = await actions.accept(entry)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('applyFailed')
      expect(outcome.error.retryable).toBe(true)
      expect(outcome.error.entry).toEqual(entry)
    }
  })

  it('reject goes through the reject endpoint with the CAS revision', async () => {
    const dataSource = spyDataSource()
    const actions = createStagedDiffActions(dataSource, decisionWorkspace)
    const entry = makeEntry({ revision: 7 })
    const outcome = await actions.reject(entry)
    expect(outcome.ok).toBe(true)
    expect(dataSource.reject).toHaveBeenCalledWith({ entryId: entry.id, expectedRevision: 7, workspace: decisionWorkspace })
  })

  it('never throws: an unexpected data-source rejection becomes an internal outcome', async () => {
    const dataSource = spyDataSource({
      accept: vi.fn(async () => { throw new Error('transport broke') }),
    })
    const actions = createStagedDiffActions(dataSource, decisionWorkspace)
    const outcome = await actions.accept(makeEntry())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('internal')
  })

  it('retryable failures are not cached — the next accept re-invokes the data source', async () => {
    const entry = makeEntry()
    const dataSource = spyDataSource({
      accept: vi.fn(async () => envelopeError(failure({
        code: GRAY_REMOTE_ERROR_CODES.CONFLICT,
        details: { causeCode: GRAY_STAGED_CAUSE_CODES.APPLY_FAILED, entry },
      }))),
    })
    const actions = createStagedDiffActions(dataSource, decisionWorkspace)
    const first = await actions.accept(entry)
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.error.retryable).toBe(true)
    // A retryable failure (GRAY_STAGED_APPLY_FAILED) must NOT be replayed
    // from the tracker: the next click re-attempts the decision.
    const second = await actions.accept(entry)
    expect(second.ok).toBe(false)
    expect(dataSource.accept).toHaveBeenCalledTimes(2)
  })

  it('successful outcomes stay cached (same-entry double click stays deduped)', async () => {
    const dataSource = spyDataSource()
    const actions = createStagedDiffActions(dataSource, decisionWorkspace)
    const entry = makeEntry()
    await actions.accept(entry)
    await actions.accept(entry)
    expect(dataSource.accept).toHaveBeenCalledTimes(1)
  })

  it('non-retryable failures are not cached either (no stale-error replay)', async () => {
    const entry = makeEntry()
    const dataSource = spyDataSource({
      accept: vi.fn(async () => envelopeError(failure({ code: GRAY_REMOTE_ERROR_CODES.ENDPOINT_NOT_FOUND }))),
    })
    const actions = createStagedDiffActions(dataSource, decisionWorkspace)
    await actions.accept(entry)
    await actions.accept(entry)
    expect(dataSource.accept).toHaveBeenCalledTimes(2)
  })

  it('rejects a blank workspace before invoking the data source', () => {
    const dataSource = spyDataSource()
    expect(() => createStagedDiffActions(dataSource, '   ')).toThrow('workspace is required')
    expect(dataSource.accept).not.toHaveBeenCalled()
    expect(dataSource.reject).not.toHaveBeenCalled()
  })

  it('times out a hanging decision into a retryable timeout outcome (3.8-M1)', async () => {
    const entry = makeEntry()
    const dataSource = spyDataSource({
      accept: vi.fn(() => new Promise<never>(() => { /* never settles */ })),
    })
    const actions = createStagedDiffActions(dataSource, decisionWorkspace, { timeoutMs: 10 })
    const outcome = await actions.accept(entry)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('timeout')
      expect(outcome.error.retryable).toBe(true)
    }
    // The busy/in-flight state is released after the timeout — retry is possible.
    expect(actions.isInFlight(entry.id)).toBe(false)
  })

  it('traps a synchronous data-source throw as an internal outcome (4.8-L3)', async () => {
    const entry = makeEntry()
    const dataSource = spyDataSource({
      accept: vi.fn(() => { throw new Error('sync transport break') }),
    })
    const actions = createStagedDiffActions(dataSource, decisionWorkspace)
    const outcome = await actions.accept(entry)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('internal')
    expect(actions.isInFlight(entry.id)).toBe(false)
  })

  it('refuses a decision whose workspace differs from the entry (3.8-M4 pre-check)', async () => {
    const dataSource = spyDataSource()
    const actions = createStagedDiffActions(dataSource, decisionWorkspace, {
      workspaceIdOf: () => 'ws-other',
    })
    const entry = makeEntry({ workspaceId: 'ws-a' })
    const outcome = await actions.accept(entry)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe('workspaceConflict')
    expect(dataSource.accept).not.toHaveBeenCalled()
  })

  it('proceeds when the workspace resolver matches the entry', async () => {
    const dataSource = spyDataSource()
    const actions = createStagedDiffActions(dataSource, decisionWorkspace, {
      workspaceIdOf: () => 'ws-a',
    })
    const entry = makeEntry({ workspaceId: 'ws-a' })
    const outcome = await actions.accept(entry)
    expect(outcome.ok).toBe(true)
    expect(dataSource.accept).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Mock data source
// ---------------------------------------------------------------------------

describe('mock data source (host-consistent semantics)', () => {
  const decisionWorkspace = 'C:\\dev\\alpha'
  // Entries seeded for this workspace must use the mock's derived id so the
  // workspace-conflict guard (3.8-M4) passes on the happy path.
  const mockWorkspaceId = mockWorkspaceIdOf(decisionWorkspace)
  it('accept runs pending → accepted → done with revision +2', async () => {
    const entry = makeEntry({ id: 'm1', workspaceId: mockWorkspaceId, status: 'pending', revision: 1 })
    const dataSource = createMockStagedDiffDataSource([entry])
    const result = await dataSource.accept({ entryId: 'm1', expectedRevision: 1, workspace: decisionWorkspace })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe('done')
      expect(result.value.revision).toBe(3)
    }
    // The store now projects done.
    const list = await dataSource.list({ statuses: ['done'] })
    expect(list.ok && list.value.items.map(e => e.id)).toEqual(['m1'])
  })

  it('accept accepts needs-reapply entries (crash-recovery decision)', async () => {
    const entry = makeEntry({ id: 'm2', workspaceId: mockWorkspaceId, status: 'needs-reapply', revision: 4 })
    const dataSource = createMockStagedDiffDataSource([entry])
    const result = await dataSource.accept({ entryId: 'm2', expectedRevision: 4, workspace: decisionWorkspace })
    expect(result.ok && result.value.status).toBe('done')
  })

  it('stale CAS revision → GRAY_CONFLICT with causeCode + authoritative entry', async () => {
    const entry = makeEntry({ id: 'm3', workspaceId: mockWorkspaceId, status: 'pending', revision: 2 })
    const dataSource = createMockStagedDiffDataSource([entry])
    const result = await dataSource.accept({ entryId: 'm3', expectedRevision: 1, workspace: decisionWorkspace })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(GRAY_REMOTE_ERROR_CODES.CONFLICT)
      expect(result.error.details.causeCode).toBe(GRAY_STAGED_CAUSE_CODES.REVISION_CONFLICT)
      expect(result.error.details.entry).toMatchObject({ id: 'm3', revision: 2 })
    }
  })

  it('applyFailures keeps the entry accepted (retryable) instead of faking done, then succeeds', async () => {
    const entry = makeEntry({ id: 'm4', workspaceId: mockWorkspaceId, status: 'pending', revision: 1 })
    const dataSource = createMockStagedDiffDataSource([entry], { applyFailures: 1 })
    const result = await dataSource.accept({ entryId: 'm4', expectedRevision: 1, workspace: decisionWorkspace })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.details.causeCode).toBe(GRAY_STAGED_CAUSE_CODES.APPLY_FAILED)
      // The authoritative snapshot shows accepted (persisted) — not done.
      expect(result.error.details.entry).toMatchObject({ status: 'accepted', revision: 2 })
    }
    // Retrying with the refreshed revision succeeds once the write recovers.
    const retry = await dataSource.accept({ entryId: 'm4', expectedRevision: 2, workspace: decisionWorkspace })
    expect(retry.ok && retry.value.status).toBe('done')
    if (retry.ok) expect(retry.value.revision).toBe(3)
  })

  it('repeated apply failures never fake done and do not bump the revision further', async () => {
    const entry = makeEntry({ id: 'm4b', workspaceId: mockWorkspaceId, status: 'pending', revision: 1 })
    const dataSource = createMockStagedDiffDataSource([entry], { applyFailures: 10 })
    await dataSource.accept({ entryId: 'm4b', expectedRevision: 1, workspace: decisionWorkspace })
    const again = await dataSource.accept({ entryId: 'm4b', expectedRevision: 2, workspace: decisionWorkspace })
    expect(again.ok).toBe(false)
    if (!again.ok) {
      expect(again.error.details.entry).toMatchObject({ status: 'accepted', revision: 2 })
    }
  })

  it('reject transitions to rejected (revision +1) and is idempotent afterwards', async () => {
    const entry = makeEntry({ id: 'm5', workspaceId: mockWorkspaceId, status: 'reviewing', revision: 1 })
    const dataSource = createMockStagedDiffDataSource([entry])
    const result = await dataSource.reject({ entryId: 'm5', expectedRevision: 1, workspace: decisionWorkspace })
    expect(result.ok && result.value.status).toBe('rejected')
    if (result.ok) expect(result.value.revision).toBe(2)
    // Rejecting again with the matching revision is an idempotent success.
    const again = await dataSource.reject({ entryId: 'm5', expectedRevision: 2, workspace: decisionWorkspace })
    expect(again.ok && again.value.status).toBe('rejected')
  })

  it('rejectConflict returns GRAY_STAGED_REJECT_CONFLICT', async () => {
    const entry = makeEntry({ id: 'm6', workspaceId: mockWorkspaceId, status: 'pending', before: 'snapshot' })
    const dataSource = createMockStagedDiffDataSource([entry], { rejectConflict: true })
    const result = await dataSource.reject({ entryId: 'm6', expectedRevision: 1, workspace: decisionWorkspace })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.details.causeCode).toBe(GRAY_STAGED_CAUSE_CODES.REJECT_CONFLICT)
    }
  })

  it('done entries cannot be rejected; rejected entries cannot be accepted', async () => {
    const done = makeEntry({ id: 'm7', workspaceId: mockWorkspaceId, status: 'done', revision: 1 })
    const rejected = makeEntry({ id: 'm8', workspaceId: mockWorkspaceId, status: 'rejected', revision: 1 })
    const dataSource = createMockStagedDiffDataSource([done, rejected])
    const rejectDone = await dataSource.reject({ entryId: 'm7', expectedRevision: 1, workspace: decisionWorkspace })
    expect(rejectDone.ok).toBe(false)
    if (!rejectDone.ok) {
      expect(rejectDone.error.details.causeCode).toBe(GRAY_STAGED_CAUSE_CODES.ILLEGAL_TRANSITION)
    }
    const acceptRejected = await dataSource.accept({ entryId: 'm8', expectedRevision: 1, workspace: decisionWorkspace })
    expect(acceptRejected.ok).toBe(false)
    if (!acceptRejected.ok) {
      expect(acceptRejected.error.details.causeCode).toBe(GRAY_STAGED_CAUSE_CODES.ILLEGAL_TRANSITION)
    }
  })

  it('accept of an already-done entry with matching revision is idempotent', async () => {
    const done = makeEntry({ id: 'm9', workspaceId: mockWorkspaceId, status: 'done', revision: 3 })
    const dataSource = createMockStagedDiffDataSource([done])
    const result = await dataSource.accept({ entryId: 'm9', expectedRevision: 3, workspace: decisionWorkspace })
    expect(result.ok && result.value.status).toBe('done')
  })

  it('list filters by workspace/session/statuses, sorts updatedAt desc, and pages by cursor', async () => {
    const entries = [
      makeEntry({ id: 'a', status: 'pending', updatedAt: 100 }),
      makeEntry({ id: 'b', status: 'pending', updatedAt: 300 }),
      makeEntry({ id: 'c', status: 'reviewing', updatedAt: 200 }),
      makeEntry({ id: 'd', status: 'pending', updatedAt: 400, sessionId: 'other' }),
    ]
    const dataSource = createMockStagedDiffDataSource(entries)
    const page1 = await dataSource.list({ workspaceId: 'ws-a', sessionId: 'session-1', statuses: ['pending'], limit: 1 })
    expect(page1.ok).toBe(true)
    if (page1.ok) {
      expect(page1.value.items.map(e => e.id)).toEqual(['b'])
      expect(page1.value.total).toBe(2)
      expect(page1.value.nextCursor).toBe('b')
      const page2 = await dataSource.list({ workspaceId: 'ws-a', sessionId: 'session-1', statuses: ['pending'], limit: 1, cursor: page1.value.nextCursor })
      expect(page2.ok && page2.value.items.map(e => e.id)).toEqual(['a'])
      expect(page2.ok && page2.value.nextCursor).toBeUndefined()
    }
  })

  it('preview returns the entry or a NOT_FOUND envelope', async () => {
    const entry = makeEntry({ id: 'm10' })
    const dataSource = createMockStagedDiffDataSource([entry])
    const found = await dataSource.preview('m10')
    expect(found.ok && found.value.id).toBe('m10')
    const missing = await dataSource.preview('nope')
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.error.code).toBe(GRAY_REMOTE_ERROR_CODES.NOT_FOUND)
      expect(missing.error.details.causeCode).toBe(GRAY_STAGED_CAUSE_CODES.ENTRY_NOT_FOUND)
    }
  })

  it('failMutationsWith simulates an unwired/broken host for every mutation', async () => {
    const entry = makeEntry({ id: 'm11' })
    const envelope = envelopeError(failure({ code: GRAY_REMOTE_ERROR_CODES.ENDPOINT_NOT_FOUND }))
    const dataSource = createMockStagedDiffDataSource([entry], { failMutationsWith: envelope.error })
    const accept = await dataSource.accept({ entryId: 'm11', expectedRevision: 1, workspace: decisionWorkspace })
    expect(accept.ok).toBe(false)
    const reject = await dataSource.reject({ entryId: 'm11', expectedRevision: 1, workspace: decisionWorkspace })
    expect(reject.ok).toBe(false)
    if (!reject.ok) expect(reject.error.code).toBe(GRAY_REMOTE_ERROR_CODES.ENDPOINT_NOT_FOUND)
  })

  it('exposes latency asynchronously without breaking the envelope contract', async () => {
    const entry = makeEntry({ id: 'm12' })
    const dataSource = createMockStagedDiffDataSource([entry], { latencyMs: 5 })
    const result = await dataSource.preview('m12')
    expect(result.ok && result.value.id).toBe('m12')
  })

  it('refuses accept/reject against a different workspace (GRAY_STAGED_WORKSPACE_CONFLICT)', async () => {
    const entry = makeEntry({ id: 'm13', workspaceId: 'ws-other', status: 'pending', revision: 1 })
    const dataSource = createMockStagedDiffDataSource([entry])
    const accept = await dataSource.accept({ entryId: 'm13', expectedRevision: 1, workspace: decisionWorkspace })
    expect(accept.ok).toBe(false)
    if (!accept.ok) {
      expect(accept.error.code).toBe(GRAY_REMOTE_ERROR_CODES.CONFLICT)
      expect(accept.error.details.causeCode).toBe(GRAY_STAGED_CAUSE_CODES.WORKSPACE_CONFLICT)
    }
    const reject = await dataSource.reject({ entryId: 'm13', expectedRevision: 1, workspace: decisionWorkspace })
    expect(reject.ok).toBe(false)
    if (!reject.ok) expect(reject.error.details.causeCode).toBe(GRAY_STAGED_CAUSE_CODES.WORKSPACE_CONFLICT)
  })

  it('rejecting an accepted entry returns an ILLEGAL_TRANSITION envelope instead of throwing (4.8-L2)', async () => {
    const entry = makeEntry({ id: 'm14', workspaceId: mockWorkspaceId, status: 'accepted', revision: 1 })
    const dataSource = createMockStagedDiffDataSource([entry])
    const result = await dataSource.reject({ entryId: 'm14', expectedRevision: 1, workspace: decisionWorkspace })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(GRAY_REMOTE_ERROR_CODES.CONFLICT)
      expect(result.error.details.causeCode).toBe(GRAY_STAGED_CAUSE_CODES.ILLEGAL_TRANSITION)
    }
  })
})

// ---------------------------------------------------------------------------
// Locale alignment
// ---------------------------------------------------------------------------

describe('graycode.stagedDiffCard locale dictionaries', () => {
  it('registers the expected namespace constant', () => {
    expect(GRAYCODE_STAGED_DIFF_CARD_NS).toBe('graycode.stagedDiffCard')
  })

  it('keeps zh/en dictionaries balanced (identical key sets)', () => {
    const en = Object.keys(graycodeStagedDiffCardDictionaries.en).sort()
    const zh = Object.keys(graycodeStagedDiffCardDictionaries.zh).sort()
    expect(zh).toEqual(en)
  })

  it('keeps the ja placeholder on the same key set', () => {
    expect(Object.keys(graycodeStagedDiffCardJaPlaceholder).sort()).toEqual(
      Object.keys(graycodeStagedDiffCardDictionaries.en).sort(),
    )
  })

  it('fills every shipped locale with non-empty text', () => {
    for (const dict of Object.values(graycodeStagedDiffCardDictionaries)) {
      for (const text of Object.values(dict)) {
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })

  it('covers every status badge key and every error kind key', () => {
    const keys = new Set(Object.keys(graycodeStagedDiffCardDictionaries.en))
    for (const status of STAGED_ENTRY_STATUSES) {
      expect(keys.has(stagedStatusLocaleKey(status))).toBe(true)
    }
    const kinds: Array<StagedDiffCardError['kind']> = [
      'revisionConflict', 'rejectConflict', 'applyFailed', 'illegalTransition',
      'workspaceConflict', 'conflict', 'notFound', 'endpointNotFound',
      'approvalRequired', 'cancelled', 'timeout', 'storageCorrupt',
      'invalidInput', 'internal',
    ]
    for (const kind of kinds) {
      expect(keys.has(`error.${kind}`)).toBe(true)
    }
    for (const kind of ['create', 'delete', 'modify'] as const) {
      expect(keys.has(`summary.${kind}`)).toBe(true)
    }
  })
})
