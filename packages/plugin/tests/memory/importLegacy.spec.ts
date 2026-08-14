/**
 * 旧格式只读导入测试：1024B LOG / 损坏记录隔离 / TREE 摘要导入 / 幂等性 /
 * meta.json 导入标记 / 新格式写入路径（审计字段、删除/截断后摘要清理）
 *
 * 全部用内联合成的固定宽度样本（1024B/320B/288B），验证：
 * - 导入正确性：条目/摘要内容、id 重编号 + legacyId 溯源、LOG.txt/TREE 保持只读；
 * - 损坏隔离：单条损坏记录不中断整体导入，位置保留（logLen 口径与旧物理计数一致）；
 * - 幂等：records.jsonl 一旦存在不重复导入；
 * - 导入后的新格式读写路径行为与旧实现语义等价。
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { describe, expect, test } from 'vitest'
import { pad } from '../../src/memory/domain/logFormat.ts'
import { LOG_REC, TREE_REC } from '../../src/memory/domain/types.ts'
import { MemoryManager } from '../../src/memory/domain/MemoryManager.ts'

/** 合成一条固定宽度旧格式记录 */
function legacyRecord(rec: number, id: number, date: string, text: string): Buffer {
  const buf = Buffer.alloc(rec)
  const line = Buffer.from(`#${id} ${date} ${text}`, 'utf-8')
  if (line.length > rec - 1) throw new Error(`fixture too long: ${line.length} bytes`)
  line.copy(buf)
  buf.fill(0x20, line.length, rec - 1)
  buf[rec - 1] = 0x0a
  return buf
}

interface LegacyFixture {
  log?: Buffer
  tree?: Record<string, Buffer>
}

function makeLegacyDir(fixture: LegacyFixture): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-import-'))
  if (fixture.log) fs.writeFileSync(path.join(dir, 'LOG.txt'), fixture.log)
  if (fixture.tree) {
    fs.mkdirSync(path.join(dir, 'TREE'))
    for (const [name, buf] of Object.entries(fixture.tree)) {
      fs.writeFileSync(path.join(dir, 'TREE', name), buf)
    }
  }
  return dir
}

/** 测试专用：访问 MemoryManager 的私有 store（类型化窄化，非 any） */
function storeOf(mm: MemoryManager): {
  treeGet(lo: number, hi: number): Promise<string | null>
  rawEntryIdAt(i: number): Promise<number | null>
} {
  return (mm as unknown as {
    store: {
      treeGet(lo: number, hi: number): Promise<string | null>
      rawEntryIdAt(i: number): Promise<number | null>
    }
  }).store
}

/** 读取新格式 records.jsonl 原始行（含空行占位），返回 JSON 对象数组（null = 占位） */
function readRecordsJsonl(dir: string): Array<Record<string, unknown> | null> {
  const lines = fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf-8').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop() // 结尾换行的空段
  return lines.map(line => (line.trim() === '' ? null : JSON.parse(line)))
}

function readMeta(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'))
}

describe('旧 LOG.txt（1024B/条）只读导入', () => {
  test('数据无损（含多字节文本）、legacyId 溯源、LOG.txt 字节级不动', async () => {
    const texts = ['alpha', 'x'.repeat(900), '记忆-β']
    const log = Buffer.concat(texts.map((t, i) => legacyRecord(LOG_REC, i, '2024-01-01', t)))
    const dir = makeLegacyDir({ log })
    const logBefore = fs.readFileSync(path.join(dir, 'LOG.txt'))
    try {
      const mm = new MemoryManager(dir)
      await mm.init()
      const entries = await mm.listEntries()
      expect(entries.map(e => e.text)).toEqual(texts)
      expect(entries.map(e => e.id)).toEqual([0, 1, 2])
      expect(fs.readFileSync(path.join(dir, 'LOG.txt')).equals(logBefore)).toBe(true)

      const lines = readRecordsJsonl(dir)
      expect(lines).toHaveLength(3)
      const first = lines[0] as Record<string, unknown>
      expect(first.legacyId).toBe(0)
      expect(first.source).toBe('legacy-import')
      expect(first.version).toBe(1)
      expect(first.date).toBe('2024-01-01')

      // meta.json：版本 + 导入统计（logRec=1024）
      const meta = readMeta(dir)
      expect(meta.formatVersion).toBe(1)
      const imp = meta.importedFromLegacy as Record<string, unknown>
      expect(imp.logRec).toBe(1024)
      expect(imp.logImported).toBe(3)
      expect(imp.logSkipped).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('1024 撕裂尾巴：完整记录导入，尾巴丢弃', async () => {
    const log = Buffer.concat([
      legacyRecord(LOG_REC, 0, '2024-01-01', 'a'),
      legacyRecord(LOG_REC, 1, '2024-01-01', 'b'),
      Buffer.from('torn-tail-without-newline'),
    ])
    const dir = makeLegacyDir({ log })
    try {
      const mm = new MemoryManager(dir)
      await mm.init()
      expect((await mm.listEntries()).map(e => e.text)).toEqual(['a', 'b'])
      const meta = readMeta(dir)
      expect((meta.importedFromLegacy as Record<string, unknown>).logImported).toBe(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('损坏记录隔离（旧 LOG 导入）', () => {
  test('中间损坏记录：占位保留位置，其余导入，logLen/note/wake 口径一致', async () => {
    // 位置 1 的切片被破坏：剩余 id 0 与 id 2 的合法记录
    const log = Buffer.concat([
      legacyRecord(LOG_REC, 0, '2024-01-01', 'a'),
      Buffer.alloc(LOG_REC, 0x58), // 'X' × 1024（损坏切片）
      legacyRecord(LOG_REC, 2, '2024-01-01', 'c'),
    ])
    const dir = makeLegacyDir({ log })
    try {
      const mm = new MemoryManager(dir)
      await mm.init()
      // 合法记录导入、损坏跳过
      expect((await mm.listEntries()).map(e => e.text)).toEqual(['a', 'c'])
      expect((await mm.listEntries()).map(e => e.id)).toEqual([0, 2])
      // 位置保留：totalEntries（logLen）与旧物理计数一致 = 3
      expect(await mm.totalEntries()).toBe(3)
      // wake 不因损坏行崩溃，正常展示合法记录
      const wake = await mm.wake()
      expect(wake.totalMemories).toBe(3)
      expect(wake.blocks.some(b => b.text.includes('a'))).toBe(true)
      expect(wake.blocks.some(b => b.text.includes('c'))).toBe(true)
      // 追加从物理计数继续：id = 3（与旧实现一致）
      expect((await mm.note('d')).id).toBe(3)
      // recall 跳过损坏占位
      expect((await mm.recall('d')).totalHits).toBe(1)
      // 导入统计：2 导入 / 1 跳过
      const meta = readMeta(dir)
      const imp = meta.importedFromLegacy as Record<string, unknown>
      expect(imp.logImported).toBe(2)
      expect(imp.logSkipped).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rawEntryIdAt 对损坏占位返回 null（wake 缺失 vs 损坏判别）', async () => {
    const log = Buffer.concat([
      legacyRecord(LOG_REC, 0, '2024-01-01', 'a'),
      Buffer.alloc(LOG_REC, 0x58),
      legacyRecord(LOG_REC, 2, '2024-01-01', 'c'),
    ])
    const dir = makeLegacyDir({ log })
    try {
      const mm = new MemoryManager(dir)
      await mm.init()
      await mm.listEntries() // 触发导入
      const store = storeOf(mm)
      expect(await store.rawEntryIdAt(0)).toBe(0)
      expect(await store.rawEntryIdAt(1)).toBeNull() // 损坏占位
      expect(await store.rawEntryIdAt(2)).toBe(2)
      expect(await store.rawEntryIdAt(3)).toBeNull() // 越界
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('旧 TREE 摘要只读导入', () => {
  test('纯文本槽位与 "#id date text" 槽位均导入，treeGet/zoom/pending 正常', async () => {
    const log = Buffer.concat([0, 1, 2, 3].map(i => legacyRecord(LOG_REC, i, '2024-01-01', String.fromCharCode(97 + i))))
    const tree = {
      '2': Buffer.concat([
        pad('ab-sum', TREE_REC), // 旧 treePut 实际写入形态：纯摘要文本
        pad('#1 2026-02-01 cd', TREE_REC), // 文档记载形态：带 id/date 头
      ]),
      '4': Buffer.concat([pad('abcd', TREE_REC)]),
    }
    const dir = makeLegacyDir({ log, tree })
    try {
      const mm = new MemoryManager(dir)
      await mm.init()
      await mm.listEntries() // 触发导入
      expect((await mm.zoom('0-3')).left.text).toBe('ab-sum')
      expect((await mm.zoom('0-3')).right.text).toBe('cd')
      // 展开原始半区 [0,1)：展示原始记忆（摘要只出现在块级）
      expect((await mm.zoom('0-1')).left.text).toContain('a')
      // "#id date text" 形态槽位：归一化后取摘要文本与日期
      expect(await storeOf(mm).treeGet(2, 4)).toBe('cd')

      const meta = readMeta(dir)
      const imp = meta.importedFromLegacy as Record<string, unknown>
      expect(imp.treeImported).toBe(3)
      expect(imp.treeSkipped).toBe(0)
      expect(imp.files).toEqual(['2', '4'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('非空槽位逐字导入（摘要为自由文本，与旧 treeGet 语义一致）；空槽进入待压缩队列', async () => {
    const log = Buffer.concat([0, 1, 2, 3].map(i => legacyRecord(LOG_REC, i, '2024-01-01', String.fromCharCode(97 + i))))
    const tree = {
      '2': Buffer.concat([
        pad('ab', TREE_REC),
        Buffer.alloc(TREE_REC, 0x58), // 非空但无结构的槽位：旧 treeGet 原样返回 → 逐字导入
      ]),
    }
    const dir = makeLegacyDir({ log, tree })
    try {
      const mm = new MemoryManager(dir)
      await mm.init()
      await mm.listEntries()
      expect(await storeOf(mm).treeGet(0, 2)).toBe('ab')
      expect(await storeOf(mm).treeGet(2, 4)).toBe('X'.repeat(TREE_REC)) // trimEnd 后仍为全 X
      // 上层块 [0,4) 缺失 → 待压缩
      expect(await mm.pendingCount(4)).toBe(1)
      expect((await mm.compress('0-3', 'abcd')).done).toBe(1)
      expect(await mm.pendingCount(4)).toBe(0)
      const meta = readMeta(dir)
      const imp = meta.importedFromLegacy as Record<string, unknown>
      expect(imp.treeImported).toBe(2)
      expect(imp.treeSkipped).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('导入幂等与标记', () => {
  test('records.jsonl 存在后不重复导入；旧文件保留；可正常继续写入', async () => {
    const log = Buffer.concat(['a', 'b'].map((t, i) => legacyRecord(LOG_REC, i, '2024-01-01', t)))
    const dir = makeLegacyDir({ log })
    try {
      const mm1 = new MemoryManager(dir)
      await mm1.init()
      expect((await mm1.listEntries()).map(e => e.text)).toEqual(['a', 'b'])

      const recordsBefore = fs.readFileSync(path.join(dir, 'records.jsonl'))
      const summariesBefore = fs.readFileSync(path.join(dir, 'summaries.jsonl'))
      const logBefore = fs.readFileSync(path.join(dir, 'LOG.txt'))

      // 第二个实例打开同一目录：不重复导入（文件字节级不变）
      const mm2 = new MemoryManager(dir)
      await mm2.init()
      expect((await mm2.listEntries()).map(e => e.text)).toEqual(['a', 'b'])
      expect(fs.readFileSync(path.join(dir, 'records.jsonl')).equals(recordsBefore)).toBe(true)
      expect(fs.readFileSync(path.join(dir, 'summaries.jsonl')).equals(summariesBefore)).toBe(true)
      expect(fs.readFileSync(path.join(dir, 'LOG.txt')).equals(logBefore)).toBe(true)

      // 导入后新写入 id 从导入计数继续
      expect((await mm2.note('c')).id).toBe(2)
      expect((await mm2.listEntries()).map(e => e.text)).toEqual(['a', 'b', 'c'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('全新存储（无旧文件）：建空 records.jsonl + meta（importedFromLegacy=null）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-import-'))
    try {
      const mm = new MemoryManager(dir)
      await mm.init()
      expect(await mm.totalEntries()).toBe(0)
      expect(fs.existsSync(path.join(dir, 'records.jsonl'))).toBe(true)
      const meta = readMeta(dir)
      expect(meta.formatVersion).toBe(1)
      expect(meta.importedFromLegacy).toBeNull()
      // 新写入记录带审计字段
      expect((await mm.note('hello')).id).toBe(0)
      const lines = readRecordsJsonl(dir)
      const rec = lines[0] as Record<string, unknown>
      expect(rec.source).toBe('note')
      expect(rec.version).toBe(1)
      expect(rec.tags).toEqual([])
      expect(typeof rec.createdAt).toBe('string')
      expect(typeof rec.updatedAt).toBe('string')
      expect(rec.legacyId).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('空 LOG.txt（0 字节）：视为旧目录但无内容，meta 记录 logRec=0', async () => {
    const dir = makeLegacyDir({ log: Buffer.alloc(0) })
    try {
      const mm = new MemoryManager(dir)
      await mm.init()
      expect(await mm.totalEntries()).toBe(0)
      const meta = readMeta(dir)
      const imp = meta.importedFromLegacy as Record<string, unknown>
      expect(imp.logRec).toBe(0)
      expect(imp.logImported).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('新格式写入路径语义（与旧实现等价）', () => {
  async function seed(mm: MemoryManager, texts: string[]): Promise<void> {
    for (const t of texts) await mm.note(t)
  }

  test('updateEntry：保留 id/date、version+1、source=update，并丢弃覆盖摘要', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-import-'))
    try {
      const mm = new MemoryManager(dir)
      await mm.init()
      await seed(mm, ['a', 'b'])
      expect((await mm.compress('0-1', 'ab')).done).toBe(1)
      expect(await storeOf(mm).treeGet(0, 2)).toBe('ab')

      await mm.updateEntry(0, 'A')
      const entries = await mm.listEntries()
      expect(entries.map(e => e.text)).toEqual(['A', 'b'])
      expect(entries[0]!.date).toBeTruthy()
      const rec = readRecordsJsonl(dir)[0] as Record<string, unknown>
      expect(rec.text).toBe('A')
      expect(rec.version).toBe(2)
      expect(rec.source).toBe('update')
      // 覆盖该 id 的摘要已丢弃，可重新压缩
      expect(await storeOf(mm).treeGet(0, 2)).toBeNull()
      expect((await mm.compress('0-1', 'AB')).done).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('deleteRange 尾部删除保留前缀摘要，中间删除清空摘要', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-import-'))
    try {
      const mm = new MemoryManager(dir)
      await mm.init()
      await seed(mm, ['a', 'b', 'c', 'd'])
      await mm.compress('0-1', 'ab')
      await mm.compress('2-3', 'cd')
      await mm.compress('0-3', 'abcd')

      // 尾部删除 [2,3]：newT=2，块 [0,2) 保留，[0,4) 与 [2,4) 丢弃
      expect((await mm.deleteRange(2, 3)).removed).toBe(2)
      expect(await storeOf(mm).treeGet(0, 2)).toBe('ab')
      expect(await storeOf(mm).treeGet(0, 4)).toBeNull()
      expect((await mm.listEntries()).map(e => e.text)).toEqual(['a', 'b'])

      // 中间删除：全部摘要清空
      await seed(mm, ['c', 'd'])
      await mm.compress('0-1', 'ab2')
      await mm.compress('2-3', 'cd2')
      await mm.compress('0-3', 'abcd2')
      expect((await mm.deleteRange(1, 2)).removed).toBe(2)
      expect(await storeOf(mm).treeGet(0, 2)).toBeNull()
      expect(await storeOf(mm).treeGet(0, 4)).toBeNull()
      expect((await mm.listEntries()).map(e => e.text)).toEqual(['a', 'd'])
      expect((await mm.listEntries()).map(e => e.id)).toEqual([0, 1])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('truncateLog 保留前缀摘要、物理截断不重编号', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-import-'))
    try {
      const mm = new MemoryManager(dir)
      await mm.init()
      await seed(mm, ['a', 'b', 'c', 'd'])
      await mm.compress('0-1', 'ab')
      await mm.compress('2-3', 'cd')
      await mm.compress('0-3', 'abcd')

      expect((await mm.truncateLog(2)).removed).toBe(2)
      const entries = await mm.listEntries()
      expect(entries.map(e => e.text)).toEqual(['a', 'b'])
      expect(entries.map(e => e.id)).toEqual([0, 1])
      expect(await storeOf(mm).treeGet(0, 2)).toBe('ab')
      expect(await storeOf(mm).treeGet(0, 4)).toBeNull()
      expect((await mm.truncateLog(0)).removed).toBe(2)
      expect(await mm.totalEntries()).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('summaries.jsonl 外部损坏行隔离：跳过不阻断读取', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-import-'))
    try {
      const mm = new MemoryManager(dir)
      await mm.init()
      await seed(mm, ['a', 'b'])
      await mm.compress('0-1', 'ab')
      fs.appendFileSync(path.join(dir, 'summaries.jsonl'), 'garbage-line-no-json\n')
      expect(await storeOf(mm).treeGet(0, 2)).toBe('ab')
      expect(await mm.pendingCount(2)).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
