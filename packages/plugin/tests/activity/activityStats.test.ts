/**
 * activity 域纯函数聚合测试：会话构建、分钟折算、24h 热力、当前连续会话、
 * 月度聚合、aggregateActivity 整体汇总。
 * 全部使用本地时区确定时间（new Date(y, m, d, ...) 构造）。
 */
import { describe, expect, test } from 'vitest'
import {
  aggregateActivity,
  aggregateMonthly,
  buildSessions,
  currentSessionInfo,
  dayStats,
  hourlyHeatmap,
  rangeToDays,
} from '../../src/activity/domain/activityStats.ts'
import { toDateStr } from '../../src/activity/domain/store.ts'
import type { DayActivityFile, DayActivityStats } from '../../src/activity/domain/types.ts'

/** 本地时区确定时间（月从 1 开始） */
function at(y: number, mo: number, d: number, h: number, mi: number, s = 0): number {
  return new Date(y, mo - 1, d, h, mi, s, 0).getTime()
}

function file(date: string, samples: number[]): DayActivityFile {
  return { date, samples }
}

function dayStatsOf(date: string, samples: number[]): DayActivityStats {
  return dayStats(date, samples, false)
}

describe('buildSessions', () => {
  test('空采样 → 无会话', () => {
    expect(buildSessions([])).toEqual([])
  })

  test('单采样 → 1 个会话，至少 1 分钟', () => {
    const t = at(2026, 6, 1, 10, 0, 0)
    expect(buildSessions([t])).toEqual([{ start: t, end: t, minutes: 1 }])
  })

  test('间隔不超过 gap 合并为一个会话，时长向上取整到分钟', () => {
    const t0 = at(2026, 6, 1, 10, 0, 0)
    const t1 = t0 + 90_000 // 10:01:30
    const sessions = buildSessions([t0, t1])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toEqual({ start: t0, end: t1, minutes: 2 })
  })

  test('间隔超过 gap（15 分钟）拆分为两个会话', () => {
    const t0 = at(2026, 6, 1, 10, 0, 0)
    const t1 = t0 + 20 * 60_000 // 10:20
    const sessions = buildSessions([t0, t1])
    expect(sessions).toHaveLength(2)
    expect(sessions[0]!.minutes).toBe(1)
    expect(sessions[1]!.minutes).toBe(1)
  })
})

describe('hourlyHeatmap', () => {
  test('单采样落在本地时区对应小时格', () => {
    const t = at(2026, 6, 1, 14, 30, 0)
    const hours = hourlyHeatmap(buildSessions([t]))
    expect(hours).toHaveLength(24)
    expect(hours[14]).toBe(1)
    expect(hours.reduce((a, b) => a + b, 0)).toBe(1)
  })

  test('跨小时边界的会话按本地小时拆分', () => {
    const start = at(2026, 6, 1, 14, 55, 0)
    const end = start + 10 * 60_000 // 15:05（间隔 10 分钟 ≤ gap，同一会话）
    const hours = hourlyHeatmap(buildSessions([start, end]))
    expect(hours[14]).toBe(5) // 14:55-14:59
    expect(hours[15]).toBe(5) // 15:00-15:04
  })

  test('跨午夜会话按本地小时边界拆分', () => {
    const start = at(2026, 6, 1, 23, 55, 0)
    const end = start + 10 * 60_000 // 次日 00:05（间隔 10 分钟 ≤ gap，同一会话）
    const hours = hourlyHeatmap(buildSessions([start, end]))
    expect(hours[23]).toBe(5)
    expect(hours[0]).toBe(5)
  })

  test('任意秒偏移时热力分钟总和与 session.minutes 完全一致', () => {
    const start = at(2026, 6, 1, 12, 0, 30)
    const end = at(2026, 6, 1, 12, 1, 30)
    const sessions = buildSessions([start, end])
    const hours = hourlyHeatmap(sessions)

    expect(sessions[0]!.minutes).toBe(1)
    expect(hours[12]).toBe(1)
    expect(hours.reduce((sum, value) => sum + value, 0)).toBe(
      sessions.reduce((sum, session) => sum + session.minutes, 0),
    )
  })
})

describe('dayStats', () => {
  test('基本统计：totalMinutes / sessionCount / first / last；includeHourly=false 惰性跳过热力', () => {
    const t0 = at(2026, 6, 1, 9, 0, 0)
    const t1 = t0 + 5 * 60_000
    const t2 = at(2026, 6, 1, 14, 0, 0) // 与 t1 间隔 > 15 分钟 → 独立会话
    const stats = dayStatsOf('2026-06-01', [t0, t1, t2])
    expect(stats.totalMinutes).toBe(6) // 5 + 1
    expect(stats.sessionCount).toBe(2)
    expect(stats.firstActiveAt).toBe(t0)
    expect(stats.lastActiveAt).toBe(t2)
    expect(stats.hourly).toEqual([])
  })

  test('includeHourly=true 时返回 24 槽热力', () => {
    const t = at(2026, 6, 1, 9, 30, 0)
    const stats = dayStats('2026-06-01', [t], true)
    expect(stats.hourly).toHaveLength(24)
    expect(stats.hourly[9]).toBe(1)
  })
})

describe('currentSessionInfo', () => {
  const now = at(2026, 6, 1, 12, 0, 0)

  test('无采样 → inactive', () => {
    expect(currentSessionInfo([], now)).toEqual({ active: false, startedAt: null, minutes: 0 })
  })

  test('最后采样在 gap 内 → active，起点合并到会话开始', () => {
    const start = at(2026, 6, 1, 11, 45, 0)
    const last = at(2026, 6, 1, 11, 50, 0) // 与 start 间隔 5 分钟 ≤ gap，同一会话；距 now 10 分钟
    const info = currentSessionInfo([start, last], now)
    expect(info.active).toBe(true)
    expect(info.startedAt).toBe(start)
    expect(info.minutes).toBe(15) // ceil((12:00-11:45)/60s)
  })

  test('最后采样超过 gap → inactive', () => {
    const last = at(2026, 6, 1, 11, 40, 0) // 距 now 20 分钟 > 15
    const info = currentSessionInfo([last], now)
    expect(info.active).toBe(false)
    expect(info.startedAt).toBeNull()
    expect(info.minutes).toBe(0)
  })
})

describe('aggregateMonthly', () => {
  test('按 YYYY-MM 聚合，activeDays 只计有活跃的天，输出按月份倒序', () => {
    const daily = [
      dayStatsOf('2026-05-31', [at(2026, 5, 31, 10, 0, 0)]), // 1 min
      dayStatsOf('2026-06-01', [at(2026, 6, 1, 10, 0, 0), at(2026, 6, 1, 10, 2, 0)]), // 2 min
      dayStatsOf('2026-06-02', []), // 0 min：不计 activeDays
    ]
    expect(aggregateMonthly(daily)).toEqual([
      { month: '2026-06', totalMinutes: 2, activeDays: 1, sessionCount: 1 },
      { month: '2026-05', totalMinutes: 1, activeDays: 1, sessionCount: 1 },
    ])
  })
})

describe('rangeToDays', () => {
  test('today→1, 7d→7, 30d→30, 90d→90, 365d→365, all→Infinity', () => {
    expect(rangeToDays('today')).toBe(1)
    expect(rangeToDays('7d')).toBe(7)
    expect(rangeToDays('30d')).toBe(30)
    expect(rangeToDays('90d')).toBe(90)
    expect(rangeToDays('365d')).toBe(365)
    expect(rangeToDays('all')).toBe(Infinity)
  })
})

describe('aggregateActivity', () => {
  const now = at(2026, 6, 11, 12, 0, 0)

  test('daily 倒序（最新在前）；today 无采样时为 null', () => {
    const t1 = at(2026, 6, 9, 10, 0, 0)
    const t2 = at(2026, 6, 10, 11, 0, 0)
    const result = aggregateActivity([file('2026-06-09', [t1]), file('2026-06-10', [t2])], {}, now)
    expect(result.daily.map(d => d.date)).toEqual(['2026-06-10', '2026-06-09'])
    expect(result.today).toBeNull()
    expect(result.currentSession.active).toBe(false)
    expect(result.hourlyHeatmap).toEqual([])
    expect(result.monthly).toEqual([])
  })

  test('今日有采样 → today 非空', () => {
    const t = at(2026, 6, 11, 10, 0, 0)
    const result = aggregateActivity([file('2026-06-11', [t])], {}, now)
    expect(result.today).not.toBeNull()
    expect(result.today!.date).toBe('2026-06-11')
    expect(result.today!.totalMinutes).toBe(1)
  })

  test('currentSession 基于最近两天采样跨午夜合并', () => {
    const yesterdayLate = at(2026, 6, 10, 23, 50, 0)
    const todayEarly = at(2026, 6, 11, 0, 5, 0)
    const result = aggregateActivity(
      [file('2026-06-10', [yesterdayLate]), file('2026-06-11', [todayEarly])],
      {},
      at(2026, 6, 11, 0, 10, 0),
    )
    expect(result.currentSession.active).toBe(true)
    expect(result.currentSession.startedAt).toBe(yesterdayLate)
    expect(result.currentSession.minutes).toBe(20) // ceil((00:10 - 23:50)/60s)
  })

  test('includeHourly 返回按天升序的 24 槽热力；includeMonthly 返回月度聚合', () => {
    const t = at(2026, 6, 10, 14, 0, 0)
    const result = aggregateActivity([file('2026-06-10', [t])], { includeHourly: true, includeMonthly: true }, now)
    expect(result.hourlyHeatmap).toHaveLength(1)
    expect(result.hourlyHeatmap[0]!.date).toBe('2026-06-10')
    expect(result.hourlyHeatmap[0]!.hours).toHaveLength(24)
    expect(result.hourlyHeatmap[0]!.hours[14]).toBe(1)
    expect(result.monthly).toEqual([{ month: '2026-06', totalMinutes: 1, activeDays: 1, sessionCount: 1 }])
  })

  test('generateAt 等于注入的 now', () => {
    const result = aggregateActivity([file('2026-06-10', [at(2026, 6, 10, 10, 0, 0)])], {}, now)
    expect(result.generatedAt).toBe(now)
  })
})

describe('toDateStr（store 导出，供聚合测试确定日期）', () => {
  test('本地时区 YYYY-MM-DD', () => {
    expect(toDateStr(new Date(2026, 0, 5, 23, 59, 59).getTime())).toBe('2026-01-05')
  })
})
