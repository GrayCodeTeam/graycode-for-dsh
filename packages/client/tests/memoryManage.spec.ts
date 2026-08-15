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
  appendMemoryListPage,
  buildMemoryListParams,
  buildMemoryEntryView,
  buildMemoryListViewModel,
  cancelForget,
  confirmForget,
  diffMemoryText,
  dismissForget,
  findMatchRanges,
  IDLE_FORGET_STATE,
  mapMemoryFailure,
  MEMORY_DIFF_MAX_CELLS,
  normalizeMemoryLimit,
  parseMemoryNextCursor,
  rejectForget,
  requestForget,
  resolveForget,
  toMemoryFailure,
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
  readMemoryEntryView,
  readMemoryForgetResult,
  readMemoryListResult,
  type GrayMemoryEntryView,
} from '../src/client/memoryManage/types.ts'
import {
  GRAYCODE_MEMORY_MANAGE_NS,
  graycodeMemoryManageDictionaries,
  graycodeMemoryManageJaPlaceholder,
} from '../src/client/memoryManage/locales.ts'

const CODES = GRAY_REMOTE_ERROR_CODES

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

  it('drops invalid cursors and keeps valid ones', () => {
    expect(buildMemoryListParams({ text: '', scope: 'global', cursor: 0 })).not.toHaveProperty('cursor')
    expect(buildMemoryListParams({ text: '', scope: 'global', cursor: -3 })).not.toHaveProperty('cursor')
    expect(buildMemoryListParams({ text: '', scope: 'global', cursor: 1.5 })).not.toHaveProperty('cursor')
    expect(buildMemoryListParams({ text: '', scope: 'global', cursor: 42 }).cursor).toBe(42)
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
  it('parses positive safe integer cursors', () => {
    expect(parseMemoryNextCursor('42')).toBe(42)
    expect(parseMemoryNextCursor('1')).toBe(1)
  })

  it('rejects malformed cursors (re-fetching page 1 would duplicate items)', () => {
    expect(parseMemoryNextCursor(undefined)).toBeNull()
    expect(parseMemoryNextCursor('')).toBeNull()
    expect(parseMemoryNextCursor('abc')).toBeNull()
    expect(parseMemoryNextCursor('0')).toBeNull()
    expect(parseMemoryNextCursor('-1')).toBeNull()
    expect(parseMemoryNextCursor('1.5')).toBeNull()
    expect(parseMemoryNextCursor('9007199254740992')).toBeNull() // not a safe integer
  })
})

describe('appendMemoryListPage', () => {
  const entry = (id: number): GrayMemoryEntryView => ({ id, date: '2025-01-01', text: `memory ${id}` })

  it('appends items and adopts total/nextCursor/hasMore from the newest page', () => {
    const prev = buildMemoryListViewModel({ items: [entry(2)], total: 3, nextCursor: '2' }, { scope: 'global' })
    const next = buildMemoryListViewModel({ items: [entry(1)], total: 3, nextCursor: '1' }, { scope: 'global' })
    const merged = appendMemoryListPage(prev, next)
    expect(merged.items.map(item => item.id)).toEqual([2, 1])
    expect(merged.total).toBe(3)
    expect(merged.nextCursor).toBe('1')
    expect(merged.hasMore).toBe(true)
  })

  it('ends pagination when the next page carries no cursor', () => {
    const prev = buildMemoryListViewModel({ items: [entry(2)], total: 2, nextCursor: '2' }, { scope: 'global' })
    const next = buildMemoryListViewModel({ items: [entry(1)], total: 2 }, { scope: 'global' })
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
    const view = buildMemoryEntryView(entry, { scope: 'workspace', workspace: 'C:\\ws', query: 'alpha' })
    expect(view).toMatchObject({ id: 7, date: '2025-01-02', text: entry.text, scope: 'workspace', workspace: 'C:\\ws' })
    expect(view.highlight).toEqual([{ start: 13, end: 18 }])
  })

  it('omits workspace and highlight when not applicable', () => {
    const view = buildMemoryEntryView(entry, { scope: 'global' })
    expect(view.workspace).toBeUndefined()
    expect(view.highlight).toEqual([])
  })

  it('builds a page view model with hasMore from nextCursor', () => {
    const vm = buildMemoryListViewModel(
      { items: [entry], total: 3, nextCursor: '7' },
      { scope: 'global', query: 'alpha' },
    )
    expect(vm.items).toHaveLength(1)
    expect(vm.total).toBe(3)
    expect(vm.nextCursor).toBe('7')
    expect(vm.hasMore).toBe(true)
    expect(buildMemoryListViewModel({ items: [entry], total: 1 }, { scope: 'global' }).hasMore).toBe(false)
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
    const good = { items: [{ id: 1, date: '2025-01-01', text: 'a' }], total: 1, nextCursor: '1' }
    expect(readMemoryListResult(good)).toEqual(good)
    expect(readMemoryListResult({ items: [{ id: 1, date: '2025-01-01', text: 'a' }, { id: 'x' }], total: 2 })).toBeNull()
    expect(readMemoryListResult({ items: [], total: -1 })).toBeNull()
    expect(readMemoryListResult({ items: [], total: 0, nextCursor: '' })).toEqual({ items: [], total: 0 })
  })

  it('reads forget results', () => {
    expect(readMemoryForgetResult({ mode: 'single', removed: 1 })).toEqual({ mode: 'single', removed: 1 })
    expect(readMemoryForgetResult({ mode: 'summary', gone: 2, firstId: '0-3' })).toEqual({ mode: 'summary', gone: 2, firstId: '0-3' })
    expect(readMemoryForgetResult({ mode: 'bogus' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

describe('createMockMemoryTransport', () => {
  const seed: GrayMemoryEntryView[] = [
    { id: 1, date: '2025-01-01', text: 'Alpha note' },
    { id: 2, date: '2025-01-02', text: 'beta design' },
    { id: 3, date: '2025-01-03', text: 'ALPHA plan' },
    { id: 4, date: '2025-01-04', text: 'gamma review' },
  ]

  it('is wired:false and lists newest-first with totals', async () => {
    const transport = createMockMemoryTransport(seed)
    expect(transport.wired).toBe(false)
    const result = await transport.list({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.items.map(item => item.id)).toEqual([4, 3, 2, 1])
    expect(result.value.total).toBe(4)
    expect(result.value.nextCursor).toBeUndefined()
  })

  it('filters by search (case-insensitive) and scope', async () => {
    const transport = createMockMemoryTransport(seed)
    const searched = await transport.list({ search: 'alpha' })
    expect(searched.ok && searched.value.items.map(item => item.id)).toEqual([3, 1])
    expect(searched.ok && searched.value.total).toBe(2)

    const scoped = createMockMemoryTransport([
      ...seed,
      { id: 5, date: '2025-01-05', text: 'workspace only', scope: 'workspace' },
    ], { workspace: 'C:\\ws' })
    const ws = await scoped.list({ scope: 'workspace' })
    expect(ws.ok && ws.value.items.map(item => item.id)).toEqual([5])
    const global = await scoped.list({ scope: 'global' })
    expect(global.ok && global.value.items.map(item => item.id)).toEqual([4, 3, 2, 1])
  })

  it('paginates by cursor and normalizes the limit', async () => {
    const transport = createMockMemoryTransport(seed)
    const page1 = await transport.list({ limit: 2 })
    expect(page1.ok && page1.value.items.map(item => item.id)).toEqual([4, 3])
    expect(page1.ok && page1.value.nextCursor).toBe('3')
    const page2 = await transport.list({ limit: 2, cursor: 3 })
    expect(page2.ok && page2.value.items.map(item => item.id)).toEqual([2, 1])
    expect(page2.ok && page2.value.nextCursor).toBeUndefined()
    const zero = await transport.list({ limit: 0 })
    expect(zero.ok).toBe(true)
    if (zero.ok) expect(zero.value.items).toHaveLength(seed.length) // default 20 > 4 seeds
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
    const edited = await transport.edit({ id: 2, text: 'beta revised' })
    expect(edited).toEqual({ ok: true, value: { id: 2, date: '2025-01-02', text: 'beta revised' } })
    const listed = await transport.list({})
    expect(listed.ok && listed.value.items.find(item => item.id === 2)!.text).toBe('beta revised')

    const missing = await transport.edit({ id: 99, text: 'x' })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error.code).toBe(CODES.NOT_FOUND)

    const empty = await transport.edit({ id: 1, text: '  ' })
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
    const single = await transport.forget({ blockId: '2', confirm: true })
    expect(single).toEqual({ ok: true, value: { mode: 'single', removed: 1 } })
    const after = await transport.list({})
    expect(after.ok && after.value.items.map(item => item.id)).toEqual([4, 3, 1])

    const range = await transport.forget({ blockId: '3,4', confirm: true })
    expect(range.ok && range.value).toEqual({ mode: 'range', removed: 2 })
    const remaining = await transport.list({})
    expect(remaining.ok && remaining.value.items.map(item => item.id)).toEqual([1])

    const missing = await transport.forget({ blockId: '9', confirm: true })
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
    expect(added).toEqual({ ok: true, value: { id: 5, date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), text: 'fresh note' } })
    const listed = await transport.list({})
    expect(listed.ok && listed.value.items[0]!.id).toBe(5)

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
    expect(added.ok && added.value.id).toBe(5)
    const wsList = await scoped.list({ scope: 'workspace' })
    expect(wsList.ok && wsList.value.items.map(item => item.id)).toEqual([5])
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

// ---------------------------------------------------------------------------
// Remote transport adapter
// ---------------------------------------------------------------------------

describe('createRemoteMemoryTransport', () => {
  function recordInvoker(calls: Array<{ namespace: string; method: string; args: unknown }>): GrayRemoteInvoker {
    return async (namespace, method, args) => {
      calls.push({ namespace, method, args })
      return { ok: true, value: { items: [], total: 0 } }
    }
  }

  it('dispatches the four endpoints with namespace/method/args', async () => {
    const calls: Array<{ namespace: string; method: string; args: unknown }> = []
    const transport = createRemoteMemoryTransport(recordInvoker(calls))
    await transport.list({ scope: 'global', search: 'x' })
    await transport.add({ text: 'new note' })
    await transport.edit({ id: 1, text: 't' })
    await transport.forget({ blockId: '1', confirm: true })
    expect(calls).toEqual([
      { namespace: 'memory', method: 'list', args: { scope: 'global', search: 'x' } },
      { namespace: 'memory', method: 'note', args: { text: 'new note' } },
      { namespace: 'memory', method: 'edit', args: { id: 1, text: 't' } },
      { namespace: 'memory', method: 'forget', args: { blockId: '1', confirm: true } },
    ])
    expect(MEMORY_ENDPOINTS).toEqual({
      list: 'memory/list',
      note: 'memory/note',
      edit: 'memory/edit',
      forget: 'memory/forget',
    })
  })

  it('narrows ok values and turns malformed values into INTERNAL failures', async () => {
    const ok = createRemoteMemoryTransport(async () => ({ ok: true, value: { items: [], total: 0 } }))
    expect(await ok.list({})).toEqual({ ok: true, value: { items: [], total: 0 } })

    const malformed = createRemoteMemoryTransport(async () => ({ ok: true, value: { items: 'nope' } }))
    const result = await malformed.list({})
    expect(result.ok).toBe(false)
    if (result.ok) return
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
})
