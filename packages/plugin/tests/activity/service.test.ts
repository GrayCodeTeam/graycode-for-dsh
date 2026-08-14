/**
 * ActivityService 测试：markActive → 落盘路径（<dataRoot>/activity/YYYY-MM-DD.json）、
 * getStats 端到端、dispose 幂等；index.ts 的 isTrackedAgent 作用域判定纯函数。
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { describe, expect, test } from 'vitest'
import { ActivityService } from '../../src/activity/service.ts'
import { toDateStr } from '../../src/activity/domain/store.ts'
import { isTrackedAgent } from '../../src/activity/index.ts'

/** 距今天数（本地时区）的毫秒时间戳 */
function daysAgo(days: number): number {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(10, 0, 0, 0)
  return d.getTime()
}

function makeService(): { service: ActivityService; dataRoot: string } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-act-svc-'))
  return { service: new ActivityService({ dataRoot }), dataRoot }
}

describe('ActivityService', () => {
  test('markActive → flush 落盘到 <dataRoot>/activity/YYYY-MM-DD.json', async () => {
    const { service, dataRoot } = makeService()
    try {
      const t = daysAgo(0) - 60_000
      await service.markActive(t)
      await service.flush()
      const filePath = path.join(dataRoot, 'activity', `${toDateStr(t)}.json`)
      expect(fs.existsSync(filePath)).toBe(true)
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      expect(parsed.date).toBe(toDateStr(t))
      expect(parsed.samples).toEqual([t])
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('getStats 默认 7d：范围含最近 7 天（含空天），范围外采样不计，today 无数据为 null', async () => {
    const { service, dataRoot } = makeService()
    try {
      await service.markActive(daysAgo(10))
      await service.markActive(daysAgo(2))
      const result = await service.getStats()
      expect(result.daily).toHaveLength(7)
      expect(result.daily.map(d => d.date)).toContain(toDateStr(daysAgo(2)))
      expect(result.daily.map(d => d.date)).not.toContain(toDateStr(daysAgo(10)))
      expect(result.today).toBeNull()
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('getStats 注入 now 与自定义采样间隔（分钟粒度向上取整）', async () => {
    const { service, dataRoot } = makeService()
    try {
      // sampleIntervalMs=120s：跨度 3 分钟的会话折算为 ceil(180/120)=2 分钟
      const svc = new ActivityService({ dataRoot, sampleIntervalMs: 120_000 })
      const t = daysAgo(2)
      await svc.markActive(t)
      await svc.markActive(t + 180_000)
      const result = await svc.getStats({ range: '7d' }, Date.now())
      const d2 = result.daily.find(d => d.date === toDateStr(t))!
      expect(d2.totalMinutes).toBe(2)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('dispose 落盘且幂等', async () => {
    const { service, dataRoot } = makeService()
    try {
      await service.markActive(daysAgo(0))
      await service.dispose()
      await service.dispose()
      const files = fs.readdirSync(path.join(dataRoot, 'activity'))
      expect(files.some(f => f.endsWith('.json'))).toBe(true)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})

describe('isTrackedAgent（index.ts 作用域纯函数）', () => {
  test('roots 只计根 agent', () => {
    expect(isTrackedAgent('root-a', 'roots', ['root-a', 'root-b'])).toBe(true)
    expect(isTrackedAgent('sub-1', 'roots', ['root-a'])).toBe(false)
  })

  test('all 计所有 agent（含子代理）', () => {
    expect(isTrackedAgent('sub-1', 'all', ['root-a'])).toBe(true)
    expect(isTrackedAgent('root-a', 'all', [])).toBe(true)
  })

  test('disabled 不计任何 agent', () => {
    expect(isTrackedAgent('root-a', 'disabled', ['root-a'])).toBe(false)
    expect(isTrackedAgent('sub-1', 'disabled', ['root-a'])).toBe(false)
  })
})
