/**
 * P4-04 checkpoint list — pure-logic tests.
 *
 * Covers: cursor pagination helpers (limit normalization mirrors the host,
 * query building, next-page detection, page merge dedupe), parent-chain
 * resolution (root / in-page / beyond-window / bounded / cyclic), item view
 * models, formatters, error-code → hint mapping, defensive wire readers,
 * the query store state machine (first page / append / overlap / end stop /
 * concurrency guard / failure / silent cancel / reload / expand) and the
 * deterministic mock data source.
 *
 * React is intentionally not imported: these are node-environment tests of
 * the replay-safe pure logic (components are not rendered here).
 */
import { describe, expect, it } from 'vitest'
import {
  CHECKPOINT_LIST_ERROR_CODES,
  checkpointListFailureHint,
  isCheckpointListCancellation,
  mapCheckpointListErrorCode,
} from '../src/client/checkpointList/errors.ts'
import {
  buildCheckpointListParams,
  hasNextPage,
  mergeCheckpointItems,
  normalizeCheckpointPageLimit,
} from '../src/client/checkpointList/query.ts'
import {
  CHECKPOINT_CHAIN_MAX_LINKS,
  buildCheckpointItemsById,
  checkpointOriginLabelKey,
  checkpointPhaseLabelKey,
  checkpointTypeLabelKey,
  formatCheckpointBytes,
  formatCheckpointTime,
  resolveCheckpointChain,
  shouldShowCheckpointOriginBadge,
  shortCheckpointId,
  toCheckpointItemVM,
} from '../src/client/checkpointList/viewModel.ts'
import { createCheckpointListStore } from '../src/client/checkpointList/store.ts'
import { createMockCheckpointListDataSource } from '../src/client/checkpointList/dataSource.ts'
import {
  GRAYCODE_CHECKPOINT_CONFIG_NS,
  GRAYCODE_CHECKPOINT_LIST_NS,
  graycodeCheckpointConfigDictionaries,
  graycodeCheckpointConfigJaPlaceholder,
  graycodeCheckpointListDictionaries,
  graycodeCheckpointListJaPlaceholder,
} from '../src/client/checkpointList/locales.ts'
import {
  readCheckpointListItem,
  readCheckpointListOutcome,
  readCheckpointListPage,
  readCheckpointRemoteFailure,
  readCheckpointVerifyResult,
} from '../src/client/checkpointList/types.ts'
import type {
  CheckpointListDataSource,
  CheckpointListItemWire,
  CheckpointListPageWire,
  CheckpointListQueryOutcome,
  CheckpointListQueryParams,
} from '../src/client/checkpointList/types.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeItem(seq: number, opts: Partial<CheckpointListItemWire> = {}): CheckpointListItemWire {
  return {
    id: `cp_${String(seq).padStart(4, '0')}`,
    conversationId: 'conv_1',
    messageIndex: seq,
    toolName: 'checkpoint_create',
    phase: 'after',
    timestamp: 1_700_000_000_000 + seq,
    type: 'full',
    contentHash: `sha256_${seq}`,
    fileCount: seq,
    backupBytes: seq * 100,
    excludedCount: 0,
    manifestVersion: 3,
    verifyState: 'unknown',
    ...opts,
  }
}

/** Newest-first chain: item seq=n has baseCheckpointId = item seq=n-1. */
function chainedItems(n: number): CheckpointListItemWire[] {
  const items: CheckpointListItemWire[] = []
  for (let seq = n; seq >= 1; seq -= 1) {
    const parent = seq > 1 ? `cp_${String(seq - 1).padStart(4, '0')}` : undefined
    items.push(
      fakeItem(seq, parent === undefined ? {} : { type: 'incremental', baseCheckpointId: parent }),
    )
  }
  return items
}

/** Host-style page slice (cursor = last listed item id). */
function sliceFake(items: CheckpointListItemWire[], cursor: string | undefined, limit: number): CheckpointListPageWire {
  let start = 0
  if (cursor !== undefined) {
    const index = items.findIndex(item => item.id === cursor)
    if (index >= 0) start = index + 1
  }
  const page = items.slice(start, start + limit)
  const nextCursor = start + limit < items.length && page.length > 0 ? page[page.length - 1]!.id : undefined
  return { items: page, total: items.length, nextCursor }
}

interface FakeSourceOptions {
  readonly failOnCall?: number
  readonly failCode?: string
  readonly cancelOnCall?: number
  readonly throwOnCall?: number
}

function createFakeSource(
  items: CheckpointListItemWire[],
  options: FakeSourceOptions = {},
): { source: CheckpointListDataSource; calls: Array<CheckpointListQueryParams> } {
  const calls: Array<CheckpointListQueryParams> = []
  let callCount = 0
  const source: CheckpointListDataSource = {
    kind: 'remote',
    async list(params, _signal): Promise<CheckpointListQueryOutcome> {
      callCount += 1
      calls.push(params)
      if (options.failOnCall === callCount) {
        return {
          ok: false,
          error: { code: options.failCode ?? 'GRAY_STORAGE_CORRUPT', message: 'fake failure', details: {} },
        }
      }
      if (options.cancelOnCall === callCount) {
        return { ok: false, error: { code: 'GRAY_CANCELLED', message: 'cancelled', details: {} } }
      }
      if (options.throwOnCall === callCount) {
        throw new Error('transport failure')
      }
      return { ok: true, value: sliceFake(items, params.cursor, params.limit ?? 20) }
    },
  }
  return { source, calls }
}

/** Source whose pages resolve only when released (concurrency tests). */
function createGateSource(items: CheckpointListItemWire[]) {
  const calls: Array<CheckpointListQueryParams> = []
  const gates: Array<(outcome: CheckpointListQueryOutcome) => void> = []
  const source: CheckpointListDataSource = {
    kind: 'remote',
    list(params) {
      calls.push(params)
      return new Promise<CheckpointListQueryOutcome>(resolve => {
        gates.push(resolve)
      })
    },
  }
  return {
    source,
    calls,
    gates,
    release(index: number): void {
      const gate = gates[index]
      const cursor = calls[index]?.cursor
      if (gate !== undefined) gate({ ok: true, value: sliceFake(items, cursor, calls[index]?.limit ?? 20) })
    },
  }
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

describe('pagination helpers', () => {
  it('normalizes page limits like the host (default 20, max 100)', () => {
    expect(normalizeCheckpointPageLimit(undefined)).toBe(20)
    expect(normalizeCheckpointPageLimit(null)).toBe(20)
    expect(normalizeCheckpointPageLimit(0)).toBe(20)
    expect(normalizeCheckpointPageLimit(-5)).toBe(20)
    expect(normalizeCheckpointPageLimit(2.5)).toBe(20)
    expect(normalizeCheckpointPageLimit(50)).toBe(50)
    expect(normalizeCheckpointPageLimit(200)).toBe(100)
    expect(normalizeCheckpointPageLimit(1)).toBe(1)
  })

  it('builds wire query params (workspaceId + cursor + normalized limit)', () => {
    expect(buildCheckpointListParams('/ws', undefined, 30)).toEqual({ workspaceId: '/ws', limit: 30 })
    expect(buildCheckpointListParams('/ws', 'cp_5', 999)).toEqual({ workspaceId: '/ws', cursor: 'cp_5', limit: 100 })
    expect(buildCheckpointListParams('/ws', '', 0).cursor).toBeUndefined()
    expect(buildCheckpointListParams('/ws', null, undefined)).toEqual({ workspaceId: '/ws', limit: 20 })
  })

  it('detects next pages', () => {
    expect(hasNextPage('cp_5')).toBe(true)
    expect(hasNextPage(undefined)).toBe(false)
    expect(hasNextPage(null)).toBe(false)
    expect(hasNextPage('')).toBe(false)
  })

  it('merges pages by id, preserving order and deduping overlaps', () => {
    const a = [fakeItem(1), fakeItem(2)]
    const b = [fakeItem(2), fakeItem(3), fakeItem(4)]
    const merged = mergeCheckpointItems(a, b)
    expect(merged.map(item => item.id)).toEqual(['cp_0001', 'cp_0002', 'cp_0003', 'cp_0004'])
  })
})

// ---------------------------------------------------------------------------
// Parent chains
// ---------------------------------------------------------------------------

describe('parent chain resolution', () => {
  it('a full snapshot root has no chain', () => {
    const items = [fakeItem(1)]
    const resolution = resolveCheckpointChain('cp_0001', buildCheckpointItemsById(items))
    expect(resolution.links).toEqual([])
    expect(resolution.truncated).toBe(false)
  })

  it('resolves a chain within the loaded pages (newest → oldest)', () => {
    const resolution = resolveCheckpointChain('cp_0004', buildCheckpointItemsById(chainedItems(4)))
    expect(resolution.truncated).toBe(false)
    expect(resolution.links.map(link => ({ id: link.id, depth: link.depth, beyondWindow: link.beyondWindow }))).toEqual([
      { id: 'cp_0003', depth: 1, beyondWindow: false },
      { id: 'cp_0002', depth: 2, beyondWindow: false },
      { id: 'cp_0001', depth: 3, beyondWindow: false },
    ])
  })

  it('marks a missing parent beyondWindow and truncated', () => {
    const items = [fakeItem(2, { type: 'incremental', baseCheckpointId: 'cp_9999' })]
    const resolution = resolveCheckpointChain('cp_0002', buildCheckpointItemsById(items))
    expect(resolution.truncated).toBe(true)
    expect(resolution.links).toEqual([{ id: 'cp_9999', depth: 1, beyondWindow: true }])
  })

  it('bounds long chains to the display maximum', () => {
    const byId = buildCheckpointItemsById(chainedItems(12))
    const bounded = resolveCheckpointChain('cp_0012', byId)
    expect(bounded.links).toHaveLength(CHECKPOINT_CHAIN_MAX_LINKS)
    expect(bounded.truncated).toBe(true)
    const full = resolveCheckpointChain('cp_0012', byId, 20)
    expect(full.links).toHaveLength(11)
    expect(full.truncated).toBe(false)
  })

  it('guards cyclic parent links', () => {
    const a = fakeItem(1, { type: 'incremental', baseCheckpointId: 'cp_0002' })
    const b = fakeItem(2, { type: 'incremental', baseCheckpointId: 'cp_0001' })
    const resolution = resolveCheckpointChain('cp_0001', buildCheckpointItemsById([a, b]))
    expect(resolution.truncated).toBe(true)
    expect(resolution.links.length).toBeGreaterThan(0)
    expect(resolution.links.length).toBeLessThanOrEqual(CHECKPOINT_CHAIN_MAX_LINKS)
  })

  it('extends chains across page boundaries (parent on a later page)', () => {
    const page1 = [fakeItem(3, { type: 'incremental', baseCheckpointId: 'cp_0002' })]
    const page2 = [fakeItem(2, { type: 'incremental', baseCheckpointId: 'cp_0001' }), fakeItem(1)]
    const merged = mergeCheckpointItems(page1, page2)
    const resolution = resolveCheckpointChain('cp_0003', buildCheckpointItemsById(merged))
    expect(resolution.truncated).toBe(false)
    expect(resolution.links.map(link => link.id)).toEqual(['cp_0002', 'cp_0001'])
  })
})

// ---------------------------------------------------------------------------
// Item view models
// ---------------------------------------------------------------------------

describe('item view model', () => {
  it('maps a full snapshot (no parent, type key, unknown verify)', () => {
    const item = fakeItem(1)
    const vm = toCheckpointItemVM(item, buildCheckpointItemsById([item]))
    expect(vm.id).toBe('cp_0001')
    expect(vm.parentId).toBeNull()
    expect(vm.type).toBe('full')
    expect(checkpointTypeLabelKey(vm.type)).toBe('type.full')
    expect(vm.verifyState).toBe('unknown')
    expect(vm.chain).toEqual([])
    expect(vm.chainTruncated).toBe(false)
    expect(vm.fileCount).toBe(1)
    expect(vm.backupBytes).toBe(100)
    expect(vm.timestamp).toBe(1_700_000_000_001)
    expect(vm.phase).toBe('after')
  })

  it('maps an incremental snapshot with a parent link', () => {
    const parent = fakeItem(1)
    const child = fakeItem(2, { type: 'incremental', baseCheckpointId: parent.id })
    const vm = toCheckpointItemVM(child, buildCheckpointItemsById([child, parent]))
    expect(vm.parentId).toBe(parent.id)
    expect(vm.type).toBe('incremental')
    expect(checkpointTypeLabelKey(vm.type)).toBe('type.incremental')
    expect(vm.chain.map(link => link.id)).toEqual([parent.id])
    expect(vm.chainTruncated).toBe(false)
  })

  it('carries verify state from the wire (read-only display)', () => {
    const item = fakeItem(1, { verifyState: 'ok' })
    const vm = toCheckpointItemVM(item, buildCheckpointItemsById([item]))
    expect(vm.verifyState).toBe('ok')
  })

  it('carries origin with a manual default; badge renders only for auto', () => {
    const auto = toCheckpointItemVM(fakeItem(1, { origin: 'auto' }), buildCheckpointItemsById([fakeItem(1, { origin: 'auto' })]))
    expect(auto.origin).toBe('auto')
    expect(shouldShowCheckpointOriginBadge(auto.origin)).toBe(true)
    expect(checkpointOriginLabelKey(auto.origin)).toBe('origin.auto')

    const manual = toCheckpointItemVM(fakeItem(2, { origin: 'manual' }), buildCheckpointItemsById([fakeItem(2, { origin: 'manual' })]))
    expect(manual.origin).toBe('manual')
    expect(shouldShowCheckpointOriginBadge(manual.origin)).toBe(false)
    expect(checkpointOriginLabelKey(manual.origin)).toBe('origin.manual')

    // Legacy wire items without the field normalize to manual (no badge).
    const legacy = toCheckpointItemVM(fakeItem(3), buildCheckpointItemsById([fakeItem(3)]))
    expect(legacy.origin).toBe('manual')
    expect(shouldShowCheckpointOriginBadge(legacy.origin)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

describe('formatters', () => {
  it('formats byte sizes (1024 base)', () => {
    expect(formatCheckpointBytes(0)).toBe('0 B')
    expect(formatCheckpointBytes(512)).toBe('512 B')
    expect(formatCheckpointBytes(1024)).toBe('1 KB')
    expect(formatCheckpointBytes(1536)).toBe('1.5 KB')
    expect(formatCheckpointBytes(15_360)).toBe('15 KB')
    expect(formatCheckpointBytes(1_048_576)).toBe('1 MB')
    expect(formatCheckpointBytes(2_621_440)).toBe('2.5 MB')
    expect(formatCheckpointBytes(1_073_741_824)).toBe('1 GB')
    expect(formatCheckpointBytes(undefined)).toBe('—')
    expect(formatCheckpointBytes(null)).toBe('—')
    expect(formatCheckpointBytes(-1)).toBe('—')
  })

  it('formats times (invalid → placeholder)', () => {
    expect(formatCheckpointTime(1_700_000_000_000)).not.toBe('—')
    expect(formatCheckpointTime(Number.NaN)).toBe('—')
    expect(formatCheckpointTime(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('shortens long ids for display', () => {
    expect(shortCheckpointId('cp_0001')).toBe('cp_0001')
    expect(shortCheckpointId('checkpoint_abcdefghijklmnop')).toBe('checkpoint_a…')
  })

  it('maps phase label keys', () => {
    expect(checkpointPhaseLabelKey('before')).toBe('phase.before')
    expect(checkpointPhaseLabelKey('after')).toBe('phase.after')
  })
})

// ---------------------------------------------------------------------------
// Error-code mapping
// ---------------------------------------------------------------------------

describe('error code mapping', () => {
  it('maps every stable GRAY_* code to a hint', () => {
    expect(mapCheckpointListErrorCode('GRAY_INVALID_INPUT')).toMatchObject({
      kind: 'invalidInput',
      messageKey: 'error.invalidInput',
      retryable: false,
    })
    expect(mapCheckpointListErrorCode('GRAY_CONFLICT')).toMatchObject({ kind: 'conflict', retryable: true })
    expect(mapCheckpointListErrorCode('GRAY_APPROVAL_REQUIRED')).toMatchObject({ kind: 'approvalRequired' })
    expect(mapCheckpointListErrorCode('GRAY_CANCELLED')).toMatchObject({ kind: 'cancelled' })
    expect(mapCheckpointListErrorCode('GRAY_STORAGE_CORRUPT')).toMatchObject({ kind: 'storageCorrupt' })
    expect(mapCheckpointListErrorCode('GRAY_NOT_FOUND')).toMatchObject({ kind: 'notFound' })
    expect(mapCheckpointListErrorCode('GRAY_ENDPOINT_NOT_FOUND')).toMatchObject({
      kind: 'endpointNotFound',
      messageKey: 'error.endpointNotFound',
    })
    expect(mapCheckpointListErrorCode('GRAY_INTERNAL')).toMatchObject({ kind: 'internal' })
  })

  it('unknown / absent codes fall back to the generic hint', () => {
    expect(mapCheckpointListErrorCode('GRAY_FUTURE_CODE')).toMatchObject({
      kind: 'unknown',
      messageKey: 'error.unknown',
      retryable: false,
    })
    expect(mapCheckpointListErrorCode(undefined)).toMatchObject({ kind: 'unknown' })
    expect(mapCheckpointListErrorCode('')).toMatchObject({ kind: 'unknown' })
  })

  it('maps failure envelopes and detects cancellations', () => {
    expect(checkpointListFailureHint({ code: 'GRAY_STORAGE_CORRUPT', message: 'x', details: {} }).kind).toBe('storageCorrupt')
    expect(checkpointListFailureHint(null).kind).toBe('unknown')
    expect(checkpointListFailureHint(undefined).kind).toBe('unknown')
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    expect(isCheckpointListCancellation(abortError)).toBe(true)
    expect(isCheckpointListCancellation(new Error('boom'))).toBe(false)
    const controller = new AbortController()
    controller.abort()
    expect(isCheckpointListCancellation(undefined, controller.signal)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Defensive wire readers
// ---------------------------------------------------------------------------

describe('defensive wire readers', () => {
  it('rejects unusable list items', () => {
    expect(readCheckpointListItem(null)).toBeNull()
    expect(readCheckpointListItem({})).toBeNull()
    expect(readCheckpointListItem({ id: 'cp_1' })).toBeNull()
    expect(readCheckpointListItem({ id: 'cp_1', type: 'bogus', phase: 'after' })).toBeNull()
    expect(readCheckpointListItem({ id: 'cp_1', type: 'full', phase: 'bogus' })).toBeNull()
  })

  it('fills defaults on a minimal valid item', () => {
    const item = readCheckpointListItem({ id: 'cp_1', type: 'full', phase: 'after' })
    expect(item).not.toBeNull()
    expect(item?.conversationId).toBe('')
    expect(item?.verifyState).toBe('unknown')
    expect(item?.fileCount).toBe(0)
    expect(item?.timestamp).toBe(0)
    expect(item?.baseCheckpointId).toBeUndefined()
  })

  it('narrows origin: auto/manual pass through; missing and hostile values → manual', () => {
    expect(readCheckpointListItem({ id: 'cp_1', type: 'full', phase: 'after', origin: 'auto' })?.origin).toBe('auto')
    expect(readCheckpointListItem({ id: 'cp_1', type: 'full', phase: 'after', origin: 'manual' })?.origin).toBe('manual')
    // Legacy data without the field defaults to manual.
    expect(readCheckpointListItem({ id: 'cp_1', type: 'full', phase: 'after' })?.origin).toBe('manual')
    // Hostile values are rejected, not propagated.
    expect(readCheckpointListItem({ id: 'cp_1', type: 'full', phase: 'after', origin: 'bogus' })?.origin).toBe('manual')
    expect(readCheckpointListItem({ id: 'cp_1', type: 'full', phase: 'after', origin: 42 })?.origin).toBe('manual')
    expect(readCheckpointListItem({ id: 'cp_1', type: 'full', phase: 'after', origin: '' })?.origin).toBe('manual')
  })

  it('narrows a page, filters invalid items and falls back total', () => {
    const page = readCheckpointListPage({
      items: [{ id: 'cp_1', type: 'full', phase: 'after' }, { junk: true }, null],
      total: 9,
      nextCursor: 'cp_1',
    })
    expect(page?.items).toHaveLength(1)
    expect(page?.total).toBe(9)
    expect(page?.nextCursor).toBe('cp_1')
    expect(readCheckpointListPage({ items: 'nope' })).toBeNull()
    expect(readCheckpointListPage(null)).toBeNull()
    const fallback = readCheckpointListPage({ items: [{ id: 'cp_1', type: 'full', phase: 'after' }] })
    expect(fallback?.total).toBe(1)
  })

  it('narrows failure envelopes', () => {
    expect(readCheckpointRemoteFailure({ code: 'GRAY_X', message: 'm', details: { a: 1 } })).toEqual({
      code: 'GRAY_X',
      message: 'm',
      details: { a: 1 },
    })
    expect(readCheckpointRemoteFailure({ message: 'no code' })).toBeNull()
    expect(readCheckpointRemoteFailure({ code: 'GRAY_X', details: 'junk' })).toEqual({
      code: 'GRAY_X',
      message: '',
      details: {},
    })
  })

  it('narrows query envelopes', () => {
    const ok = readCheckpointListOutcome({ ok: true, value: { items: [], total: 0 } })
    expect(ok?.ok).toBe(true)
    if (ok?.ok) {
      expect(ok.value.items).toEqual([])
      expect(ok.value.nextCursor).toBeUndefined()
    }
    expect(readCheckpointListOutcome({ ok: false, error: { message: 'no code' } })).toBeNull()
    expect(readCheckpointListOutcome({ ok: true, value: { items: 'nope' } })).toBeNull()
    expect(readCheckpointListOutcome('junk')).toBeNull()
  })

  it('narrows verify results', () => {
    const result = readCheckpointVerifyResult({
      ok: true,
      checkpointId: 'cp_1',
      issues: ['a', 1],
      checkedFiles: 3,
      chainLength: 1,
      filesRevisionPaired: true,
    })
    expect(result?.ok).toBe(true)
    expect(result?.issues).toEqual(['a'])
    expect(result?.checkedFiles).toBe(3)
    expect(readCheckpointVerifyResult({})).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Query store
// ---------------------------------------------------------------------------

describe('checkpoint list store', () => {
  it('starts idle and empty', () => {
    const { source } = createFakeSource([fakeItem(1)])
    const store = createCheckpointListStore({ workspaceId: '/ws', dataSource: source })
    expect(store.state.loadState).toBe('idle')
    expect(store.state.entries).toEqual([])
    expect(store.state.hasMore).toBe(false)
    expect(store.state.total).toBeNull()
    expect(store.state.error).toBeNull()
    expect(store.state.revision).toBe(0)
    expect(store.state.sourceKind).toBe('remote')
  })

  it('loadFirstPage fetches page 1 and maps view models', async () => {
    const items = [fakeItem(1), fakeItem(2), fakeItem(3), fakeItem(4), fakeItem(5)]
    const { source, calls } = createFakeSource(items)
    const store = createCheckpointListStore({ workspaceId: '/ws', dataSource: source, pageSize: 2 })
    await store.loadFirstPage()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ workspaceId: '/ws', limit: 2 })
    expect(calls[0]?.cursor).toBeUndefined()
    const state = store.state
    expect(state.loadState).toBe('ready')
    expect(state.entries).toHaveLength(2)
    expect(state.entries[0]?.id).toBe('cp_0001')
    expect(state.total).toBe(5)
    expect(state.hasMore).toBe(true)
    expect(state.nextCursor).toBe('cp_0002')
    expect(state.error).toBeNull()
  })

  it('loadNextPage appends via cursor and stops at the end (no full fetch)', async () => {
    const items = [fakeItem(1), fakeItem(2), fakeItem(3), fakeItem(4), fakeItem(5)]
    const { source, calls } = createFakeSource(items)
    const store = createCheckpointListStore({ workspaceId: '/ws', dataSource: source, pageSize: 2 })
    await store.loadFirstPage()
    await store.loadNextPage()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.cursor).toBe('cp_0002')
    expect(store.state.entries).toHaveLength(4)
    expect(store.state.hasMore).toBe(true)
    await store.loadNextPage()
    expect(store.state.entries).toHaveLength(5)
    expect(store.state.hasMore).toBe(false)
    expect(store.state.nextCursor).toBeNull()
    const callsBefore = calls.length
    await store.loadNextPage() // no-op at the end
    expect(calls).toHaveLength(callsBefore)
  })

  it('merges overlapping pages without duplicates', async () => {
    const items = [fakeItem(1), fakeItem(2), fakeItem(3), fakeItem(4), fakeItem(5)]
    const { source } = createFakeSource(items)
    const store = createCheckpointListStore({ workspaceId: '/ws', dataSource: source, pageSize: 3 })
    await store.loadFirstPage()
    await store.loadNextPage()
    expect(store.state.entries).toHaveLength(5)
    expect(new Set(store.state.entries.map(entry => entry.id)).size).toBe(5)
  })

  it('ignores concurrent loads', async () => {
    const gate = createGateSource([fakeItem(1), fakeItem(2), fakeItem(3), fakeItem(4)])
    const store = createCheckpointListStore({ workspaceId: '/ws', dataSource: gate.source, pageSize: 2 })
    const first = store.loadFirstPage()
    const second = store.loadFirstPage() // ignored while loading
    await second
    expect(gate.calls).toHaveLength(1)
    gate.release(0)
    await first
    expect(store.state.entries).toHaveLength(2)
    expect(store.state.loadState).toBe('ready')
  })

  it('append failure → error state with hint, entries kept, cursor retained', async () => {
    const items = [fakeItem(1), fakeItem(2), fakeItem(3), fakeItem(4)]
    const { source } = createFakeSource(items, { failOnCall: 2, failCode: 'GRAY_STORAGE_CORRUPT' })
    const store = createCheckpointListStore({ workspaceId: '/ws', dataSource: source, pageSize: 2 })
    await store.loadFirstPage()
    await store.loadNextPage()
    expect(store.state.loadState).toBe('error')
    expect(store.state.error?.kind).toBe('storageCorrupt')
    expect(store.state.error?.messageKey).toBe('error.storageCorrupt')
    expect(store.state.entries).toHaveLength(2)
    expect(store.state.hasMore).toBe(true)
  })

  it('first-page failure → error state; retry recovers', async () => {
    const items = [fakeItem(1), fakeItem(2)]
    const { source } = createFakeSource(items, { failOnCall: 1, failCode: 'GRAY_INTERNAL' })
    const store = createCheckpointListStore({ workspaceId: '/ws', dataSource: source, pageSize: 2 })
    await store.loadFirstPage()
    expect(store.state.loadState).toBe('error')
    expect(store.state.entries).toHaveLength(0)
    await store.loadFirstPage() // retry
    expect(store.state.loadState).toBe('ready')
    expect(store.state.entries).toHaveLength(2)
  })

  it('GRAY_CANCELLED is a silent stop (no error surface)', async () => {
    const items = [fakeItem(1), fakeItem(2), fakeItem(3), fakeItem(4)]
    const { source } = createFakeSource(items, { cancelOnCall: 2 })
    const store = createCheckpointListStore({ workspaceId: '/ws', dataSource: source, pageSize: 2 })
    await store.loadFirstPage()
    await store.loadNextPage()
    expect(store.state.loadState).toBe('ready')
    expect(store.state.error).toBeNull()
    expect(store.state.entries).toHaveLength(2)
  })

  it('thrown transport error → internal hint', async () => {
    const { source } = createFakeSource([fakeItem(1)], { throwOnCall: 1 })
    const store = createCheckpointListStore({ workspaceId: '/ws', dataSource: source })
    await store.loadFirstPage()
    expect(store.state.loadState).toBe('error')
    expect(store.state.error?.kind).toBe('internal')
    expect(store.state.error?.messageKey).toBe('error.internal')
  })

  it('reload clears entries and restarts from page 1', async () => {
    const items = [fakeItem(1), fakeItem(2), fakeItem(3)]
    const { source } = createFakeSource(items)
    const store = createCheckpointListStore({ workspaceId: '/ws', dataSource: source, pageSize: 2 })
    await store.loadFirstPage()
    await store.loadNextPage()
    expect(store.state.entries).toHaveLength(3)
    store.toggleExpand('cp_0001')
    await store.reload()
    expect(store.state.entries).toHaveLength(2)
    expect(store.state.total).toBe(3)
    expect(store.state.expandedId).toBeNull()
    expect(store.state.error).toBeNull()
  })

  it('defers reload while a load is in flight instead of dropping it', async () => {
    const gate = createGateSource([fakeItem(1), fakeItem(2), fakeItem(3)])
    const store = createCheckpointListStore({ workspaceId: '/ws', dataSource: gate.source, pageSize: 2 })
    const first = store.loadFirstPage()
    const reloadPromise = store.reload() // must not be silently skipped
    // Do not await yet: the queued reload resolves only after the gated loads
    // are released. No extra call may go out while the first load is gated.
    expect(gate.calls).toHaveLength(1)
    gate.release(0)
    await first
    // The deferred reload now runs: clears the list and issues a fresh
    // first-page call (cursor undefined), instead of being dropped.
    expect(gate.calls).toHaveLength(2)
    expect(gate.calls[1]?.cursor).toBeUndefined()
    gate.release(1)
    await reloadPromise
    expect(store.state.loadState).toBe('ready')
    expect(store.state.entries).toHaveLength(2)
    expect(store.state.total).toBe(3)
    expect(store.state.expandedId).toBeNull()
  })

  it('toggleExpand toggles the selected item', async () => {
    const { source } = createFakeSource([fakeItem(1), fakeItem(2)])
    const store = createCheckpointListStore({ workspaceId: '/ws', dataSource: source })
    await store.loadFirstPage()
    store.toggleExpand('cp_0001')
    expect(store.state.expandedId).toBe('cp_0001')
    store.toggleExpand('cp_0001')
    expect(store.state.expandedId).toBeNull()
    store.toggleExpand('cp_0002')
    expect(store.state.expandedId).toBe('cp_0002')
  })
})

// ---------------------------------------------------------------------------
// Mock data source
// ---------------------------------------------------------------------------

describe('mock data source', () => {
  it('is deterministic for the same seed', async () => {
    const a = createMockCheckpointListDataSource({ seed: 7, total: 12 })
    const b = createMockCheckpointListDataSource({ seed: 7, total: 12 })
    const ra = await a.list({ workspaceId: '/ws', limit: 5 })
    const rb = await b.list({ workspaceId: '/ws', limit: 5 })
    expect(ra.ok && rb.ok).toBe(true)
    if (ra.ok && rb.ok) {
      expect(ra.value.items.map(item => item.id)).toEqual(rb.value.items.map(item => item.id))
    }
  })

  it('paginates the full set via cursor (never one-shot)', async () => {
    const source = createMockCheckpointListDataSource({ seed: 1, total: 45 })
    const ids: string[] = []
    let cursor: string | undefined
    let pages = 0
    for (;;) {
      const outcome = await source.list({ workspaceId: '/ws', cursor, limit: 20 })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) break
      pages += 1
      ids.push(...outcome.value.items.map(item => item.id))
      cursor = outcome.value.nextCursor
      if (cursor === undefined) break
    }
    expect(pages).toBe(3)
    expect(ids).toHaveLength(45)
    expect(new Set(ids).size).toBe(45)
  })

  it('emits newest-first items with descending timestamps', async () => {
    const source = createMockCheckpointListDataSource({ seed: 1, total: 10 })
    const outcome = await source.list({ workspaceId: '/ws', limit: 10 })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      const times = outcome.value.items.map(item => item.timestamp)
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index]!).toBeLessThan(times[index - 1]!)
      }
      expect(outcome.value.items[0]?.type).toBe('full') // newest is a chain root
    }
  })

  it('emits a deterministic origin mix (auto/manual) so the badge is exercisable', async () => {
    const a = createMockCheckpointListDataSource({ seed: 3, total: 12 })
    const b = createMockCheckpointListDataSource({ seed: 3, total: 12 })
    const ra = await a.list({ workspaceId: '/ws', limit: 12 })
    const rb = await b.list({ workspaceId: '/ws', limit: 12 })
    expect(ra.ok && rb.ok).toBe(true)
    if (ra.ok && rb.ok) {
      const originsA = ra.value.items.map(item => item.origin)
      const originsB = rb.value.items.map(item => item.origin)
      expect(originsA).toEqual(originsB)
      expect(originsA.every(origin => origin === 'auto' || origin === 'manual')).toBe(true)
      expect(originsA).toContain('auto')
      expect(originsA).toContain('manual')
      // seq % 4 === 0 → auto (every 4th item, 1-based).
      expect(originsA[3]).toBe('auto')
      expect(originsA[0]).toBe('manual')
    }
  })

  it('simulates a host failure on the Nth call', async () => {
    const source = createMockCheckpointListDataSource({
      seed: 1,
      total: 10,
      failOnCall: 2,
      failCode: 'GRAY_STORAGE_CORRUPT',
    })
    const first = await source.list({ workspaceId: '/ws', limit: 5 })
    expect(first.ok).toBe(true)
    const second = await source.list({
      workspaceId: '/ws',
      cursor: first.ok ? first.value.nextCursor : undefined,
      limit: 5,
    })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe('GRAY_STORAGE_CORRUPT')
  })

  it('verify: known id ok, unknown id NOT_FOUND', async () => {
    const source = createMockCheckpointListDataSource({ seed: 1, total: 5 })
    const first = await source.list({ workspaceId: '/ws', limit: 1 })
    const id = first.ok ? first.value.items[0]!.id : 'cp_mock_00000001'
    const okResult = await source.verify!(id)
    expect(okResult.ok).toBe(true)
    const missing = await source.verify!('cp_mock_nope')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('GRAY_NOT_FOUND')
  })

  it('drives the store end-to-end (45 items, 3 pages, mock notice)', async () => {
    const store = createCheckpointListStore({
      workspaceId: '/ws',
      dataSource: createMockCheckpointListDataSource({ seed: 1, total: 45 }),
      pageSize: 20,
    })
    await store.loadFirstPage()
    expect(store.state.entries).toHaveLength(20)
    expect(store.state.sourceKind).toBe('mock')
    await store.loadNextPage()
    expect(store.state.entries).toHaveLength(40)
    await store.loadNextPage()
    expect(store.state.entries).toHaveLength(45)
    expect(store.state.hasMore).toBe(false)
    expect(store.state.total).toBe(45)
    expect(store.state.error).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Locale alignment
// ---------------------------------------------------------------------------

describe('locale alignment', () => {
  it('registers the independent checkpointList namespace', () => {
    expect(GRAYCODE_CHECKPOINT_LIST_NS).toBe('graycode.checkpointList')
    expect(GRAYCODE_CHECKPOINT_LIST_NS).not.toBe('graycode')
  })

  it('zh/en/ja dictionaries share the same key set', () => {
    const zhKeys = Object.keys(graycodeCheckpointListDictionaries.zh).sort()
    const enKeys = Object.keys(graycodeCheckpointListDictionaries.en).sort()
    const jaKeys = Object.keys(graycodeCheckpointListJaPlaceholder).sort()
    expect(enKeys).toEqual(zhKeys)
    expect(jaKeys).toEqual(zhKeys)
  })

  it('checkpointConfig namespace registers separately and stays balanced', () => {
    expect(GRAYCODE_CHECKPOINT_CONFIG_NS).toBe('graycode.checkpointConfig')
    expect(GRAYCODE_CHECKPOINT_CONFIG_NS).not.toBe(GRAYCODE_CHECKPOINT_LIST_NS)
    const zhKeys = Object.keys(graycodeCheckpointConfigDictionaries.zh).sort()
    const enKeys = Object.keys(graycodeCheckpointConfigDictionaries.en).sort()
    const jaKeys = Object.keys(graycodeCheckpointConfigJaPlaceholder).sort()
    expect(enKeys).toEqual(zhKeys)
    expect(jaKeys).toEqual(zhKeys)
    expect(zhKeys.length).toBeGreaterThan(0)
  })

  it('every error hint key and label key exists in the dictionaries', () => {
    const keys = new Set(Object.keys(graycodeCheckpointListDictionaries.zh))
    for (const code of Object.values(CHECKPOINT_LIST_ERROR_CODES)) {
      expect(keys.has(mapCheckpointListErrorCode(code).messageKey)).toBe(true)
    }
    expect(keys.has(mapCheckpointListErrorCode('GRAY_FUTURE').messageKey)).toBe(true)
    expect(keys.has(checkpointTypeLabelKey('full'))).toBe(true)
    expect(keys.has(checkpointTypeLabelKey('incremental'))).toBe(true)
    expect(keys.has(checkpointPhaseLabelKey('before'))).toBe(true)
    expect(keys.has(checkpointPhaseLabelKey('after'))).toBe(true)
    expect(keys.has('verify.unknown')).toBe(true)
    expect(keys.has('verify.ok')).toBe(true)
    expect(keys.has('verify.failed')).toBe(true)
    expect(keys.has('origin.auto')).toBe(true)
    expect(keys.has('origin.manual')).toBe(true)
  })
})
