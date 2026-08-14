/**
 * Checkpoint list — cursor pagination helpers (P4-04).
 *
 * Pure and replay-safe: nothing here performs I/O. The host clamps `limit` to
 * [1..100] (default 20), treats `cursor` as the id of the last listed item,
 * and omits `nextCursor` when no more pages exist. The store (store.ts) uses
 * these helpers to drive one-page-at-a-time loading — never a full fetch.
 */
import type { CheckpointListItemWire, CheckpointListQueryParams } from './types.ts'

/** Host default page size (GRAY_PAGE_LIMIT_DEFAULT). */
export const CHECKPOINT_PAGE_LIMIT_DEFAULT = 20

/** Host hard cap (GRAY_PAGE_LIMIT_MAX). */
export const CHECKPOINT_PAGE_LIMIT_MAX = 100

/**
 * Normalize a page limit (mirrors the host's `normalizeLimit`; never throws —
 * the client treats malformed UI-level values as the default).
 * @param value - raw limit.
 */
export function normalizeCheckpointPageLimit(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return CHECKPOINT_PAGE_LIMIT_DEFAULT
  }
  if (value <= 0) return CHECKPOINT_PAGE_LIMIT_DEFAULT
  return Math.min(value, CHECKPOINT_PAGE_LIMIT_MAX)
}

/**
 * Build the wire query for one page.
 * @param workspaceId - workspace root (absolute path on the host bridge).
 * @param cursor - last listed item id; null/undefined/'' = first page.
 * @param limit - page size (normalized).
 */
export function buildCheckpointListParams(
  workspaceId: string,
  cursor: string | null | undefined,
  limit: number | null | undefined,
): CheckpointListQueryParams {
  return {
    workspaceId,
    ...(cursor !== null && cursor !== undefined && cursor.length > 0 ? { cursor } : {}),
    limit: normalizeCheckpointPageLimit(limit),
  }
}

/** Whether a nextCursor still has a next page. */
export function hasNextPage(nextCursor: string | null | undefined): boolean {
  return nextCursor !== null && nextCursor !== undefined && nextCursor.length > 0
}

/**
 * Merge two pages by id (overlapping windows collapse to the first occurrence;
 * existing order is preserved, new items append). Used by the store so a
 * retried/overlapping page never duplicates entries.
 * @param existing - already loaded items (newest first).
 * @param incoming - the newly fetched page.
 */
export function mergeCheckpointItems(
  existing: readonly CheckpointListItemWire[],
  incoming: readonly CheckpointListItemWire[],
): readonly CheckpointListItemWire[] {
  const seen = new Set<string>()
  const merged: CheckpointListItemWire[] = []
  for (const item of [...existing, ...incoming]) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  return merged
}
