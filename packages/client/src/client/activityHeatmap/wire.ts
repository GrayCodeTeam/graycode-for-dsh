/**
 * Activity heatmap (C6) — contract-driven envelope readers (pure).
 *
 * The host returns every remote call as a `GrayRemoteResult<T>` envelope
 * (`{ ok: true, value }` | `{ ok: false, error }`, see
 * packages/plugin/src/remote/types.ts). These readers narrow the raw `unknown`
 * defensively — the client never trusts the wire: malformed numbers/arrays
 * degrade to safe fallbacks and unknown shapes to a stable `GRAY_INTERNAL`
 * failure.
 */

import type {
  ActivitySessionLike,
  ActivityStatsError,
  ActivityStatsResultLike,
  CurrentSessionInfoLike,
  DayActivityStatsLike,
  HourlyHeatmapRowLike,
  MonthlyActivityStatsLike,
} from './types.ts'

/** Narrowed `ok` half of the remote envelope. */
export interface ActivityEnvelopeOk {
  readonly ok: true
  readonly value: unknown
}

/** Narrowed failure half of the remote envelope. */
export interface ActivityEnvelopeErr {
  readonly ok: false
  readonly error: ActivityStatsError
}

/** Narrowed remote envelope (`GrayRemoteResult<unknown>` mirror). */
export type ActivityEnvelope = ActivityEnvelopeOk | ActivityEnvelopeErr

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.floor(value)
}

function readNullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null
  return readInt(value) ?? null
}

function readIntArray(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value
    .map(readInt)
    .filter((item): item is number => item !== undefined)
}

function internalFailure(message: string): ActivityStatsError {
  return { code: 'GRAY_INTERNAL', message, details: {} }
}

/** Narrow one `ActivitySession` wire item. */
export function readActivitySession(value: unknown): ActivitySessionLike | null {
  if (!isRecord(value)) return null
  const start = readInt(value.start)
  const end = readInt(value.end)
  const minutes = readInt(value.minutes)
  if (start === undefined || end === undefined || minutes === undefined) return null
  return { start, end, minutes }
}

/** Narrow one `DayActivityStats` wire item. */
export function readDayActivityStats(value: unknown): DayActivityStatsLike | null {
  if (!isRecord(value)) return null
  const date = readString(value.date)
  const totalMinutes = readInt(value.totalMinutes)
  const sessionCount = readInt(value.sessionCount)
  if (date === undefined || totalMinutes === undefined || sessionCount === undefined) return null
  return {
    date,
    totalMinutes,
    sessionCount,
    sessions: Array.isArray(value.sessions)
      ? value.sessions
          .map(readActivitySession)
          .filter((item): item is ActivitySessionLike => item !== null)
      : [],
    firstActiveAt: readNullableInt(value.firstActiveAt),
    lastActiveAt: readNullableInt(value.lastActiveAt),
    hourly: readIntArray(value.hourly),
  }
}

/** Narrow one `CurrentSessionInfo` wire item. */
export function readCurrentSessionInfo(value: unknown): CurrentSessionInfoLike | null {
  if (!isRecord(value) || typeof value.active !== 'boolean') return null
  const minutes = readInt(value.minutes)
  if (minutes === undefined) return null
  return { active: value.active, startedAt: readNullableInt(value.startedAt), minutes }
}

/** Narrow one `HourlyHeatmapRow` wire item. */
export function readHourlyHeatmapRow(value: unknown): HourlyHeatmapRowLike | null {
  if (!isRecord(value)) return null
  const date = readString(value.date)
  if (date === undefined) return null
  return { date, hours: readIntArray(value.hours) }
}

/** Narrow one `MonthlyActivityStats` wire item. */
export function readMonthlyActivityStats(value: unknown): MonthlyActivityStatsLike | null {
  if (!isRecord(value)) return null
  const month = readString(value.month)
  const totalMinutes = readInt(value.totalMinutes)
  const activeDays = readInt(value.activeDays)
  const sessionCount = readInt(value.sessionCount)
  if (month === undefined || totalMinutes === undefined || activeDays === undefined || sessionCount === undefined) {
    return null
  }
  return { month, totalMinutes, activeDays, sessionCount }
}

/**
 * Narrow the `activity/stats` result value. Malformed rows are dropped;
 * a missing `currentSession` degrades to an inactive placeholder (the host
 * always sends one, but the wire is not trusted).
 */
export function readActivityStatsResult(value: unknown): ActivityStatsResultLike | null {
  if (!isRecord(value)) return null
  const generatedAt = readInt(value.generatedAt)
  const currentSession = readCurrentSessionInfo(value.currentSession)
  if (generatedAt === undefined || currentSession === null) return null
  return {
    generatedAt,
    today: value.today === null || value.today === undefined ? null : readDayActivityStats(value.today),
    currentSession,
    daily: Array.isArray(value.daily)
      ? value.daily
          .map(readDayActivityStats)
          .filter((item): item is DayActivityStatsLike => item !== null)
      : [],
    hourlyHeatmap: Array.isArray(value.hourlyHeatmap)
      ? value.hourlyHeatmap
          .map(readHourlyHeatmapRow)
          .filter((item): item is HourlyHeatmapRowLike => item !== null)
      : [],
    monthly: Array.isArray(value.monthly)
      ? value.monthly
          .map(readMonthlyActivityStats)
          .filter((item): item is MonthlyActivityStatsLike => item !== null)
      : [],
  }
}

/** Narrow a `GrayRemoteFailure` value (`{ code, message, details }`). */
export function readActivityFailure(value: unknown): ActivityStatsError | null {
  if (!isRecord(value)) return null
  const code = readString(value.code)
  if (code === undefined) return null
  return {
    code,
    message: typeof value.message === 'string' ? value.message : '',
    details: isRecord(value.details) ? (value.details as Readonly<Record<string, unknown>>) : {},
  }
}

/**
 * Narrow the raw remote envelope. Anything that is not a well-formed envelope
 * degrades to a stable `GRAY_INTERNAL` failure — the consumer never crashes on
 * the wire.
 */
export function readActivityEnvelope(value: unknown): ActivityEnvelope {
  if (!isRecord(value)) {
    return { ok: false, error: internalFailure('malformed remote envelope') }
  }
  if (value.ok === true) return { ok: true, value: value.value }
  if (value.ok === false) {
    const error = readActivityFailure(value.error)
    if (error !== null) return { ok: false, error }
  }
  return { ok: false, error: internalFailure('malformed remote envelope') }
}

/**
 * Normalize an arbitrary thrown value into a stable {@link ActivityStatsError}
 * (used at the data-source boundary; rejects never leak raw internals).
 */
export function readActivityThrownError(error: unknown): ActivityStatsError {
  if (isRecord(error) && typeof error.code === 'string') {
    return {
      code: error.code,
      message: typeof error.message === 'string' ? error.message : '',
      details: isRecord(error.details) ? (error.details as Readonly<Record<string, unknown>>) : {},
    }
  }
  return internalFailure('unexpected error')
}
