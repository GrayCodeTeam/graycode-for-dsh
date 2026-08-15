/**
 * P4-03 memory management — pure-logic tests.
 *
 * Covers: query parameter building (trim/scope/cursor/limit normalization),
 * entry + page view models with highlight ranges, the edit diff (token LCS,
 * including the cost guard), the forget confirmation state machine
 * (idle → confirming → submitting → done | error), stable error-code
 * mapping, the mock transport semantics (search/scope/pagination/edit/forget
 * confirm gate), the remote transport adapter (endpoint dispatch + defensive
 * narrowing), the defensive wire readers, and locale key alignment.
 *
 * React is intentionally not imported: these are node-environment tests of
 * the pure logic (the components are not rendered here).
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_MEMORY_SELECTION,
  GLOBAL_MEMORY_SCOPE_FALLBACK,
  IDLE_BATCH_FORGET_STATE,
  appendMemoryListPage,
  applyMemoryTextCount,
  buildMemoryListParams,
  buildMemoryEntryView,
  buildMemoryListViewModel,
  buildMemoryScopeOptions,
  cancelBatchForget,
  cancelForget,
  confirmBatchForget,
  confirmForget,
  defaultMemoryScopeSelection,
  diffMemoryText,
  dismissBatchForget,
  dismissForget,
  excludeMemorySelection,
  findMatchRanges,
  IDLE_FORGET_STATE,
  INITIAL_MEMORY_SEARCH_SETTLE,
  MemoryAddInFlightGate,
  isCurrentMemoryConfigResponse,
  isMemoryPageSelected,
  isStaleMemoryCursorFailure,
  isStaleMemoryRevisionFailure,
  mapMemoryFailure,
  memoryEntryCharsExceededFailure,
  memoryRequestContextKey,
  memoryScopeOptionKey,
  MEMORY_DIFF_MAX_CELLS,
  normalizeMemoryLimit,
  normalizeMemoryEntryChars,
  parseMemoryNextCursor,
  rejectBatchForget,
  rejectForget,
  requestBatchForget,
  requestForget,
  resolveBatchForget,
  resolveForget,
  selectMemoryPage,
  settleMemorySearch,
  startMemoryAddRequest,
  toMemoryFailure,
  toggleMemorySelection,
  workspacePathName,
} from '../src/client/memoryManage/logic.ts'
import {
  MEMORY_ENDPOINTS,
  createMockMemoryTransport,
  createRemoteMemoryTransport,
  type GrayRemoteInvoker,
} from '../src/client/memoryManage/api.ts'
import {
  GRAY_MEMORY_SCOPES,
  GRAY_PAGE_LIMIT_DEFAULT,
  GRAY_PAGE_LIMIT_MAX,
  GRAY_REMOTE_ERROR_CODES,
  isGrayRemoteResult,
  readGrayRemoteFailure,
  readMemoryConfig,
  readMemoryEntryView,
  readMemoryForgetBatchResult,
  readMemoryForgetResult,
  readMemoryListResult,
  readMemoryScopeInfo,
  readMemoryScopesResult,
  type GrayMemoryEntryView,
  type GrayMemoryScopeInfo,
} from '../src/client/memoryManage/types.ts'
import {
  GRAYCODE_MEMORY_MANAGE_NS,
  graycodeMemoryManageDictionaries,
  graycodeMemoryManageJaPlaceholder,
} from '../src/client/memoryManage/locales.ts'

const CODES = GRAY_REMOTE_ERROR_CODES
const REVISION = 'sha256:test-revision'

function failure(code: string, message = 'boom'): { code: string; message: string; details: Record<string, unknown> } {
  return { code, message, details: {} }
}

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

describe('buildMemoryListParams', () => {
  it('trims and omits an empty search', () => {
    expect(buildMemoryListParams({ text: '   ', scope: 'global' })).toEqual({ scope: 'global', limit: 20 })
  })

  it('keeps a non-empty search and passes the scope through', () => {
    const params = buildMemoryListParams({ text: '  hello  ', scope: 'workspace', workspace: 'C:\\ws' })
    expect(params.search).toBe('hello')
    expect(params.scope).toBe('workspace')
    expect(params.workspace).toBe('C:\\ws')
  })

  it('drops empty cursors and returns opaque host tokens verbatim', () => {
    expect(buildMemoryListParams({ text: '', scope: 'global', cursor: '' })).not.toHaveProperty('cursor')
    expect(buildMemoryListParams({ text: '', scope: 'global', cursor: '   ' })).not.toHaveProperty('cursor')
    const opaque = 'eyJ2IjoxLCJzIjoiYWJjIiwibyI6Mn0'
    expect(buildMemoryListParams({ text: '', scope: 'global', cursor: opaque }).cursor).toBe(opaque)
  })

  it('normalizes the limit to the host contract', () => {
    expect(buildMemoryListParams({ text: '', scope: 'global' }).limit).toBe(GRAY_PAGE_LIMIT_DEFAULT)
    expect(buildMemoryListParams({ text: '', scope: 'global', limit: 0 }).limit).toBe(GRAY_PAGE_LIMIT_DEFAULT)
    expect(buildMemoryListParams({ text: '', scope: 'global', limit: 5 }).limit).toBe(5)
    expect(buildMemoryListParams({ text: '', scope: 'global', limit: 999 }).limit).toBe(GRAY_PAGE_LIMIT_MAX)
  })

  it('omits the workspace when empty', () => {
    expect(buildMemoryListParams({ text: '', scope: 'workspace', workspace: '' })).not.toHaveProperty('workspace')
  })
})

describe('memory request context identity', () => {
  it('binds workspace views to a normalized workspace and global views only to their query', () => {
    expect(memoryRequestContextKey({ text: 'q', scope: 'workspace', workspace: ' C:\\repo ' }))
      .toBe(memoryRequestContextKey({ text: 'q', scope: 'workspace', workspace: 'C:\\repo' }))
    expect(memoryRequestContextKey({ text: 'q', scope: 'workspace', workspace: 'C:\\repo' }))
      .not.toBe(memoryRequestContextKey({ text: 'q', scope: 'workspace', workspace: 'D:\\repo' }))
    expect(memoryRequestContextKey({ text: 'q', scope: 'global', workspace: 'C:\\repo' }))
      .toBe(memoryRequestContextKey({ text: 'q', scope: 'global', workspace: 'D:\\repo' }))
  })
})

describe('settleMemorySearch (H-7a regression)', () => {
  it('advances the fetch generation on every settle, even for an unchanged applied query', () => {
    const first = settleMemorySearch(INITIAL_MEMORY_SEARCH_SETTLE, 'ab')
    expect(first.appliedQuery).toBe('ab')
    expect(first.fetchGeneration).toBe(1)
    // Typing "ab" → "abc" → "ab" settles back on the SAME applied query; the
    // generation must still advance so the panel's fetch effect cannot bail
    // out on an unchanged appliedQuery and leave the panel stuck in 'loading'.
    const second = settleMemorySearch(first, 'ab')
    expect(second.appliedQuery).toBe('ab')
    expect(second.fetchGeneration).toBe(2)
  })

  it('starts frozen with an empty applied query', () => {
    expect(INITIAL_MEMORY_SEARCH_SETTLE).toEqual({ appliedQuery: '', fetchGeneration: 0 })
    expect(Object.isFrozen(INITIAL_MEMORY_SEARCH_SETTLE)).toBe(true)
  })
})

describe('MemoryAddInFlightGate', () => {
  it('keeps one delayed host write locked across search, scope, and workspace changes', async () => {
    let resolveWrite!: () => void
    const delayedWrite = new Promise<void>(resolve => { resolveWrite = resolve })
    const gate = new MemoryAddInFlightGate()
    let transportCalls = 0

    const submit = () => {
      return startMemoryAddRequest(gate, async () => {
        transportCalls += 1
        await delayedWrite
      })
    }

    const first = submit()
    expect(first.started).toBe(true)
    expect(gate.isInFlight()).toBe(true)
    const changedViews = [
      memoryRequestContextKey({ text: 'new search', scope: 'global' }),
      memoryRequestContextKey({ text: 'new search', scope: 'workspace', workspace: 'C:\\one' }),
      memoryRequestContextKey({ text: 'new search', scope: 'workspace', workspace: 'D:\\two' }),
    ]
    for (const view of changedViews) {
      expect(view.length).toBeGreaterThan(0) // model the view-generation changes
      expect(submit()).toEqual({ started: false })
    }
    expect(transportCalls).toBe(1)

    resolveWrite()
    if (!first.started) throw new Error('first add should have acquired the gate')
    await expect(first.completion).resolves.toBeUndefined()
    expect(gate.isInFlight()).toBe(false)
  })
})

describe('normalizeMemoryLimit', () => {
  it('defaults, clamps and floors', () => {
    expect(normalizeMemoryLimit(undefined)).toBe(GRAY_PAGE_LIMIT_DEFAULT)
    expect(normalizeMemoryLimit(-1)).toBe(GRAY_PAGE_LIMIT_DEFAULT)
    expect(normalizeMemoryLimit(Number.NaN)).toBe(GRAY_PAGE_LIMIT_DEFAULT)
    expect(normalizeMemoryLimit(7)).toBe(7)
    expect(normalizeMemoryLimit(7.9)).toBe(7)
    expect(normalizeMemoryLimit(1000)).toBe(GRAY_PAGE_LIMIT_MAX)
  })
})

describe('parseMemoryNextCursor', () => {
  it('accepts and preserves non-empty opaque tokens', () => {
    expect(parseMemoryNextCursor('42')).toBe('42')
    expect(parseMemoryNextCursor('opaque.token-_')).toBe('opaque.token-_')
  })

  it('rejects only absent/empty cursors without interpreting host tokens', () => {
    expect(parseMemoryNextCursor(undefined)).toBeNull()
    expect(parseMemoryNextCursor('')).toBeNull()
    expect(parseMemoryNextCursor('   ')).toBeNull()
    expect(parseMemoryNextCursor('abc')).toBe('abc')
  })
})

describe('appendMemoryListPage', () => {
  const entry = (id: number): GrayMemoryEntryView => ({ id, date: '2025-01-01', text: `memory ${id}` })

  it('appends items and adopts total/nextCursor/hasMore from the newest page', () => {
    const prev = buildMemoryListViewModel({ items: [entry(2)], total: 3, nextCursor: '2', revision: REVISION }, { scope: 'global' })
    const next = buildMemoryListViewModel({ items: [entry(1)], total: 3, nextCursor: '1', revision: REVISION }, { scope: 'global' })
    const merged = appendMemoryListPage(prev, next)
    expect(merged.items.map(item => item.id)).toEqual([2, 1])
    expect(merged.total).toBe(3)
    expect(merged.nextCursor).toBe('1')
    expect(merged.hasMore).toBe(true)
  })

  it('ends pagination when the next page carries no cursor', () => {
    const prev = buildMemoryListViewModel({ items: [entry(2)], total: 2, nextCursor: '2', revision: REVISION }, { scope: 'global' })
    const next = buildMemoryListViewModel({ items: [entry(1)], total: 2, revision: REVISION }, { scope: 'global' })
    const merged = appendMemoryListPage(prev, next)
    expect(merged.items.map(item => item.id)).toEqual([2, 1])
    expect(merged.nextCursor).toBeUndefined()
    expect(merged.hasMore).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// View models + highlight ranges
// ---------------------------------------------------------------------------

describe('findMatchRanges', () => {
  it('returns nothing for empty queries', () => {
    expect(findMatchRanges('hello world', '')).toEqual([])
    expect(findMatchRanges('hello world', '   ')).toEqual([])
  })

  it('returns nothing when there is no match', () => {
    expect(findMatchRanges('hello world', 'xyz')).toEqual([])
  })

  it('finds case-insensitive single and multiple matches', () => {
    expect(findMatchRanges('Alpha beta ALPHA', 'alpha')).toEqual([
      { start: 0, end: 5 },
      { start: 11, end: 16 },
    ])
  })

  it('does not produce overlapping ranges', () => {
    expect(findMatchRanges('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ])
  })
})

describe('buildMemoryEntryView / buildMemoryListViewModel', () => {
  const entry: GrayMemoryEntryView = { id: 7, date: '2025-01-02', text: 'Remember the Alpha build' }

  it('folds scope, workspace and highlight ranges into the view', () => {
    const view = buildMemoryEntryView(entry, { scope: 'workspace', workspace: 'C:\\ws', query: 'alpha' }, REVISION)
    expect(view).toMatchObject({ id: 7, date: '2025-01-02', text: entry.text, scope: 'workspace', workspace: 'C:\\ws' })
    expect(view.highlight).toEqual([{ start: 13, end: 18 }])
  })

  it('omits workspace and highlight when not applicable', () => {
    const view = buildMemoryEntryView(entry, { scope: 'global' }, REVISION)
    expect(view.workspace).toBeUndefined()
    expect(view.highlight).toEqual([])
  })

  it('builds a page view model with hasMore from nextCursor', () => {
    const vm = buildMemoryListViewModel(
      { items: [entry], total: 3, nextCursor: '7', revision: REVISION },
      { scope: 'global', query: 'alpha' },
    )
    expect(vm.items).toHaveLength(1)
    expect(vm.total).toBe(3)
    expect(vm.nextCursor).toBe('7')
    expect(vm.hasMore).toBe(true)
    expect(buildMemoryListViewModel({ items: [entry], total: 1, revision: REVISION }, { scope: 'global' }).hasMore).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Edit diff
// ---------------------------------------------------------------------------

/** Ordered reconstruction: walk segments and keep `same` plus one edit kind. */
function reconstruct(
  segments: ReadonlyArray<{ type: string; value: string }>,
  keep: 'added' | 'removed',
): string {
  let out = ''
  for (const segment of segments) {
    if (segment.type === 'same' || segment.type === keep) out += segment.value
  }
  return out
}

describe('diffMemoryText', () => {
  it('reports identical texts as unchanged with a single same segment', () => {
    const diff = diffMemoryText('hello world', 'hello world')
    expect(diff.changed).toBe(false)
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(0)
    expect(diff.segments).toEqual([{ type: 'same', value: 'hello world' }])
  })

  it('detects an append as an added segment', () => {
    const diff = diffMemoryText('hello', 'hello world')
    expect(diff.changed).toBe(true)
    expect(diff.added).toBe(6)
    expect(diff.removed).toBe(0)
    expect(diff.segments.map(s => s.type)).toEqual(['same', 'added'])
    expect(diff.segments.map(s => s.value).join('')).toBe('hello world')
  })

  it('detects a removal as a removed segment', () => {
    const diff = diffMemoryText('hello world', 'world')
    expect(diff.changed).toBe(true)
    expect(diff.removed).toBe(6)
    expect(diff.segments.map(s => s.type)).toEqual(['removed', 'same'])
  })

  it('detects a replacement as removed + added', () => {
    const diff = diffMemoryText('old text here', 'new text here')
    expect(diff.changed).toBe(true)
    expect(diff.segments.map(s => s.type)).toEqual(['added', 'removed', 'same'])
    // Reconstruction invariants: same+added (ordered) == next, same+removed (ordered) == original.
    expect(reconstruct(diff.segments, 'added')).toBe('new text here')
    expect(reconstruct(diff.segments, 'removed')).toBe('old text here')
  })

  it('treats an empty original as all-added', () => {
    const diff = diffMemoryText('', 'brand new')
    expect(diff.changed).toBe(true)
    expect(diff.segments).toEqual([{ type: 'added', value: 'brand new' }])
    expect(diff.added).toBe(9) // 'brand new'.length
  })

  it('treats an empty next text as all-removed', () => {
    const diff = diffMemoryText('gone', '')
    expect(diff.changed).toBe(true)
    expect(diff.segments).toEqual([{ type: 'removed', value: 'gone' }])
    expect(diff.removed).toBe(4)
  })

  it('preserves whitespace across the diff', () => {
    const diff = diffMemoryText('a  b', 'a b')
    expect(reconstruct(diff.segments, 'added')).toBe('a b')
    expect(reconstruct(diff.segments, 'removed')).toBe('a  b')
  })

  it('falls back to a whole-text change when the LCS budget is exceeded', () => {
    // 400 words + 399 separators = 799 whitespace-preserving tokens each.
    const long = 'word '.repeat(400).trim()
    const other = 'other '.repeat(400).trim()
    const tokens = (text: string) => text.match(/\s+|\S+/g) ?? []
    const cells = (tokens(long).length + 1) * (tokens(other).length + 1)
    expect(cells).toBeGreaterThan(MEMORY_DIFF_MAX_CELLS)
    const diff = diffMemoryText(long, other)
    expect(diff.changed).toBe(true)
    expect(diff.segments.map(s => s.type)).toEqual(['removed', 'added'])
    expect(diff.added).toBe(other.length)
    expect(diff.removed).toBe(long.length)
  })
})

// ---------------------------------------------------------------------------
// Forget confirmation state machine
// ---------------------------------------------------------------------------

describe('forget confirmation state machine', () => {
  const target = { id: 5, scope: 'global' as const }
  const preview = 'the exact memory text'

  it('starts idle and frozen', () => {
    expect(IDLE_FORGET_STATE).toEqual({ phase: 'idle', target: null, preview: null, outcome: null, error: null })
    expect(Object.isFrozen(IDLE_FORGET_STATE)).toBe(true)
  })

  it('request arms the target with the warning snapshot (idle → confirming)', () => {
    const state = requestForget(IDLE_FORGET_STATE, target, preview)
    expect(state.phase).toBe('confirming')
    expect(state.target).toEqual(target)
    expect(state.preview).toBe(preview)
  })

  it('request is a no-op while already armed', () => {
    const armed = requestForget(IDLE_FORGET_STATE, target, preview)
    expect(requestForget(armed, { id: 9, scope: 'workspace' }, 'other')).toBe(armed)
  })

  it('cancel abandons from confirming and from error, no-op from idle', () => {
    const armed = requestForget(IDLE_FORGET_STATE, target, preview)
    expect(cancelForget(armed).phase).toBe('idle')
    expect(cancelForget(IDLE_FORGET_STATE)).toBe(IDLE_FORGET_STATE)
    const errored = rejectForget(confirmForget(armed), failure(CODES.INTERNAL))
    expect(cancelForget(errored).phase).toBe('idle')
  })

  it('cancel resets a submitting forget so a superseded flow can never get stuck (H-7b)', () => {
    const submitting = confirmForget(requestForget(IDLE_FORGET_STATE, target, preview))
    expect(submitting.phase).toBe('submitting')
    const reset = cancelForget(submitting)
    expect(reset).toEqual(IDLE_FORGET_STATE)
    expect(reset.phase).toBe('idle')
  })

  it('confirm is the only path to submitting (double-submit guarded)', () => {
    const armed = requestForget(IDLE_FORGET_STATE, target, preview)
    const submitting = confirmForget(armed)
    expect(submitting.phase).toBe('submitting')
    expect(submitting.target).toEqual(target)
    expect(confirmForget(submitting)).toBe(submitting)
    expect(confirmForget(IDLE_FORGET_STATE)).toBe(IDLE_FORGET_STATE)
  })

  it('resolve lands the outcome (submitting → done)', () => {
    const state = resolveForget(confirmForget(requestForget(IDLE_FORGET_STATE, target, preview)), {
      mode: 'single',
      removed: 1,
    })
    expect(state.phase).toBe('done')
    expect(state.outcome).toEqual({ mode: 'single', removed: 1 })
    expect(state.error).toBeNull()
  })

  it('reject maps the failure to a stable-code view (submitting → error)', () => {
    const state = rejectForget(confirmForget(requestForget(IDLE_FORGET_STATE, target, preview)), failure(CODES.CONFLICT))
    expect(state.phase).toBe('error')
    expect(state.error).toMatchObject({ code: CODES.CONFLICT, localeKey: 'error.conflict' })
    expect(state.outcome).toBeNull()
  })

  it('resolve/reject are no-ops outside submitting', () => {
    const armed = requestForget(IDLE_FORGET_STATE, target, preview)
    expect(resolveForget(armed, { mode: 'single', removed: 1 })).toBe(armed)
    expect(rejectForget(armed, failure(CODES.INTERNAL))).toBe(armed)
    expect(resolveForget(IDLE_FORGET_STATE, { mode: 'single', removed: 1 })).toBe(IDLE_FORGET_STATE)
  })

  it('retries from error via confirm (error → submitting)', () => {
    const errored = rejectForget(confirmForget(requestForget(IDLE_FORGET_STATE, target, preview)), failure(CODES.INTERNAL))
    const retried = confirmForget(errored)
    expect(retried.phase).toBe('submitting')
    expect(retried.target).toEqual(target)
  })

  it('dismiss resets done → idle and is a no-op elsewhere', () => {
    const done = resolveForget(confirmForget(requestForget(IDLE_FORGET_STATE, target, preview)), {
      mode: 'single',
      removed: 1,
    })
    expect(dismissForget(done)).toBe(IDLE_FORGET_STATE)
    expect(dismissForget(IDLE_FORGET_STATE)).toBe(IDLE_FORGET_STATE)
  })
})

// ---------------------------------------------------------------------------
// Scope enumeration (M-02 workspace dropdown)
// ---------------------------------------------------------------------------

describe('workspacePathName', () => {
  it('returns the last non-empty path segment', () => {
    expect(workspacePathName('C:\\repo\\my-ws')).toBe('my-ws')
    expect(workspacePathName('/home/user/ws/')).toBe('ws')
    expect(workspacePathName('C:\\')).toBe('C:')
    expect(workspacePathName('')).toBe('')
  })
})

describe('buildMemoryScopeOptions', () => {
  const global: GrayMemoryScopeInfo = { scope: 'global', id: 'global', name: 'Global', path: '' }
  const wsA: GrayMemoryScopeInfo = { scope: 'workspace', id: 'a', name: 'A', path: 'C:\\a', cwd: 'C:\\a' }

  it('keeps the enumeration unchanged when the current workspace is covered (by path or cwd)', () => {
    expect(buildMemoryScopeOptions([global, wsA], 'C:\\a')).toEqual([global, wsA])
    const withCwd: GrayMemoryScopeInfo = { scope: 'workspace', id: 'b', name: 'B', path: 'C:\\b', cwd: 'C:\\b\\sub' }
    expect(buildMemoryScopeOptions([global, withCwd], 'C:\\b\\sub')).toEqual([global, withCwd])
  })

  it('appends the current workspace as a degraded fallback when the enumeration is missing or does not cover it', () => {
    const options = buildMemoryScopeOptions(null, 'C:\\ws')
    expect(options).toHaveLength(2)
    expect(options[0]).toEqual(global)
    expect(options[1]).toMatchObject({ scope: 'workspace', id: 'current', name: 'ws', path: 'C:\\ws', cwd: 'C:\\ws' })
    const appended = buildMemoryScopeOptions([global], 'C:\\other')
    expect(appended).toHaveLength(2)
    expect(appended[1]).toMatchObject({ scope: 'workspace', path: 'C:\\other' })
  })

  it('always guarantees a global option, even without an enumeration', () => {
    expect(buildMemoryScopeOptions(null, undefined)).toEqual([global])
    expect(buildMemoryScopeOptions(null, '   ')).toEqual([global])
    expect(buildMemoryScopeOptions([], '')).toEqual([global])
  })
})

describe('memoryScopeOptionKey / defaultMemoryScopeSelection', () => {
  const global: GrayMemoryScopeInfo = { scope: 'global', id: 'global', name: 'Global', path: '' }
  const wsA: GrayMemoryScopeInfo = { scope: 'workspace', id: 'a', name: 'A', path: 'C:\\a' }
  const wsB: GrayMemoryScopeInfo = { scope: 'workspace', id: 'b', name: 'B', path: 'C:\\b' }

  it('keys workspace options by path so the fallback and the real entry share one key', () => {
    const fallback: GrayMemoryScopeInfo = { scope: 'workspace', id: 'current', name: 'ws', path: 'C:\\ws', cwd: 'C:\\ws' }
    const real: GrayMemoryScopeInfo = { scope: 'workspace', id: 'ws', name: 'ws', path: 'C:\\ws', cwd: 'C:\\ws' }
    expect(memoryScopeOptionKey(fallback)).toBe(memoryScopeOptionKey(real))
    expect(memoryScopeOptionKey(global)).toBe('global\u0000global')
    expect(memoryScopeOptionKey(wsA)).not.toBe(memoryScopeOptionKey(wsB))
  })

  it('defaults to the current session workspace when present, else global', () => {
    expect(defaultMemoryScopeSelection([global, wsA, wsB], 'C:\\b')).toEqual(wsB)
    expect(defaultMemoryScopeSelection([global, wsA], undefined)).toEqual(global)
    expect(defaultMemoryScopeSelection([global, wsA], 'D:\\missing')).toEqual(global)
  })

  it('degrades to the global fallback for an empty option list', () => {
    expect(defaultMemoryScopeSelection([], undefined)).toEqual(GLOBAL_MEMORY_SCOPE_FALLBACK)
  })
})

// ---------------------------------------------------------------------------
// Selection helpers (M-03 multi-select / select-all)
// ---------------------------------------------------------------------------

describe('memory selection helpers', () => {
  it('toggles ids in and out of the selection order-preservingly', () => {
    expect(toggleMemorySelection(EMPTY_MEMORY_SELECTION, 1)).toEqual([1])
    expect(toggleMemorySelection([1, 3], 2)).toEqual([1, 3, 2])
    expect(toggleMemorySelection([1, 3, 2], 3)).toEqual([1, 2])
  })

  it('selects a whole page as a union; empty pages are no-ops', () => {
    expect(selectMemoryPage(EMPTY_MEMORY_SELECTION, [5, 6, 7])).toEqual([5, 6, 7])
    expect(selectMemoryPage([1, 5], [5, 6])).toEqual([1, 5, 6])
    expect(selectMemoryPage([1], [])).toEqual([1])
  })

  it('excludes reported notFound ids from the selection', () => {
    expect(excludeMemorySelection([1, 2, 3], [2])).toEqual([1, 3])
    expect(excludeMemorySelection([1, 2], [])).toEqual([1, 2])
    expect(excludeMemorySelection(EMPTY_MEMORY_SELECTION, [1])).toEqual([])
  })

  it('reports page-selection state for the header checkbox', () => {
    expect(isMemoryPageSelected([1, 2, 3], [1, 2, 3])).toBe(true)
    expect(isMemoryPageSelected([1, 2], [1, 2, 3])).toBe(false)
    expect(isMemoryPageSelected([], [1])).toBe(false)
    expect(isMemoryPageSelected([], [])).toBe(false)
  })
})

describe('applyMemoryTextCount', () => {
  it('substitutes the {n} placeholder only when a count is given', () => {
    expect(applyMemoryTextCount('delete {n} memories', 3)).toBe('delete 3 memories')
    expect(applyMemoryTextCount('delete {n} memories', undefined)).toBe('delete {n} memories')
    expect(applyMemoryTextCount('no placeholder', 2)).toBe('no placeholder')
  })
})

// ---------------------------------------------------------------------------
// Batch forget confirmation state machine (M-03)
// ---------------------------------------------------------------------------

describe('batch forget confirmation state machine', () => {
  const target = { ids: [1, 2, 3], revision: REVISION, scope: 'global' as const }
  const outcome = { removed: 2, notFound: [3] }

  it('starts idle and frozen', () => {
    expect(IDLE_BATCH_FORGET_STATE).toEqual({ phase: 'idle', target: null, outcome: null, error: null })
    expect(Object.isFrozen(IDLE_BATCH_FORGET_STATE)).toBe(true)
  })

  it('request arms the target with the captured ids (idle → confirming)', () => {
    const state = requestBatchForget(IDLE_BATCH_FORGET_STATE, target)
    expect(state.phase).toBe('confirming')
    expect(state.target).toEqual(target)
  })

  it('request is a no-op while already armed', () => {
    const armed = requestBatchForget(IDLE_BATCH_FORGET_STATE, target)
    expect(requestBatchForget(armed, { ids: [9], revision: REVISION, scope: 'workspace' })).toBe(armed)
  })

  it('cancel abandons from confirming, submitting and error; no-op from idle', () => {
    const armed = requestBatchForget(IDLE_BATCH_FORGET_STATE, target)
    expect(cancelBatchForget(armed).phase).toBe('idle')
    const submitting = confirmBatchForget(armed)
    expect(cancelBatchForget(submitting).phase).toBe('idle')
    const errored = rejectBatchForget(submitting, failure(CODES.INTERNAL))
    expect(cancelBatchForget(errored).phase).toBe('idle')
    expect(cancelBatchForget(IDLE_BATCH_FORGET_STATE)).toBe(IDLE_BATCH_FORGET_STATE)
  })

  it('confirm is the only path to submitting (double-submit guarded)', () => {
    const armed = requestBatchForget(IDLE_BATCH_FORGET_STATE, target)
    const submitting = confirmBatchForget(armed)
    expect(submitting.phase).toBe('submitting')
    expect(submitting.target).toEqual(target)
    expect(confirmBatchForget(submitting)).toBe(submitting)
    expect(confirmBatchForget(IDLE_BATCH_FORGET_STATE)).toBe(IDLE_BATCH_FORGET_STATE)
  })

  it('resolve lands the outcome including a partial notFound (submitting → done)', () => {
    const state = resolveBatchForget(confirmBatchForget(requestBatchForget(IDLE_BATCH_FORGET_STATE, target)), outcome)
    expect(state.phase).toBe('done')
    expect(state.outcome).toEqual(outcome)
    expect(state.error).toBeNull()
  })

  it('reject maps the failure to a stable-code view (submitting → error)', () => {
    const state = rejectBatchForget(confirmBatchForget(requestBatchForget(IDLE_BATCH_FORGET_STATE, target)), failure(CODES.CONFLICT))
    expect(state.phase).toBe('error')
    expect(state.error).toMatchObject({ code: CODES.CONFLICT, localeKey: 'error.conflict' })
    expect(state.outcome).toBeNull()
  })

  it('resolve/reject are no-ops outside submitting', () => {
    const armed = requestBatchForget(IDLE_BATCH_FORGET_STATE, target)
    expect(resolveBatchForget(armed, outcome)).toBe(armed)
    expect(rejectBatchForget(armed, failure(CODES.INTERNAL))).toBe(armed)
    expect(resolveBatchForget(IDLE_BATCH_FORGET_STATE, outcome)).toBe(IDLE_BATCH_FORGET_STATE)
  })

  it('retries from error via confirm (error → submitting)', () => {
    const errored = rejectBatchForget(confirmBatchForget(requestBatchForget(IDLE_BATCH_FORGET_STATE, target)), failure(CODES.INTERNAL))
    const retried = confirmBatchForget(errored)
    expect(retried.phase).toBe('submitting')
    expect(retried.target).toEqual(target)
  })

  it('dismiss resets done → idle and is a no-op elsewhere', () => {
    const done = resolveBatchForget(confirmBatchForget(requestBatchForget(IDLE_BATCH_FORGET_STATE, target)), outcome)
    expect(dismissBatchForget(done)).toBe(IDLE_BATCH_FORGET_STATE)
    expect(dismissBatchForget(IDLE_BATCH_FORGET_STATE)).toBe(IDLE_BATCH_FORGET_STATE)
  })
})

// ---------------------------------------------------------------------------
// Error code mapping
// ---------------------------------------------------------------------------

describe('mapMemoryFailure', () => {
  it('maps every stable code to its locale key, tone and retryability', () => {
    const expectations: Record<string, { localeKey: string; tone: string; retryable: boolean }> = {
      [CODES.INVALID_INPUT]: { localeKey: 'error.invalidInput', tone: 'warning', retryable: false },
      [CODES.CONFLICT]: { localeKey: 'error.conflict', tone: 'warning', retryable: true },
      [CODES.APPROVAL_REQUIRED]: { localeKey: 'error.approvalRequired', tone: 'warning', retryable: true },
      [CODES.CANCELLED]: { localeKey: 'error.cancelled', tone: 'info', retryable: true },
      [CODES.STORAGE_CORRUPT]: { localeKey: 'error.storageCorrupt', tone: 'danger', retryable: false },
      [CODES.NOT_FOUND]: { localeKey: 'error.notFound', tone: 'warning', retryable: false },
      [CODES.ENDPOINT_NOT_FOUND]: { localeKey: 'error.endpointNotFound', tone: 'neutral', retryable: false },
      [CODES.INTERNAL]: { localeKey: 'error.internal', tone: 'danger', retryable: true },
    }
    for (const [code, expected] of Object.entries(expectations)) {
      const view = mapMemoryFailure(failure(code))
      expect(view.code, code).toBe(code)
      expect(view.localeKey, code).toBe(expected.localeKey)
      expect(view.tone, code).toBe(expected.tone)
      expect(view.retryable, code).toBe(expected.retryable)
    }
  })

  it('degrades unknown codes and null failures to the internal view', () => {
    expect(mapMemoryFailure(failure('GRAY_UNKNOWN'))).toMatchObject({ code: 'UNKNOWN', localeKey: 'error.internal' })
    expect(mapMemoryFailure(null)).toMatchObject({ code: 'UNKNOWN', localeKey: 'error.internal' })
    expect(mapMemoryFailure(undefined)).toMatchObject({ code: 'UNKNOWN', localeKey: 'error.internal' })
  })

  it('distinguishes an absent workspace store from an absent entry using structured details', () => {
    expect(mapMemoryFailure({
      code: CODES.NOT_FOUND,
      message: 'not parsed by the client',
      details: { kind: 'workspace-store', workspace: 'D:\\repo' },
    })).toMatchObject({ localeKey: 'error.workspaceNotInitialized', tone: 'info' })
    expect(mapMemoryFailure({
      code: CODES.NOT_FOUND,
      message: 'not parsed by the client',
      details: { workspace: 'D:\\repo' },
    })).toMatchObject({ localeKey: 'error.notFound', tone: 'warning' })
    expect(mapMemoryFailure({
      code: CODES.NOT_FOUND,
      message: 'not parsed by the client',
      details: { kind: 'memory-entry', workspace: 'D:\\repo', id: 7 },
    })).toMatchObject({ localeKey: 'error.notFound', tone: 'warning' })
  })

  it('classifies only the structured stale-cursor conflict as restartable', () => {
    expect(isStaleMemoryCursorFailure({
      code: CODES.CONFLICT,
      message: 'stale',
      details: { kind: 'memory-cursor', reason: 'stale', restartRequired: true },
    })).toBe(true)
    expect(isStaleMemoryCursorFailure({
      code: CODES.CONFLICT,
      message: 'other conflict',
      details: { kind: 'memory-entry' },
    })).toBe(false)
  })

  it('classifies only structured stale memory revisions as CAS refresh conflicts', () => {
    expect(isStaleMemoryRevisionFailure({
      code: CODES.CONFLICT,
      message: 'stale',
      details: { kind: 'memory-revision', reason: 'stale', restartRequired: true },
    })).toBe(true)
    expect(isStaleMemoryRevisionFailure({
      code: CODES.CONFLICT,
      message: 'other conflict',
      details: { kind: 'memory-entry', reason: 'stale' },
    })).toBe(false)
  })

  it('maps local entryChars overflow to INVALID_INPUT rather than INTERNAL', () => {
    const failure = memoryEntryCharsExceededFailure(11, 10)
    expect(failure).toMatchObject({
      code: CODES.INVALID_INPUT,
      details: { field: 'text', actualBytes: 11, limit: 10 },
    })
    expect(mapMemoryFailure(failure)).toMatchObject({ localeKey: 'error.invalidInput', retryable: false })
  })
})

describe('normalizeMemoryEntryChars', () => {
  it('accepts only host-valid integer limits', () => {
    expect(normalizeMemoryEntryChars(1)).toBe(1)
    expect(normalizeMemoryEntryChars(1_000)).toBe(1_000)
    expect(normalizeMemoryEntryChars(0)).toBeUndefined()
    expect(normalizeMemoryEntryChars(1_001)).toBeUndefined()
    expect(normalizeMemoryEntryChars(1.5)).toBeUndefined()
    expect(normalizeMemoryEntryChars('280')).toBeUndefined()
  })

  it('rejects stale config responses after a newer request, context switch, HMR, or unmount', () => {
    const oldTransport = {}
    const currentTransport = {}
    const base = {
      mounted: true,
      requestId: 2,
      latestRequestId: 2,
      requestContextKey: '["workspace","C:\\\\repo",""]',
      currentContextKey: '["workspace","C:\\\\repo",""]',
      requestTransport: currentTransport,
      currentTransport,
    }
    expect(isCurrentMemoryConfigResponse(base)).toBe(true)
    expect(isCurrentMemoryConfigResponse({ ...base, latestRequestId: 3 })).toBe(false)
    expect(isCurrentMemoryConfigResponse({ ...base, currentContextKey: '["global","",""]' })).toBe(false)
    expect(isCurrentMemoryConfigResponse({ ...base, requestTransport: oldTransport })).toBe(false)
    expect(isCurrentMemoryConfigResponse({ ...base, mounted: false })).toBe(false)
  })
})

describe('toMemoryFailure', () => {
  it('passes failure-like values through', () => {
    const err = { code: CODES.NOT_FOUND, message: 'gone', details: { id: 1 } }
    expect(toMemoryFailure(err)).toEqual(err)
  })

  it('maps aborted signals and AbortError to CANCELLED', () => {
    const signal = { aborted: true } as AbortSignal
    expect(toMemoryFailure(new Error('x'), signal).code).toBe(CODES.CANCELLED)
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(toMemoryFailure(abort).code).toBe(CODES.CANCELLED)
  })

  it('maps anything else to INTERNAL without leaking details', () => {
    const mapped = toMemoryFailure(new Error('secret internal path'))
    expect(mapped.code).toBe(CODES.INTERNAL)
    expect(mapped.message).not.toContain('secret')
    expect(mapped.details).toEqual({ causeName: 'Error' })
  })
})

// ---------------------------------------------------------------------------
// Defensive wire readers
// ---------------------------------------------------------------------------

describe('defensive wire readers', () => {
  it('narrows envelopes and failures', () => {
    expect(isGrayRemoteResult({ ok: true, value: {} })).toBe(true)
    expect(isGrayRemoteResult({ ok: false, error: failure(CODES.INTERNAL) })).toBe(true)
    expect(isGrayRemoteResult({ ok: true })).toBe(false)
    expect(isGrayRemoteResult({ ok: false, error: { code: 'NOPE', message: 'x' } })).toBe(false)
    expect(isGrayRemoteResult('nope')).toBe(false)
    expect(readGrayRemoteFailure(failure(CODES.NOT_FOUND))).toEqual(failure(CODES.NOT_FOUND))
    expect(readGrayRemoteFailure({ code: 'NOPE' })).toBeNull()
  })

  it('reads entry views and rejects malformed ones', () => {
    expect(readMemoryEntryView({ id: 1, date: '2025-01-01', text: 't' })).toEqual({ id: 1, date: '2025-01-01', text: 't' })
    expect(readMemoryEntryView({ id: '1', date: '2025-01-01', text: 't' })).toBeNull()
    expect(readMemoryEntryView({ id: 1, date: 5, text: 't' })).toBeNull()
    expect(readMemoryEntryView({ id: 1, date: '2025-01-01', text: 5 })).toBeNull()
    expect(readMemoryEntryView(null)).toBeNull()
  })

  it('reads list pages strictly (one bad item voids the page)', () => {
    const good = { items: [{ id: 1, date: '2025-01-01', text: 'a' }], total: 1, nextCursor: '1', revision: REVISION }
    expect(readMemoryListResult(good)).toEqual(good)
    expect(readMemoryListResult({ items: [{ id: 1, date: '2025-01-01', text: 'a' }, { id: 'x' }], total: 2, revision: REVISION })).toBeNull()
    expect(readMemoryListResult({ items: [], total: -1, revision: REVISION })).toBeNull()
    expect(readMemoryListResult({ items: [], total: 0 })).toBeNull()
    expect(readMemoryListResult({ items: [], total: 0, nextCursor: '', revision: REVISION }))
      .toEqual({ items: [], total: 0, revision: REVISION })
  })

  it('reads bounded effective memory configs', () => {
    const config = { wakeLines: 96, entryChars: 400, partChars: 20_000, partLines: 500 }
    expect(readMemoryConfig(config)).toEqual(config)
    expect(readMemoryConfig({ ...config, entryChars: 0 })).toBeNull()
    expect(readMemoryConfig({ ...config, entryChars: 1_001 })).toBeNull()
    expect(readMemoryConfig({ ...config, wakeLines: '96' })).toBeNull()
  })

  it('reads forget results', () => {
    expect(readMemoryForgetResult({ mode: 'single', removed: 1 })).toEqual({ mode: 'single', removed: 1 })
    expect(readMemoryForgetResult({ mode: 'summary', gone: 2, firstId: '0-3' })).toEqual({ mode: 'summary', gone: 2, firstId: '0-3' })
    expect(readMemoryForgetResult({ mode: 'bogus' })).toBeNull()
  })

  it('reads scope info and scopes results strictly', () => {
    const info: GrayMemoryScopeInfo = { scope: 'workspace', id: 'ws', name: 'WS', path: 'C:\\ws', cwd: 'C:\\ws\\sub' }
    expect(readMemoryScopeInfo(info)).toEqual(info)
    expect(readMemoryScopeInfo({ scope: 'workspace', id: 'ws', name: 'WS', path: 'C:\\ws' }))
      .toEqual({ scope: 'workspace', id: 'ws', name: 'WS', path: 'C:\\ws' })
    // Optional fields with a wrong type are dropped, required fields are strict.
    expect(readMemoryScopeInfo({ scope: 'workspace', id: 'x', name: 'X', path: 'p', cwd: 5 }))
      .toEqual({ scope: 'workspace', id: 'x', name: 'X', path: 'p' })
    expect(readMemoryScopeInfo({ scope: 'global', id: '', name: 'G', path: '' })).toBeNull()
    expect(readMemoryScopeInfo({ scope: 'bogus', id: 'x', name: 'X', path: 'p' })).toBeNull()
    expect(readMemoryScopeInfo(null)).toBeNull()

    expect(readMemoryScopesResult({ items: [info] })).toEqual({ items: [info] })
    expect(readMemoryScopesResult({ items: [{ scope: 'bogus', id: 'x', name: 'X', path: 'p' }] })).toBeNull()
    expect(readMemoryScopesResult({ items: 'nope' })).toBeNull()
    expect(readMemoryScopesResult({})).toBeNull()
  })

  it('reads forgetBatch results (including partial notFound)', () => {
    expect(readMemoryForgetBatchResult({ removed: 2, notFound: [3, 4] })).toEqual({ removed: 2, notFound: [3, 4] })
    expect(readMemoryForgetBatchResult({ removed: 0, notFound: [] })).toEqual({ removed: 0, notFound: [] })
    expect(readMemoryForgetBatchResult({ removed: -1, notFound: [] })).toBeNull()
    expect(readMemoryForgetBatchResult({ removed: 1, notFound: ['x'] })).toBeNull()
    expect(readMemoryForgetBatchResult({ removed: 1 })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

describe('createMockMemoryTransport', () => {
  const seed: GrayMemoryEntryView[] = [
    { id: 0, date: '2025-01-01', text: 'Alpha note' },
    { id: 1, date: '2025-01-02', text: 'beta design' },
    { id: 2, date: '2025-01-03', text: 'ALPHA plan' },
    { id: 3, date: '2025-01-04', text: 'gamma review' },
  ]

  it('is wired:false and lists newest-first with totals', async () => {
    const transport = createMockMemoryTransport(seed)
    expect(transport.wired).toBe(false)
    const result = await transport.list({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.items.map(item => item.id)).toEqual([3, 2, 1, 0])
    expect(result.value.total).toBe(4)
    expect(result.value.nextCursor).toBeUndefined()
  })

  it('filters by search (case-insensitive) and scope', async () => {
    const transport = createMockMemoryTransport(seed)
    const searched = await transport.list({ search: 'alpha' })
    expect(searched.ok && searched.value.items.map(item => item.id)).toEqual([2, 0])
    expect(searched.ok && searched.value.total).toBe(2)

    const scoped = createMockMemoryTransport([
      ...seed,
      { id: 0, date: '2025-01-05', text: 'workspace only', scope: 'workspace' },
    ], { workspace: 'C:\\ws' })
    const ws = await scoped.list({ scope: 'workspace' })
    expect(ws.ok && ws.value.items.map(item => item.id)).toEqual([0])
    const global = await scoped.list({ scope: 'global' })
    expect(global.ok && global.value.items.map(item => item.id)).toEqual([3, 2, 1, 0])
  })

  it('paginates by cursor and normalizes the limit', async () => {
    const transport = createMockMemoryTransport(seed)
    const page1 = await transport.list({ limit: 2 })
    expect(page1.ok && page1.value.items.map(item => item.id)).toEqual([3, 2])
    expect(page1.ok && page1.value.nextCursor).toMatch(/^mock-memory-cursor-/)
    if (!page1.ok || page1.value.nextCursor === undefined) return
    const page2 = await transport.list({ limit: 2, cursor: page1.value.nextCursor })
    expect(page2.ok && page2.value.items.map(item => item.id)).toEqual([1, 0])
    expect(page2.ok && page2.value.nextCursor).toBeUndefined()
    const zero = await transport.list({ limit: 0 })
    expect(zero.ok).toBe(true)
    if (zero.ok) expect(zero.value.items).toHaveLength(seed.length) // default 20 > 4 seeds
  })

  it('rejects a cursor after the backing snapshot mutates', async () => {
    const transport = createMockMemoryTransport(seed)
    const first = await transport.list({ limit: 2 })
    if (!first.ok || first.value.nextCursor === undefined) throw new Error('expected a cursor')
    await transport.add({ text: 'newer memory' })
    const stale = await transport.list({ limit: 2, cursor: first.value.nextCursor })
    expect(stale.ok).toBe(false)
    if (stale.ok) return
    expect(stale.error).toMatchObject({
      code: CODES.CONFLICT,
      details: { kind: 'memory-cursor', reason: 'stale', restartRequired: true },
    })
  })

  it('rejects stale edit/delete revisions after a renumbering mutation', async () => {
    const transport = createMockMemoryTransport(seed)
    const stale = await transport.list({})
    if (!stale.ok) throw new Error('expected list')
    const removed = await transport.forget({
      blockId: '0',
      expectedRevision: stale.value.revision,
      confirm: true,
    })
    expect(removed.ok).toBe(true)

    const edit = await transport.edit({
      id: 1,
      text: 'must not overwrite the shifted row',
      expectedRevision: stale.value.revision,
    })
    expect(edit).toMatchObject({
      ok: false,
      error: { code: CODES.CONFLICT, details: { kind: 'memory-revision', reason: 'stale' } },
    })
    const forget = await transport.forget({
      blockId: '1',
      expectedRevision: stale.value.revision,
      confirm: true,
    })
    expect(forget).toMatchObject({
      ok: false,
      error: { code: CODES.CONFLICT, details: { kind: 'memory-revision', reason: 'stale' } },
    })
  })

  it('returns the effective config and preserves workspace-store details', async () => {
    const config = { wakeLines: 120, entryChars: 640, partChars: 30_000, partLines: 600 }
    const transport = createMockMemoryTransport(seed, { config })
    expect(await transport.configGet?.({ scope: 'global' })).toEqual({ ok: true, value: config })
    const workspaceResult = await transport.configGet?.({ scope: 'workspace', workspace: 'C:\\ws' })
    expect(workspaceResult).toMatchObject({
      ok: false,
      error: { code: CODES.NOT_FOUND, details: { kind: 'workspace-store', workspace: 'C:\\ws' } },
    })
  })

  it('rejects workspace scope without a workspace root (mirrors host)', async () => {
    const transport = createMockMemoryTransport(seed)
    const result = await transport.list({ scope: 'workspace' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(CODES.INVALID_INPUT)
  })

  it('edits in place keeping id and date; missing id → NOT_FOUND; empty text → INVALID_INPUT', async () => {
    const transport = createMockMemoryTransport(seed)
    const before = await transport.list({})
    if (!before.ok) throw new Error('expected list')
    const edited = await transport.edit({ id: 1, text: 'beta revised', expectedRevision: before.value.revision })
    expect(edited).toEqual({ ok: true, value: { id: 1, date: '2025-01-02', text: 'beta revised' } })
    const listed = await transport.list({})
    expect(listed.ok && listed.value.items.find(item => item.id === 1)!.text).toBe('beta revised')
    if (!listed.ok) throw new Error('expected refreshed list')

    const missing = await transport.edit({ id: 99, text: 'x', expectedRevision: listed.value.revision })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error.code).toBe(CODES.NOT_FOUND)

    const empty = await transport.edit({ id: 0, text: '  ', expectedRevision: listed.value.revision })
    expect(empty.ok).toBe(false)
    if (empty.ok) return
    expect(empty.error.code).toBe(CODES.INVALID_INPUT)
  })

  it('gates forget behind confirm: true (APPROVAL_REQUIRED otherwise)', async () => {
    const transport = createMockMemoryTransport(seed)
    const unconfirmed = await transport.forget({ blockId: '1', confirm: false })
    expect(unconfirmed.ok).toBe(false)
    if (unconfirmed.ok) return
    expect(unconfirmed.error.code).toBe(CODES.APPROVAL_REQUIRED)
    const missingConfirm = await transport.forget({ blockId: '1' })
    expect(missingConfirm.ok).toBe(false)
    if (missingConfirm.ok) return
    expect(missingConfirm.error.code).toBe(CODES.APPROVAL_REQUIRED)
  })

  it('forgets single entries and ranges; missing → NOT_FOUND; summary ids → INVALID_INPUT', async () => {
    const transport = createMockMemoryTransport(seed)
    const before = await transport.list({})
    if (!before.ok) throw new Error('expected list')
    const single = await transport.forget({
      blockId: '1',
      expectedRevision: before.value.revision,
      confirm: true,
    })
    expect(single).toEqual({ ok: true, value: { mode: 'single', removed: 1 } })
    const after = await transport.list({})
    expect(after.ok && after.value.items.map(item => item.id)).toEqual([2, 1, 0])
    if (!after.ok) throw new Error('expected refreshed list')

    const range = await transport.forget({
      blockId: '1,2',
      expectedRevision: after.value.revision,
      confirm: true,
    })
    expect(range.ok && range.value).toEqual({ mode: 'range', removed: 2 })
    const remaining = await transport.list({})
    expect(remaining.ok && remaining.value.items.map(item => item.id)).toEqual([0])
    if (!remaining.ok) throw new Error('expected remaining list')

    const missing = await transport.forget({
      blockId: '9',
      expectedRevision: remaining.value.revision,
      confirm: true,
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error.code).toBe(CODES.NOT_FOUND)

    const summary = await transport.forget({ blockId: '1-2', confirm: true })
    expect(summary.ok).toBe(false)
    if (summary.ok) return
    expect(summary.error.code).toBe(CODES.INVALID_INPUT)
  })

  it('adds a new entry with the next id and today date; trims and validates', async () => {
    const transport = createMockMemoryTransport(seed)
    const added = await transport.add({ text: '  fresh note  ' })
    expect(added).toEqual({ ok: true, value: { id: 4, date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), text: 'fresh note' } })
    const listed = await transport.list({})
    expect(listed.ok && listed.value.items[0]!.id).toBe(4)

    const empty = await transport.add({ text: '   ' })
    expect(empty.ok).toBe(false)
    if (empty.ok) return
    expect(empty.error.code).toBe(CODES.INVALID_INPUT)
  })

  it('add respects the workspace scope guard (requires a workspace root)', async () => {
    const transport = createMockMemoryTransport(seed)
    const result = await transport.add({ scope: 'workspace', text: 'ws note' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(CODES.INVALID_INPUT)

    const scoped = createMockMemoryTransport(seed, { workspace: 'C:\\ws' })
    const added = await scoped.add({ scope: 'workspace', text: 'ws note' })
    expect(added.ok && added.value.id).toBe(0)
    const wsList = await scoped.list({ scope: 'workspace' })
    expect(wsList.ok && wsList.value.items.map(item => item.id)).toEqual([0])
  })

  it('honours aborted signals with CANCELLED', async () => {
    const transport = createMockMemoryTransport(seed)
    const signal = { aborted: true } as AbortSignal
    const result = await transport.list({}, signal)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(CODES.CANCELLED)
  })
})

describe('createMockMemoryTransport — M-02/M-03 endpoints', () => {
  const seed: GrayMemoryEntryView[] = [
    { id: 0, date: '2025-01-01', text: 'Alpha note' },
    { id: 1, date: '2025-01-02', text: 'beta design' },
    { id: 2, date: '2025-01-03', text: 'ALPHA plan' },
  ]

  it('enumerates scopes: global alone, or global + the mock workspace root', async () => {
    const globalOnly = createMockMemoryTransport(seed)
    const g = await globalOnly.listScopes()
    expect(g.ok && g.value.items).toEqual([{ scope: 'global', id: 'global', name: 'Global', path: '' }])

    const withWs = createMockMemoryTransport(seed, { workspace: 'C:\\repo' })
    const s = await withWs.listScopes()
    expect(s.ok && s.value.items).toEqual([
      { scope: 'global', id: 'global', name: 'Global', path: '' },
      { scope: 'workspace', id: 'repo', name: 'repo', path: 'C:\\repo', cwd: 'C:\\repo' },
    ])
  })

  it('serves a custom scope enumeration from the options', async () => {
    const scopes: GrayMemoryScopeInfo[] = [
      { scope: 'global', id: 'global', name: 'Global', path: '' },
      { scope: 'workspace', id: 'one', name: 'One', path: 'C:\\one' },
      { scope: 'workspace', id: 'two', name: 'Two', path: 'C:\\two' },
    ]
    const transport = createMockMemoryTransport(seed, { scopes })
    const result = await transport.listScopes()
    expect(result.ok && result.value.items).toEqual(scopes)
  })

  it('gates forgetBatch behind confirm: true (APPROVAL_REQUIRED otherwise)', async () => {
    const transport = createMockMemoryTransport(seed)
    const before = await transport.list({})
    if (!before.ok) throw new Error('expected list')
    const unconfirmed = await transport.forgetBatch({ ids: [1], expectedRevision: before.value.revision, confirm: false })
    expect(unconfirmed.ok).toBe(false)
    if (unconfirmed.ok) return
    expect(unconfirmed.error.code).toBe(CODES.APPROVAL_REQUIRED)
    const missing = await transport.forgetBatch({ ids: [1], expectedRevision: before.value.revision })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error.code).toBe(CODES.APPROVAL_REQUIRED)
  })

  it('rejects empty/non-integer id arrays and stale revisions', async () => {
    const transport = createMockMemoryTransport(seed)
    const before = await transport.list({})
    if (!before.ok) throw new Error('expected list')
    const empty = await transport.forgetBatch({ ids: [], expectedRevision: before.value.revision, confirm: true })
    expect(empty.ok).toBe(false)
    if (empty.ok) return
    expect(empty.error.code).toBe(CODES.INVALID_INPUT)
    const bad = await transport.forgetBatch({ ids: [1.5], expectedRevision: before.value.revision, confirm: true })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error.code).toBe(CODES.INVALID_INPUT)
    const stale = await transport.forgetBatch({ ids: [1], expectedRevision: 'mock:old', confirm: true })
    expect(stale.ok).toBe(false)
    if (stale.ok) return
    expect(stale.error).toMatchObject({
      code: CODES.CONFLICT,
      details: { kind: 'memory-revision', reason: 'stale' },
    })
  })

  it('removes selected ids, renumbers the store and reports notFound (partial success)', async () => {
    const transport = createMockMemoryTransport(seed)
    const before = await transport.list({})
    if (!before.ok) throw new Error('expected list')
    const result = await transport.forgetBatch({
      ids: [1, 99],
      expectedRevision: before.value.revision,
      confirm: true,
    })
    expect(result).toEqual({ ok: true, value: { removed: 1, notFound: [99] } })
    const after = await transport.list({})
    expect(after.ok && after.value.items.map(item => item.id)).toEqual([1, 0])
    expect(after.ok && after.value.total).toBe(2)
    if (!after.ok) throw new Error('expected refreshed list')
    // The store revision advanced, so the old revision is now stale.
    const again = await transport.forgetBatch({ ids: [0], expectedRevision: before.value.revision, confirm: true })
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.error.code).toBe(CODES.CONFLICT)
  })

  it('deduplicates ids and removes them all in one pass', async () => {
    const transport = createMockMemoryTransport(seed)
    const before = await transport.list({})
    if (!before.ok) throw new Error('expected list')
    const result = await transport.forgetBatch({
      ids: [2, 2, 0],
      expectedRevision: before.value.revision,
      confirm: true,
    })
    expect(result).toEqual({ ok: true, value: { removed: 2, notFound: [] } })
    const after = await transport.list({})
    expect(after.ok && after.value.items.map(item => item.id)).toEqual([0])
  })

  it('scopes the batch to the current workspace store and keeps global untouched', async () => {
    const transport = createMockMemoryTransport([
      ...seed,
      { id: 0, date: '2025-01-04', text: 'ws note', scope: 'workspace', workspace: 'C:\\ws' },
    ], { workspace: 'C:\\ws' })
    const before = await transport.list({ scope: 'workspace' })
    if (!before.ok) throw new Error('expected workspace list')
    const result = await transport.forgetBatch({
      ids: [0],
      expectedRevision: before.value.revision,
      confirm: true,
      scope: 'workspace',
      workspace: 'C:\\ws',
    })
    expect(result).toEqual({ ok: true, value: { removed: 1, notFound: [] } })
    const global = await transport.list({})
    expect(global.ok && global.value.items).toHaveLength(3)
    if (!global.ok) throw new Error('expected global list')
    const missing = await transport.forgetBatch({
      ids: [99],
      expectedRevision: global.value.revision,
      confirm: true,
      scope: 'global',
    })
    expect(missing).toEqual({ ok: true, value: { removed: 0, notFound: [99] } })
  })

  it('rejects a workspace-scoped forgetBatch without a workspace root', async () => {
    const transport = createMockMemoryTransport(seed)
    const result = await transport.forgetBatch({
      ids: [1],
      expectedRevision: REVISION,
      confirm: true,
      scope: 'workspace',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(CODES.INVALID_INPUT)
  })

  it('lists per-workspace entries in a multi-workspace mock', async () => {
    const transport = createMockMemoryTransport([
      { id: 0, date: '2025-01-01', text: 'one note', scope: 'workspace', workspace: 'C:\\one' },
      { id: 0, date: '2025-01-02', text: 'two note', scope: 'workspace', workspace: 'C:\\two' },
    ], { workspace: 'C:\\one' })
    const one = await transport.list({ scope: 'workspace', workspace: 'C:\\one' })
    expect(one.ok && one.value.items.map(item => item.text)).toEqual(['one note'])
    const two = await transport.list({ scope: 'workspace', workspace: 'C:\\two' })
    expect(two.ok && two.value.items.map(item => item.text)).toEqual(['two note'])
  })
})

// ---------------------------------------------------------------------------
// Remote transport adapter
// ---------------------------------------------------------------------------

describe('memory transport timeout (3.4-M3 regression)', () => {
  const hangingInvoker: GrayRemoteInvoker = () => new Promise<never>(() => {})

  it('fails a hung host call as GRAY_INTERNAL instead of hanging forever', async () => {
    const hanging = createRemoteMemoryTransport(hangingInvoker, { timeoutMs: 5 })
    const result = await hanging.list({})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(CODES.INTERNAL)
  })

  it('releases the add-gate lease once a hung host call times out', async () => {
    const hanging = createRemoteMemoryTransport(hangingInvoker, { timeoutMs: 5 })
    const gate = new MemoryAddInFlightGate()
    const request = startMemoryAddRequest(gate, () => hanging.add({ text: 'x' }))
    expect(request.started).toBe(true)
    expect(gate.isInFlight()).toBe(true)
    if (!request.started) return
    const result = await request.completion
    expect(result.ok).toBe(false)
    expect(gate.isInFlight()).toBe(false)
  })
})

describe('createRemoteMemoryTransport', () => {
  function recordInvoker(calls: Array<{ namespace: string; method: string; args: unknown }>): GrayRemoteInvoker {
    return async (namespace, method, args) => {
      calls.push({ namespace, method, args })
      return { ok: true, value: { items: [], total: 0, revision: REVISION } }
    }
  }

  it('dispatches all endpoints with namespace/method/args', async () => {
    const calls: Array<{ namespace: string; method: string; args: unknown }> = []
    const transport = createRemoteMemoryTransport(recordInvoker(calls))
    await transport.list({ scope: 'global', search: 'x' })
    await transport.add({ text: 'new note' })
    await transport.edit({ id: 1, text: 't', expectedRevision: REVISION })
    await transport.forget({ blockId: '1', expectedRevision: REVISION, confirm: true })
    await transport.forgetBatch({
      ids: [1, 2],
      expectedRevision: REVISION,
      confirm: true,
      scope: 'workspace',
      workspace: 'C:\\ws',
    })
    await transport.listScopes()
    await transport.configGet?.({ scope: 'workspace', workspace: 'C:\\ws' })
    expect(calls).toEqual([
      { namespace: 'memory', method: 'list', args: { scope: 'global', search: 'x' } },
      { namespace: 'memory', method: 'note', args: { text: 'new note' } },
      { namespace: 'memory', method: 'edit', args: { id: 1, text: 't', expectedRevision: REVISION } },
      { namespace: 'memory', method: 'forget', args: { blockId: '1', expectedRevision: REVISION, confirm: true } },
      {
        namespace: 'memory',
        method: 'forgetBatch',
        args: { ids: [1, 2], expectedRevision: REVISION, confirm: true, scope: 'workspace', workspace: 'C:\\ws' },
      },
      { namespace: 'memory', method: 'scopes', args: {} },
      { namespace: 'memory', method: 'configGet', args: { scope: 'workspace', workspace: 'C:\\ws' } },
    ])
    expect(MEMORY_ENDPOINTS).toEqual({
      list: 'memory/list',
      note: 'memory/note',
      edit: 'memory/edit',
      forget: 'memory/forget',
      forgetBatch: 'memory/forgetBatch',
      scopes: 'memory/scopes',
      configGet: 'memory/configGet',
    })
  })

  it('narrows ok values and turns malformed values into INTERNAL failures', async () => {
    const ok = createRemoteMemoryTransport(async () => ({
      ok: true,
      value: { items: [], total: 0, revision: REVISION },
    }))
    expect(await ok.list({})).toEqual({
      ok: true,
      value: { items: [], total: 0, revision: REVISION },
    })

    const malformed = createRemoteMemoryTransport(async () => ({ ok: true, value: { items: 'nope' } }))
    const result = await malformed.list({})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(CODES.INTERNAL)
  })

  it('defensively narrows configGet values', async () => {
    const config = { wakeLines: 96, entryChars: 512, partChars: 20_000, partLines: 500 }
    const ok = createRemoteMemoryTransport(async () => ({ ok: true, value: config }))
    expect(await ok.configGet?.({ scope: 'global' })).toEqual({ ok: true, value: config })

    const malformed = createRemoteMemoryTransport(async () => ({ ok: true, value: { ...config, entryChars: 0 } }))
    const result = await malformed.configGet?.({ scope: 'global' })
    expect(result?.ok).toBe(false)
    if (result === undefined || result.ok) return
    expect(result.error.code).toBe(CODES.INTERNAL)
  })

  it('never rejects: thrown invokers and non-envelope results become INTERNAL', async () => {
    const throwing = createRemoteMemoryTransport(async () => {
      throw new Error('secret')
    })
    const thrown = await throwing.list({})
    expect(thrown.ok).toBe(false)
    if (thrown.ok) return
    expect(thrown.error.code).toBe(CODES.INTERNAL)
    expect(thrown.error.message).not.toContain('secret')

    const weird = createRemoteMemoryTransport(async () => 'not an envelope')
    const weirdResult = await weird.list({})
    expect(weirdResult.ok).toBe(false)
    if (weirdResult.ok) return
    expect(weirdResult.error.code).toBe(CODES.INTERNAL)
  })

  it('passes host failure envelopes through untouched', async () => {
    const transport = createRemoteMemoryTransport(async () => ({
      ok: false,
      error: { code: CODES.ENDPOINT_NOT_FOUND, message: 'not found', details: {} },
    }))
    const result = await transport.list({})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(CODES.ENDPOINT_NOT_FOUND)
  })
})

describe('createRemoteMemoryTransport — M-02/M-03 endpoints', () => {
  it('narrows scopes and forgetBatch values; malformed ones become INTERNAL', async () => {
    const scopesValue = { items: [{ scope: 'global', id: 'global', name: 'Global', path: '' }] }
    const okScopes = createRemoteMemoryTransport(async () => ({ ok: true, value: scopesValue }))
    expect(await okScopes.listScopes()).toEqual({ ok: true, value: scopesValue })

    const okBatch = createRemoteMemoryTransport(async () => ({ ok: true, value: { removed: 1, notFound: [2] } }))
    expect(await okBatch.forgetBatch({ ids: [1], expectedRevision: REVISION, confirm: true }))
      .toEqual({ ok: true, value: { removed: 1, notFound: [2] } })

    const malformedScopes = createRemoteMemoryTransport(async () => ({ ok: true, value: { items: [{ scope: 'bogus' }] } }))
    const s = await malformedScopes.listScopes()
    expect(s.ok).toBe(false)
    if (s.ok) return
    expect(s.error.code).toBe(CODES.INTERNAL)

    const malformedBatch = createRemoteMemoryTransport(async () => ({ ok: true, value: { removed: 'x' } }))
    const b = await malformedBatch.forgetBatch({ ids: [1], expectedRevision: REVISION, confirm: true })
    expect(b.ok).toBe(false)
    if (b.ok) return
    expect(b.error.code).toBe(CODES.INTERNAL)
  })

  it('passes scopes/forgetBatch host failures through untouched', async () => {
    const failing = createRemoteMemoryTransport(async () => ({
      ok: false,
      error: { code: CODES.APPROVAL_REQUIRED, message: 'confirm required', details: {} },
    }))
    const scopes = await failing.listScopes()
    expect(scopes.ok).toBe(false)
    if (scopes.ok) return
    expect(scopes.error.code).toBe(CODES.APPROVAL_REQUIRED)
    const batch = await failing.forgetBatch({ ids: [1], expectedRevision: REVISION, confirm: true })
    expect(batch.ok).toBe(false)
    if (batch.ok) return
    expect(batch.error.code).toBe(CODES.APPROVAL_REQUIRED)
  })
})

// ---------------------------------------------------------------------------
// Locale alignment
// ---------------------------------------------------------------------------

describe('graycode.memoryManage locale dictionaries', () => {
  it('declares its own namespace', () => {
    expect(GRAYCODE_MEMORY_MANAGE_NS).toBe('graycode.memoryManage')
  })

  it('keeps zh/en dictionaries balanced (identical key sets)', () => {
    const en = Object.keys(graycodeMemoryManageDictionaries.en).sort()
    const zh = Object.keys(graycodeMemoryManageDictionaries.zh).sort()
    expect(zh).toEqual(en)
  })

  it('keeps the ja placeholder on the same key set', () => {
    expect(Object.keys(graycodeMemoryManageJaPlaceholder).sort()).toEqual(
      Object.keys(graycodeMemoryManageDictionaries.en).sort(),
    )
  })

  it('fills every shipped locale with non-empty text', () => {
    for (const dict of Object.values(graycodeMemoryManageDictionaries)) {
      for (const text of Object.values(dict)) {
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })

  it('covers every stable error code with its mapped error.<x> key', () => {
    const en = graycodeMemoryManageDictionaries.en
    const expected: Record<string, string> = {
      [CODES.INVALID_INPUT]: 'error.invalidInput',
      [CODES.CONFLICT]: 'error.conflict',
      [CODES.APPROVAL_REQUIRED]: 'error.approvalRequired',
      [CODES.CANCELLED]: 'error.cancelled',
      [CODES.STORAGE_CORRUPT]: 'error.storageCorrupt',
      [CODES.NOT_FOUND]: 'error.notFound',
      [CODES.ENDPOINT_NOT_FOUND]: 'error.endpointNotFound',
      [CODES.INTERNAL]: 'error.internal',
    }
    for (const [code, key] of Object.entries(expected)) {
      expect(en[key as keyof typeof en], code).toBeDefined()
    }
  })

  it('covers every view-model scope and forget phase label', () => {
    const en = graycodeMemoryManageDictionaries.en
    for (const scope of GRAY_MEMORY_SCOPES) {
      expect(en[`scope.${scope}`]).toBeDefined()
    }
    for (const label of ['forget.warning', 'forget.confirm', 'forget.cancel', 'forget.submitting', 'forget.done']) {
      expect(en[label as keyof typeof en]).toBeDefined()
    }
  })

  it('covers the M-02/M-03 UI keys in every shipped locale', () => {
    const keys = [
      'scope.select',
      'scope.path',
      'scope.loadFailed',
      'list.selectAll',
      'list.selectAllHint',
      'batchForget.button',
      'batchForget.title',
      'batchForget.warning',
      'batchForget.confirm',
      'batchForget.cancel',
      'batchForget.submitting',
      'batchForget.done',
      'batchForget.partial',
    ]
    for (const dict of Object.values(graycodeMemoryManageDictionaries)) {
      for (const key of keys) {
        expect((dict as Record<string, string>)[key], key).toBeDefined()
      }
    }
    for (const key of keys) {
      expect((graycodeMemoryManageJaPlaceholder as Record<string, string>)[key], key).toBeDefined()
    }
  })

  it('keeps the {n} count placeholders in the batch copy', () => {
    const en = graycodeMemoryManageDictionaries.en
    const zh = graycodeMemoryManageDictionaries.zh
    for (const key of ['batchForget.warning', 'batchForget.done'] as const) {
      expect(en[key]).toContain('{n}')
      expect(zh[key]).toContain('{n}')
    }
    expect(graycodeMemoryManageJaPlaceholder['batchForget.warning']).toContain('{n}')
    expect(graycodeMemoryManageJaPlaceholder['batchForget.done']).toContain('{n}')
  })
})
