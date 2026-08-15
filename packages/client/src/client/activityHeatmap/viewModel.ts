/**
 * Activity heatmap (C6) — view-model construction (pure, unit-testable).
 *
 * Projects the `activity/stats` result into render-ready views for the three
 * chart areas (legacy Gray Code activity panel):
 *
 * - hourly heatmap: one 24-slot row per day (activity minutes per local hour),
 *   rows clamped to the last {@link ACTIVITY_HEATMAP_MAX_ROWS} days for huge
 *   ranges (365d / all);
 * - daily bars: one bar per day (totalMinutes), newest first (host order);
 * - monthly bars: one bar per month (totalMinutes), newest first (host order).
 *
 * Intensity buckets for the heatmap cells map minutes to 0-4 levels
 * (pure arithmetic, no I/O). Host data stays authoritative: no re-sorting,
 * no filtering.
 */

import { ACTIVITY_HEATMAP_MAX_ROWS } from './query.ts'
import type {
  ActivityStatsResultLike,
  DayActivityStatsLike,
  HourlyHeatmapRowLike,
  MonthlyActivityStatsLike,
} from './types.ts'

/** Intensity level of one heatmap cell (0 = none … 4 = max). */
export type ActivityIntensity = 0 | 1 | 2 | 3 | 4

/** One render-ready heatmap cell (hour slot of a day). */
export interface ActivityHeatmapCellView {
  readonly hour: number
  /** Active minutes in that hour (from the wire). */
  readonly minutes: number
  /** 0-4 intensity bucket (drives cell opacity/color). */
  readonly intensity: ActivityIntensity
}

/** One render-ready heatmap row (a day with up to 24 cells). */
export interface ActivityHeatmapRowView {
  readonly date: string
  readonly totalMinutes: number
  readonly cells: readonly ActivityHeatmapCellView[]
}

/** One render-ready daily bar. */
export interface ActivityDailyBarView {
  readonly date: string
  readonly totalMinutes: number
  readonly sessionCount: number
}

/** One render-ready monthly bar. */
export interface ActivityMonthlyBarView {
  readonly month: string
  readonly totalMinutes: number
  readonly activeDays: number
  readonly sessionCount: number
}

/** Render-ready overview (legacy Gray Code panel: today / current / range). */
export interface ActivitySummaryView {
  /** Result generation time (ms epoch) for the header stamp. */
  readonly generatedAt: number
  /** Total minutes across the query range (sum of daily). */
  readonly totalMinutes: number
  /** Number of days with any activity in the range. */
  readonly activeDays: number
  /** Total session count across the range. */
  readonly sessionCount: number
  /** Today's minutes (0 when today has no data). */
  readonly todayMinutes: number
  /** Whether a continuous work session is in progress now. */
  readonly currentActive: boolean
  /** Minutes of the current continuous session. */
  readonly currentMinutes: number
}

/**
 * Map active minutes to a 0-4 intensity bucket (legacy Gray Code scale:
 * 0 → none; ≤5 → faint; ≤15 → low; ≤30 → medium; >30 → max).
 */
export function activityIntensityOf(minutes: number): ActivityIntensity {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0
  if (minutes <= 5) return 1
  if (minutes <= 15) return 2
  if (minutes <= 30) return 3
  return 4
}

/** Build one render-ready heatmap row from the wire row. */
export function buildActivityHeatmapRow(row: HourlyHeatmapRowLike): ActivityHeatmapRowView {
  const cells: ActivityHeatmapCellView[] = []
  for (let hour = 0; hour < 24; hour++) {
    const minutes = row.hours[hour] ?? 0
    cells.push({ hour, minutes, intensity: activityIntensityOf(minutes) })
  }
  return { date: row.date, totalMinutes: cells.reduce((sum, cell) => sum + cell.minutes, 0), cells }
}

/**
 * Build the hourly heatmap view: rows in host order (ascending date), clamped
 * to the last {@link ACTIVITY_HEATMAP_MAX_ROWS} entries so huge ranges do not
 * overflow the panel.
 */
export function buildActivityHeatmap(result: ActivityStatsResultLike): readonly ActivityHeatmapRowView[] {
  const rows = result.hourlyHeatmap.map(buildActivityHeatmapRow)
  return rows.slice(-ACTIVITY_HEATMAP_MAX_ROWS)
}

/** Build one render-ready daily bar from the wire day. */
export function buildActivityDailyBar(day: DayActivityStatsLike): ActivityDailyBarView {
  return { date: day.date, totalMinutes: day.totalMinutes, sessionCount: day.sessionCount }
}

/** Build the daily bars view (host order: newest first). */
export function buildActivityDailyBars(result: ActivityStatsResultLike): readonly ActivityDailyBarView[] {
  return result.daily.map(buildActivityDailyBar)
}

/** Build one render-ready monthly bar from the wire month. */
export function buildActivityMonthlyBar(month: MonthlyActivityStatsLike): ActivityMonthlyBarView {
  return { month: month.month, totalMinutes: month.totalMinutes, activeDays: month.activeDays, sessionCount: month.sessionCount }
}

/** Build the monthly bars view (host order: newest first). */
export function buildActivityMonthlyBars(result: ActivityStatsResultLike): readonly ActivityMonthlyBarView[] {
  return result.monthly.map(buildActivityMonthlyBar)
}

/** Build the summary strip from the full result. */
export function buildActivitySummary(result: ActivityStatsResultLike): ActivitySummaryView {
  let totalMinutes = 0
  let activeDays = 0
  let sessionCount = 0
  for (const day of result.daily) {
    totalMinutes += day.totalMinutes
    if (day.totalMinutes > 0) activeDays += 1
    sessionCount += day.sessionCount
  }
  return {
    generatedAt: result.generatedAt,
    totalMinutes,
    activeDays,
    sessionCount,
    todayMinutes: result.today?.totalMinutes ?? 0,
    currentActive: result.currentSession.active,
    currentMinutes: result.currentSession.minutes,
  }
}

/**
 * Format a minute count the way the legacy Gray Code panel does:
 * `0m` / `23m` / `2h` / `2h 5m`. Units are injected so the surface can keep
 * them localized (zh `小时/分钟`, en `h/min`, ja placeholder).
 */
export function formatActivityDuration(
  minutes: number,
  units: { readonly hour: string; readonly minute: string },
): string {
  const total = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0
  if (total <= 0) return `0${units.minute}`
  const hours = Math.floor(total / 60)
  const rest = total % 60
  if (hours === 0) return `${rest}${units.minute}`
  if (rest === 0) return `${hours}${units.hour}`
  return `${hours}${units.hour} ${rest}${units.minute}`
}

/** Format a ms epoch as local `YYYY-MM-DD HH:mm` (legacy panel header stamp). */
export function formatGeneratedAt(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  const two = (value: number): string => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    '-',
    two(date.getMonth() + 1),
    '-',
    two(date.getDate()),
    ' ',
    two(date.getHours()),
    ':',
    two(date.getMinutes()),
  ].join('')
}
