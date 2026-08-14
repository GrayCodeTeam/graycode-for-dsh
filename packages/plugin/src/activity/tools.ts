/**
 * GrayCode - activity 工具（DSH defineTool 表面）
 *
 * get_activity_stats：查询「人在 IDE 前」活跃时间统计（老 Gray Code 的 activity
 * 模块在 DSH 上的适配）。DSH 无窗口聚焦概念，活跃采样改为 DSH 事件
 * （真实用户消息 + agent 步骤），只存时间戳、不含任何用户内容。
 *
 * 参数与老版一致：range（today/7d/30d/90d/365d/all，默认 7d）、includeHourly、
 * includeMonthly。返回结构与老版对齐：daily 分钟数/会话数、当前连续会话、
 * hourly 热力（24 槽）、monthly 聚合。
 *
 * 错误返回稳定机器码（ActivityErrorCode），模型/前端不解析错误文案。
 */

import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ActivityService } from './service.ts'
import {
  ACTIVITY_RANGES,
  ActivityError,
  ActivityErrorCode,
  type ActivityRange,
  type ActivityStatsQuery,
  type ActivityStatsResult,
} from './domain/types.ts'

/** 渲染规范的 text 字段（模型可见文案） */
function renderText(value: { text: string }): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: value.text }]
}

/**
 * 丢弃值为 undefined 的键。
 *
 * 工具输出跨 dsh-tools 边界为无损 JSON：值为 undefined 的键会失败快照
 * （walkJsonValue 返回 undefined，报 "value is not lossless JSON"），
 * 因此可选字段必须省略而非携带 undefined。
 */
function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) out[key] = v
  }
  return out as T
}

/**
 * 工具参数校验：range 枚举 / 布尔参数类型。
 * dsh-tools 的 schema 校验之外再显式校验一次（防御模型直传非法值），
 * 非法参数抛稳定错误码 ActivityErrorCode.INVALID_INPUT。
 */
export function parseStatsQueryArgs(args: unknown): ActivityStatsQuery {
  const raw = (args ?? {}) as Record<string, unknown>
  const query: ActivityStatsQuery = {}
  if (raw.range !== undefined) {
    if (typeof raw.range !== 'string' || !(ACTIVITY_RANGES as readonly string[]).includes(raw.range)) {
      throw new ActivityError(
        `invalid range ${JSON.stringify(raw.range)}: expected one of ${ACTIVITY_RANGES.join(', ')}`,
        ActivityErrorCode.INVALID_INPUT,
      )
    }
    query.range = raw.range as ActivityRange
  }
  if (raw.includeHourly !== undefined) {
    if (typeof raw.includeHourly !== 'boolean') {
      throw new ActivityError(
        `invalid includeHourly ${JSON.stringify(raw.includeHourly)}: expected boolean`,
        ActivityErrorCode.INVALID_INPUT,
      )
    }
    query.includeHourly = raw.includeHourly
  }
  if (raw.includeMonthly !== undefined) {
    if (typeof raw.includeMonthly !== 'boolean') {
      throw new ActivityError(
        `invalid includeMonthly ${JSON.stringify(raw.includeMonthly)}: expected boolean`,
        ActivityErrorCode.INVALID_INPUT,
      )
    }
    query.includeMonthly = raw.includeMonthly
  }
  return query
}

// ─── 输出文本渲染 ───────────────────────────────

function two(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地时区 HH:MM */
function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

/** 本地时区 YYYY-MM-DD HH:MM:SS */
function formatDateTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** 渲染统计结果为模型可读文本 */
export function formatStats(result: ActivityStatsResult): string {
  const lines: string[] = []
  lines.push(`Activity stats (generated ${formatDateTime(result.generatedAt)})`)

  const today = result.today
  lines.push(today
    ? `Today (${today.date}): ${today.totalMinutes} min, ${today.sessionCount} session${today.sessionCount === 1 ? '' : 's'}`
    : 'Today: no activity recorded yet')

  const cs = result.currentSession
  lines.push(cs.active
    ? `Current session: ${cs.minutes} min (started ${cs.startedAt !== null ? formatTime(cs.startedAt) : '?'})`
    : 'Current session: inactive')

  const activeDays = result.daily.filter(d => d.totalMinutes > 0).length
  lines.push(`Active days in range: ${activeDays}`)

  if (result.daily.length > 0) {
    lines.push('Daily (newest first):')
    for (const d of result.daily) {
      const range = d.firstActiveAt !== null && d.lastActiveAt !== null
        ? ` (${formatTime(d.firstActiveAt)} - ${formatTime(d.lastActiveAt)})`
        : ''
      lines.push(`  ${d.date}  ${d.totalMinutes} min  ${d.sessionCount} session${d.sessionCount === 1 ? '' : 's'}${range}`)
    }
  }

  if (result.monthly.length > 0) {
    lines.push('Monthly (newest first):')
    for (const m of result.monthly) {
      lines.push(`  ${m.month}  ${m.totalMinutes} min  ${m.activeDays} active days  ${m.sessionCount} sessions`)
    }
  }

  if (result.hourlyHeatmap.length > 0) {
    lines.push('Hourly heatmap (local time, hours 0-23):')
    for (const row of result.hourlyHeatmap) {
      lines.push(`  ${row.date}  ${row.hours.join(' ')}`)
    }
  }
  return lines.join('\n')
}

// ─── 输出 schema ────────────────────────────────

const sessionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    start: { type: 'integer', required: true },
    end: { type: 'integer', required: true },
    minutes: { type: 'integer', required: true },
  },
} as const

const nullableIntegerSchema = { oneOf: [{ type: 'integer' }, { type: 'null' }] } as const

const dayStatsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    date: { type: 'string', required: true },
    totalMinutes: { type: 'integer', required: true },
    sessionCount: { type: 'integer', required: true },
    sessions: { type: 'array', items: sessionSchema, required: true },
    firstActiveAt: nullableIntegerSchema,
    lastActiveAt: nullableIntegerSchema,
    hourly: { type: 'array', items: { type: 'integer' }, required: true },
  },
} as const

const currentSessionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    active: { type: 'boolean', required: true },
    startedAt: nullableIntegerSchema,
    minutes: { type: 'integer', required: true },
  },
} as const

const hourlyRowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    date: { type: 'string', required: true },
    hours: { type: 'array', items: { type: 'integer' }, required: true },
  },
} as const

const monthlySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    month: { type: 'string', required: true },
    totalMinutes: { type: 'integer', required: true },
    activeDays: { type: 'integer', required: true },
    sessionCount: { type: 'integer', required: true },
  },
} as const

/** activity 工具集合，闭包持有 ActivityService 实例 */
export function createActivityTools(service: ActivityService): ToolDefinition[] {
  const getActivityStats = defineTool({
    name: 'get_activity_stats',
    description:
      'Get usage-time activity statistics: how long you have been actively working in this environment.\n' +
      'Activity is sampled from real user messages and agent steps (timestamps only, never message content);\n' +
      'lazy 60s heartbeat reconstruction at query time — no live timers.\n' +
      'Parameters: range (today/7d/30d/90d/365d/all, default 7d); includeHourly (24-slot hourly heatmap per day, local time); includeMonthly (per-month aggregation).\n' +
      'Returns: today, currentSession (in-progress continuous work), daily (newest first, minutes + session count), hourlyHeatmap, monthly.',
    parameters: {
      range: { type: 'string', enum: [...ACTIVITY_RANGES], description: 'Stats range. Defaults to 7d.' },
      includeHourly: { type: 'boolean', description: 'Include the 24-slot hourly heatmap per day (local time).' },
      includeMonthly: { type: 'boolean', description: 'Include per-month aggregation (newest first).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          generatedAt: { type: 'integer', required: true },
          today: { oneOf: [dayStatsSchema, { type: 'null' }] },
          currentSession: currentSessionSchema,
          daily: { type: 'array', items: dayStatsSchema },
          hourlyHeatmap: { type: 'array', items: hourlyRowSchema },
          monthly: { type: 'array', items: monthlySchema },
        },
      },
      render: (args, value) => renderText(value),
    },
    async execute(args, exec) {
      // 参数校验：range 枚举 / 布尔类型；非法参数抛稳定错误码
      const query = parseStatsQueryArgs(args)
      if (exec.signal.aborted) {
        throw new Error('get_activity_stats aborted')
      }
      const result = await service.getStats(query)
      if (exec.signal.aborted) {
        throw new Error('get_activity_stats aborted')
      }
      return omitUndefined({
        text: formatStats(result),
        generatedAt: result.generatedAt,
        today: result.today,
        currentSession: result.currentSession,
        daily: result.daily,
        hourlyHeatmap: result.hourlyHeatmap,
        monthly: result.monthly,
      })
    },
  })

  return [getActivityStats]
}
