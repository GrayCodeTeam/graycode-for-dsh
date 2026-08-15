/**
 * activity 存储测试：按天 JSON 存取、串行锁并发追加、原子写（tmp+rename）、
 * 损坏文件容错（非法 JSON / 结构不符 / 非数值过滤）、跨午夜脏日期落盘。
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { describe, expect, test } from 'vitest'
import { ActivityStore, toDateStr } from '../../src/activity/domain/store.ts'

/** 本地时区确定时间 */
const T0 = new Date(2026, 0, 5, 10, 0, 0).getTime()

function makeStore(dedupWindowMs = 60_000): { store: ActivityStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-activity-'))
  return { store: new ActivityStore(dir, dedupWindowMs), dir }
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

function writeDayFile(dir: string, date: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${date}.json`)
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

describe('toDateStr', () => {
  test('本地时区 YYYY-MM-DD', () => {
    expect(toDateStr(new Date(2026, 0, 5, 23, 59, 59).getTime())).toBe('2026-01-05')
    expect(toDateStr(new Date(2026, 11, 31, 0, 0, 0).getTime())).toBe('2026-12-31')
  })
})

describe('appendSample', () => {
  test('乱序追加后保持升序', async () => {
    const { store, dir } = makeStore()
    try {
      const t1 = T0 + 60_000
      const t2 = T0
      expect(await store.appendSample(t1)).toBe(true)
      expect(await store.appendSample(t2)).toBe(true)
      expect(await store.loadDay(toDateStr(T0))).toEqual([t2, t1])
    } finally {
      cleanup(dir)
    }
  })

  test('去重窗口内相邻采样跳过（返回 false），窗口边界保留', async () => {
    const { store, dir } = makeStore(60_000)
    try {
      expect(await store.appendSample(T0)).toBe(true)
      expect(await store.appendSample(T0 + 30_000)).toBe(false) // 同窗口
      expect(await store.appendSample(T0 + 60_000)).toBe(true) // 恰在边界
      expect(await store.loadDay(toDateStr(T0))).toEqual([T0, T0 + 60_000])
    } finally {
      cleanup(dir)
    }
  })

  test('并发追加不丢失（串行锁）', async () => {
    const { store, dir } = makeStore(1) // 1ms 窗口：全部保留
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => store.appendSample(T0 + i * 1_000)),
      )
      expect(results.every(r => r === true)).toBe(true)
      const samples = await store.loadDay(toDateStr(T0))
      expect(samples).toHaveLength(50)
      for (let i = 1; i < samples.length; i++) {
        expect(samples[i]!).toBeGreaterThan(samples[i - 1]!)
      }
    } finally {
      cleanup(dir)
    }
  })
})

describe('flushDay', () => {
  test('原子写：生成 {date,samples} 文件，无 tmp 残留', async () => {
    const { store, dir } = makeStore()
    try {
      await store.appendSample(T0)
      await store.appendSample(T0 + 120_000)
      await store.flushDay()
      const filePath = path.join(dir, `${toDateStr(T0)}.json`)
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      expect(parsed.date).toBe(toDateStr(T0))
      expect(parsed.samples).toEqual([T0, T0 + 120_000])
      const leftovers = fs.readdirSync(dir).filter(n => n.includes('tmp'))
      expect(leftovers).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  test('脏日期一并落盘：跨午夜追加昨天的采样后 flushDay() 写两个文件', async () => {
    const { store, dir } = makeStore()
    try {
      const yesterday = T0 - 24 * 3_600_000 // 前一天同一时刻
      await store.appendSample(yesterday)
      await store.appendSample(T0)
      await store.flushDay()
      const files = fs.readdirSync(dir).sort()
      expect(files).toEqual([`${toDateStr(yesterday)}.json`, `${toDateStr(T0)}.json`].sort())
    } finally {
      cleanup(dir)
    }
  })

  test('无采样时 flush 不写文件', async () => {
    const { store, dir } = makeStore()
    try {
      await store.flushDay()
      expect(fs.readdirSync(dir)).toEqual([])
    } finally {
      cleanup(dir)
    }
  })
})

describe('loadDay 损坏容错', () => {
  test('文件不存在 → 空数组', async () => {
    const { store, dir } = makeStore()
    try {
      expect(await store.loadDay('2026-01-05')).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  test('非法 JSON → 空数组并删除坏文件', async () => {
    const { store, dir } = makeStore()
    try {
      const filePath = writeDayFile(dir, '2026-01-05', '{oops')
      expect(await store.loadDay('2026-01-05')).toEqual([])
      expect(fs.existsSync(filePath)).toBe(false)
    } finally {
      cleanup(dir)
    }
  })

  test('结构不符（samples 非数组）→ 空数组并删除', async () => {
    const { store, dir } = makeStore()
    try {
      const filePath = writeDayFile(dir, '2026-01-05', JSON.stringify({ date: '2026-01-05', samples: 'x' }))
      expect(await store.loadDay('2026-01-05')).toEqual([])
      expect(fs.existsSync(filePath)).toBe(false)
    } finally {
      cleanup(dir)
    }
  })

  test('含非数值条目的文件按坏文件处理：返回空并删除（4.15-L3，避免残留反复解析）', async () => {
    const { store, dir } = makeStore(60_000)
    try {
      const filePath = writeDayFile(dir, '2026-01-05', '{"date":"2026-01-05","samples":[200100, null, "x", 100, 100]}')
      expect(await store.loadDay('2026-01-05')).toEqual([])
      expect(fs.existsSync(filePath)).toBe(false)
    } finally {
      cleanup(dir)
    }
  })

  test('纯数值采样按窗口去重、排序', async () => {
    const { store, dir } = makeStore(60_000)
    try {
      writeDayFile(dir, '2026-01-05', '{"date":"2026-01-05","samples":[200100, 100, 100]}')
      expect(await store.loadDay('2026-01-05')).toEqual([100, 200100])
    } finally {
      cleanup(dir)
    }
  })
})

describe('listDays / loadRecentDays / loadAllDays', () => {
  test('listDays 只列天文件且升序', async () => {
    const { store, dir } = makeStore()
    try {
      writeDayFile(dir, '2026-01-06', '{}')
      writeDayFile(dir, '2026-01-05', '{}')
      writeDayFile(dir, 'notes.txt', 'x')
      expect(await store.listDays()).toEqual(['2026-01-05', '2026-01-06'])
    } finally {
      cleanup(dir)
    }
  })

  test('loadRecentDays 返回最近 count 天（含今天），仅已存在的天有采样', async () => {
    const { store, dir } = makeStore()
    try {
      const now = new Date(2026, 5, 11, 12, 0, 0).getTime()
      const d2 = new Date(2026, 5, 9, 10, 0, 0).getTime() // 2 天前
      await store.appendSample(d2)
      await store.appendSample(new Date(2026, 5, 11, 11, 0, 0).getTime())
      const days = await store.loadRecentDays(3, now)
      expect(days.map(d => d.date)).toEqual(['2026-06-09', '2026-06-10', '2026-06-11'])
      expect(days[0]!.samples).toEqual([d2])
      expect(days[1]!.samples).toEqual([]) // 06-10 无文件
      expect(days[2]!.samples).toHaveLength(1)
    } finally {
      cleanup(dir)
    }
  })

  test('loadAllDays 含今天与内存脏日期，升序', async () => {
    const { store, dir } = makeStore()
    try {
      const now = new Date(2026, 5, 11, 12, 0, 0).getTime()
      const d1 = new Date(2026, 5, 8, 9, 0, 0).getTime()
      const d2 = new Date(2026, 5, 11, 10, 0, 0).getTime()
      await store.appendSample(d1)
      await store.flushDay() // d1 落盘
      await store.appendSample(d2) // 脏（未落盘）
      const days = await store.loadAllDays(now)
      expect(days.map(d => d.date)).toEqual(['2026-06-08', '2026-06-11'])
      expect(days[1]!.samples).toEqual([d2])
    } finally {
      cleanup(dir)
    }
  })

  test('loadRecentDays 返回拷贝，外部修改不污染缓存', async () => {
    const { store, dir } = makeStore()
    try {
      const now = new Date(2026, 5, 11, 12, 0, 0).getTime()
      const sample = new Date(2026, 5, 11, 10, 0, 0).getTime()
      await store.appendSample(sample)
      const days = await store.loadRecentDays(1, now)
      days[0]!.samples.push(999)
      const again = await store.loadRecentDays(1, now)
      expect(again[0]!.samples).toEqual([sample])
    } finally {
      cleanup(dir)
    }
  })
})
