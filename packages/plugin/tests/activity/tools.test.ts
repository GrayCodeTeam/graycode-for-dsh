/**
 * get_activity_stats 工具测试：参数校验（range 枚举 / 布尔类型 → 稳定错误码）、
 * range 语义（默认 7d / today / all）、includeHourly / includeMonthly、exec.signal
 * 中止、输出结构（与老版对齐）。经 service 闭包走真实临时数据根。
 *
 * 注意：工具内部以真实 Date.now() 为基准，采样种子用「距今天数」构造，
 * 保证与真实当前时间在同一时区语义下落在期望的范围内。
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { describe, expect, test } from 'vitest'
import type { JsonValue, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createActivityTools, parseStatsQueryArgs } from '../../src/activity/tools.ts'
import { ActivityService } from '../../src/activity/service.ts'
import { toDateStr } from '../../src/activity/domain/store.ts'
import { ActivityError, ActivityErrorCode, ACTIVITY_RANGES } from '../../src/activity/domain/types.ts'

/** 距今天数（本地时区，固定 10:00 或指定时刻）的毫秒时间戳 */
function daysAgo(days: number, h = 10, mi = 0): number {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(h, mi, 0, 0)
  return d.getTime()
}

/** 今天 00:01（本地）：始终属于今天且几乎总在过去 */
function todayEarly(): number {
  const d = new Date()
  d.setHours(0, 1, 0, 0)
  return d.getTime()
}

interface StatsToolResult {
  text: string
  generatedAt: number
  today: { date: string; totalMinutes: number; sessionCount: number } | null
  currentSession: { active: boolean; startedAt: number | null; minutes: number }
  daily: Array<{ date: string; totalMinutes: number; sessionCount: number }>
  hourlyHeatmap: Array<{ date: string; hours: number[] }>
  monthly: Array<{ month: string; totalMinutes: number; activeDays: number; sessionCount: number }>
}

function makeTools(): { tool: ToolDefinition; service: ActivityService; dataRoot: string } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-act-tools-'))
  const service = new ActivityService({ dataRoot })
  const tool = createActivityTools(service)[0]!
  return { tool, service, dataRoot }
}

function fakeExec(aborted = false): ToolRunContext {
  const controller = new AbortController()
  if (aborted) controller.abort()
  return { signal: controller.signal, agent: { session: { header: {} } } } as unknown as ToolRunContext
}

describe('get_activity_stats 参数校验', () => {
  test('非法 range 被 schema 层拒绝（ToolArgsError，含违规路径）', async () => {
    const { tool, dataRoot } = makeTools()
    try {
      const error = (await tool.execute({ range: 'foo' }, fakeExec()).catch(e => e)) as Error
      expect(error).not.toBeInstanceOf(ActivityError)
      expect(error.message).toContain('range')
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('includeHourly / includeMonthly 非布尔被 schema 层拒绝', async () => {
    const { tool, dataRoot } = makeTools()
    try {
      for (const args of [{ includeHourly: 'yes' }, { includeMonthly: 1 }, { includeHourly: 0 }]) {
        const error = (await tool.execute(args as never, fakeExec()).catch(e => e)) as Error
        expect(error.message).toContain('invalid arguments')
      }
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('parseStatsQueryArgs（body 层防御校验）：非法参数抛稳定错误码 GRAY_ACTIVITY_INVALID_INPUT', () => {
    const invalid = [{ range: 'foo' }, { includeHourly: 'yes' }, { includeMonthly: 1 }, { range: 7 }]
    for (const args of invalid) {
      let caught: unknown
      try {
        parseStatsQueryArgs(args)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(ActivityError)
      expect((caught as ActivityError).code).toBe(ActivityErrorCode.INVALID_INPUT)
    }
  })

  test('parseStatsQueryArgs 合法参数透传并给出默认值', () => {
    expect(parseStatsQueryArgs({})).toEqual({})
    expect(parseStatsQueryArgs({ range: 'all', includeHourly: true })).toEqual({ range: 'all', includeHourly: true })
    expect(parseStatsQueryArgs({ range: 'today', includeMonthly: false })).toEqual({ range: 'today', includeMonthly: false })
    expect(ACTIVITY_RANGES).toContain('365d')
  })

  test('合法枚举与布尔参数不报错', async () => {
    const { tool, dataRoot } = makeTools()
    try {
      const result = (await tool.execute(
        { range: 'today', includeHourly: true, includeMonthly: false },
        fakeExec(),
      )) as StatsToolResult
      expect(result.daily).toBeDefined()
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})

describe('get_activity_stats range 语义', () => {
  test('默认 range=7d：范围含最近 7 天（含空天）；today 无数据为 null；currentSession inactive', async () => {
    const { tool, service, dataRoot } = makeTools()
    try {
      await service.markActive(daysAgo(10)) // 10 天前：超出 7d
      await service.markActive(daysAgo(2)) // 2 天前：在范围内
      const result = (await tool.execute({}, fakeExec())) as StatsToolResult
      expect(result.daily).toHaveLength(7)
      expect(result.daily.map(d => d.date)).toContain(toDateStr(daysAgo(2)))
      expect(result.daily.map(d => d.date)).not.toContain(toDateStr(daysAgo(10)))
      const d2 = result.daily.find(d => d.date === toDateStr(daysAgo(2)))!
      expect(d2.totalMinutes).toBe(1)
      expect(result.today).toBeNull()
      expect(result.currentSession.active).toBe(false)
      expect(result.text).toContain('Today: no activity recorded yet')
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('range=today：只返回今日统计，today 非空，currentSession active', async () => {
    const { tool, service, dataRoot } = makeTools()
    try {
      await service.markActive(daysAgo(2))
      await service.markActive(todayEarly())
      await service.markActive(Date.now() - 30_000) // 30 秒前：保证进行中会话
      const result = (await tool.execute({ range: 'today' }, fakeExec())) as StatsToolResult
      expect(result.daily).toHaveLength(1)
      expect(result.today).not.toBeNull()
      // 今日采样：todayEarly（00:01）+ 30 秒前（可能落在昨天或与 00:01 去重）——至少 1 分钟
      expect(result.today!.totalMinutes).toBeGreaterThanOrEqual(1)
      expect(result.today!.sessionCount).toBeGreaterThanOrEqual(1)
      expect(result.currentSession.active).toBe(true)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('range=all：包含 7d 之外的旧采样', async () => {
    const { tool, service, dataRoot } = makeTools()
    try {
      await service.markActive(daysAgo(10))
      await service.markActive(daysAgo(2))
      const result = (await tool.execute({ range: 'all' }, fakeExec())) as StatsToolResult
      expect(result.daily.map(d => d.date)).toContain(toDateStr(daysAgo(10)))
      expect(result.daily.map(d => d.date)).toContain(toDateStr(daysAgo(2)))
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})

describe('get_activity_stats 输出结构', () => {
  test('includeHourly 返回 24 槽热力；includeMonthly 返回月度聚合（倒序）', async () => {
    const { tool, service, dataRoot } = makeTools()
    try {
      await service.markActive(todayEarly())
      await service.markActive(daysAgo(40))
      const result = (await tool.execute(
        { range: 'all', includeHourly: true, includeMonthly: true },
        fakeExec(),
      )) as StatsToolResult
      // hourly：范围内每天一行，24 槽
      expect(result.hourlyHeatmap.length).toBeGreaterThanOrEqual(2)
      for (const row of result.hourlyHeatmap) {
        expect(row.hours).toHaveLength(24)
      }
      // monthly：倒序，总分钟数 = daily 之和
      expect(result.monthly.length).toBeGreaterThanOrEqual(2)
      for (let i = 1; i < result.monthly.length; i++) {
        expect(result.monthly[i - 1]!.month >= result.monthly[i]!.month).toBe(true)
      }
      const dailySum = result.daily.reduce((sum, d) => sum + d.totalMinutes, 0)
      const monthlySum = result.monthly.reduce((sum, m) => sum + m.totalMinutes, 0)
      expect(monthlySum).toBe(dailySum)
      expect(result.text).toContain('Monthly')
      expect(result.text).toContain('Hourly heatmap')
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('exec.signal 已中止 → 工具拒绝执行', async () => {
    const { tool, dataRoot } = makeTools()
    try {
      const error = (await tool.execute({}, fakeExec(true)).catch(e => e)) as Error
      expect(error.message).toContain('aborted')
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('render 投影为 text 块', async () => {
    const { tool, service, dataRoot } = makeTools()
    try {
      await service.markActive(todayEarly())
      const result = (await tool.execute({ range: 'today' }, fakeExec())) as StatsToolResult
      const content = tool.output.render({}, result as unknown as JsonValue)
      expect(content[0]!.type).toBe('text')
      expect((content[0] as { text: string }).text).toContain('Activity stats')
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})
