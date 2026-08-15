/**
 * GrayCode - 使用时间统计聚合（DSH 版）
 *
 * 从原始活动事件时间戳聚合出：
 * - 每日使用时长（分钟）与活跃会话明细
 * - 24 小时作息热力（每格 = 该小时活跃分钟数）
 * - 当前连续工作时长（进行中的会话）
 * - 月度聚合
 *
 * 纯函数逻辑与 DSH 宿主解耦（不 import ctx / fs），便于单元测试。
 * 「60s 心跳」为惰性回算：存储原始事件时间戳，查询时按会话跨度折算分钟，
 * 不常驻任何定时器。
 */

import type {
  ActivitySession,
  ActivityStatsQuery,
  ActivityStatsResult,
  CurrentSessionInfo,
  DayActivityFile,
  DayActivityStats,
  MonthlyActivityStats,
  ActivityRange,
} from './types.ts'
import { ACTIVITY_HEARTBEAT_MS, ACTIVITY_SESSION_GAP_MS } from './types.ts'
import { toDateStr } from './store.ts'

/**
 * 把升序采样点合并为连续会话：
 * 相邻采样间隔 > gapMs 视为两个独立会话。
 * 会话时长 = (最后一个采样 - 第一个采样) 向上取整到采样间隔（默认 1 分钟），至少 1 分钟。
 */
export function buildSessions(
  samples: number[],
  gapMs: number = ACTIVITY_SESSION_GAP_MS,
  minuteMs: number = ACTIVITY_HEARTBEAT_MS,
): ActivitySession[] {
  const sessions: ActivitySession[] = []
  if (samples.length === 0) return sessions

  let start = samples[0]!
  let prev = samples[0]!

  for (let i = 1; i < samples.length; i++) {
    const t = samples[i]!
    if (t - prev > gapMs) {
      sessions.push(makeSession(start, prev, minuteMs))
      start = t
    }
    prev = t
  }
  sessions.push(makeSession(start, prev, minuteMs))
  return sessions
}

function makeSession(start: number, end: number, minuteMs: number): ActivitySession {
  const minutes = Math.max(1, Math.ceil((end - start) / minuteMs))
  return { start, end, minutes }
}

/**
 * 把会话展开为 24 格小时热力（本地时区）：
 * 会话覆盖的每一分钟，对应小时格 +1。
 */
export function hourlyHeatmap(sessions: ActivitySession[]): number[] {
  const hours = new Array<number>(24).fill(0)
  for (const session of sessions) {
    // buildSessions 已把持续时间量化为整数分钟。热力图必须精确分配同样数量
    // 的分钟；若重新按 start/end 所在的墙钟分钟取整，任意秒偏移（例如
    // 12:00:30 → 12:01:30）会错误覆盖两个格子而 daily 只有 1 分钟。
    let m = Math.floor(session.start / 60_000) * 60_000
    let remaining = session.minutes
    while (remaining > 0) {
      // 使用本地时区的下一小时边界，并按块累计，保持 O(小时数)。
      const nextHour = new Date(m)
      nextHour.setMinutes(60, 0, 0)
      const capacity = Math.max(1, Math.round((nextHour.getTime() - m) / 60_000))
      const minutes = Math.min(remaining, capacity)
      const h = new Date(m).getHours()
      hours[h] = (hours[h] ?? 0) + minutes
      remaining -= minutes
      m += minutes * 60_000
    }
  }
  return hours
}

/** 单日统计（samples 应为该日升序采样；includeHourly=false 时惰性跳过热力计算） */
export function dayStats(
  date: string,
  samples: number[],
  includeHourly: boolean = true,
  minuteMs: number = ACTIVITY_HEARTBEAT_MS,
): DayActivityStats {
  return dayStatsFromSessions(date, samples, buildSessions(samples, ACTIVITY_SESSION_GAP_MS, minuteMs), includeHourly)
}

/** dayStats 内部实现：复用已算好的 sessions，避免同一批采样重复 buildSessions */
function dayStatsFromSessions(
  date: string,
  samples: number[],
  sessions: ActivitySession[],
  includeHourly: boolean,
): DayActivityStats {
  return {
    date,
    totalMinutes: sessions.reduce((sum, s) => sum + s.minutes, 0),
    sessionCount: sessions.length,
    sessions,
    firstActiveAt: samples.length > 0 ? samples[0]! : null,
    lastActiveAt: samples.length > 0 ? samples[samples.length - 1]! : null,
    hourly: includeHourly ? hourlyHeatmap(sessions) : [],
  }
}

/**
 * 当前连续工作会话：
 * 取最近一天（含今天）的采样，若距最后采样不超过 gapMs 且最后采样在
 * 近 2 倍 gap 内（防止读旧数据误判为「正在工作」），则视为进行中。
 */
export function currentSessionInfo(
  recentSamples: number[],
  now: number = Date.now(),
  gapMs: number = ACTIVITY_SESSION_GAP_MS,
  minuteMs: number = ACTIVITY_HEARTBEAT_MS,
): CurrentSessionInfo {
  if (recentSamples.length === 0) {
    return { active: false, startedAt: null, minutes: 0 }
  }

  const last = recentSamples[recentSamples.length - 1]!
  // 最后采样距今超过 gapMs：会话已结束
  if (now - last > gapMs) {
    return { active: false, startedAt: null, minutes: 0 }
  }

  // 从最后采样向前合并同一会话的起点
  let sessionStart = last
  for (let i = recentSamples.length - 2; i >= 0; i--) {
    const t = recentSamples[i]!
    if (sessionStart - t <= gapMs) {
      sessionStart = t
    } else {
      break
    }
  }

  return {
    active: true,
    startedAt: sessionStart,
    minutes: Math.max(1, Math.ceil((now - sessionStart) / minuteMs)),
  }
}

/** 把每日统计按 YYYY-MM 聚合为月度统计（输入顺序不限，输出按月份倒序） */
export function aggregateMonthly(daily: DayActivityStats[]): MonthlyActivityStats[] {
  const byMonth = new Map<string, MonthlyActivityStats>()
  for (const d of daily) {
    const month = d.date.slice(0, 7) // YYYY-MM
    let entry = byMonth.get(month)
    if (!entry) {
      entry = { month, totalMinutes: 0, activeDays: 0, sessionCount: 0 }
      byMonth.set(month, entry)
    }
    if (d.totalMinutes > 0) {
      entry.totalMinutes += d.totalMinutes
      entry.activeDays++
    }
    entry.sessionCount += d.sessionCount
  }
  return [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month))
}

/** 解析查询范围 → 需要加载的天数（'all' 返回 Infinity） */
export function rangeToDays(range: ActivityRange): number {
  switch (range) {
    case 'today': return 1
    case '30d': return 30
    case '90d': return 90
    case '365d': return 365
    case 'all': return Infinity
    case '7d':
    default: return 7
  }
}

/**
 * 汇总统计结果（惰性聚合：按原始事件时间戳回算，无常驻定时器）。
 *
 * @param files 已按查询范围加载的按天文件（由 store 层负责范围切片）
 * @param query 查询参数
 * @param now   当前时间（测试注入）
 * @param minuteMs 采样间隔/分钟粒度（默认 60s）
 * @param currentSessionSamples 仅用于 currentSession 的采样集（4.15-L1：range='today'
 *   时服务层多加载昨天一天注入，跨午夜归集会话起点；daily/today/hourly/monthly 不受影响）
 */
export function aggregateActivity(
  files: DayActivityFile[],
  query: ActivityStatsQuery = {},
  now: number = Date.now(),
  minuteMs: number = ACTIVITY_HEARTBEAT_MS,
  currentSessionSamples?: number[],
): ActivityStatsResult {
  const recent = [...files].sort((a, b) => a.date.localeCompare(b.date))

  // 当前连续会话判断：默认取最近 2 天采样拼接（跨午夜不中断）。4.15-L1：range='today'
  // 时服务层额外加载昨天一天并注入 currentSessionSamples——daily/today 按日历日只报
  // 今天，而 currentSession 需归集跨午夜起点（昨晚开始、今晨继续的会话）。
  const recentAll = currentSessionSamples ?? recent.slice(-2).flatMap((day) => day.samples)

  const includeHourly = query.includeHourly === true
  const daily: DayActivityStats[] = []
  const hourlyRows: Array<{ date: string; hours: number[] }> = []
  // 每天的 sessions 只算一次：daily 统计与 hourlyHeatmap 复用（避免同一批采样重复 buildSessions）
  for (const day of recent) {
    const sessions = buildSessions(day.samples, ACTIVITY_SESSION_GAP_MS, minuteMs)
    // daily 统计自身不需要热力（hourlyHeatmap 单独按需计算），惰性跳过
    daily.push(dayStatsFromSessions(day.date, day.samples, sessions, false))
    if (includeHourly) {
      hourlyRows.push({ date: day.date, hours: hourlyHeatmap(sessions) })
    }
  }
  // 倒序：最新在前
  daily.reverse()

  // today 语义：今日无活跃会话时返回 null（与类型注释一致），
  // 而非全零对象——前端据此区分「今天没数据」与「今天活跃 0 分钟」。
  // 「今日」取注入的 now（本地时区），而非文件里的最后一天：纯函数必须
  // 自包含——store 层保证范围切片含今天，但聚合本身不依赖该约定。
  const todayStr = toDateStr(now)
  const todayEntry = todayStr ? daily.find((d) => d.date === todayStr) ?? null : null
  const today = todayEntry && todayEntry.sessions.length > 0 ? todayEntry : null

  const monthly = query.includeMonthly === true ? aggregateMonthly(daily) : []

  return {
    generatedAt: now,
    today,
    currentSession: currentSessionInfo(recentAll, now, ACTIVITY_SESSION_GAP_MS, minuteMs),
    daily,
    hourlyHeatmap: hourlyRows,
    monthly,
  }
}
