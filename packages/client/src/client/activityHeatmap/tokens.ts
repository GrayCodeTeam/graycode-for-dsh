/**
 * Activity heatmap (C6) — token statistics aggregation (pure, unit-testable).
 *
 * The token section is aggregated on the browser side from the host `session.list`
 * rows (`projections.values.tokenUsage`, backed by the host token-meter's durable
 * projection cache — cold sessions included). This module turns the narrowed
 * session rows into the render-ready result:
 *
 * - range filter: sessions are kept by their start day vs. the range's
 *   local-day start (same vocabulary as the activity ranges);
 * - byDay: bucket sums grouped by local day, newest day first;
 * - sessions: sorted by total tokens descending (the top slice happens in the
 *   view model, not here);
 * - totals: bucket sums across the filtered set.
 *
 * Host data stays authoritative: no re-typing, no invented buckets.
 */
import type { ActivityRange, ActivityTokenSessionLike, ActivityTokensResultLike } from './types.ts'

/** Day count of each bounded range (matches the legacy activity ranges). */
const RANGE_DAYS: Readonly<Record<Exclude<ActivityRange, 'all'>, number>> = {
  today: 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '365d': 365,
}

/** Local midnight of the range start; undefined = unbounded (`all`). */
export function activityTokenRangeStartMs(range: ActivityRange | undefined, now: number): number | undefined {
  if (range === undefined || range === 'all') return undefined
  const days = RANGE_DAYS[range]
  // 宿主日历日语义：窗口起点 = 今天本地零点往回退 (days-1) 个「日历日」，
  // 而不是固定 24h 算术——DST 过渡日的 24h 时长不等于一个日历日，按小时相减会
  // 把边界日的整天数据丢失或混入（3.1-M1）。setDate 逐日历日回退，天然跨月/跨年。
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  startOfToday.setDate(startOfToday.getDate() - (days - 1))
  return startOfToday.getTime()
}

/** Sum two bucket sets into a new immutable bucket set. */
function addBuckets(
  left: ActivityTokenSessionLike | ActivityTokensResultLike['totals'],
  right: ActivityTokenSessionLike | ActivityTokensResultLike['totals'],
): ActivityTokensResultLike['totals'] {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  }
}

/**
 * Aggregate the narrowed session rows into the token stats result. Sessions
 * outside the range are excluded; a session with zero tokens in every bucket
 * is still listed (it was narrowed in by the wire, so its usage is real).
 */
export function aggregateActivityTokens(
  sessions: readonly ActivityTokenSessionLike[],
  params: { readonly range?: ActivityRange },
  now: number,
): ActivityTokensResultLike {
  const start = activityTokenRangeStartMs(params.range, now)
  const filtered = start === undefined
    ? sessions
    : sessions.filter(session => {
        const day = new Date(`${session.date}T00:00:00`)
        return day.getTime() >= start
      })
  const byDay = new Map<string, ActivityTokensResultLike['totals']>()
  let totals: ActivityTokensResultLike['totals'] = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  }
  for (const session of filtered) {
    totals = addBuckets(totals, session)
    const buckets = {
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      cacheReadTokens: session.cacheReadTokens,
      cacheWriteTokens: session.cacheWriteTokens,
      totalTokens: session.totalTokens,
    }
    byDay.set(session.date, byDay.has(session.date) ? addBuckets(byDay.get(session.date)!, buckets) : buckets)
  }
  return {
    generatedAt: now,
    totals,
    byDay: [...byDay.entries()]
      .map(([date, buckets]) => ({ date, ...buckets }))
      .sort((left, right) => right.date.localeCompare(left.date)),
    sessions: [...filtered].sort((left, right) => right.totalTokens - left.totalTokens),
  }
}
