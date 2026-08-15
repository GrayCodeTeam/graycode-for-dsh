/**
 * Review-batch aggregation (P4-06) — client half.
 *
 * Mirrors `packages/plugin/src/stagedDiff/domain/reviewBatch.ts`: the same
 * workspace+session's `pending`/`reviewing` entries form a review batch — a
 * derived view (not a stored entity) sorted by createdAt asc, id asc. The
 * client additionally surfaces the crash-recovery `needs-reapply` residue in
 * the batch (4.8-L7): its decision path (`needs-reapply → accepted|rejected`)
 * is otherwise unreachable through the batch list.
 *
 * `loadReviewBatch` is the contract-driven consumption point: it pages
 * through the host `stagedDiff/list` endpoint (statuses =
 * `REVIEW_BATCH_STATUSES`) and folds the pages into the batch view, so the
 * rendered card list stays consistent with the host projection (same filter,
 * same final sort).
 */
import type { StagedEntry, StagedEntryStatus } from './contract.ts'
import type { StagedDiffDataSource } from './dataSource.ts'

/**
 * Statuses that form the review batch (ADR-0003 §4) plus `needs-reapply`
 * (4.8-L7, crash-recovery residue the card must offer a decision for).
 */
export const REVIEW_BATCH_STATUSES: readonly StagedEntryStatus[] = ['pending', 'reviewing', 'needs-reapply']

/** Review-batch derived view — mirrors host `ReviewBatchView` (+ needs-reapply). */
export interface ReviewBatchView {
  readonly workspaceId: string
  readonly sessionId: string
  /** Pending/reviewing/needs-reapply entries, createdAt asc then id asc. */
  readonly entries: readonly StagedEntry[]
  readonly pendingCount: number
  readonly reviewingCount: number
  readonly totalCount: number
}

/**
 * Aggregate entries into a review batch view (does not mutate the input;
 * returns copies). Filter and sort are identical to the host's
 * `buildReviewBatch` so the rendered list matches the host projection.
 */
export function buildReviewBatch(
  entries: readonly StagedEntry[],
  workspaceId: string,
  sessionId: string,
): ReviewBatchView {
  const scoped = entries
    .filter(
      entry =>
        entry.workspaceId === workspaceId
        && entry.sessionId === sessionId
        && (entry.status === 'pending'
          || entry.status === 'reviewing'
          || entry.status === 'needs-reapply'),
    )
    .map(entry => ({ ...entry }))
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
  let pendingCount = 0
  let reviewingCount = 0
  for (const entry of scoped) {
    if (entry.status === 'pending') pendingCount += 1
    else reviewingCount += 1
  }
  return {
    workspaceId,
    sessionId,
    entries: scoped,
    pendingCount,
    reviewingCount,
    totalCount: scoped.length,
  }
}

/** Parameters for loading a review batch from the data source. */
export interface LoadReviewBatchParams {
  readonly workspaceId: string
  readonly sessionId: string
  /** Page size per `stagedDiff/list` call (host clamps to 100). */
  readonly limit?: number
}

/**
 * Contract-driven batch loader: page through `stagedDiff/list` filtered to
 * pending/reviewing, then fold all pages into `buildReviewBatch`.
 *
 * This is the data-loading consumption point (host wiring provides the
 * `StagedDiffDataSource`); the card components themselves never load — they
 * render the injected batch (replay-safe).
 */
export async function loadReviewBatch(
  dataSource: StagedDiffDataSource,
  params: LoadReviewBatchParams,
): Promise<ReviewBatchView> {
  const collected: StagedEntry[] = []
  let cursor: string | undefined
  for (;;) {
    const result = await dataSource.list({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      statuses: REVIEW_BATCH_STATUSES,
      cursor,
      limit: params.limit,
    })
    if (!result.ok) {
      throw new Error(`stagedDiff/list failed: ${result.error.code}`)
    }
    const { items, nextCursor } = result.value
    // 3.8-M3: a non-advancing cursor (host/mock pagination drift) must
    // terminate the loop instead of spinning forever; an empty page cannot
    // advance either.
    if (nextCursor !== undefined && (nextCursor === cursor || items.length === 0)) break
    for (const item of items) {
      // 4.8-L6: pages arrive updatedAt desc while the batch sorts createdAt
      // asc; a page-boundary shift can repeat an entry across pages — keep
      // the last copy so the final sort is the single authoritative order.
      const index = collected.findIndex(entry => entry.id === item.id)
      const copy = { ...item }
      if (index >= 0) collected[index] = copy
      else collected.push(copy)
    }
    if (nextCursor === undefined) break
    cursor = nextCursor
  }
  return buildReviewBatch(collected, params.workspaceId, params.sessionId)
}
