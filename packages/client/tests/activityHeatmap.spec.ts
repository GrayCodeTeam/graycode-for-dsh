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
  readActivitySession,
  readActivityStatsResult,
  readActivityThrownError,
  readCurrentSessionInfo,
  readDayActivityStats,
  readHourlyHeatmapRow,
  readMonthlyActivityStats,
} from '../src/client/activityHeatmap/wire.ts'
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
  type ActivityHeatmapRowView,
} from '../src/client/activityHeatmap/viewModel.ts'
import {
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
    expect(buildActivityStatsRequest({ range: 'bogus' })).toEqual({ range: '7d' })
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
      totalMinutes: 165,
      activeDays: 2,
      sessionCount: 3,
      todayMinutes: 120,
      currentActive: true,
      currentMinutes: 42,
    })
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
      expect(en[`error.${code}`], code).toBeDefined()
    }
  })
})
