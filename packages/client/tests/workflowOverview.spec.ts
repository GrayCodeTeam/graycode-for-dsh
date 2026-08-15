/**
 * P4-02 workflow overview — pure-logic tests.
 *
 * Covers: the list query model (workspace/session filters, limit
 * normalization, wire-request contract honesty), the defensive envelope/item
 * readers (wire.ts), the error-code → hint mapping (errors.ts), view-model
 * construction (viewModel.ts), the paged list state machine (paging.ts), the
 * mock data source (host-identical cursor semantics), the remote consumer
 * against a fake transport, and locale alignment.
 *
 * React is intentionally not imported: these are node-environment tests of
 * the replay-safe pure logic (the components are not rendered here).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  WORKFLOW_PAGE_LIMIT_DEFAULT,
  WORKFLOW_PAGE_LIMIT_MAX,
  WORKFLOW_SESSION_FILTER_AVAILABLE,
  buildWorkflowListRequest,
  createWorkflowOverviewQuery,
  normalizeWorkflowPageLimit,
  withWorkflowSession,
  withWorkflowWorkspace,
} from '../src/client/workflowOverview/query.ts'
import {
  readWorkflowEnvelope,
  readWorkflowFailure,
  readWorkflowListResult,
  readWorkflowRunDetail,
  readWorkflowRunSummary,
  readWorkflowThrownError,
} from '../src/client/workflowOverview/wire.ts'
import {
  isWorkflowErrorRetryable,
  workflowOverviewErrorHint,
  workflowOverviewErrorKey,
} from '../src/client/workflowOverview/errors.ts'
import {
  buildWorkflowListView,
  buildWorkflowRunView,
  formatWorkflowRunSize,
  formatWorkflowRunTime,
  workflowKindLabelKey,
  workflowPhaseLabelKey,
  workflowStatusLabelKey,
  workspaceLabelOf,
} from '../src/client/workflowOverview/viewModel.ts'
import {
  applyWorkflowPageError,
  applyWorkflowPageLoaded,
  applyWorkflowPageLoading,
  createWorkflowOverviewPageState,
  isWorkflowAppendCurrent,
  mergeWorkflowRunViews,
  nextWorkflowPageRequest,
} from '../src/client/workflowOverview/paging.ts'
import {
  MockWorkflowOverviewDataSource,
  RemoteWorkflowOverviewDataSource,
  createMockWorkflowRuns,
  type WorkflowRemoteTransport,
} from '../src/client/workflowOverview/dataSource.ts'
import type { WorkflowRunSummaryLike } from '../src/client/workflowOverview/types.ts'
import {
  GRAYCODE_WORKFLOW_OVERVIEW_NS,
  graycodeWorkflowOverviewDictionaries,
  graycodeWorkflowOverviewJaPlaceholder,
} from '../src/client/workflowOverview/locales.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function summary(partial: Partial<WorkflowRunSummaryLike> = {}): WorkflowRunSummaryLike {
  return {
    id: '.graycode/progress.md',
    kind: 'progress',
    path: '.graycode/progress.md',
    workspace: 'C:\\dev\\alpha',
    updatedAt: 1_700_000_000_000,
    sizeBytes: 2048,
    status: 'active',
    phase: 'implementation',
    projectName: 'Alpha',
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// Query model
// ---------------------------------------------------------------------------

describe('workflow overview query model', () => {
  it('creates a normalized default query', () => {
    const query = createWorkflowOverviewQuery()
    expect(query.workspace).toBeNull()
    expect(query.sessionId).toBeNull()
    expect(query.limit).toBe(WORKFLOW_PAGE_LIMIT_DEFAULT)
  })

  it('normalizes the page limit like the host', () => {
    expect(normalizeWorkflowPageLimit(undefined)).toBe(WORKFLOW_PAGE_LIMIT_DEFAULT)
    expect(normalizeWorkflowPageLimit(null)).toBe(WORKFLOW_PAGE_LIMIT_DEFAULT)
    expect(normalizeWorkflowPageLimit(0)).toBe(WORKFLOW_PAGE_LIMIT_DEFAULT)
    expect(normalizeWorkflowPageLimit(-3)).toBe(WORKFLOW_PAGE_LIMIT_DEFAULT)
    expect(normalizeWorkflowPageLimit(Number.NaN)).toBe(WORKFLOW_PAGE_LIMIT_DEFAULT)
    expect(normalizeWorkflowPageLimit(12.5)).toBe(WORKFLOW_PAGE_LIMIT_DEFAULT)
    expect(normalizeWorkflowPageLimit(50)).toBe(50)
    expect(normalizeWorkflowPageLimit(WORKFLOW_PAGE_LIMIT_MAX)).toBe(WORKFLOW_PAGE_LIMIT_MAX)
    expect(normalizeWorkflowPageLimit(5000)).toBe(WORKFLOW_PAGE_LIMIT_MAX)
  })

  it('updates filters immutably', () => {
    const base = createWorkflowOverviewQuery({ workspace: 'C:\\a' })
    const next = withWorkflowWorkspace(base, 'C:\\b')
    expect(next.workspace).toBe('C:\\b')
    expect(base.workspace).toBe('C:\\a')
    const withSession = withWorkflowSession(base, 's1')
    expect(withSession.sessionId).toBe('s1')
    expect(base.sessionId).toBeNull()
  })

  it('declares the session filter unavailable on rc.6 (GAP-remote-1)', () => {
    expect(WORKFLOW_SESSION_FILTER_AVAILABLE).toBe(false)
  })

  it('maps a query onto the workflows/list wire args', () => {
    const query = createWorkflowOverviewQuery({ workspace: '  C:\\dev\\alpha  ', limit: 5 })
    expect(buildWorkflowListRequest(query)).toEqual({ workspace: 'C:\\dev\\alpha', limit: 5 })
    expect(buildWorkflowListRequest(query, '.graycode/review/r1.md')).toEqual({
      workspace: 'C:\\dev\\alpha',
      cursor: '.graycode/review/r1.md',
      limit: 5,
    })
  })

  it('never forwards the session filter to the wire (contract honesty)', () => {
    const query = createWorkflowOverviewQuery({ sessionId: 'session-42', workspace: 'C:\\a' })
    const request = buildWorkflowListRequest(query)
    expect(request).toEqual({ workspace: 'C:\\a', limit: WORKFLOW_PAGE_LIMIT_DEFAULT })
    expect(request).not.toBeNull()
    expect('sessionId' in request!).toBe(false)
    expect('session' in request!).toBe(false)
  })

  it('refuses to build a request without an explicit workspace', () => {
    const request = buildWorkflowListRequest(createWorkflowOverviewQuery())
    expect(request).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Wire readers (contract-driven envelope narrowing)
// ---------------------------------------------------------------------------

describe('workflow wire readers', () => {
  it('reads a well-formed run summary', () => {
    expect(readWorkflowRunSummary(summary())).toEqual(summary())
  })

  it('drops malformed summaries (missing identity, unknown kind, wrong types)', () => {
    expect(readWorkflowRunSummary(null)).toBeNull()
    expect(readWorkflowRunSummary({ kind: 'progress', path: 'p.md', workspace: 'w' })).toBeNull() // no id
    expect(readWorkflowRunSummary({ id: 'i', kind: 'unknown', path: 'p.md', workspace: 'w' })).toBeNull()
    expect(readWorkflowRunSummary({ id: 'i', kind: 'progress', path: 'p.md', workspace: 42 })).toBeNull()
    expect(readWorkflowRunSummary({ id: 'i', kind: 'progress', path: 'p.md', workspace: 'w', status: 7 })).not.toBeNull() // optional junk dropped
  })

  it('normalizes optional numeric fields defensively', () => {
    const run = readWorkflowRunSummary({
      id: 'i',
      kind: 'design',
      path: 'p.md',
      workspace: 'w',
      updatedAt: Number.NaN,
      sizeBytes: 12.9,
    })
    expect(run).not.toBeNull()
    expect(run!.updatedAt).toBeUndefined()
    expect(run!.sizeBytes).toBe(12)
  })

  it('reads a list result, dropping malformed items and trusting total', () => {
    const result = readWorkflowListResult({
      items: [summary(), { id: 'bad' }, summary({ id: '.graycode/review/r1.md', kind: 'review' })],
      total: 17,
      nextCursor: '.graycode/review/r1.md',
    })
    expect(result).not.toBeNull()
    expect(result!.items).toHaveLength(2)
    expect(result!.total).toBe(17)
    expect(result!.nextCursor).toBe('.graycode/review/r1.md')
  })

  it('rejects a list payload without an items array', () => {
    expect(readWorkflowListResult({ total: 3 })).toBeNull()
    expect(readWorkflowListResult(null)).toBeNull()
  })

  it('reads a run detail with metadata', () => {
    const detail = readWorkflowRunDetail({
      ...summary(),
      content: '# body',
      metadata: { status: 'active' },
    })
    expect(detail).not.toBeNull()
    expect(detail!.content).toBe('# body')
    expect(detail!.metadata).toEqual({ status: 'active' })
    expect(readWorkflowRunDetail({ ...summary(), content: 42 })).toBeNull()
  })

  it('narrows ok and error envelopes', () => {
    const ok = readWorkflowEnvelope({ ok: true, value: { items: [] } })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.value).toEqual({ items: [] })
    const err = readWorkflowEnvelope({
      ok: false,
      error: { code: 'GRAY_NOT_FOUND', message: 'x', details: { id: 'i' } },
    })
    expect(err.ok).toBe(false)
    if (!err.ok) {
      expect(err.error.code).toBe('GRAY_NOT_FOUND')
      expect(err.error.details).toEqual({ id: 'i' })
    }
  })

  it('degrades malformed envelopes to a stable GRAY_INTERNAL failure', () => {
    // `{ ok: true }` is a well-formed envelope shape (the value reader then
    // rejects its payload); these are the truly malformed shapes.
    for (const bad of [null, 42, 'x', { ok: 'yes' }, { ok: false }, { ok: false, error: { message: 'no code' } }]) {
      const envelope = readWorkflowEnvelope(bad)
      expect(envelope.ok).toBe(false)
      if (!envelope.ok) expect(envelope.error.code).toBe('GRAY_INTERNAL')
    }
  })

  it('normalizes arbitrary thrown values into stable failures', () => {
    expect(readWorkflowThrownError(new Error('boom'))).toEqual({
      code: 'GRAY_INTERNAL',
      message: 'unexpected error',
      details: {},
    })
    expect(readWorkflowThrownError({ code: 'GRAY_CANCELLED', message: 'cancelled' }).code).toBe('GRAY_CANCELLED')
  })
})

// ---------------------------------------------------------------------------
// Error-code → hint mapping
// ---------------------------------------------------------------------------

describe('workflow overview error mapping', () => {
  const EXPECTED: Readonly<Record<string, { key: string; retryable: boolean }>> = {
    GRAY_INVALID_INPUT: { key: 'error.invalidInput', retryable: false },
    GRAY_CONFLICT: { key: 'error.conflict', retryable: false },
    GRAY_APPROVAL_REQUIRED: { key: 'error.approvalRequired', retryable: false },
    GRAY_CANCELLED: { key: 'error.cancelled', retryable: false },
    GRAY_STORAGE_CORRUPT: { key: 'error.storageCorrupt', retryable: false },
    GRAY_NOT_FOUND: { key: 'error.notFound', retryable: false },
    GRAY_ENDPOINT_NOT_FOUND: { key: 'error.endpointNotFound', retryable: false },
    GRAY_INTERNAL: { key: 'error.internal', retryable: true },
  }

  it('maps every stable GRAY_* code to its hint', () => {
    for (const [code, expected] of Object.entries(EXPECTED)) {
      expect(workflowOverviewErrorHint(code), code).toEqual(expected)
      expect(workflowOverviewErrorKey(code), code).toBe(expected.key)
      expect(isWorkflowErrorRetryable(code), code).toBe(expected.retryable)
    }
  })

  it('falls back to a retryable unknown hint for unknown/absent codes', () => {
    expect(workflowOverviewErrorHint('GRAY_WHATEVER')).toEqual({ key: 'error.unknown', retryable: true })
    expect(workflowOverviewErrorHint(undefined)).toEqual({ key: 'error.unknown', retryable: true })
    expect(workflowOverviewErrorHint(null)).toEqual({ key: 'error.unknown', retryable: true })
  })
})

// ---------------------------------------------------------------------------
// View-model construction
// ---------------------------------------------------------------------------

describe('workflow overview view model', () => {
  it('derives short workspace labels for POSIX and Windows roots', () => {
    expect(workspaceLabelOf('/home/dev/beta')).toBe('beta')
    expect(workspaceLabelOf('C:\\dev\\alpha')).toBe('alpha')
    expect(workspaceLabelOf('C:\\dev\\alpha\\')).toBe('alpha')
    expect(workspaceLabelOf('C:\\')).toBe('C:')
    expect(workspaceLabelOf('')).toBe('')
  })

  it('maps the four kinds to locale keys and rejects unknown kinds', () => {
    expect(workflowKindLabelKey('progress')).toBe('kind.progress')
    expect(workflowKindLabelKey('design')).toBe('kind.design')
    expect(workflowKindLabelKey('plan')).toBe('kind.plan')
    expect(workflowKindLabelKey('review')).toBe('kind.review')
    expect(workflowKindLabelKey('unknown')).toBeNull()
  })

  it('maps known progress statuses/phases and rejects unknown/absent values', () => {
    for (const status of ['active', 'blocked', 'completed', 'archived'] as const) {
      expect(workflowStatusLabelKey(status)).toBe(`runStatus.${status}`)
    }
    expect(workflowStatusLabelKey('draft')).toBeNull()
    expect(workflowStatusLabelKey(undefined)).toBeNull()
    for (const phase of ['design', 'plan', 'implementation', 'review', 'maintenance'] as const) {
      expect(workflowPhaseLabelKey(phase)).toBe(`phase.${phase}`)
    }
    expect(workflowPhaseLabelKey('deploy')).toBeNull()
  })

  it('builds a normalized run view from a summary', () => {
    const view = buildWorkflowRunView(summary())
    expect(view).toEqual({
      id: '.graycode/progress.md',
      kind: 'progress',
      path: '.graycode/progress.md',
      workspace: 'C:\\dev\\alpha',
      workspaceLabel: 'alpha',
      updatedAt: 1_700_000_000_000,
      sizeBytes: 2048,
      status: 'active',
      phase: 'implementation',
      projectName: 'Alpha',
      kindLabelKey: 'kind.progress',
      statusLabelKey: 'runStatus.active',
      phaseLabelKey: 'phase.implementation',
    })
  })

  it('nulls absent optional fields (non-progress kinds, missing metadata)', () => {
    const view = buildWorkflowRunView(summary({
      kind: 'design',
      updatedAt: undefined,
      sizeBytes: undefined,
      status: undefined,
      phase: undefined,
      projectName: undefined,
    }))
    expect(view.updatedAt).toBeNull()
    expect(view.sizeBytes).toBeNull()
    expect(view.status).toBeNull()
    expect(view.phase).toBeNull()
    expect(view.projectName).toBeNull()
    expect(view.statusLabelKey).toBeNull()
    expect(view.phaseLabelKey).toBeNull()
    expect(view.kindLabelKey).toBe('kind.design')
  })

  it('builds a page view with hasMore following the cursor contract', () => {
    const withMore = buildWorkflowListView({
      items: [summary(), summary({ id: 'b', kind: 'review' })],
      total: 5,
      nextCursor: 'b',
    })
    expect(withMore.entries).toHaveLength(2)
    expect(withMore.total).toBe(5)
    expect(withMore.hasMore).toBe(true)
    expect(withMore.nextCursor).toBe('b')

    const done = buildWorkflowListView({ items: [summary()], total: 1 })
    expect(done.hasMore).toBe(false)
    expect(done.nextCursor).toBeNull()

    // a next cursor with no items cannot page further (defensive)
    const empty = buildWorkflowListView({ items: [], total: 0, nextCursor: 'x' })
    expect(empty.hasMore).toBe(false)
  })

  it('formats sizes into value + unit locale keys', () => {
    expect(formatWorkflowRunSize(null)).toBeNull()
    expect(formatWorkflowRunSize(undefined)).toBeNull()
    expect(formatWorkflowRunSize(0)).toEqual({ value: '0', unitKey: 'size.bytes' })
    expect(formatWorkflowRunSize(1023)).toEqual({ value: '1023', unitKey: 'size.bytes' })
    expect(formatWorkflowRunSize(1024)).toEqual({ value: '1.0', unitKey: 'size.kb' })
    expect(formatWorkflowRunSize(1536)).toEqual({ value: '1.5', unitKey: 'size.kb' })
    expect(formatWorkflowRunSize(1048576)).toEqual({ value: '1.0', unitKey: 'size.mb' })
    expect(formatWorkflowRunSize(1073741824)).toEqual({ value: '1.0', unitKey: 'size.gb' })
    // values >= 100 render as integers (the format rule), so 111.8 rounds
    expect(formatWorkflowRunSize(120000000000)).toEqual({ value: '112', unitKey: 'size.gb' })
  })

  it('formats timestamps with a neutral dash for absent values', () => {
    expect(formatWorkflowRunTime(null)).toBe('—')
    expect(formatWorkflowRunTime(Number.NaN)).toBe('—')
    expect(formatWorkflowRunTime(1_700_000_000_000)).not.toBe('—')
  })
})

// ---------------------------------------------------------------------------
// Paged list state machine
// ---------------------------------------------------------------------------

describe('workflow overview paging', () => {
  it('starts idle and empty', () => {
    const state = createWorkflowOverviewPageState()
    expect(state.phase).toBe('idle')
    expect(state.entries).toEqual([])
    expect(state.revision).toBe(0)
    expect(state.hasMore).toBe(false)
  })

  it('marks loading (idempotent) and keeps entries', () => {
    const loaded = applyWorkflowPageLoaded(createWorkflowOverviewPageState(), {
      items: [summary()],
      total: 1,
    }, 'replace')
    const loading = applyWorkflowPageLoading(loaded)
    expect(loading.phase).toBe('loading')
    expect(loading.entries).toHaveLength(1)
    expect(loading.revision).toBe(loaded.revision + 1)
    expect(applyWorkflowPageLoading(loading)).toBe(loading)
  })

  it('replace installs a fresh page and append accumulates with id dedupe', () => {
    const first = applyWorkflowPageLoaded(createWorkflowOverviewPageState(), {
      items: [summary(), summary({ id: '.graycode/review/r1.md', kind: 'review' })],
      total: 4,
      nextCursor: '.graycode/review/r1.md',
    }, 'replace')
    expect(first.phase).toBe('ready')
    expect(first.entries).toHaveLength(2)
    expect(first.total).toBe(4)
    expect(first.hasMore).toBe(true)

    // boundary re-delivery of the last id must not duplicate
    const second = applyWorkflowPageLoaded(first, {
      items: [
        summary({ id: '.graycode/review/r1.md', kind: 'review' }),
        summary({ id: '.graycode/plans/p4.md', kind: 'plan' }),
      ],
      total: 4,
    }, 'append')
    expect(second.entries.map((run) => run.id)).toEqual([
      '.graycode/progress.md',
      '.graycode/review/r1.md',
      '.graycode/plans/p4.md',
    ])
    expect(second.hasMore).toBe(false)
    expect(second.revision).toBe(first.revision + 1)
  })

  it('merge keeps the first occurrence per id', () => {
    const a = buildWorkflowRunView(summary({ id: 'a', kind: 'review' }))
    const b = buildWorkflowRunView(summary({ id: 'b', kind: 'plan' }))
    const merged = mergeWorkflowRunViews([a, b], [b, a])
    expect(merged.map((run) => run.id)).toEqual(['a', 'b'])
  })

  it('records failures without dropping loaded entries', () => {
    const loaded = applyWorkflowPageLoaded(createWorkflowOverviewPageState(), {
      items: [summary()],
      total: 1,
    }, 'replace')
    const failed = applyWorkflowPageError(loaded, { code: 'GRAY_INTERNAL', message: 'x', details: {} })
    expect(failed.phase).toBe('error')
    expect(failed.error?.code).toBe('GRAY_INTERNAL')
    expect(failed.entries).toHaveLength(1)
    expect(failed.revision).toBe(loaded.revision + 1)
    // duplicate same-code error is a no-op
    expect(applyWorkflowPageError(failed, { code: 'GRAY_INTERNAL', message: 'x', details: {} })).toBe(failed)
  })

  it('refuses concurrent requests and serves retry after errors', () => {
    const loading = applyWorkflowPageLoading(createWorkflowOverviewPageState())
    expect(nextWorkflowPageRequest(loading)).toBeNull()

    const ready = applyWorkflowPageLoaded(createWorkflowOverviewPageState(), {
      items: [summary()],
      total: 3,
      nextCursor: '.graycode/progress.md',
    }, 'replace')
    expect(nextWorkflowPageRequest(ready)).toEqual({ cursor: '.graycode/progress.md' })

    const done = applyWorkflowPageLoaded(createWorkflowOverviewPageState(), { items: [summary()], total: 1 }, 'replace')
    expect(nextWorkflowPageRequest(done)).toEqual({ cursor: null })

    const failed = applyWorkflowPageError(createWorkflowOverviewPageState(), {
      code: 'GRAY_INTERNAL',
      message: 'x',
      details: {},
    })
    expect(nextWorkflowPageRequest(failed)).toEqual({ cursor: null }) // retry re-issues the first page
  })

  it('isWorkflowAppendCurrent accepts an untouched page and rejects a replaced one', () => {
    const loaded = applyWorkflowPageLoaded(createWorkflowOverviewPageState(), {
      items: [summary()],
      total: 1,
    }, 'replace')
    const loading = applyWorkflowPageLoading(loaded)
    const issuedRevision = loading.revision
    // Nothing intervened — the load-more response may still append.
    expect(isWorkflowAppendCurrent(loading, issuedRevision)).toBe(true)
    // A filter change replaced the list while the append was in flight.
    const replaced = applyWorkflowPageLoaded(createWorkflowOverviewPageState(), {
      items: [summary({ id: '.graycode/review/r1.md', kind: 'review' })],
      total: 1,
    }, 'replace')
    expect(isWorkflowAppendCurrent(replaced, issuedRevision)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Mock data source
// ---------------------------------------------------------------------------

describe('mock workflow overview data source', () => {
  it('serves one explicit workspace with host-identical cursor paging', async () => {
    const source = new MockWorkflowOverviewDataSource()
    const workspace = 'C:\\dev\\alpha'
    const first = await source.list({ workspace, limit: 2 })
    expect(first.total).toBe(createMockWorkflowRuns().filter(run => run.workspace === workspace).length)
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBe(first.items[1]!.id)

    const second = await source.list({ workspace, limit: 2, cursor: first.nextCursor })
    expect(second.items[0]!.id).not.toBe(first.items[1]!.id)
    expect(second.nextCursor).toBe(second.items[1]!.id)
  })

  it('walks every page without duplicates and terminates at the end', async () => {
    const source = new MockWorkflowOverviewDataSource()
    const seen: string[] = []
    let cursor: string | undefined
    // The fixture intentionally shares `.graycode/progress.md` across
    // workspaces (realistic); cursor paging is id-based and unambiguous only
    // within one workspace (host `slicePage` semantics), so walk one.
    const workspace = 'C:\\dev\\alpha'
    for (let page = 0; page < 20; page++) {
      const result = await source.list({ limit: 2, cursor, workspace })
      seen.push(...result.items.map((run) => run.id))
      if (result.nextCursor === undefined) break
      cursor = result.nextCursor
    }
    const runs = createMockWorkflowRuns().filter((run) => run.workspace === workspace)
    expect(seen).toHaveLength(runs.length)
    expect(new Set(seen).size).toBe(runs.length)
  })

  it('treats an unknown or deleted cursor as exhausted like the host', async () => {
    const source = new MockWorkflowOverviewDataSource()
    const workspace = 'C:\\dev\\alpha'
    const result = await source.list({ workspace, limit: 2, cursor: '.graycode/deleted.md' })
    expect(result).toEqual({ items: [], total: 5 })
    expect(result.nextCursor).toBeUndefined()
  })

  it('filters by exact workspace root like the host', async () => {
    const source = new MockWorkflowOverviewDataSource()
    const alpha = await source.list({ workspace: 'C:\\dev\\alpha' })
    expect(alpha.total).toBe(5)
    expect(alpha.items.every((run) => run.workspace === 'C:\\dev\\alpha')).toBe(true)
    const unknown = await source.list({ workspace: 'C:\\nope' })
    expect(unknown.total).toBe(0)
    expect(unknown.items).toEqual([])
    expect(unknown.nextCursor).toBeUndefined()
  })

  it('clamps the limit to the host max', async () => {
    const source = new MockWorkflowOverviewDataSource()
    const workspace = 'C:\\dev\\alpha'
    const all = await source.list({ workspace, limit: 10_000 })
    expect(all.items).toHaveLength(createMockWorkflowRuns().filter(run => run.workspace === workspace).length)
    expect(all.nextCursor).toBeUndefined()
  })

  it('get resolves details and null for unknown runs', async () => {
    const source = new MockWorkflowOverviewDataSource()
    const detail = await source.get({ id: '.graycode/progress.md', workspace: 'C:\\dev\\alpha' })
    expect(detail).not.toBeNull()
    expect(detail!.content).toContain('# .graycode/progress.md')
    expect(detail!.status).toBe('active')
    expect(await source.get({ id: '.graycode/nope.md', workspace: 'C:\\dev\\alpha' })).toBeNull()
    expect(await source.get({ id: '.graycode/progress.md', workspace: '/home/dev/beta' })).not.toBeNull()
  })

  it('injects stable failures for tests', async () => {
    const source = new MockWorkflowOverviewDataSource({ failures: { list: 'GRAY_INTERNAL', get: 'GRAY_NOT_FOUND' } })
    await expect(source.list({ workspace: 'C:\\dev\\alpha' })).rejects.toMatchObject({ code: 'GRAY_INTERNAL' })
    await expect(source.get({ id: 'x', workspace: 'C:\\dev\\alpha' })).rejects.toMatchObject({ code: 'GRAY_NOT_FOUND' })
  })
})

// ---------------------------------------------------------------------------
// Remote consumer (contract-driven) over a fake transport
// ---------------------------------------------------------------------------

describe('remote workflow overview data source', () => {
  it('invokes workflows/list with normalized args and reads the envelope', async () => {
    const transport = vi.fn<WorkflowRemoteTransport>(async () => ({
      ok: true,
      value: {
        items: [summary(), summary({ id: '.graycode/review/r1.md', kind: 'review' })],
        total: 2,
      },
    }))
    const source = new RemoteWorkflowOverviewDataSource(transport)
    const result = await source.list({ workspace: 'C:\\dev\\alpha', limit: 0 })
    expect(transport).toHaveBeenCalledWith('workflows/list', { workspace: 'C:\\dev\\alpha', limit: WORKFLOW_PAGE_LIMIT_DEFAULT }, undefined)
    expect(result.items).toHaveLength(2)
    expect(result.total).toBe(2)
    expect(result.nextCursor).toBeUndefined()
  })

  it('forwards the cursor and passes through the abort signal', async () => {
    const signal = new AbortController().signal
    const transport = vi.fn<WorkflowRemoteTransport>(async () => ({
      ok: true,
      value: { items: [summary()], total: 9, nextCursor: 'x' },
    }))
    const source = new RemoteWorkflowOverviewDataSource(transport)
    await source.list({ workspace: 'C:\\dev\\alpha', cursor: 'prev', limit: 5 }, signal)
    expect(transport).toHaveBeenCalledWith('workflows/list', { workspace: 'C:\\dev\\alpha', cursor: 'prev', limit: 5 }, signal)
  })

  it('throws the envelope failure as a stable error', async () => {
    const transport = vi.fn<WorkflowRemoteTransport>(async () => ({
      ok: false,
      error: { code: 'GRAY_ENDPOINT_NOT_FOUND', message: 'remote endpoint not found: workflows/list', details: {} },
    }))
    const source = new RemoteWorkflowOverviewDataSource(transport)
    await expect(source.list({ workspace: 'C:\\dev\\alpha' })).rejects.toMatchObject({ code: 'GRAY_ENDPOINT_NOT_FOUND' })
  })

  it('degrades malformed payloads to GRAY_INTERNAL', async () => {
    const transport = vi.fn<WorkflowRemoteTransport>(async () => ({ ok: true, value: { nope: true } }))
    const source = new RemoteWorkflowOverviewDataSource(transport)
    await expect(source.list({ workspace: 'C:\\dev\\alpha' })).rejects.toMatchObject({ code: 'GRAY_INTERNAL' })
  })

  it('get resolves null on GRAY_NOT_FOUND and details otherwise', async () => {
    const notFound = new RemoteWorkflowOverviewDataSource(async () => ({
      ok: false,
      error: { code: 'GRAY_NOT_FOUND', message: 'workflow run not found', details: {} },
    }))
    expect(await notFound.get({ id: '.graycode/progress.md', workspace: 'C:\\dev\\alpha' })).toBeNull()

    const found = new RemoteWorkflowOverviewDataSource(async () => ({
      ok: true,
      value: { ...summary(), content: '# body' },
    }))
    const detail = await found.get({ id: '.graycode/progress.md', workspace: 'C:\\dev\\alpha' })
    expect(detail?.content).toBe('# body')
  })

  it('does not invoke the transport for a blank workspace', async () => {
    const transport = vi.fn<WorkflowRemoteTransport>()
    const source = new RemoteWorkflowOverviewDataSource(transport)
    await expect(source.list({ workspace: '   ' })).rejects.toMatchObject({ code: 'GRAY_INVALID_INPUT' })
    await expect(source.get({ id: 'x', workspace: '' })).rejects.toMatchObject({ code: 'GRAY_INVALID_INPUT' })
    expect(transport).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// End-to-end fold: mock source + paging state machine
// ---------------------------------------------------------------------------

describe('mock source through the paging state machine', () => {
  it('loads every page with append and no duplicates', async () => {
    const source = new MockWorkflowOverviewDataSource()
    const workspace = 'C:\\dev\\alpha'
    let state = createWorkflowOverviewPageState()
    for (let page = 0; page < 20; page++) {
      const request = nextWorkflowPageRequest(state)
      if (request === null) break
      state = applyWorkflowPageLoading(state)
      const result = await source.list({ limit: 2, cursor: request.cursor, workspace })
      state = applyWorkflowPageLoaded(state, result, 'append')
      if (!state.hasMore) break
    }
    const runs = createMockWorkflowRuns().filter((run) => run.workspace === workspace)
    expect(state.phase).toBe('ready')
    expect(state.entries).toHaveLength(runs.length)
    expect(state.total).toBe(runs.length)
    expect(new Set(state.entries.map((run) => run.id)).size).toBe(state.entries.length)
    expect(nextWorkflowPageRequest(state)).toEqual({ cursor: null })
  })

  it('surfaces a first-page failure in the error phase with retry', async () => {
    const source = new MockWorkflowOverviewDataSource({ failures: { list: 'GRAY_INTERNAL' } })
    let state = createWorkflowOverviewPageState()
    state = applyWorkflowPageLoading(state)
    try {
      await source.list({ workspace: 'C:\\dev\\alpha' })
    } catch (error) {
      state = applyWorkflowPageError(state, error as { code: string; message: string; details: object })
    }
    expect(state.phase).toBe('error')
    expect(state.error?.code).toBe('GRAY_INTERNAL')
    expect(nextWorkflowPageRequest(state)).toEqual({ cursor: null })
  })
})

// ---------------------------------------------------------------------------
// Locale alignment
// ---------------------------------------------------------------------------

describe('graycode.workflowOverview locale dictionaries', () => {
  it('declares its own namespace', () => {
    expect(GRAYCODE_WORKFLOW_OVERVIEW_NS).toBe('graycode.workflowOverview')
  })

  it('keeps zh/en dictionaries balanced (identical key sets)', () => {
    const en = Object.keys(graycodeWorkflowOverviewDictionaries.en).sort()
    const zh = Object.keys(graycodeWorkflowOverviewDictionaries.zh).sort()
    expect(zh).toEqual(en)
  })

  it('keeps the ja placeholder on the same key set', () => {
    expect(Object.keys(graycodeWorkflowOverviewJaPlaceholder).sort()).toEqual(
      Object.keys(graycodeWorkflowOverviewDictionaries.en).sort(),
    )
  })

  it('fills every shipped locale with non-empty text', () => {
    for (const dict of Object.values(graycodeWorkflowOverviewDictionaries)) {
      for (const text of Object.values(dict)) {
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })

  it('covers every kind, status, phase, error and size key used by the logic', () => {
    const en = graycodeWorkflowOverviewDictionaries.en
    for (const kind of ['progress', 'design', 'plan', 'review'] as const) {
      expect(en[`kind.${kind}`], kind).toBeDefined()
    }
    for (const status of ['active', 'blocked', 'completed', 'archived'] as const) {
      expect(en[`runStatus.${status}`], status).toBeDefined()
    }
    for (const phase of ['design', 'plan', 'implementation', 'review', 'maintenance'] as const) {
      expect(en[`phase.${phase}`], phase).toBeDefined()
    }
    for (const code of ['invalidInput', 'conflict', 'approvalRequired', 'cancelled', 'storageCorrupt', 'notFound', 'endpointNotFound', 'internal', 'unknown']) {
      expect(en[`error.${code}`], code).toBeDefined()
    }
    for (const unit of ['bytes', 'kb', 'mb', 'gb']) {
      expect(en[`size.${unit}`], unit).toBeDefined()
    }
    for (const label of ['title', 'filter.workspace', 'filter.sessionUnavailable', 'list.empty', 'list.loadMore', 'state.replayOnly', 'run.locateSession', 'run.openDocument']) {
      expect(en[label], label).toBeDefined()
    }
  })
})
