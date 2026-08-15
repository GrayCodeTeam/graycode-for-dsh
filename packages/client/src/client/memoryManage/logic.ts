/**
 * P4-03 memory management — pure logic (fully unit-testable, no React).
 *
 * Covers:
 * - query parameter building (`buildMemoryListParams` / `normalizeMemoryLimit`);
 * - entry + page view models (`buildMemoryEntryView` / `buildMemoryListViewModel`,
 *   including search-match highlight ranges);
 * - edit diff (`diffMemoryText` — whitespace-preserving token LCS with a
 *   cost guard, driving the edit overlay preview);
 * - forget confirmation state machine (idle → confirming → submitting →
 *   done | error, with the destructive warning snapshot at arm time);
 * - stable error-code mapping (`mapMemoryFailure` — UI shows locale keys
 *   only, never raw error text; PLAN_V2 §5.6).
 *
 * CLIENT BOUNDARY RULES: everything here is replay-safe — no I/O, no
 * workspace access, no timers. Deletion/edit are explicit user actions: the
 * forget machine refuses to submit without an explicit `confirmForget`, and
 * the edit overlay only saves after the user reviews the diff.
 */
import {
  GRAY_PAGE_LIMIT_DEFAULT,
  GRAY_PAGE_LIMIT_MAX,
  GRAY_REMOTE_ERROR_CODES,
  makeInternalFailure,
  type GrayMemoryEntryView,
  type GrayMemoryForgetResult,
  type GrayMemoryListParams,
  type GrayMemoryListResult,
  type GrayMemoryScope,
  type GrayRemoteErrorCode,
  type GrayRemoteFailure,
} from './types.ts'

// ==================== Query parameters ====================

/** Client-side query state the panel holds (before building wire params). */
export interface MemoryQueryState {
  readonly text: string
  readonly scope: GrayMemoryScope
  readonly cursor?: string
  readonly workspace?: string
  readonly limit?: number
}

/** Stable identity for every list/action response owned by one visible view. */
export function memoryRequestContextKey(state: Pick<MemoryQueryState, 'text' | 'scope' | 'workspace'>): string {
  return JSON.stringify([
    state.scope,
    state.scope === 'workspace' ? state.workspace?.trim() ?? '' : '',
    state.text,
  ])
}

/**
 * H-7a: the debounced search settle the panel applies and then fetches.
 *
 * `fetchGeneration` advances on EVERY settle — even when the applied query is
 * identical to the previous one — because every keystroke already invalidated
 * the in-flight fetch (the panel bumps its request seq refs on input). The
 * panel includes the generation in its fetch-effect dependencies, so an
 * unchanged `appliedQuery` cannot bail the effect out and leave the panel
 * stuck in 'loading' forever (H-7a).
 */
export interface MemorySearchSettle {
  readonly appliedQuery: string
  readonly fetchGeneration: number
}

/** Initial settle (empty query, no fetch yet). Frozen so callers cannot mutate it. */
export const INITIAL_MEMORY_SEARCH_SETTLE: MemorySearchSettle = Object.freeze({
  appliedQuery: '',
  fetchGeneration: 0,
})

/** Apply one debounced search settle; always advances the fetch generation. */
export function settleMemorySearch(prev: MemorySearchSettle, queryText: string): MemorySearchSettle {
  return { appliedQuery: queryText, fetchGeneration: prev.fetchGeneration + 1 }
}

/**
 * Normalize a page size to the host contract: missing/≤0 → default (20),
 * above the cap → cap (100). Non-finite values fall back to the default.
 */
export function normalizeMemoryLimit(
  value: number | undefined,
  fallback: number = GRAY_PAGE_LIMIT_DEFAULT,
): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), GRAY_PAGE_LIMIT_MAX)
}

/**
 * Validate an opaque host-issued `nextCursor` without interpreting it.
 * Clients must return valid tokens byte-for-byte: the host binds their
 * snapshot hash and offset to scope/workspace/search.
 */
export function parseMemoryNextCursor(value: string | undefined): string | null {
  return value !== undefined && value.trim().length > 0 ? value : null
}

/**
 * Build wire params for `memory/list` from the panel query state:
 * - search is trimmed and omitted when empty;
 * - an opaque cursor is included verbatim when non-empty;
 * - limit is normalized to the host contract;
 * - scope always travels explicitly (default 'global' is host-side).
 */
export function buildMemoryListParams(state: MemoryQueryState): GrayMemoryListParams {
  const search = state.text.trim()
  return {
    scope: state.scope,
    ...(state.workspace !== undefined && state.workspace.length > 0 ? { workspace: state.workspace } : {}),
    ...(search.length > 0 ? { search } : {}),
    ...(state.cursor !== undefined && state.cursor.trim().length > 0
      ? { cursor: state.cursor }
      : {}),
    limit: normalizeMemoryLimit(state.limit),
  }
}

// ==================== View models ====================

/** Half-open char range `[start, end)` of a query match in an entry text. */
export interface MemoryMatchRange {
  readonly start: number
  readonly end: number
}

/**
 * Case-insensitive, non-overlapping match ranges of `query` in `text`.
 * Returns [] for an empty query or no match. Used for highlight rendering
 * and asserted by tests.
 */
export function findMatchRanges(text: string, query: string): readonly MemoryMatchRange[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return []
  const { haystack, startOffsetAt, endOffsetAt } = buildLowercasedHaystack(text)
  const ranges: MemoryMatchRange[] = []
  let from = 0
  for (;;) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) break
    const start = startOffsetAt(index)
    const end = endOffsetAt(index + needle.length - 1)
    if (end > start) ranges.push({ start, end })
    from = index + needle.length
    if (from >= haystack.length) break
  }
  return ranges
}

/**
 * Lowercase `text` code-point by code-point while recording, for every output
 * code-unit offset, the original code-unit range it came from.
 *
 * 4.4-L2: whole-string `text.toLowerCase()` can change the string's length
 * (e.g. 'İ' U+0130 lowercases to 'i̇' — one code point expanding to two code
 * units), which shifts naive match indices relative to the original text.
 * Surrogate pairs are iterated as single code points by `for...of`, so a
 * highlight range never splits a pair (start maps to the pair's first unit,
 * end maps past its last unit).
 */
function buildLowercasedHaystack(text: string): {
  readonly haystack: string
  readonly startOffsetAt: (index: number) => number
  readonly endOffsetAt: (index: number) => number
} {
  let haystack = ''
  const starts: number[] = []
  const ends: number[] = []
  let original = 0
  for (const char of text) {
    const lower = char.toLowerCase()
    haystack += lower
    for (let i = 0; i < lower.length; i++) {
      starts.push(original)
      ends.push(original + char.length)
    }
    original += char.length
  }
  return {
    haystack,
    startOffsetAt: (index: number) => (index < starts.length ? starts[index]! : text.length),
    endOffsetAt: (index: number) => (index < ends.length ? ends[index]! : text.length),
  }
}

/** List context every entry is projected against. */
export interface MemoryEntryViewContext {
  readonly scope: GrayMemoryScope
  readonly workspace?: string
  readonly query?: string
}

/** Entry list item view model: wire entry + source marker + highlight ranges. */
export interface MemoryEntryViewModel {
  readonly id: number
  readonly date: string
  readonly text: string
  /** Full-store revision captured with this row; required for mutation CAS. */
  readonly revision: string
  /** Source marker: which scope the entry was listed under. */
  readonly scope: GrayMemoryScope
  readonly workspace?: string
  /** Query match ranges ([] when no query or no match). */
  readonly highlight: readonly MemoryMatchRange[]
}

/** Project one wire entry into the list view model. */
export function buildMemoryEntryView(
  entry: GrayMemoryEntryView,
  ctx: MemoryEntryViewContext,
  revision: string,
): MemoryEntryViewModel {
  return {
    id: entry.id,
    date: entry.date,
    text: entry.text,
    revision,
    scope: ctx.scope,
    ...(ctx.workspace !== undefined ? { workspace: ctx.workspace } : {}),
    highlight: ctx.query !== undefined ? findMatchRanges(entry.text, ctx.query) : [],
  }
}

/** One accumulated page of the list surface. */
export interface MemoryListViewModel {
  readonly items: readonly MemoryEntryViewModel[]
  readonly total: number
  readonly revision: string
  readonly nextCursor?: string
  readonly hasMore: boolean
}

/** Project one `memory/list` page into the list view model. */
export function buildMemoryListViewModel(
  result: GrayMemoryListResult,
  ctx: MemoryEntryViewContext,
): MemoryListViewModel {
  return {
    items: result.items.map(entry => buildMemoryEntryView(entry, ctx, result.revision)),
    total: result.total,
    revision: result.revision,
    ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
    hasMore: result.nextCursor !== undefined,
  }
}

/**
 * Accumulate the next page onto the current list view model (load more):
 * items append in host order, while `total` / `nextCursor` / `hasMore` follow
 * the newest page. A next page without a cursor ends pagination.
 */
export function appendMemoryListPage(
  prev: MemoryListViewModel,
  next: MemoryListViewModel,
): MemoryListViewModel {
  return {
    items: [...prev.items, ...next.items],
    total: next.total,
    revision: next.revision,
    ...(next.nextCursor !== undefined ? { nextCursor: next.nextCursor } : {}),
    hasMore: next.hasMore,
  }
}

// ==================== Edit diff ====================

export type MemoryDiffSegmentType = 'same' | 'added' | 'removed'

/** One renderable diff segment (whitespace-preserving token LCS). */
export interface MemoryDiffSegment {
  readonly type: MemoryDiffSegmentType
  readonly value: string
}

/** Diff of one entry: original text → new text (drives the edit overlay). */
export interface MemoryTextDiff {
  readonly original: string
  readonly next: string
  readonly changed: boolean
  /** Chars added (length of `added` segments). */
  readonly added: number
  /** Chars removed (length of `removed` segments). */
  readonly removed: number
  readonly segments: readonly MemoryDiffSegment[]
}

/** LCS cell budget: guards O(m·n) on very long inputs (falls back to whole-text change). */
export const MEMORY_DIFF_MAX_CELLS = 250_000

/**
 * Word-level diff of two entry texts. Identical texts yield a single `same`
 * segment with `changed: false`; any edit yields changed segments. The
 * whitespace-preserving tokenization keeps the preview readable.
 */
export function diffMemoryText(original: string, next: string): MemoryTextDiff {
  if (original === next) {
    return {
      original,
      next,
      changed: false,
      added: 0,
      removed: 0,
      segments: [{ type: 'same', value: original }],
    }
  }
  const oTokens = splitTokens(original)
  const nTokens = splitTokens(next)
  const cells = (oTokens.length + 1) * (nTokens.length + 1)
  if (cells > MEMORY_DIFF_MAX_CELLS) {
    // Cost guard: mark the whole text changed without building a matrix.
    return {
      original,
      next,
      changed: true,
      added: next.length,
      removed: original.length,
      segments: [
        ...(original.length > 0 ? [{ type: 'removed' as const, value: original }] : []),
        ...(next.length > 0 ? [{ type: 'added' as const, value: next }] : []),
      ],
    }
  }
  // Classic LCS DP with a direction matrix (0 = up/removed, 1 = left/added, 2 = diagonal/same).
  const width = nTokens.length + 1
  const lengths = new Int32Array((oTokens.length + 1) * width)
  const dirs = new Uint8Array(lengths.length)
  for (let i = 1; i <= oTokens.length; i++) {
    for (let j = 1; j <= nTokens.length; j++) {
      const cell = i * width + j
      const up = lengths[(i - 1) * width + j]!
      const left = lengths[i * width + j - 1]!
      if (oTokens[i - 1] === nTokens[j - 1]) {
        const diag = lengths[(i - 1) * width + j - 1]! + 1
        if (diag >= up && diag >= left) {
          lengths[cell] = diag
          dirs[cell] = 2
          continue
        }
      }
      if (up >= left) {
        lengths[cell] = up
        dirs[cell] = 0
      } else {
        lengths[cell] = left
        dirs[cell] = 1
      }
    }
  }
  const raw: MemoryDiffSegment[] = []
  let i = oTokens.length
  let j = nTokens.length
  while (i > 0 || j > 0) {
    if (i === 0) {
      raw.push({ type: 'added', value: nTokens[j - 1]! })
      j--
      continue
    }
    if (j === 0) {
      raw.push({ type: 'removed', value: oTokens[i - 1]! })
      i--
      continue
    }
    const dir = dirs[i * width + j]!
    if (dir === 2) {
      raw.push({ type: 'same', value: oTokens[i - 1]! })
      i--
      j--
    } else if (dir === 1) {
      raw.push({ type: 'added', value: nTokens[j - 1]! })
      j--
    } else {
      raw.push({ type: 'removed', value: oTokens[i - 1]! })
      i--
    }
  }
  raw.reverse()
  const segments = mergeSegments(raw)
  let added = 0
  let removed = 0
  for (const segment of segments) {
    if (segment.type === 'added') added += segment.value.length
    else if (segment.type === 'removed') removed += segment.value.length
  }
  return { original, next, changed: true, added, removed, segments }
}

/** Tokenize into whitespace-preserving chunks (non-space runs / space runs). */
function splitTokens(text: string): string[] {
  const tokens = text.match(/\s+|\S+/g)
  return tokens === null ? [] : tokens
}

/** Coalesce adjacent segments of the same type. */
function mergeSegments(raw: readonly MemoryDiffSegment[]): MemoryDiffSegment[] {
  const merged: MemoryDiffSegment[] = []
  for (const segment of raw) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.type === segment.type) {
      merged[merged.length - 1] = { type: segment.type, value: last.value + segment.value }
    } else {
      merged.push(segment)
    }
  }
  return merged
}

// ==================== Forget confirmation state machine ====================

export type ForgetPhase = 'idle' | 'confirming' | 'submitting' | 'done' | 'error'

/** Entry-level forget target (this surface only forgets single entries). */
export interface ForgetTarget {
  readonly id: number
  readonly revision: string
  readonly scope: GrayMemoryScope
  readonly workspace?: string
}

/**
 * Immutable forget-flow state. `preview` is the exact entry text captured at
 * arm time — the warning shows what will be lost. `outcome` (done) and
 * `error` (error) carry the terminal results.
 */
export interface ForgetState {
  readonly phase: ForgetPhase
  readonly target: ForgetTarget | null
  readonly preview: string | null
  readonly outcome: GrayMemoryForgetResult | null
  readonly error: MemoryErrorView | null
}

/** Initial forget state (idle). Frozen so callers cannot mutate it. */
export const IDLE_FORGET_STATE: ForgetState = Object.freeze({
  phase: 'idle',
  target: null,
  preview: null,
  outcome: null,
  error: null,
})

/**
 * Arm the destructive action: idle → confirming. The warning snapshot
 * (`preview`) is captured here, before any network activity.
 * No-op from any other phase (the UI must cancel first).
 */
export function requestForget(state: ForgetState, target: ForgetTarget, preview: string): ForgetState {
  if (state.phase !== 'idle') return state
  return { phase: 'confirming', target, preview, outcome: null, error: null }
}

/**
 * Abandon: confirming|submitting|error → idle. Submitting is included so a
 * cancel (or a superseded flow) can never leave the machine stuck: the host
 * write itself is not cancellable, but the caller bumps the flow sequence
 * before resetting, so the in-flight response is dropped by the panel guard
 * (H-7b).
 */
export function cancelForget(state: ForgetState): ForgetState {
  if (state.phase !== 'confirming' && state.phase !== 'submitting' && state.phase !== 'error') return state
  return IDLE_FORGET_STATE
}

/**
 * The explicit user confirmation: confirming|error → submitting (error allows
 * retry after a transient failure). Double-submit guard: no-op while already
 * submitting. This is the ONLY way to reach submitting — a forget request
 * can never go out without an explicit confirm.
 */
export function confirmForget(state: ForgetState): ForgetState {
  if (state.phase !== 'confirming' && state.phase !== 'error') return state
  if (state.target === null) return state
  return { phase: 'submitting', target: state.target, preview: state.preview, outcome: null, error: null }
}

/** Success: submitting → done with the host outcome. */
export function resolveForget(state: ForgetState, outcome: GrayMemoryForgetResult): ForgetState {
  if (state.phase !== 'submitting') return state
  return { phase: 'done', target: state.target, preview: state.preview, outcome, error: null }
}

/** Failure: submitting → error with the mapped stable-code view. */
export function rejectForget(state: ForgetState, failure: GrayRemoteFailure): ForgetState {
  if (state.phase !== 'submitting') return state
  return {
    phase: 'error',
    target: state.target,
    preview: state.preview,
    outcome: null,
    error: mapMemoryFailure(failure),
  }
}

/** Dismiss the result note: done → idle. */
export function dismissForget(state: ForgetState): ForgetState {
  if (state.phase !== 'done') return state
  return IDLE_FORGET_STATE
}

// ==================== Error code mapping ====================

export type MemoryErrorTone = 'danger' | 'warning' | 'info' | 'neutral'

/** Locale keys the error mapping may produce (subset of the namespace). */
export type MemoryErrorLocaleKey =
  | 'error.invalidInput'
  | 'error.conflict'
  | 'error.approvalRequired'
  | 'error.cancelled'
  | 'error.storageCorrupt'
  | 'error.notFound'
  | 'error.workspaceNotInitialized'
  | 'error.endpointNotFound'
  | 'error.internal'

/**
 * Stable-code error view: the UI renders `localeKey` (localized copy) and the
 * machine code — never the host's raw `failure.message` text (PLAN_V2 §5.6).
 */
export interface MemoryErrorView {
  readonly code: GrayRemoteErrorCode | 'UNKNOWN'
  readonly localeKey: MemoryErrorLocaleKey
  readonly tone: MemoryErrorTone
  /** Whether the banner offers a retry entry. */
  readonly retryable: boolean
}

const ERROR_VIEWS: Readonly<Record<GrayRemoteErrorCode, MemoryErrorView>> = {
  [GRAY_REMOTE_ERROR_CODES.INVALID_INPUT]: {
    code: GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
    localeKey: 'error.invalidInput',
    tone: 'warning',
    retryable: false,
  },
  [GRAY_REMOTE_ERROR_CODES.CONFLICT]: {
    code: GRAY_REMOTE_ERROR_CODES.CONFLICT,
    localeKey: 'error.conflict',
    tone: 'warning',
    retryable: true,
  },
  [GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED]: {
    code: GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED,
    localeKey: 'error.approvalRequired',
    tone: 'warning',
    retryable: true,
  },
  [GRAY_REMOTE_ERROR_CODES.CANCELLED]: {
    code: GRAY_REMOTE_ERROR_CODES.CANCELLED,
    localeKey: 'error.cancelled',
    tone: 'info',
    retryable: true,
  },
  [GRAY_REMOTE_ERROR_CODES.STORAGE_CORRUPT]: {
    code: GRAY_REMOTE_ERROR_CODES.STORAGE_CORRUPT,
    localeKey: 'error.storageCorrupt',
    tone: 'danger',
    retryable: false,
  },
  [GRAY_REMOTE_ERROR_CODES.NOT_FOUND]: {
    code: GRAY_REMOTE_ERROR_CODES.NOT_FOUND,
    localeKey: 'error.notFound',
    tone: 'warning',
    retryable: false,
  },
  [GRAY_REMOTE_ERROR_CODES.ENDPOINT_NOT_FOUND]: {
    code: GRAY_REMOTE_ERROR_CODES.ENDPOINT_NOT_FOUND,
    localeKey: 'error.endpointNotFound',
    tone: 'neutral',
    retryable: false,
  },
  [GRAY_REMOTE_ERROR_CODES.INTERNAL]: {
    code: GRAY_REMOTE_ERROR_CODES.INTERNAL,
    localeKey: 'error.internal',
    tone: 'danger',
    retryable: true,
  },
}

const UNKNOWN_ERROR_VIEW: MemoryErrorView = {
  code: 'UNKNOWN',
  localeKey: 'error.internal',
  tone: 'danger',
  retryable: true,
}

/**
 * Stable failure → display view. Unknown codes degrade to the internal view
 * (defensive; the host contract only emits known codes).
 */
export function mapMemoryFailure(failure: GrayRemoteFailure | null | undefined): MemoryErrorView {
  if (failure === null || failure === undefined) return UNKNOWN_ERROR_VIEW
  // The host uses the stable NOT_FOUND code for both an absent workspace
  // store and an absent entry. Its structured details disambiguate them;
  // never parse the human message.
  if (isWorkspaceStoreMissingFailure(failure)) {
    return {
      code: failure.code,
      localeKey: 'error.workspaceNotInitialized',
      tone: 'info',
      retryable: false,
    }
  }
  return ERROR_VIEWS[failure.code] ?? UNKNOWN_ERROR_VIEW
}

/** Exact structured discriminator for a never-initialized workspace store. */
export function isWorkspaceStoreMissingFailure(failure: GrayRemoteFailure): boolean {
  return failure.code === GRAY_REMOTE_ERROR_CODES.NOT_FOUND
    && failure.details.kind === 'workspace-store'
}

/** Whether a failed load-more cursor is bound to an obsolete host snapshot. */
export function isStaleMemoryCursorFailure(failure: GrayRemoteFailure): boolean {
  return failure.code === GRAY_REMOTE_ERROR_CODES.CONFLICT
    && failure.details.kind === 'memory-cursor'
    && failure.details.reason === 'stale'
}

/** A write was based on a list snapshot invalidated by another mutation. */
export function isStaleMemoryRevisionFailure(failure: GrayRemoteFailure): boolean {
  return failure.code === GRAY_REMOTE_ERROR_CODES.CONFLICT
    && failure.details.kind === 'memory-revision'
    && failure.details.reason === 'stale'
}

/** Accept only a usable `entryChars` byte limit; malformed values fall back. */
export function normalizeMemoryEntryChars(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= 1_000
    ? value
    : undefined
}

/**
 * 3.4-M2: the host `memory/note` / `memory/edit` contract rejects any text
 * containing a line break ("A memory is one line."). The add box is a
 * textarea, so before submitting we collapse CRLF/LF/CR to a single space and
 * trim. `changed` reports whether a line break was actually collapsed, so the
 * panel can hint about the transformation (plain trimming is not flagged).
 */
export function normalizeMemoryNoteText(text: string): { readonly text: string; readonly changed: boolean } {
  const collapsed = text.replace(/\r\n|\r|\n/g, ' ')
  return { text: collapsed.trim(), changed: collapsed !== text }
}

/** Stable local validation failure matching the host's over-limit response. */
export function memoryEntryCharsExceededFailure(actualBytes: number, limit: number): GrayRemoteFailure {
  return {
    code: GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
    message: 'memory text exceeds entryChars',
    details: { field: 'text', actualBytes, limit },
  }
}

/** Pure ownership check used before an async config response may update UI. */
export function isCurrentMemoryConfigResponse(input: {
  readonly mounted: boolean
  readonly requestId: number
  readonly latestRequestId: number
  readonly requestContextKey: string
  readonly currentContextKey: string
  readonly requestTransport: unknown
  readonly currentTransport: unknown
}): boolean {
  return input.mounted
    && input.requestId === input.latestRequestId
    && input.requestContextKey === input.currentContextKey
    && input.requestTransport === input.currentTransport
}

/**
 * View-independent mutex for `memory/note`.
 *
 * Search/scope/workspace generations may invalidate how a response is
 * rendered, but the host write itself is not cancellable. Only the holder's
 * `finally` may release its lease; view changes must never unlock it early.
 */
export class MemoryAddInFlightGate {
  private sequence = 0
  private activeLease: number | null = null

  tryAcquire(): number | null {
    if (this.activeLease !== null) return null
    const lease = ++this.sequence
    this.activeLease = lease
    return lease
  }

  release(lease: number): void {
    if (this.activeLease === lease) this.activeLease = null
  }

  isInFlight(): boolean {
    return this.activeLease !== null
  }
}

export type MemoryAddRequestStart<T> =
  | { readonly started: false }
  | { readonly started: true; readonly completion: Promise<T> }

/** Acquire once, invoke the host call once, and release only on settlement. */
export function startMemoryAddRequest<T>(
  gate: MemoryAddInFlightGate,
  request: () => Promise<T>,
): MemoryAddRequestStart<T> {
  const lease = gate.tryAcquire()
  if (lease === null) return { started: false }
  return {
    started: true,
    completion: (async () => {
      try {
        return await request()
      } finally {
        gate.release(lease)
      }
    })(),
  }
}

function isFailureLike(value: unknown): value is GrayRemoteFailure {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.code === 'string' && typeof record.message === 'string'
}

function cancelledFailure(): GrayRemoteFailure {
  return { code: GRAY_REMOTE_ERROR_CODES.CANCELLED, message: 'operation cancelled', details: {} }
}

/**
 * Defensive: arbitrary thrown value → stable failure (for transports that
 * misbehave and reject; conformant transports never do). Cancellation-shaped
 * errors map to GRAY_CANCELLED, everything else to GRAY_INTERNAL.
 */
export function toMemoryFailure(err: unknown, signal?: AbortSignal): GrayRemoteFailure {
  if (signal?.aborted) return cancelledFailure()
  if (err instanceof Error && err.name === 'AbortError') return cancelledFailure()
  if (isFailureLike(err)) return { code: err.code, message: err.message, details: err.details }
  return makeInternalFailure('unexpected transport failure', err)
}
