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
  /** A reload requested while a load was in flight — run it once the load settles. */
  let reloadQueued = false
  /**
   * Completion of the currently queued reload generation (created on the first
   * queued reload() call; repeated calls during the same in-flight load
   * collapse onto it). Detached in {@link settleLoad} when the queued reload
   * *starts*, so a reload requested while that reload is running creates its
   * own promise and awaits its own refresh (M-5) — never an earlier one's.
   */
  let queuedReloadPromise: Promise<void> | null = null
  let queuedReloadDone: (() => void) | null = null

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
      settleLoad()
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
      settleLoad()
    }
  }

  async function reload(): Promise<void> {
    if (loading) {
      // A load is in flight: queue the reload instead of silently dropping it.
      // Repeated requests during the same in-flight load collapse into one
      // queued reload and every such caller awaits that reload's completion
      // (settings-pump coalescing). A call that arrives while a queued reload
      // is already *running* starts a fresh generation — settleLoad detached
      // the previous promise — so it awaits the refresh its own request
      // produces, never an earlier one (M-5).
      reloadQueued = true
      if (queuedReloadPromise === null) {
        queuedReloadPromise = new Promise<void>(resolve => {
          queuedReloadDone = resolve
        })
      }
      return queuedReloadPromise
    }
    return doReload()
  }

  /** Clear everything and restart from page 1. */
  async function doReload(): Promise<void> {
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

  /** End of a load: release the guard and run a queued reload if any. */
  function settleLoad(): void {
    loading = false
    if (reloadQueued) {
      reloadQueued = false
      // Detach this generation's completion *before* the reload starts: a
      // reload requested while the queued reload is running must await its own
      // refresh (M-5), not the one that is about to finish. The queued reload
      // never rejects (loadFirstPage folds transport errors into a hint).
      const done = queuedReloadDone
      queuedReloadPromise = null
      queuedReloadDone = null
      void doReload().then(
        () => done?.(),
        () => done?.(),
      )
    }
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
