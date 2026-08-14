/**
 * Checkpoint list — query store (P4-04).
 *
 * Drives the cursor pagination state machine over an injected
 * {@link CheckpointListDataSource}:
 *
 * - `loadFirstPage()` — fetch page 1 (also the retry entry point);
 * - `loadNextPage()` — append one page via `nextCursor`; no-op at the end;
 * - `reload()` — clear everything and restart from page 1;
 * - `toggleExpand(id)` — detail expand (UI-local, kept in state so the
 *   components stay stateless).
 *
 * Boundary rules: one page per request (never a full fetch); pages merge by
 * id (overlapping windows collapse, see query.ts); GRAY_CANCELLED is a silent
 * stop — state returns to the previous snapshot without an error surface;
 * every other failure maps to a locale hint (errors.ts) and keeps the
 * previously loaded entries so a retry can resume. Thrown transport errors
 * are folded into the GRAY_INTERNAL hint (the port contract says business
 * errors never throw).
 */
import {
  checkpointListFailureHint,
  isCheckpointListCancellation,
} from './errors.ts'
import {
  buildCheckpointListParams,
  hasNextPage,
  mergeCheckpointItems,
  normalizeCheckpointPageLimit,
} from './query.ts'
import { buildCheckpointItemsById, toCheckpointItemVM } from './viewModel.ts'
import type {
  CheckpointListDataSource,
  CheckpointListQueryOutcome,
  CheckpointListItemVM,
  CheckpointListItemWire,
  CheckpointListStoreState,
} from './types.ts'

export interface CheckpointListStoreOptions {
  /** Workspace root (absolute path on the host bridge). */
  readonly workspaceId: string
  /** Contract-driven consumer port (see dataSource.ts). */
  readonly dataSource: CheckpointListDataSource
  /** Per-page limit (normalized to 1..100, default 20). */
  readonly pageSize?: number
  /** External cancellation signal (aborted → GRAY_CANCELLED semantics). */
  readonly signal?: AbortSignal
}

export interface CheckpointListStore {
  /** Immutable snapshot (revision bumps on every change). */
  readonly state: CheckpointListStoreState
  loadFirstPage(): Promise<void>
  loadNextPage(): Promise<void>
  reload(): Promise<void>
  toggleExpand(id: string): void
}

const INTERNAL_HINT = { kind: 'internal', messageKey: 'error.internal', retryable: false } as const

/**
 * Create the list query store.
 * @param options - workspace, data source port and page sizing.
 */
export function createCheckpointListStore(options: CheckpointListStoreOptions): CheckpointListStore {
  const workspaceId = options.workspaceId
  const pageSize = normalizeCheckpointPageLimit(options.pageSize)
  const dataSource = options.dataSource
  const signal = options.signal

  let wireItems: readonly CheckpointListItemWire[] = []
  let state: CheckpointListStoreState = {
    workspaceId,
    entries: [],
    total: null,
    nextCursor: null,
    hasMore: false,
    loadState: 'idle',
    error: null,
    expandedId: null,
    sourceKind: dataSource.kind ?? 'remote',
    revision: 0,
  }
  let loading = false

  function commit(partial: Partial<CheckpointListStoreState>): void {
    state = { ...state, ...partial, revision: state.revision + 1 }
  }

  function render(wire: readonly CheckpointListItemWire[]): CheckpointListItemVM[] {
    const byId = buildCheckpointItemsById(wire)
    return wire.map(item => toCheckpointItemVM(item, byId))
  }

  async function queryPage(cursor: string | undefined): Promise<CheckpointListQueryOutcome> {
    return dataSource.list(buildCheckpointListParams(workspaceId, cursor, pageSize), signal)
  }

  async function loadFirstPage(): Promise<void> {
    if (loading) return
    loading = true
    const previous = state
    commit({ loadState: 'loading', error: null })
    try {
      const outcome = await queryPage(undefined)
      if (!outcome.ok) {
        const hint = checkpointListFailureHint(outcome.error)
        if (hint.kind === 'cancelled') {
          commit({ loadState: previous.entries.length > 0 ? 'ready' : 'idle', error: null })
          return
        }
        commit({ loadState: 'error', error: hint })
        return
      }
      wireItems = outcome.value.items
      commit({
        entries: render(wireItems),
        total: outcome.value.total,
        nextCursor: outcome.value.nextCursor ?? null,
        hasMore: hasNextPage(outcome.value.nextCursor),
        loadState: 'ready',
        error: null,
      })
    } catch (err) {
      if (isCheckpointListCancellation(err, signal)) {
        commit({ loadState: previous.entries.length > 0 ? 'ready' : 'idle', error: null })
      } else {
        commit({ loadState: 'error', error: INTERNAL_HINT })
      }
    } finally {
      loading = false
    }
  }

  async function loadNextPage(): Promise<void> {
    if (loading) return
    if (!state.hasMore || state.nextCursor === null) return
    loading = true
    const previous = state
    const cursor = state.nextCursor
    commit({ loadState: 'loading', error: null })
    try {
      const outcome = await queryPage(cursor)
      if (!outcome.ok) {
        const hint = checkpointListFailureHint(outcome.error)
        if (hint.kind === 'cancelled') {
          commit({ loadState: 'ready', error: null })
          return
        }
        commit({ loadState: 'error', error: hint })
        return
      }
      wireItems = mergeCheckpointItems(wireItems, outcome.value.items)
      commit({
        entries: render(wireItems),
        total: outcome.value.total,
        nextCursor: outcome.value.nextCursor ?? null,
        hasMore: hasNextPage(outcome.value.nextCursor),
        loadState: 'ready',
        error: null,
      })
    } catch (err) {
      if (isCheckpointListCancellation(err, signal)) {
        commit({ loadState: 'ready', error: null })
      } else {
        commit({ loadState: 'error', error: INTERNAL_HINT })
      }
    } finally {
      loading = false
    }
  }

  async function reload(): Promise<void> {
    if (loading) return
    wireItems = []
    commit({
      entries: [],
      total: null,
      nextCursor: null,
      hasMore: false,
      loadState: 'idle',
      error: null,
      expandedId: null,
    })
    await loadFirstPage()
  }

  function toggleExpand(id: string): void {
    commit({ expandedId: state.expandedId === id ? null : id })
  }

  return {
    get state() {
      return state
    },
    loadFirstPage,
    loadNextPage,
    reload,
    toggleExpand,
  }
}
