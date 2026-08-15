/**
 * Activity heatmap (C6) — wire contract types (structural mirrors).
 *
 * The host `activity/stats` endpoint returns a `GrayRemoteResult<ActivityStatsResult>`
 * envelope (see packages/plugin/src/activity/domain/types.ts). This package must
 * NOT import host plugin code (bundle purity gate), so the wire shapes are
 * mirrored here as `*Like` structures and narrowed by the pure readers in
 * `wire.ts` — the client never trusts the wire.
 *
 * Ranges are inherently bounded (today/7d/30d/90d/365d/all), so this surface
 * needs no cursor pagination.
 */

/** Query params mirrored from host `ActivityStatsQuery`. */
export type ActivityRange = 'today' | '7d' | '30d' | '90d' | '365d' | 'all'

/** Wire args for the `activity/stats` endpoint. */
export interface ActivityStatsWireParams {
  readonly range?: ActivityRange
  readonly includeHourly?: boolean
  readonly includeMonthly?: boolean
}

/** One continuous active session (host `ActivitySession` mirror). */
export interface ActivitySessionLike {
  readonly start: number
  readonly end: number
  readonly minutes: number
}

/** One day's stats (host `DayActivityStats` mirror). */
export interface DayActivityStatsLike {
  readonly date: string
  readonly totalMinutes: number
  readonly sessionCount: number
  readonly sessions: readonly ActivitySessionLike[]
  readonly firstActiveAt: number | null
  readonly lastActiveAt: number | null
  readonly hourly: readonly number[]
}

/** Current in-progress session (host `CurrentSessionInfo` mirror). */
export interface CurrentSessionInfoLike {
  readonly active: boolean
  readonly startedAt: number | null
  readonly minutes: number
}

/** Per-month aggregation (host `MonthlyActivityStats` mirror). */
export interface MonthlyActivityStatsLike {
  readonly month: string
  readonly totalMinutes: number
  readonly activeDays: number
  readonly sessionCount: number
}

/** One 24-slot heatmap row. */
export interface HourlyHeatmapRowLike {
  readonly date: string
  readonly hours: readonly number[]
}

/** Full stats result (host `ActivityStatsResult` mirror). */
export interface ActivityStatsResultLike {
  readonly generatedAt: number
  readonly today: DayActivityStatsLike | null
  readonly currentSession: CurrentSessionInfoLike
  readonly daily: readonly DayActivityStatsLike[]
  readonly hourlyHeatmap: readonly HourlyHeatmapRowLike[]
  readonly monthly: readonly MonthlyActivityStatsLike[]
}

/** Stable error view shared by this surface (mirror of `GrayRemoteFailure`). */
export interface ActivityStatsError {
  readonly code: string
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
}

/**
 * Data source consumed by the panel: one `stats` call with query params.
 * Business failures surface as rejected promises carrying a stable
 * {@link ActivityStatsError} (never raw internals).
 */
export interface ActivityStatsDataSource {
  stats(params: ActivityStatsWireParams, signal?: AbortSignal): Promise<ActivityStatsResultLike>
}

// ---------------------------------------------------------------------------
// Token statistics (browser-side aggregation over the host session list)
// ---------------------------------------------------------------------------

/** Wire params for the token surface (same range vocabulary as `stats`). */
export interface ActivityTokensWireParams {
  readonly range?: ActivityRange
}

/** Token usage buckets (host `TokenUsageProjection` mirror; 4 disjoint buckets). */
export interface ActivityTokenBucketsLike {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
}

/** One day's token totals. */
export interface ActivityTokenDayLike extends ActivityTokenBucketsLike {
  readonly date: string
}

/** One session's token totals (date = the session's last-updated local day). */
export interface ActivityTokenSessionLike extends ActivityTokenBucketsLike {
  readonly sessionId: string
  readonly title: string
  readonly date: string
}

/** Aggregated token stats result (generated wholly on the browser side). */
export interface ActivityTokensResultLike {
  readonly generatedAt: number
  readonly totals: ActivityTokenBucketsLike
  readonly byDay: readonly ActivityTokenDayLike[]
  readonly sessions: readonly ActivityTokenSessionLike[]
}

/**
 * Minimal structural mirror of the host session-list API — the one unary this
 * surface needs. Kept local so the client never imports host packages at
 * runtime (bundle purity gate); `connection.api` satisfies it structurally.
 */
export interface ActivitySessionListApi {
  readonly sessions: {
    list(
      payload: { readonly cursor?: string },
      signal?: AbortSignal,
    ): Promise<{ readonly result: { readonly ok: boolean; readonly value?: unknown; readonly error?: unknown } }>
  }
}

/** Data source for the token section (browser-side, host session projections). */
export interface ActivityTokensDataSource {
  tokens(params: ActivityTokensWireParams): Promise<ActivityTokensResultLike>
}
