/**
 * MemoryManager 核心行为测试：note→wake（近期原文 + 远期摘要）、recall
 * （正则 + ReDoS 防护）、compress→zoom、forget 各形态、updateConfig 钳制
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { describe, expect, test } from 'vitest'
import { MemoryManager } from '../../src/memory/domain/MemoryManager.ts'

function makeManager(overrides?: Record<string, number>): { mm: MemoryManager; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-manager-'))
  const mm = new MemoryManager(dir, overrides)
  return { mm, dir }
}

describe('MemoryManager.note → wake', () => {
  test('wake 含近期原文 + 远期摘要（wakeLines 预算下 cover 混合块）', async () => {
    const { mm, dir } = makeManager({ wakeLines: 3 })
    try {
      await mm.init()
      for (const t of ['a', 'b', 'c', 'd', 'e']) {
        await mm.note(t)
      }
      // T=5、预算 3 → 块 [0,2) [2,4) [4,5)：先压缩前两个块
      expect((await mm.compress('0-1', 'ab')).done).toBe(1)
      expect((await mm.compress('2-3', 'cd')).done).toBe(1)

      const wake = await mm.wake()
      expect(wake.totalMemories).toBe(5)
      const texts = wake.blocks.map(b => b.text)
      // 远期两条为摘要（块 #0-1、#2-3），近期一条为原文（#4）
      expect(wake.blocks[0]).toMatchObject({ lo: 0, hi: 1, isRaw: false })
      expect(wake.blocks[1]).toMatchObject({ lo: 2, hi: 3, isRaw: false })
      expect(wake.blocks[2]).toMatchObject({ lo: 4, hi: 4, isRaw: true })
      expect(texts.join(' ')).toContain('ab')
      expect(texts.join(' ')).toContain('cd')
      expect(texts.join(' ')).toContain('e')
      expect(wake.awake).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('wake 缺失摘要时给出指向实际缺失块的压缩提示', async () => {
    const { mm, dir } = makeManager({ wakeLines: 2 })
    try {
      await mm.init()
      for (const t of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
        await mm.note(t)
      }
      await mm.compress('0-1', 'ab')
      const error = (await mm.wake(undefined, 8).catch(e => e as Error)) as Error
      expect(error.message).toContain('needs #0-3')
      expect(error.message).toContain('Compress memories #0-3')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MemoryManager.recall', () => {
  test('正则搜索（大小写不敏感），命中完整含 id/日期', async () => {
    const { mm, dir } = makeManager()
    try {
      await mm.init()
      await mm.note('alpha-1')
      await mm.note('beta-2')
      await mm.note('Alpha-3')
      const result = await mm.recall('alpha')
      expect(result.totalHits).toBe(2)
      expect(result.truncated).toBe(false)
      expect(result.lines.some(l => l.includes('alpha-1'))).toBe(true)
      expect(result.lines.some(l => l.includes('Alpha-3'))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('无命中返回 0', async () => {
    const { mm, dir } = makeManager()
    try {
      await mm.init()
      await mm.note('nothing-here')
      expect(await mm.recall('missing')).toEqual({ lines: [], totalHits: 0, truncated: false })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('ReDoS 危险模式（(a+)+）被拒绝并报可读错误', async () => {
    const { mm, dir } = makeManager()
    try {
      await mm.init()
      await mm.note('anything')
      const error = (await mm.recall('(a+)+').catch(e => e as Error)) as Error
      expect(error.message).toMatch(/bad regex/)
      expect(error.message).toMatch(/ReDoS|Dangerous/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MemoryManager.compress → zoom', () => {
  test('压缩后 zoom 展开显示两半（摘要 → 原始）', async () => {
    const { mm, dir } = makeManager()
    try {
      await mm.init()
      for (const t of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
        await mm.note(t)
      }
      expect((await mm.compress('0-1', 'ab')).done).toBe(1)
      expect((await mm.compress('2-3', 'cd')).done).toBe(1)
      expect((await mm.compress('4-5', 'ef')).done).toBe(1)
      expect((await mm.compress('6-7', 'gh')).done).toBe(1)
      expect((await mm.compress('0-3', 'abcd')).done).toBe(1)
      expect((await mm.compress('4-7', 'efgh')).done).toBe(1)

      // zoom 摘要块 #0-3 → 两半为摘要
      const zoomed = await mm.zoom('0-3')
      expect(zoomed.left.text).toBe('ab')
      expect(zoomed.right.text).toBe('cd')
      expect(zoomed.left.isRaw).toBe(false)
      expect(zoomed.right.isRaw).toBe(false)

      // zoom 原始半区 #0-1 → 两条原始记忆
      const raw = await mm.zoom('0-1')
      expect(raw.left.isRaw).toBe(true)
      expect(raw.right.isRaw).toBe(true)
      expect(raw.left.text).toContain('a')
      expect(raw.right.text).toContain('b')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('无待压缩块时压缩已存在块幂等返回 done=0', async () => {
    const { mm, dir } = makeManager()
    try {
      await mm.init()
      for (const t of ['a', 'b', 'c', 'd']) {
        await mm.note(t)
      }
      expect((await mm.compress('0-1', 'ab')).done).toBe(1)
      expect((await mm.compress('2-3', 'cd')).done).toBe(1)
      expect((await mm.compress('0-1', 'AB')).done).toBe(0)
      expect((await mm.compress('0-3', 'abcd')).done).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MemoryManager.forget 各形态', () => {
  test('块 ID：只丢树摘要，原始记忆保留；可重新压缩重建', async () => {
    const { mm, dir } = makeManager()
    try {
      await mm.init()
      for (const t of ['a', 'b', 'c', 'd']) {
        await mm.note(t)
      }
      // 按序构建树：0-1 → 2-3 → 0-3
      await mm.compress('0-1', 'ab')
      await mm.compress('2-3', 'cd')
      await mm.compress('0-3', 'abcd')
      const forgotten = await mm.forget('0-3')
      expect(forgotten.gone).toBe(1)
      expect(forgotten.firstId).toBe('0-3')
      // 原始记忆完好
      expect((await mm.listEntries()).length).toBe(4)
      // 再次压缩重建成功（size=4 的块仍在待压缩队列）
      expect((await mm.compress('0-3', 'ABCD')).done).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('无摘要时 forget 报错', async () => {
    const { mm, dir } = makeManager()
    try {
      await mm.init()
      await mm.note('a')
      await mm.note('b')
      const error = (await mm.forget('0-1').catch(e => e as Error)) as Error
      expect(error.message).toMatch(/No summary at 0-1/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('deleteEntry：单条删除，其余 id 前移重编号', async () => {
    const { mm, dir } = makeManager()
    try {
      await mm.init()
      for (const t of ['a', 'b', 'c', 'd']) {
        await mm.note(t)
      }
      expect((await mm.deleteEntry(1)).removed).toBe(1)
      const entries = await mm.listEntries()
      expect(entries.map(e => e.text)).toEqual(['a', 'c', 'd'])
      expect(entries.map(e => e.id)).toEqual([0, 1, 2])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('deleteRange：闭区间删除（含端点）', async () => {
    const { mm, dir } = makeManager()
    try {
      await mm.init()
      for (const t of ['a', 'b', 'c', 'd', 'e']) {
        await mm.note(t)
      }
      expect((await mm.deleteRange(1, 3)).removed).toBe(3)
      expect((await mm.listEntries()).map(e => e.text)).toEqual(['a', 'e'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MemoryManager.updateConfig 钳制', () => {
  test('越界值被拒绝（entryChars 上限 1000、正整数下限 1）', async () => {
    const { mm, dir } = makeManager()
    try {
      await mm.init()
      await expect(mm.updateConfig({ entryChars: 1001 })).rejects.toThrow(/Invalid entryChars/)
      await expect(mm.updateConfig({ wakeLines: 0 })).rejects.toThrow(/Invalid wakeLines/)
      await expect(mm.updateConfig({ partLines: 1.5 })).rejects.toThrow(/Invalid partLines/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('合法值生效并持久化', async () => {
    const { mm, dir } = makeManager()
    try {
      await mm.init()
      await mm.updateConfig({ wakeLines: 200, entryChars: 500 })
      expect(mm.getConfig().wakeLines).toBe(200)
      expect(mm.getConfig().entryChars).toBe(500)
      // 重读实例（同 config 文件）仍读到新值
      const mm2 = new MemoryManager(dir)
      expect((await mm2.loadConfig()).entryChars).toBe(500)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('写盘失败时内存配置不变，恢复后更新成功（BUG-08：先写盘后提交内存）', async () => {
    const { mm, dir } = makeManager()
    try {
      await mm.init()
      expect(mm.getConfig().entryChars).toBe(280)

      // 注入故障：config 目标被外部替换为同名目录（原子写 rename 必失败，等价写盘失败）
      const configPath = path.join(dir, 'config')
      fs.rmSync(configPath)
      fs.mkdirSync(configPath)

      await expect(mm.updateConfig({ entryChars: 500 })).rejects.toThrow()

      // 内存未提交：仍为旧值（无内存/磁盘分叉）
      expect(mm.getConfig().entryChars).toBe(280)

      // 故障消除后更新成功，内存与磁盘一致
      fs.rmSync(configPath, { recursive: true, force: true })
      await mm.updateConfig({ entryChars: 500 })
      expect(mm.getConfig().entryChars).toBe(500)
      const mm2 = new MemoryManager(dir)
      expect((await mm2.loadConfig()).entryChars).toBe(500)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('entryChars 提高后可记录更长文本', async () => {
    const { mm, dir } = makeManager()
    try {
      await mm.init()
      await expect(mm.note('x'.repeat(300))).rejects.toThrow(/Too long/)
      await mm.updateConfig({ entryChars: 500 })
      expect((await mm.note('x'.repeat(300))).id).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
