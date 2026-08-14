/**
 * Review-batch aggregation (P4-06) — client half.
 *
 * Mirrors `packages/plugin/src/stagedDiff/domain/reviewBatch.ts`: the same
 * workspace+session's `pending`/`reviewing` entries form a review batch — a
 * derived view (not a stored entity) sorted by createdAt asc, id asc.
 *
 * `loadReviewBatch` is the contract-driven consumption point: it pages
 * through the host `stagedDiff/list` endpoint (statuses = pending/reviewing)
 * and folds the pages into the batch view, so the rendered card list stays
 * consistent with the host projection (same filter, same sort).
 */
import type { StagedEntry, StagedEntryStatus } from './contract.ts'
import type { StagedDiffDataSource } from './dataSource.ts'

/** Statuses that form the review batch (ADR-0003 §4). */
export const REVIEW_BATCH_STATUSES: readonly StagedEntryStatus[] = ['pending', 'reviewing']

/** Review-batch derived view — mirrors host `ReviewBatchView`. */
export interface ReviewBatchView {
  readonly workspaceId: string
  readonly sessionId: string
  /** Pending/reviewing entries, createdAt asc then id asc. */
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
        && (entry.status === 'pending' || entry.status === 'reviewing'),
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
    collected.push(...result.value.items)
    if (result.value.nextCursor === undefined) break
    cursor = result.value.nextCursor
  }
  return buildReviewBatch(collected, params.workspaceId, params.sessionId)
}
