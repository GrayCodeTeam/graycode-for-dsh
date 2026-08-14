/**
 * Activity heatmap (C6) — query model (pure).
 *
 * The `activity/stats` endpoint takes optional `range` / `includeHourly` /
 * `includeMonthly`. Ranges are bounded enumerations (today/7d/30d/90d/365d/all),
 * so there is no cursor pagination on this surface; the query model normalizes
 * the wire args and resolves display limits for the panel.
 */

import type { ActivityRange, ActivityStatsWireParams } from './types.ts'

/** All ranges in display order (most detailed first). */
export const ACTIVITY_RANGES: readonly ActivityRange[] = [
  'today',
  '7d',
  '30d',
  '90d',
  '365d',
  'all',
]

/** Default range for the panel (mirrors the host tool default). */
export const ACTIVITY_DEFAULT_RANGE: ActivityRange = '7d'

/** Heatmap row width cap: 365d / all are unbounded — rows clamp display. */
export const ACTIVITY_HEATMAP_MAX_ROWS = 30

/** Whether a range string is a known enumeration value. */
export function isActivityRange(value: unknown): value is ActivityRange {
  return typeof value === 'string' && (ACTIVITY_RANGES as readonly string[]).includes(value)
}

/** Normalize a range value to the bounded default. */
export function normalizeActivityRange(value: unknown): ActivityRange {
  return isActivityRange(value) ? value : ACTIVITY_DEFAULT_RANGE
}

/**
 * Build the wire args for the `activity/stats` endpoint: `range` is always
 * explicit (normalized), hourly/monthly flags forwarded only when true (the
 * host omits empty payloads — keep the request honest).
 */
export function buildActivityStatsRequest(
  query: ActivityStatsQueryModel,
): ActivityStatsWireParams {
  const range = normalizeActivityRange(query.range)
  return {
    range,
    ...(query.includeHourly === true ? { includeHourly: true } : {}),
    ...(query.includeMonthly === true ? { includeMonthly: true } : {}),
  }
}
/** Query model owned by the panel. */
export interface ActivityStatsQueryModel {
  readonly range?: ActivityRange
  readonly includeHourly?: boolean
  readonly includeMonthly?: boolean
}

/** Create the default query model (7d, no aggregates). */
export function createActivityStatsQuery(): ActivityStatsQueryModel {
  return { range: ACTIVITY_DEFAULT_RANGE }
}

/** Derived range with an explicit value (used by the range switcher). */
export function withActivityRange(query: ActivityStatsQueryModel, range: ActivityRange): ActivityStatsQueryModel {
  return { ...query, range }
}

/** Derived range toggling the hourly heatmap flag. */
export function withActivityHourly(query: ActivityStatsQueryModel, includeHourly: boolean): ActivityStatsQueryModel {
  return { ...query, includeHourly }
}

/** Derived range toggling the monthly aggregation flag. */
export function withActivityMonthly(query: ActivityStatsQueryModel, includeMonthly: boolean): ActivityStatsQueryModel {
  return { ...query, includeMonthly }
}
