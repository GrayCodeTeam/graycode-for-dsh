/**
 * Activity heatmap (C6) — node-environment tests of the replay-safe pure
 * logic. React is intentionally not imported: these tests cover query
 * normalization, wire readers (malformed input defense), error hints,
 * view-model projections (7×24 heatmap rows/cells, daily/monthly bars,
 * summary strip), the mock source determinism, the remote consumer with a
 * fake transport, and locale alignment.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ACTIVITY_DEFAULT_RANGE,
  ACTIVITY_HEATMAP_MAX_ROWS,
  ACTIVITY_RANGES,
  buildActivityStatsRequest,
  createActivityStatsQuery,
  isActivityRange,
  normalizeActivityRange,
  withActivityHourly,
  withActivityMonthly,
  withActivityRange,
} from '../src/client/activityHeatmap/query.ts'
import {
  readActivityEnvelope,
  readActivityNextCursor,
  readActivitySession,
  readActivityStatsResult,
  readActivityThrownError,
  readActivityTokenBuckets,
  readActivityTokenListItems,
  readActivityTokenSessionSummary,
  readCurrentSessionInfo,
  readDayActivityStats,
  readHourlyHeatmapRow,
  readMonthlyActivityStats,
} from '../src/client/activityHeatmap/wire.ts'
import { aggregateActivityTokens, activityTokenRangeStartMs } from '../src/client/activityHeatmap/tokens.ts'
import {
  activityStatsErrorHint,
  activityStatsErrorKey,
  isActivityErrorRetryable,
} from '../src/client/activityHeatmap/errors.ts'
import {
  activityIntensityOf,
  buildActivityDailyBars,
  buildActivityHeatmap,
  buildActivityMonthlyBars,
  buildActivitySummary,
  buildActivityTokenStats,
  formatActivityDuration,
  formatGeneratedAt,
  formatTokenCount,
  type ActivityHeatmapRowView,
} from '../src/client/activityHeatmap/viewModel.ts'
import {
  ConnectionActivityTokensDataSource,
  MockActivityStatsDataSource,
  RemoteActivityStatsDataSource,
  createMockActivityStats,
  type ActivityRemoteTransport,
} from '../src/client/activityHeatmap/dataSource.ts'
import {
  GRAYCODE_ACTIVITY_HEATMAP_NS,
  graycodeActivityHeatmapDictionaries,
  graycodeActivityHeatmapJaPlaceholder,
} from '../src/client/activityHeatmap/locales.ts'
import type { ActivityStatsResultLike } from '../src/client/activityHeatmap/types.ts'

// ---------------------------------------------------------------------------
// query model
// ---------------------------------------------------------------------------

describe('activity query model', () => {
  it('exposes all ranges and the default', () => {
    expect(ACTIVITY_RANGES).toEqual(['today', '7d', '30d', '90d', '365d', 'all'])
    expect(ACTIVITY_DEFAULT_RANGE).toBe('7d')
    expect(createActivityStatsQuery()).toEqual({ range: '7d' })
  })

  it('isActivityRange / normalizeActivityRange fall back to the default', () => {
    expect(isActivityRange('30d')).toBe(true)
    expect(isActivityRange('bogus')).toBe(false)
    expect(normalizeActivityRange('bogus')).toBe('7d')
    expect(normalizeActivityRange(undefined)).toBe('7d')
    expect(normalizeActivityRange('365d')).toBe('365d')
  })

  it('buildActivityStatsRequest always carries a normalized range and forwards toggles only when true', () => {
    expect(buildActivityStatsRequest(createActivityStatsQuery())).toEqual({ range: '7d' })
    expect(buildActivityStatsRequest({ range: 'today' })).toEqual({ range: 'today' })
    expect(buildActivityStatsRequest({ range: 'bogus' } as never)).toEqual({ range: '7d' })
    const full = withActivityMonthly(withActivityHourly(withActivityRange(createActivityStatsQuery(), '30d'), true), true)
    expect(buildActivityStatsRequest(full)).toEqual({ range: '30d', includeHourly: true, includeMonthly: true })
  })

  it('derived query helpers keep other fields intact', () => {
    const base = withActivityRange(createActivityStatsQuery(), '30d')
    const hourly = withActivityHourly(base, true)
    expect(hourly).toEqual({ range: '30d', includeHourly: true })
    expect(withActivityMonthly(hourly, true)).toEqual({ range: '30d', includeHourly: true, includeMonthly: true })
  })
})

// ---------------------------------------------------------------------------
// wire readers (defensive narrowing)
// ---------------------------------------------------------------------------

describe('activity wire readers', () => {
  it('reads a well-formed envelope value', () => {
    const envelope = readActivityEnvelope({ ok: true, value: { generatedAt: 1 } })
    expect(envelope.ok).toBe(true)
  })

  it('degrades malformed envelopes to a stable GRAY_INTERNAL failure', () => {
    for (const bad of [null, 'str', 42, { ok: 'yes' }, { ok: false }, { ok: false, error: 'x' }]) {
      const envelope = readActivityEnvelope(bad)
      expect(envelope.ok).toBe(false)
      if (!envelope.ok) expect(envelope.error.code).toBe('GRAY_INTERNAL')
    }
  })

  it('reads a well-formed failure envelope', () => {
    const envelope = readActivityEnvelope({ ok: false, error: { code: 'GRAY_STORAGE_CORRUPT', message: 'x', details: {} } })
    expect(envelope.ok).toBe(false)
    if (!envelope.ok) expect(envelope.error.code).toBe('GRAY_STORAGE_CORRUPT')
  })

  it('narrows one activity session and drops malformed entries', () => {
    expect(readActivitySession({ start: 1, end: 2, minutes: 1 })).toEqual({ start: 1, end: 2, minutes: 1 })
    expect(readActivitySession({ start: '1', end: 2, minutes: 1 })).toBeNull()
    expect(readActivitySession(null)).toBeNull()
  })

  it('narrows a day stats row and drops malformed rows', () => {
    const day = readDayActivityStats({
      date: '2026-08-14',
      totalMinutes: 120,
      sessionCount: 2,
      sessions: [{ start: 1, end: 2, minutes: 1 }, 'bad'],
      firstActiveAt: 1,
      lastActiveAt: 2,
      hourly: [0, 1, 'x', 3],
    })
    expect(day).not.toBeNull()
    expect(day!.sessions).toHaveLength(1)
    expect(day!.hourly).toEqual([0, 1, 3])
    expect(readDayActivityStats({ date: 'x' })).toBeNull()
  })

  it('narrows current session info with an inactive fallback shape', () => {
    expect(readCurrentSessionInfo({ active: false, startedAt: null, minutes: 0 })).toEqual({
      active: false,
      startedAt: null,
      minutes: 0,
    })
    expect(readCurrentSessionInfo({ active: true })).toBeNull()
  })

  it('narrows heatmap rows and monthly stats', () => {
    expect(readHourlyHeatmapRow({ date: 'd', hours: [1, 2, 'x'] })).toEqual({ date: 'd', hours: [1, 2] })
    expect(readHourlyHeatmapRow({ hours: [1] })).toBeNull()
    expect(readMonthlyActivityStats({ month: '2026-08', totalMinutes: 1, activeDays: 1, sessionCount: 1 })).toEqual({
      month: '2026-08',
      totalMinutes: 1,
      activeDays: 1,
      sessionCount: 1,
    })
    expect(readMonthlyActivityStats({ month: 'x' })).toBeNull()
  })

  it('narrows the full stats result and tolerates missing optional payloads', () => {
    const result = readActivityStatsResult({
      generatedAt: 5,
      today: null,
      currentSession: { active: false, startedAt: null, minutes: 0 },
      daily: [],
      hourlyHeatmap: [],
      monthly: [],
    })
    expect(result).not.toBeNull()
    expect(result!.today).toBeNull()
    expect(result!.daily).toEqual([])
    expect(readActivityStatsResult({ generatedAt: 5 })).toBeNull()
    expect(readActivityStatsResult('nope')).toBeNull()
  })

  it('readActivityThrownError normalizes arbitrary throws', () => {
    expect(readActivityThrownError({ code: 'GRAY_CONFLICT', message: 'x', details: {} }).code).toBe('GRAY_CONFLICT')
    expect(readActivityThrownError(new Error('secret: /home/user')).code).toBe('GRAY_INTERNAL')
  })

  it('narrows a token usage projection and degrades missing / non-numeric buckets to 0 (3.1-M3)', () => {
    expect(readActivityTokenBuckets({ uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 })).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      totalTokens: 100,
    })
    expect(readActivityTokenBuckets({ uncachedInputTokens: 5, outputTokens: 6 })).toEqual({
      inputTokens: 5,
      outputTokens: 6,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 11,
    })
    // 缺失/非数值字段降级为 0（宿主契约字段名不可验证），不整行丢弃，避免整节静默为空
    expect(readActivityTokenBuckets({ uncachedInputTokens: 5 })).toEqual({
      inputTokens: 5,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 5,
    })
    expect(readActivityTokenBuckets({ uncachedInputTokens: 'x', outputTokens: 1 })).toEqual({
      inputTokens: 0,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1,
    })
    // 非 record 输入仍视为不可读（null）
    expect(readActivityTokenBuckets('nope')).toBeNull()
  })

  it('narrows a session summary item, buckets by the session start day and drops items without usable projections', () => {
    // 本地时区构造：localDateKey 的结果在任何测试环境时区下都确定（修复 M1 时区依赖断言）
    const item = {
      sessionId: 'session-a',
      // startedAt 落在开始日；updatedAt 已前滚到次日（resumed 会话）——
      // 归集必须落在开始日，否则历史累计值随 updatedAt 前滚漂移（H-10）。
      startedAt: new Date(2026, 7, 14, 10, 0, 0).getTime(),
      updatedAt: new Date(2026, 7, 15, 10, 0, 0).getTime(),
      title: 'My session',
      projections: { values: { tokenUsage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } } },
    }
    const row = readActivityTokenSessionSummary(item)
    expect(row).not.toBeNull()
    expect(row!.title).toBe('My session')
    expect(row!.date).toBe('2026-08-14')
    expect(row!.totalTokens).toBe(10)
    // 缺失 startedAt/createdAt 的旧契约数据（只有 updatedAt）仍可用：兜底键 = updatedAt
    expect(readActivityTokenSessionSummary({ ...item, startedAt: undefined })!.date).toBe('2026-08-15')
    expect(readActivityTokenSessionSummary({ sessionId: 'x', startedAt: 1 })).toBeNull()
    expect(readActivityTokenSessionSummary({ ...item, projections: undefined })).toBeNull()
    expect(readActivityTokenSessionSummary({ ...item, startedAt: '1', updatedAt: '1' })).toBeNull()
    expect(readActivityTokenSessionSummary(null)).toBeNull()
  })

  it('narrows the session.list value into its raw item list', () => {
    expect(readActivityTokenListItems({ items: [1, 2] })).toEqual([1, 2])
    expect(readActivityTokenListItems({ items: 'x' })).toBeNull()
    expect(readActivityTokenListItems({})).toBeNull()
    expect(readActivityTokenListItems(null)).toBeNull()
  })

  it('narrows the session.list page cursor (absent/blank = no more pages)', () => {
    expect(readActivityNextCursor({ nextCursor: 'abc' })).toBe('abc')
    expect(readActivityNextCursor({ nextCursor: '  ' })).toBeUndefined()
    expect(readActivityNextCursor({})).toBeUndefined()
    expect(readActivityNextCursor('nope')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// error hints
// ---------------------------------------------------------------------------

describe('activity error hints', () => {
  it('maps every standard code to a locale key', () => {
    const cases: Array<[string, string, boolean]> = [
      ['GRAY_INVALID_INPUT', 'error.invalidInput', false],
      ['GRAY_CONFLICT', 'error.conflict', false],
      ['GRAY_APPROVAL_REQUIRED', 'error.approvalRequired', false],
      ['GRAY_CANCELLED', 'error.cancelled', false],
      ['GRAY_STORAGE_CORRUPT', 'error.storageCorrupt', false],
      ['GRAY_NOT_FOUND', 'error.notFound', false],
      ['GRAY_ENDPOINT_NOT_FOUND', 'error.endpointNotFound', false],
      ['GRAY_INTERNAL', 'error.internal', true],
    ]
    for (const [code, key, retryable] of cases) {
      expect(activityStatsErrorKey(code), code).toBe(key)
      expect(activityStatsErrorHint(code).retryable, code).toBe(retryable)
      expect(isActivityErrorRetryable(code), code).toBe(retryable)
    }
  })

  it('unknown and missing codes fall back to error.unknown (retryable)', () => {
    expect(activityStatsErrorKey('GRAY_WAT')).toBe('error.unknown')
    expect(activityStatsErrorKey(undefined)).toBe('error.unknown')
    expect(isActivityErrorRetryable('GRAY_WAT')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// view model projections
// ---------------------------------------------------------------------------

const FIXTURE: ActivityStatsResultLike = {
  generatedAt: 1_700_000_000_000,
  today: {
    date: '2026-08-14',
    totalMinutes: 120,
    sessionCount: 2,
    sessions: [{ start: 1, end: 2, minutes: 60 }],
    firstActiveAt: 1,
    lastActiveAt: 2,
    hourly: [0, 0, 0, 0, 0, 0, 0, 0, 0, 60, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  currentSession: { active: true, startedAt: 5, minutes: 42 },
  daily: [
    {
      date: '2026-08-14',
      totalMinutes: 120,
      sessionCount: 2,
      sessions: [],
      firstActiveAt: 1,
      lastActiveAt: 2,
      hourly: [0, 0, 0, 0, 0, 0, 0, 0, 0, 60, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
    {
      date: '2026-08-13',
      totalMinutes: 45,
      sessionCount: 1,
      sessions: [],
      firstActiveAt: 1,
      lastActiveAt: 2,
      hourly: [0, 0, 0, 0, 0, 0, 0, 0, 0, 30, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
  ],
  hourlyHeatmap: [
    { date: '2026-08-13', hours: [0, 0, 0, 0, 0, 0, 0, 0, 0, 30, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { date: '2026-08-14', hours: [0, 0, 0, 0, 0, 0, 0, 0, 0, 60, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  ],
  monthly: [{ month: '2026-08', totalMinutes: 165, activeDays: 2, sessionCount: 3 }],
}

describe('activity view model', () => {
  it('maps minutes to the 0-4 intensity buckets', () => {
    expect(activityIntensityOf(0)).toBe(0)
    expect(activityIntensityOf(-5)).toBe(0)
    expect(activityIntensityOf(NaN)).toBe(0)
    expect(activityIntensityOf(5)).toBe(1)
    expect(activityIntensityOf(15)).toBe(2)
    expect(activityIntensityOf(30)).toBe(3)
    expect(activityIntensityOf(31)).toBe(4)
  })

  it('builds heatmap rows with 24 cells and intensity buckets', () => {
    const rows: readonly ActivityHeatmapRowView[] = buildActivityHeatmap(FIXTURE)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.cells).toHaveLength(24)
    expect(rows[1]!.cells[9]).toEqual({ hour: 9, minutes: 60, intensity: 4 })
    expect(rows[0]!.cells[9]).toEqual({ hour: 9, minutes: 30, intensity: 3 })
  })

  it('clamps huge heatmaps to the last ACTIVITY_HEATMAP_MAX_ROWS rows', () => {
    const big = createMockActivityStats(Date.now())
    const many: ActivityStatsResultLike = {
      ...big,
      hourlyHeatmap: Array.from({ length: 100 }, (_, index) => ({ date: `d-${index}`, hours: Array(24).fill(5) })),
    }
    const rows = buildActivityHeatmap(many)
    expect(rows).toHaveLength(ACTIVITY_HEATMAP_MAX_ROWS)
    expect(rows[0]!.date).toBe(`d-${100 - ACTIVITY_HEATMAP_MAX_ROWS}`)
  })

  it('builds daily bars in host order (newest first)', () => {
    const bars = buildActivityDailyBars(FIXTURE)
    expect(bars.map((bar) => bar.date)).toEqual(['2026-08-14', '2026-08-13'])
    expect(bars[0]).toEqual({ date: '2026-08-14', totalMinutes: 120, sessionCount: 2 })
  })

  it('builds monthly bars in host order (newest first)', () => {
    const bars = buildActivityMonthlyBars(FIXTURE)
    expect(bars[0]).toEqual({ month: '2026-08', totalMinutes: 165, activeDays: 2, sessionCount: 3 })
  })

  it('builds the summary strip (totals, active days, today, current session)', () => {
    const summary = buildActivitySummary(FIXTURE)
    expect(summary).toEqual({
      generatedAt: 1_700_000_000_000,
      totalMinutes: 165,
      activeDays: 2,
      sessionCount: 3,
      todayMinutes: 120,
      currentActive: true,
      currentMinutes: 42,
    })
  })

  it('formats durations like the legacy panel (0m / 23m / 2h / 2h 5m)', () => {
    const units = { hour: 'h', minute: 'm' }
    expect(formatActivityDuration(0, units)).toBe('0m')
    expect(formatActivityDuration(-10, units)).toBe('0m')
    expect(formatActivityDuration(NaN, units)).toBe('0m')
    expect(formatActivityDuration(23, units)).toBe('23m')
    expect(formatActivityDuration(60, units)).toBe('1h')
    expect(formatActivityDuration(125, units)).toBe('2h 5m')
    expect(formatActivityDuration(59.6, units)).toBe('1h')
  })

  it('formats the generated stamp as local YYYY-MM-DD HH:mm', () => {
    const local = new Date(2026, 7, 14, 9, 5, 0)
    expect(formatGeneratedAt(local.getTime())).toBe('2026-08-14 09:05')
    expect(formatGeneratedAt(Number.NaN)).toBe('')
  })

  it('formats token counts compactly (raw / K / M, locale-free)', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1500)).toBe('1.5K')
    expect(formatTokenCount(12_300)).toBe('12.3K')
    expect(formatTokenCount(10_000)).toBe('10.0K')
    expect(formatTokenCount(2_500_000)).toBe('2.5M')
    expect(formatTokenCount(25_000_000)).toBe('25.0M')
    expect(formatTokenCount(Number.NaN)).toBe('0')
    expect(formatTokenCount(-5)).toBe('0')
  })
})

// ---------------------------------------------------------------------------
// token aggregation (pure)
// ---------------------------------------------------------------------------

const TOKEN_SESSIONS = [
  { sessionId: 'a', title: 'Alpha', date: '2026-08-14', inputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400, totalTokens: 1000 },
  { sessionId: 'b', title: 'Beta', date: '2026-08-13', inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 30 },
  { sessionId: 'c', title: 'Gamma', date: '2026-08-01', inputTokens: 500, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1000 },
] as const

describe('activity token aggregation', () => {
  it('computes the range start for every bounded range and none for all', () => {
    const now = new Date(2026, 7, 14, 12, 0, 0).getTime()
    expect(activityTokenRangeStartMs(undefined, now)).toBeUndefined()
    expect(activityTokenRangeStartMs('all', now)).toBeUndefined()
    expect(activityTokenRangeStartMs('today', now)).toBe(new Date(2026, 7, 14, 0, 0, 0).getTime())
    expect(activityTokenRangeStartMs('7d', now)).toBe(new Date(2026, 7, 8, 0, 0, 0).getTime())
    expect(activityTokenRangeStartMs('30d', now)).toBe(new Date(2026, 6, 16, 0, 0, 0).getTime())
  })

  it('totals, groups by day (newest first) and sorts sessions by total descending', () => {
    const now = new Date(2026, 7, 14, 12, 0, 0).getTime()
    const result = aggregateActivityTokens([...TOKEN_SESSIONS], {}, now)
    expect(result.generatedAt).toBe(now)
    expect(result.totals).toEqual({ inputTokens: 610, outputTokens: 720, cacheReadTokens: 300, cacheWriteTokens: 400, totalTokens: 2030 })
    expect(result.byDay.map(day => day.date)).toEqual(['2026-08-14', '2026-08-13', '2026-08-01'])
    expect(result.byDay[0]).toEqual({ date: '2026-08-14', inputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400, totalTokens: 1000 })
    expect(result.sessions.map(session => session.sessionId)).toEqual(['a', 'c', 'b'])
  })

  it('filters sessions outside the range before aggregating', () => {
    const now = new Date(2026, 7, 14, 12, 0, 0).getTime()
    const result = aggregateActivityTokens([...TOKEN_SESSIONS], { range: '7d' }, now)
    expect(result.sessions.map(session => session.sessionId)).toEqual(['a', 'b'])
    expect(result.totals.totalTokens).toBe(1030)
    expect(aggregateActivityTokens([...TOKEN_SESSIONS], { range: 'all' }, now).sessions).toHaveLength(3)
  })

  it('yields zero buckets for an empty set', () => {
    const result = aggregateActivityTokens([], {}, 1)
    expect(result.totals.totalTokens).toBe(0)
    expect(result.byDay).toEqual([])
    expect(result.sessions).toEqual([])
  })
})

describe('activity token view model', () => {
  it('caps the session list and projects day rows', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      sessionId: `s-${index}`,
      title: `S${index}`,
      date: '2026-08-14',
      inputTokens: index + 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: index + 1,
    }))
    const result = aggregateActivityTokens(many, {}, 1)
    const view = buildActivityTokenStats(result)
    expect(view.sessions).toHaveLength(8)
    expect(view.sessions[0]!.sessionId).toBe('s-11')
    expect(view.byDay).toHaveLength(1)
    expect(view.byDay[0]).toEqual({ date: '2026-08-14', totalTokens: 78 })
    expect(view.totals.totalTokens).toBe(78)
  })
})

// ---------------------------------------------------------------------------
// mock source
// ---------------------------------------------------------------------------

describe('mock activity data source', () => {
  it('is deterministic for a fixed now', async () => {
    const now = Date.UTC(2026, 7, 14, 12, 0, 0)
    const a = await new MockActivityStatsDataSource({ now }).stats({})
    const b = await new MockActivityStatsDataSource({ now }).stats({})
    expect(a).toEqual(b)
    expect(a.daily).toHaveLength(7)
    expect(a.hourlyHeatmap).toHaveLength(7)
    expect(a.monthly.length).toBeGreaterThan(0)
  })

  it('defaults to Date.now() when now is absent', async () => {
    const source = new MockActivityStatsDataSource()
    const result = await source.stats({})
    expect(result.generatedAt).toBeGreaterThan(0)
  })

  it('injects stable failures for tests/dev', async () => {
    const source = new MockActivityStatsDataSource({ failure: 'GRAY_STORAGE_CORRUPT' })
    await expect(source.stats({})).rejects.toMatchObject({ code: 'GRAY_STORAGE_CORRUPT' })
  })

  it('stays internally consistent (daily sums, sessions, monthly aggregation) (4.1-L3)', async () => {
    const now = Date.UTC(2026, 7, 14, 12, 0, 0)
    const result = await new MockActivityStatsDataSource({ now }).stats({})
    for (const day of result.daily) {
      const hourlyTotal = day.hourly.reduce((sum, minutes) => sum + minutes, 0)
      expect(day.totalMinutes).toBe(hourlyTotal)
      expect(day.sessionCount).toBe(day.sessions.length)
      expect(day.sessions.reduce((sum, session) => sum + session.minutes, 0)).toBe(day.totalMinutes)
    }
    const month = result.monthly[0]!
    const monthDays = result.daily.filter(day => day.date.startsWith(month.month))
    expect(month.totalMinutes).toBe(monthDays.reduce((sum, day) => sum + day.totalMinutes, 0))
    expect(month.activeDays).toBe(monthDays.filter(day => day.totalMinutes > 0).length)
    expect(month.sessionCount).toBe(monthDays.reduce((sum, day) => sum + day.sessionCount, 0))
    // 固定锚点下 7 天全部落在同一个月（任意测试环境时区下均为 2026-08-08..15）
    expect(month.activeDays).toBe(7)
    expect(month.sessionCount).toBe(13)
  })
})

// ---------------------------------------------------------------------------
// remote consumer (contract-driven)
// ---------------------------------------------------------------------------

describe('remote activity data source', () => {
  it('calls the activity/stats endpoint with the built args and returns the narrowed result', async () => {
    const transport = vi.fn<ActivityRemoteTransport>(async () => ({ ok: true, value: FIXTURE }))
    const source = new RemoteActivityStatsDataSource(transport)
    const result = await source.stats({ range: '30d', includeHourly: true, includeMonthly: true })
    expect(result).toEqual(FIXTURE)
    expect(transport).toHaveBeenCalledTimes(1)
    const [endpoint, args] = transport.mock.calls[0]!
    expect(endpoint).toBe('activity/stats')
    expect(args).toEqual({ range: '30d', includeHourly: true, includeMonthly: true })
  })

  it('throws a stable error on a failure envelope (never rejects the transport)', async () => {
    const transport = vi.fn<ActivityRemoteTransport>(async () => ({
      ok: false,
      error: { code: 'GRAY_STORAGE_CORRUPT', message: 'store broken', details: {} },
    }))
    const source = new RemoteActivityStatsDataSource(transport)
    await expect(source.stats({})).rejects.toMatchObject({ code: 'GRAY_STORAGE_CORRUPT' })
  })

  it('throws GRAY_INTERNAL on a malformed result payload', async () => {
    const transport = vi.fn<ActivityRemoteTransport>(async () => ({ ok: true, value: { nope: true } }))
    const source = new RemoteActivityStatsDataSource(transport)
    await expect(source.stats({})).rejects.toMatchObject({ code: 'GRAY_INTERNAL' })
  })

  it('passes the abort signal through to the transport', async () => {
    const transport = vi.fn<ActivityRemoteTransport>(async () => ({ ok: true, value: FIXTURE }))
    const source = new RemoteActivityStatsDataSource(transport)
    const controller = new AbortController()
    await source.stats({}, controller.signal)
    expect(transport.mock.calls[0]![2]).toBe(controller.signal)
  })
})

// ---------------------------------------------------------------------------
// token data source (browser-side session list)
// ---------------------------------------------------------------------------

const SESSION_LIST_ITEMS = [
  {
    sessionId: 'session-a',
    startedAt: new Date(2026, 7, 14, 10, 0, 0).getTime(),
    updatedAt: new Date(2026, 7, 15, 10, 0, 0).getTime(),
    title: 'Alpha',
    projections: { values: { tokenUsage: { uncachedInputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
  },
  { sessionId: 'session-blank', startedAt: 1, title: '' },
]

describe('connection token data source', () => {
  it('calls session.list and aggregates the narrowed rows', async () => {
    const list = vi.fn(async () => ({ result: { ok: true as const, value: { items: SESSION_LIST_ITEMS } } }))
    const source = new ConnectionActivityTokensDataSource({ sessions: { list } })
    const result = await source.tokens({ range: 'all' })
    expect(list).toHaveBeenCalledTimes(1)
    expect(result.sessions).toHaveLength(1)
    // 按会话开始日归集（updatedAt 已前滚到次日，date 仍为开始日）
    expect(result.sessions[0]).toMatchObject({ sessionId: 'session-a', title: 'Alpha', totalTokens: 300, date: '2026-08-14' })
    expect(result.totals.totalTokens).toBe(300)
  })

  it('throws a stable error on a failure result', async () => {
    const source = new ConnectionActivityTokensDataSource({
      sessions: {
        list: async () => ({ result: { ok: false, error: { code: 'session-not-found', message: 'x', details: {} } } }),
      },
    })
    await expect(source.tokens({})).rejects.toMatchObject({ code: 'session-not-found' })
  })

  it('throws GRAY_INTERNAL on a malformed value and on transport throws', async () => {
    const malformed = new ConnectionActivityTokensDataSource({ sessions: { list: async () => ({ result: { ok: true, value: { nope: 1 } } }) } })
    await expect(malformed.tokens({})).rejects.toMatchObject({ code: 'GRAY_INTERNAL' })
    const rejected = new ConnectionActivityTokensDataSource({ sessions: { list: async () => { throw new Error('net down') } } })
    await expect(rejected.tokens({})).rejects.toMatchObject({ code: 'GRAY_INTERNAL' })
  })

  it('pages through session.list with the cursor until no nextCursor remains (3.1-M2)', async () => {
    const list = vi.fn(async (payload: { readonly cursor?: string }) => ({
      result: {
        ok: true as const,
        value: payload.cursor === undefined
          ? { items: [SESSION_LIST_ITEMS[0]], nextCursor: 'page-2' }
          : { items: [SESSION_LIST_ITEMS[1]], total: 2 },
      },
    }))
    const source = new ConnectionActivityTokensDataSource({ sessions: { list } })
    const result = await source.tokens({ range: 'all' })
    expect(list).toHaveBeenCalledTimes(2)
    expect(list.mock.calls[0]![0]).toEqual({})
    expect(list.mock.calls[1]![0]).toEqual({ cursor: 'page-2' })
    // 两页都已拉取；第二页的空白会话（无 token 投影）被丢弃
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({ sessionId: 'session-a', totalTokens: 300 })
  })

  it('guards against a repeating cursor with a hard page cap (3.1-M2)', async () => {
    const list = vi.fn(async () => ({
      result: { ok: true as const, value: { items: [SESSION_LIST_ITEMS[0]], nextCursor: 'loop' } },
    }))
    const source = new ConnectionActivityTokensDataSource({ sessions: { list } })
    await expect(source.tokens({})).rejects.toMatchObject({ code: 'GRAY_INTERNAL' })
  })
})

// ---------------------------------------------------------------------------
// locale alignment
// ---------------------------------------------------------------------------

describe('graycode.activityHeatmap locale dictionaries', () => {
  it('declares its own namespace', () => {
    expect(GRAYCODE_ACTIVITY_HEATMAP_NS).toBe('graycode.activityHeatmap')
  })

  it('keeps zh/en dictionaries balanced (identical key sets)', () => {
    const en = Object.keys(graycodeActivityHeatmapDictionaries.en).sort()
    const zh = Object.keys(graycodeActivityHeatmapDictionaries.zh).sort()
    expect(zh).toEqual(en)
  })

  it('keeps the ja placeholder on the same key set', () => {
    expect(Object.keys(graycodeActivityHeatmapJaPlaceholder).sort()).toEqual(
      Object.keys(graycodeActivityHeatmapDictionaries.en).sort(),
    )
  })

  it('fills every shipped locale with non-empty text', () => {
    for (const dict of Object.values(graycodeActivityHeatmapDictionaries)) {
      for (const text of Object.values(dict)) {
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })

  it('covers every range and error key used by the logic', () => {
    const en = graycodeActivityHeatmapDictionaries.en
    for (const range of ACTIVITY_RANGES) {
      expect(en[`range.${range}`], range).toBeDefined()
    }
    for (const code of ['invalidInput', 'conflict', 'approvalRequired', 'cancelled', 'storageCorrupt', 'notFound', 'endpointNotFound', 'internal', 'unknown']) {
      expect((en as Record<string, string>)[`error.${code}`], code).toBeDefined()
    }
  })
})
