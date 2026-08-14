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
  ActivityStatsDataSource,
  ActivityStatsError,
  ActivityStatsResultLike,
  ActivityStatsWireParams,
} from './types.ts'
import { readActivityEnvelope, readActivityStatsResult } from './wire.ts'

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
  const day: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 60, 60, 45, 0, 0, 30, 60, 60, 30, 0, 0, 0, 0, 0, 0]
  const lightDay: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 30, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
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
    const hours = offset === 3 ? [...lightDay] : [...day]
    const total = hours.reduce((sum, minutes) => sum + minutes, 0)
    const sessionCount = offset === 3 ? 1 : 2
    daily.push({
      date,
      totalMinutes: total,
      sessionCount,
      sessions: [
        { start: hourStartOf(dayStart.getTime(), 9), end: hourStartOf(dayStart.getTime(), 12), minutes: 60 + 60 + 45 },
      ],
      firstActiveAt: hourStartOf(dayStart.getTime(), 9),
      lastActiveAt: hourStartOf(dayStart.getTime(), 17),
      hourly: hours,
    })
    hourlyHeatmap.push({ date, hours })
  }

  return {
    generatedAt: now,
    today: {
      date: daily[daily.length - 1]!.date,
      totalMinutes: daily[daily.length - 1]!.totalMinutes,
      sessionCount: daily[daily.length - 1]!.sessionCount,
      sessions: daily[daily.length - 1]!.sessions,
      firstActiveAt: daily[daily.length - 1]!.firstActiveAt,
      lastActiveAt: daily[daily.length - 1]!.lastActiveAt,
      hourly: daily[daily.length - 1]!.hourly,
    },
    currentSession: { active: true, startedAt: hourStartOf(now, 14), minutes: 42 },
    daily,
    hourlyHeatmap,
    monthly: [
      { month: `${dateStr(now).slice(0, 7)}`, totalMinutes: daily.reduce((sum, d) => sum + d.totalMinutes, 0), activeDays: 6, sessionCount: 11 },
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
