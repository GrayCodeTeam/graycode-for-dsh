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
  readonly cursor?: number
  readonly workspace?: string
  readonly limit?: number
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
 * Parse the host `nextCursor` string into a paging cursor.
 *
 * Returns null for anything that is not a positive safe integer. The panel
 * must not forward a malformed cursor: `buildMemoryListParams` would drop it
 * and the host would re-serve page 1, duplicating items on every "load more"
 * click. Callers stop paginating (and surface a hint) on null.
 */
export function parseMemoryNextCursor(value: string | undefined): number | null {
  if (value === undefined) return null
  const cursor = Number(value)
  return Number.isSafeInteger(cursor) && cursor > 0 ? cursor : null
}

/**
 * Build wire params for `memory/list` from the panel query state:
 * - search is trimmed and omitted when empty;
 * - cursor is dropped unless it is a positive safe integer;
 * - limit is normalized to the host contract;
 * - scope always travels explicitly (default 'global' is host-side).
 */
export function buildMemoryListParams(state: MemoryQueryState): GrayMemoryListParams {
  const search = state.text.trim()
  return {
    scope: state.scope,
    ...(state.workspace !== undefined && state.workspace.length > 0 ? { workspace: state.workspace } : {}),
    ...(search.length > 0 ? { search } : {}),
    ...(state.cursor !== undefined && Number.isSafeInteger(state.cursor) && state.cursor > 0
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
  const haystack = text.toLowerCase()
  const ranges: MemoryMatchRange[] = []
  let from = 0
  for (;;) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) break
    ranges.push({ start: index, end: index + needle.length })
    from = index + needle.length
    if (from >= text.length) break
  }
  return ranges
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
): MemoryEntryViewModel {
  return {
    id: entry.id,
    date: entry.date,
    text: entry.text,
    scope: ctx.scope,
    ...(ctx.workspace !== undefined ? { workspace: ctx.workspace } : {}),
    highlight: ctx.query !== undefined ? findMatchRanges(entry.text, ctx.query) : [],
  }
}

/** One accumulated page of the list surface. */
export interface MemoryListViewModel {
  readonly items: readonly MemoryEntryViewModel[]
  readonly total: number
  readonly nextCursor?: string
  readonly hasMore: boolean
}

/** Project one `memory/list` page into the list view model. */
export function buildMemoryListViewModel(
  result: GrayMemoryListResult,
  ctx: MemoryEntryViewContext,
): MemoryListViewModel {
  return {
    items: result.items.map(entry => buildMemoryEntryView(entry, ctx)),
    total: result.total,
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

/** Abandon: confirming|error → idle. No-op otherwise. */
export function cancelForget(state: ForgetState): ForgetState {
  if (state.phase !== 'confirming' && state.phase !== 'error') return state
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
  return ERROR_VIEWS[failure.code] ?? UNKNOWN_ERROR_VIEW
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
