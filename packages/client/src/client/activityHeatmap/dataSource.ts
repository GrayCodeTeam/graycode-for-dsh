/**
 * Activity heatmap (C6) — data sources.
 *
 * Two implementations of {@link ActivityStatsDataSource}:
 *
 * - {@link RemoteActivityStatsDataSource} — the contract-driven consumer of
 *   the host Remote API (`activity/stats`; handler in
 *   packages/plugin/src/activity/adapters/dsh/remote.ts, registered under
 *   `ctx.grayRemote` by the activity domain). It consumes the `GrayRemoteResult`
 *   envelope through the pure readers in `wire.ts` and never trusts the wire.
 *   The actual browser→host transport is NOT wired in rc.6 (README
 *   GAP-client-1), so the class takes a transport function the main session
 *   supplies.
 *
 * - {@link MockActivityStatsDataSource} — deterministic in-memory fixture (no
 *   I/O) for development, tests and unwired hosts. Generates a week of daily
 *   stats with a stable pattern plus today/current-session info.
 *
 * Neither implementation touches the workspace or the file system (browser
 * bundle boundary rules).
 */
import { buildActivityStatsRequest } from './query.ts'
import type {
  ActivitySessionListApi,
  ActivityStatsDataSource,
  ActivityStatsError,
  ActivityStatsResultLike,
  ActivityStatsWireParams,
  ActivityTokensDataSource,
  ActivityTokensResultLike,
  ActivityTokensWireParams,
} from './types.ts'
import { readActivityEnvelope, readActivityNextCursor, readActivityStatsResult, readActivityTokenListItems, readActivityTokenSessionSummary, readActivityThrownError } from './wire.ts'
import { aggregateActivityTokens } from './tokens.ts'

/**
 * Hard cap on `session.list` pages fetched per `tokens()` call. Defensive
 * bound: a broken host must not loop forever on a repeating cursor (3.1-M2);
 * hitting the cap raises a stable `GRAY_INTERNAL` instead of returning a
 * silently truncated total.
 */
export const ACTIVITY_SESSION_LIST_MAX_PAGES = 100

/** Host endpoint consumed by this surface (contract key). */
export type ActivityRemoteEndpoint = 'activity/stats'

/**
 * Transport from the browser half to the host `ctx.grayRemote` dispatcher.
 * Returns the raw `GrayRemoteResult` envelope (unknown on the wire). Wired by
 * the main session — rc.6 has no built-in client→host remote channel
 * (README GAP-client-1).
 */
export type ActivityRemoteTransport = (
  endpoint: ActivityRemoteEndpoint,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
) => Promise<unknown>

function toActivityError(code: string, message: string): ActivityStatsError {
  return { code, message, details: {} }
}

/**
 * Contract-driven consumer of the host `activity/stats` endpoint.
 *
 * Maps wire params onto the endpoint args, reads the `GrayRemoteResult`
 * envelope defensively (`wire.ts`), and translates failures into thrown
 * {@link ActivityStatsError} values (business errors never reject the transport
 * itself — only this wrapper's promise).
 */
export class RemoteActivityStatsDataSource implements ActivityStatsDataSource {
  constructor(private readonly transport: ActivityRemoteTransport) {}

  async stats(params: ActivityStatsWireParams, signal?: AbortSignal): Promise<ActivityStatsResultLike> {
    const request = buildActivityStatsRequest(params)
    const envelope = readActivityEnvelope(
      await this.transport('activity/stats', request as Readonly<Record<string, unknown>>, signal),
    )
    if (!envelope.ok) throw envelope.error
    const result = readActivityStatsResult(envelope.value)
    if (result === null) throw toActivityError('GRAY_INTERNAL', 'malformed activity/stats result')
    return result
  }
}

/**
 * Browser-side token statistics source.
 *
 * The host exposes token usage per session through the `session.list`
 * projection baseline (`projections.values.tokenUsage`, token-meter), covering
 * both attached and cold sessions via the durable projection cache — no plugin
 * endpoint needed. This source narrows each page defensively, pages through the
 * cursor until exhausted (3.1-M2), raises a stable {@link ActivityStatsError}
 * on malformed envelopes, and delegates the range filter / day grouping /
 * sorting to the pure aggregator in `tokens.ts`.
 */
export class ConnectionActivityTokensDataSource implements ActivityTokensDataSource {
  constructor(private readonly api: ActivitySessionListApi) {}

  async tokens(params: ActivityTokensWireParams): Promise<ActivityTokensResultLike> {
    // `session.list` 是分页接口（items + nextCursor/total）：必须用 cursor 循环
    // 拉全，否则会话数超过单页大小时 token 汇总被低估（3.1-M2）。带硬性页数
    // 上限，主机游标异常（重复/恒真）时抛稳定错误而不是死循环。
    const rawItems: unknown[] = []
    let cursor: string | undefined
    for (let page = 0; ; page++) {
      if (page >= ACTIVITY_SESSION_LIST_MAX_PAGES) {
        throw toActivityError('GRAY_INTERNAL', `session.list pagination cap (${ACTIVITY_SESSION_LIST_MAX_PAGES} pages) exceeded`)
      }
      let response: { readonly result: { readonly ok: boolean; readonly value?: unknown; readonly error?: unknown } }
      try {
        response = await this.api.sessions.list(cursor === undefined ? {} : { cursor })
      } catch (error: unknown) {
        throw readActivityThrownError(error)
      }
      const { result } = response
      if (!result.ok) {
        throw readActivityThrownError(result.error ?? new Error('session.list failed'))
      }
      const items = readActivityTokenListItems(result.value)
      if (items === null) throw toActivityError('GRAY_INTERNAL', 'malformed session.list result')
      rawItems.push(...items)
      const nextCursor = readActivityNextCursor(result.value)
      if (nextCursor === undefined) break
      cursor = nextCursor
    }
    const sessions = rawItems
      .map(readActivityTokenSessionSummary)
      .filter((item): item is NonNullable<typeof item> => item !== null)
    return aggregateActivityTokens(sessions, params, Date.now())
  }
}

/** Options for the deterministic mock source. */
export interface MockActivityStatsDataSourceOptions {
  /** Injected failure code (stable) to throw on `stats`, for tests/dev. */
  readonly failure?: string
  /** Anchor "now" for deterministic fixtures (defaults to Date.now()). */
  readonly now?: number
}

function dateStr(ts: number): string {
  const d = new Date(ts)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

function hourStartOf(ts: number, hour: number): number {
  const d = new Date(ts)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

/**
 * Deterministic fixture: 7 days of activity ending at `now`, a stable
 * 9-12 + 14-18 local pattern with a light day, plus an active current session.
 * Pure in-memory data — no file system, no workspace access.
 */
export function createMockActivityStats(now: number): ActivityStatsResultLike {
  const dayHours: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 60, 60, 45, 0, 0, 30, 60, 60, 30, 0, 0, 0, 0, 0, 0]
  const lightHours: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 30, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  const daily: Array<{
    date: string
    totalMinutes: number
    sessionCount: number
    sessions: Array<{ start: number; end: number; minutes: number }>
    firstActiveAt: number
    lastActiveAt: number
    hourly: number[]
  }> = []
  const hourlyHeatmap: Array<{ date: string; hours: number[] }> = []

  for (let offset = 6; offset >= 0; offset--) {
    const dayStart = new Date(now)
    dayStart.setDate(dayStart.getDate() - offset)
    dayStart.setHours(0, 0, 0, 0)
    const date = dateStr(dayStart.getTime())
    const light = offset === 3
    const hours = light ? [...lightHours] : [...dayHours]
    const total = hours.reduce((sum, minutes) => sum + minutes, 0)
    // 会话列表与会话数、小时分布自洽（4.1-L3）：常规日 9-12（165 分钟）+
    // 14-18（180 分钟）；轻量日 9-9:45（45 分钟），分钟数之和等于 hourly 总和。
    const sessions = light
      ? [{ start: hourStartOf(dayStart.getTime(), 9), end: hourStartOf(dayStart.getTime(), 9) + 45 * 60 * 1000, minutes: 45 }]
      : [
          { start: hourStartOf(dayStart.getTime(), 9), end: hourStartOf(dayStart.getTime(), 12), minutes: 60 + 60 + 45 },
          { start: hourStartOf(dayStart.getTime(), 14), end: hourStartOf(dayStart.getTime(), 18), minutes: 30 + 60 + 60 + 30 },
        ]
    daily.push({
      date,
      totalMinutes: total,
      sessionCount: sessions.length,
      sessions,
      firstActiveAt: hourStartOf(dayStart.getTime(), 9),
      lastActiveAt: light ? hourStartOf(dayStart.getTime(), 10) : hourStartOf(dayStart.getTime(), 17),
      hourly: hours,
    })
    hourlyHeatmap.push({ date, hours })
  }

  // 月度行只汇总落在当前月的 daily（跨月天数不属于本月），保证 monthly 与 daily 自洽。
  const month = dateStr(now).slice(0, 7)
  const monthDays = daily.filter(day => day.date.startsWith(month))

  return {
    generatedAt: now,
    today: { ...daily[daily.length - 1]! },
    currentSession: { active: true, startedAt: hourStartOf(now, 14), minutes: 42 },
    daily,
    hourlyHeatmap,
    monthly: [
      {
        month,
        totalMinutes: monthDays.reduce((sum, day) => sum + day.totalMinutes, 0),
        activeDays: monthDays.filter(day => day.totalMinutes > 0).length,
        sessionCount: monthDays.reduce((sum, day) => sum + day.sessionCount, 0),
      },
    ],
  }
}

/**
 * Deterministic in-memory data source. No cursor semantics (ranges are
 * bounded); the failure option injects a stable code for tests/dev.
 */
export class MockActivityStatsDataSource implements ActivityStatsDataSource {
  private readonly failure?: string
  private readonly now: number

  constructor(options: MockActivityStatsDataSourceOptions = {}) {
    this.failure = options.failure
    this.now = options.now ?? Date.now()
  }

  async stats(_params: ActivityStatsWireParams, _signal?: AbortSignal): Promise<ActivityStatsResultLike> {
    if (this.failure !== undefined) {
      throw toActivityError(this.failure, `mock activity/stats failure: ${this.failure}`)
    }
    return createMockActivityStats(this.now)
  }
}
