/**
 * activity Remote 端点测试（C6）：activity/stats 查询端点。
 * 服务由真实 ActivityStore + 临时 dataRoot 支撑；端点经 GrayRemoteService.invoke
 * 调用（信封 + 稳定码转换全链路）。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GrayRemoteService } from '../../src/remote/service.ts'
import { GRAY_REMOTE_ERROR_CODES } from '../../src/remote/types.ts'
import { ActivityService } from '../../src/activity/service.ts'
import { createActivityRemoteHandlers } from '../../src/activity/adapters/dsh/remote.ts'
import { toDateStr } from '../../src/activity/domain/store.ts'

function daysAgo(days: number): number {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(10, 0, 0, 0)
  return d.getTime()
}

let dataRoot: string
let service: ActivityService
let remote: GrayRemoteService

beforeEach(async () => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-act-remote-'))
  service = new ActivityService({ dataRoot })
  const ctx = new Context()
  remote = new GrayRemoteService(ctx, {})
  remote.register(createActivityRemoteHandlers(service))
})

afterEach(() => {
  service.dispose()
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

async function invokeStats(args: Record<string, unknown>): Promise<
  { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }
> {
  return remote.invoke('activity', 'stats', args) as never
}

describe('activity/stats', () => {
  it('默认 7d：返回 today/currentSession/daily（不含 hourly/monthly）', async () => {
    await service.markActive(daysAgo(2))
    const result = await invokeStats({})
    expect(result.ok).toBe(true)
    if (result.ok) {
      const value = result.value as {
        generatedAt: number
        today: unknown
        currentSession: { active: boolean }
        daily: Array<{ date: string; totalMinutes: number }>
        hourlyHeatmap: unknown
        monthly: unknown
      }
      expect(value.generatedAt).toBeGreaterThan(0)
      expect(value.daily).toHaveLength(7)
      expect(value.daily.map(d => d.date)).toContain(toDateStr(daysAgo(2)))
      expect(value.hourlyHeatmap).toEqual([])
      expect(value.monthly).toEqual([])
    }
  })

  it('range=30d + includeHourly + includeMonthly 全量返回', async () => {
    await service.markActive(daysAgo(5))
    const result = await invokeStats({ range: '30d', includeHourly: true, includeMonthly: true })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const value = result.value as {
        daily: unknown[]
        hourlyHeatmap: Array<{ date: string; hours: number[] }>
        monthly: Array<{ month: string }>
      }
      expect(value.daily).toHaveLength(30)
      expect(value.hourlyHeatmap.length).toBeGreaterThan(0)
      expect(value.hourlyHeatmap[0]!.hours).toHaveLength(24)
      expect(value.monthly.length).toBeGreaterThan(0)
    }
  })

  it('非法 range → GRAY_INVALID_INPUT（信封失败，不 reject）', async () => {
    const result = await invokeStats({ range: 'bogus' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })

  it('非法布尔参数 → GRAY_INVALID_INPUT', async () => {
    const result = await invokeStats({ includeHourly: 'yes' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })

  it('today 无数据为 null（range=today 时 daily 恰 1 天）', async () => {
    const result = await invokeStats({ range: 'today' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const value = result.value as { today: unknown; daily: unknown[] }
      expect(value.today).toBeNull()
      expect(value.daily).toHaveLength(1)
    }
  })
})
