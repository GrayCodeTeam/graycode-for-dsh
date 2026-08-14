/**
 * Workflow overview (P4-02) — paged list state machine (pure, unit-testable).
 *
 * Cursor-paged accumulation with defensive dedupe: appending a page never
 * duplicates an already-present run id (cursor paging can re-deliver a
 * boundary item when the underlying data changes between pages). Every
 * mutation returns a new state with a bumped `revision` counter (uSES-
 * friendly), and the machine refuses concurrent requests — `nextWorkflowPageRequest`
 * returns null while a page is in flight, so "load more" can never stack
 * overlapping fetches.
 *
 * The component drives this reducer from a {@link WorkflowOverviewDataSource};
 * the reducer itself never performs I/O (client boundary rules).
 */
import type { WorkflowOverviewError, WorkflowOverviewListResult } from './types.ts'
import {
  buildWorkflowListView,
  type WorkflowRunView,
} from './viewModel.ts'

/** Lifecycle phase of the accumulated list. */
export type WorkflowPagePhase = 'idle' | 'loading' | 'ready' | 'error'

/** Accumulated paged list state (entries survive page reloads/errors). */
export interface WorkflowOverviewPageState {
  /** Accumulated run views (host order preserved; deduped by id). */
  readonly entries: readonly WorkflowRunView[]
  /** Filtered total from the latest page (host-authoritative). */
  readonly total: number
  /** Cursor for the next page (id of the last loaded run); null = none. */
  readonly nextCursor: string | null
  /** Whether the host reported more pages after the loaded ones. */
  readonly hasMore: boolean
  readonly phase: WorkflowPagePhase
  /** Failure of the latest request; null while not in the error phase. */
  readonly error: WorkflowOverviewError | null
  /** Monotonic mutation counter (uSES-friendly). */
  readonly revision: number
}

/** Empty page state (cold start). */
export function createWorkflowOverviewPageState(): WorkflowOverviewPageState {
  return {
    entries: [],
    total: 0,
    nextCursor: null,
    hasMore: false,
    phase: 'idle',
    error: null,
    revision: 0,
  }
}

/** Mark a request as in flight (idempotent while already loading). */
export function applyWorkflowPageLoading(state: WorkflowOverviewPageState): WorkflowOverviewPageState {
  if (state.phase === 'loading') return state
  return { ...state, phase: 'loading', error: null, revision: state.revision + 1 }
}

/**
 * Merge incoming run views after the existing ones, keeping the first
 * occurrence of each id (defensive against cursor-boundary re-delivery).
 * @param existing - accumulated entries.
 * @param incoming - newly loaded page entries.
 */
export function mergeWorkflowRunViews(
  existing: readonly WorkflowRunView[],
  incoming: readonly WorkflowRunView[],
): readonly WorkflowRunView[] {
  const seen = new Set<string>(existing.map((run) => run.id))
  const merged = [...existing]
  for (const run of incoming) {
    if (seen.has(run.id)) continue
    seen.add(run.id)
    merged.push(run)
  }
  return merged
}

/**
 * Land a page: `replace` installs a fresh page (filter change / first load),
 * `append` accumulates after the existing entries with id dedupe (load more).
 */
export function applyWorkflowPageLoaded(
  state: WorkflowOverviewPageState,
  result: WorkflowOverviewListResult,
  mode: 'replace' | 'append',
): WorkflowOverviewPageState {
  const view = buildWorkflowListView(result)
  return {
    entries: mode === 'replace' ? view.entries : mergeWorkflowRunViews(state.entries, view.entries),
    total: view.total,
    nextCursor: view.nextCursor,
    hasMore: view.hasMore,
    phase: 'ready',
    error: null,
    revision: state.revision + 1,
  }
}

/** Record a request failure (entries stay; the error phase offers retry). */
export function applyWorkflowPageError(
  state: WorkflowOverviewPageState,
  error: WorkflowOverviewError,
): WorkflowOverviewPageState {
  if (state.phase === 'error' && state.error?.code === error.code) return state
  return { ...state, phase: 'error', error, revision: state.revision + 1 }
}

/**
 * The next page request: `null` while a page is in flight (no concurrent
 * requests); `{ cursor: null }` fetches the first page; `{ cursor: <id> }`
 * fetches the page after the last loaded run. Also serves retry after an
 * error (the error phase re-issues the failed request).
 * @param state - current page state.
 */
export function nextWorkflowPageRequest(
  state: WorkflowOverviewPageState,
): { readonly cursor: string | null } | null {
  if (state.phase === 'loading') return null
  return { cursor: state.nextCursor }
}

/**
 * Stale-append guard: whether a load-more response issued against the page
 * state at `issuedRevision` may still commit.
 *
 * The panel captures the page revision when the request goes out; a response
 * is dropped once the page state moved on — in particular when the applied
 * filter changed and a fresh first page replaced the list, so a stale page
 * can never append into a newer filter's list.
 * @param state - the page state at response time.
 * @param issuedRevision - `state.revision` captured at request time.
 */
export function isWorkflowAppendCurrent(
  state: WorkflowOverviewPageState,
  issuedRevision: number,
): boolean {
  return state.revision === issuedRevision
}
