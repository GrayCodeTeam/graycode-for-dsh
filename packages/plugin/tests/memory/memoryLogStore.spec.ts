/**
 * MemoryLogStore 底层直测（F-03 补强）：LOG/TREE 新格式（JSONL）细节显式覆盖。
 *
 * audit-tests.md F-03：MemoryLogStore（959 行）此前仅经 MemoryManager 高层
 * 间接到达。本文件直接实例化 MemoryLogStore 覆盖：
 * - 记录读写：logAppend/logLen/logSlice/logGet/rawEntryIdAt、磁盘 JSONL 形状
 * - 损坏隔离：records.jsonl 中间损坏行占位（logLen 口径一致）、撕裂尾截断修复、
 *   summaries.jsonl 损坏行跳过
 * - mtime+size 缓存失效重扫（多实例共享目录可见彼此写入）
 * - truncateLog（物理截断、keepId 越界、非法 keepId）
 * - deleteRange（闭区间、损坏占位不计、越界/非法输入）
 * - updateEntry（版本递增、source 审计、空/换行/超长拒绝、损坏占位不可编辑）
 * - treePut/treeGet/treeDrop/pending（重复 false、缺槽报错、按 lo 升序确定输出）
 * - 旧格式导入路径（320B LOG + TREE 槽位 → legacyId/meta 统计/旧文件只读）
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, test } from 'vitest'
import {
  MemoryLogStore,
  MemoryRevisionConflictError,
} from '../../src/memory/domain/MemoryLogStore.ts'
import { DEFAULT_MEMORY_CONFIG, LOG_REC, TREE_REC } from '../../src/memory/domain/types.ts'
import { pad } from '../../src/memory/domain/logFormat.ts'
import { encodeRecordLine } from '../../src/memory/domain/memoryFormat.ts'

const CONFIG = (): typeof DEFAULT_MEMORY_CONFIG => ({ ...DEFAULT_MEMORY_CONFIG })

function makeStore(): { store: MemoryLogStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-store-'))
  const store = new MemoryLogStore(dir, CONFIG)
  return { store, dir }
}

/** 合成一条旧格式固定宽度记录（320/1024B） */
function legacyRecord(rec: number, id: number, date: string, text: string): Buffer {
  const buf = Buffer.alloc(rec)
  const line = Buffer.from(`#${id} ${date} ${text}`, 'utf-8')
  if (line.length > rec - 1) throw new Error(`fixture too long: ${line.length} bytes`)
  line.copy(buf)
  buf.fill(0x20, line.length, rec - 1)
  buf[rec - 1] = 0x0a
  return buf
}

describe('MemoryLogStore 记录读写', () => {
  test('logAppend → logLen/logSlice/logGet/rawEntryIdAt 基础读写与磁盘形状', async () => {
    const { store, dir } = makeStore()
    try {
      expect(await store.logLen()).toBe(0)
      const base = await store.logAppend([
        { date: '2026-01-01', text: 'first', source: 'note', tags: ['a'] },
        { date: '2026-01-02', text: 'second' },
      ])
      expect(base).toBe(0)
      expect(await store.logLen()).toBe(2)
      expect(await store.logSlice(0, 2)).toEqual([
        { id: 0, date: '2026-01-01', text: 'first' },
        { id: 1, date: '2026-01-02', text: 'second' },
      ])
      expect(await store.logSlice(1, 3)).toEqual([{ id: 1, date: '2026-01-02', text: 'second' }])
      expect(await store.logGet(0)).toEqual({ id: 0, date: '2026-01-01', text: 'first' })
      expect(await store.rawEntryIdAt(0)).toBe(0)
      expect(await store.rawEntryIdAt(5)).toBeNull()

      // 磁盘格式：一行一条 JSON，追加式
      const raw = fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf-8')
      const lines = raw.split('\n').filter(line => line.trim() !== '')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!)).toMatchObject({
        id: 0,
        date: '2026-01-01',
        text: 'first',
        source: 'note',
        tags: ['a'],
        version: 1,
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('logGet 越界抛 "No memory at index"', async () => {
    const { store, dir } = makeStore()
    try {
      await expect(store.logGet(0)).rejects.toThrow('No memory at index 0')
      await store.logAppend([{ date: '2026-01-01', text: 'a' }])
      await expect(store.logGet(1)).rejects.toThrow('No memory at index 1')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MemoryLogStore 损坏隔离', () => {
  test('records.jsonl 中间损坏行：空行占位保留位置，logLen 与物理计数一致，读取跳过', async () => {
    const { store, dir } = makeStore()
    try {
      await store.logAppend([{ date: '2026-01-01', text: 'a' }])
      // 外部构造：合法行 + 损坏行 + 合法行（id 不连续，位置保留语义）
      fs.writeFileSync(
        path.join(dir, 'records.jsonl'),
        encodeRecordLine({ id: 0, date: '2026-01-01', text: 'a', version: 1, source: 'note', tags: [] }) +
          'garbage-line-not-json\n' +
          encodeRecordLine({ id: 2, date: '2026-01-02', text: 'c', version: 1, source: 'note', tags: [] }),
      )
      expect(await store.logLen()).toBe(3) // 含占位
      expect(await store.logSlice(0, 3)).toEqual([
        { id: 0, date: '2026-01-01', text: 'a' },
        { id: 2, date: '2026-01-02', text: 'c' },
      ])
      expect(await store.rawEntryIdAt(1)).toBeNull() // 损坏占位
      // 追加从物理计数继续（id=3），损坏不打断后续 id
      expect(await store.logAppend([{ date: '2026-01-03', text: 'd' }])).toBe(3)
      expect(await store.logLen()).toBe(4)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('record.id 与行号不一致的异常记录按损坏占位处理（L6）', async () => {
    const { store, dir } = makeStore()
    try {
      // 位置 0 的记录 id=5 ≠ 行号 0 → 损坏占位；位置 1 的 id=1 正常
      fs.writeFileSync(
        path.join(dir, 'records.jsonl'),
        encodeRecordLine({ id: 5, date: '2026-01-01', text: 'misaligned', version: 1, source: 'note', tags: [] }) +
          encodeRecordLine({ id: 1, date: '2026-01-02', text: 'aligned', version: 1, source: 'note', tags: [] }),
      )
      expect(await store.logLen()).toBe(2)
      expect(await store.logSlice(0, 2)).toEqual([{ id: 1, date: '2026-01-02', text: 'aligned' }])
      expect(await store.rawEntryIdAt(0)).toBeNull()
      expect(await store.rawEntryIdAt(1)).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('records.jsonl 撕裂尾（无换行半行）：加载时截断修复，logLen 正确', async () => {
    const { store, dir } = makeStore()
    try {
      await store.logAppend([
        { date: '2026-01-01', text: 'a' },
        { date: '2026-01-01', text: 'b' },
      ])
      fs.appendFileSync(path.join(dir, 'records.jsonl'), 'torn-tail-no-newline')
      expect(await store.logLen()).toBe(2)
      expect((await store.logSlice(0, 2)).map(e => e.text)).toEqual(['a', 'b'])
      // 撕裂尾巴已被截断修复（文件不再含半行）
      const raw = fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf-8')
      expect(raw.endsWith('\n')).toBe(true)
      expect(raw).not.toContain('torn-tail')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('summaries.jsonl 外部损坏行：跳过不阻断读取（树是缓存）', async () => {
    const { store, dir } = makeStore()
    try {
      await store.logAppend([
        { date: '2026-01-01', text: 'a' },
        { date: '2026-01-01', text: 'b' },
      ])
      expect(await store.treePut(0, 2, 'ab', 'compress')).toBe(true)
      fs.appendFileSync(path.join(dir, 'summaries.jsonl'), 'broken-line\n')
      expect(await store.treeGet(0, 2)).toBe('ab')
      expect(await store.pendingCount(2)).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('mtime+size 缓存失效重扫：外部写入立即可见（多实例共享目录语义）', async () => {
    const { store, dir } = makeStore()
    try {
      await store.logAppend([{ date: '2026-01-01', text: 'a' }])
      expect(await store.logLen()).toBe(1)
      // 另一“实例”直接追加（size 变化 → 缓存失效重载）
      fs.appendFileSync(
        path.join(dir, 'records.jsonl'),
        encodeRecordLine({ id: 1, date: '2026-01-02', text: 'b', version: 1, source: 'note', tags: [] }),
      )
      expect(await store.logLen()).toBe(2)
      expect((await store.logSlice(0, 2)).map(e => e.text)).toEqual(['a', 'b'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MemoryLogStore truncateLog', () => {
  test('物理截断保留前缀（不重编号）、返回删除数；keepId 越界返回 0', async () => {
    const { store, dir } = makeStore()
    try {
      await store.logAppend([
        { date: '2026-01-01', text: 'a' },
        { date: '2026-01-01', text: 'b' },
        { date: '2026-01-01', text: 'c' },
      ])
      expect((await store.truncateLog(2)).removed).toBe(1)
      expect(await store.logLen()).toBe(2)
      expect((await store.logSlice(0, 2)).map(e => e.text)).toEqual(['a', 'b'])
      // keepId >= T：不删除
      expect((await store.truncateLog(2)).removed).toBe(0)
      expect((await store.truncateLog(0)).removed).toBe(2)
      expect(await store.logLen()).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('非法 keepId（负数/NaN）报可读错误', async () => {
    const { store, dir } = makeStore()
    try {
      await store.logAppend([{ date: '2026-01-01', text: 'a' }])
      await expect(store.truncateLog(-1)).rejects.toThrow(/Invalid keepId/)
      await expect(store.truncateLog(NaN)).rejects.toThrow(/Invalid keepId/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MemoryLogStore deleteRange', () => {
  test('闭区间删除 + 重编号；区间内损坏占位不计入删除数', async () => {
    const { store, dir } = makeStore()
    try {
      await store.logAppend([
        { date: '2026-01-01', text: 'a' },
        { date: '2026-01-01', text: 'b' },
        { date: '2026-01-01', text: 'c' },
        { date: '2026-01-01', text: 'd' },
      ])
      // 位置 1 破坏为占位
      fs.writeFileSync(
        path.join(dir, 'records.jsonl'),
        encodeRecordLine({ id: 0, date: '2026-01-01', text: 'a', version: 1, source: 'note', tags: [] }) +
          '\n' +
          encodeRecordLine({ id: 2, date: '2026-01-01', text: 'c', version: 1, source: 'note', tags: [] }) +
          encodeRecordLine({ id: 3, date: '2026-01-01', text: 'd', version: 1, source: 'note', tags: [] }),
      )
      // 删除 [0,2]：实际删除 a + c（占位不计），剩余 d 重编号为 0
      const result = await store.deleteRange(0, 2)
      expect(result.removed).toBe(2)
      expect(await store.logLen()).toBe(2) // 占位位置保留
      expect((await store.logSlice(0, 2)).map(e => e.text)).toEqual(['d'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('尾部删除截除保留区末尾损坏占位，覆盖已删记忆的越界摘要块被丢弃（M1）', async () => {
    const { store, dir } = makeStore()
    try {
      await store.logAppend([
        { date: '2026-01-01', text: 'a' },
        { date: '2026-01-01', text: 'b' },
        { date: '2026-01-01', text: 'c' },
        { date: '2026-01-01', text: 'd' },
      ])
      await store.treePut(0, 2, 'ab', 'compress')
      await store.treePut(2, 4, 'cd', 'compress')
      // 位置 4、5 外部破坏为占位（空行）
      fs.writeFileSync(
        path.join(dir, 'records.jsonl'),
        encodeRecordLine({ id: 0, date: '2026-01-01', text: 'a', version: 1, source: 'note', tags: [] }) +
          encodeRecordLine({ id: 1, date: '2026-01-01', text: 'b', version: 1, source: 'note', tags: [] }) +
          encodeRecordLine({ id: 2, date: '2026-01-01', text: 'c', version: 1, source: 'note', tags: [] }) +
          encodeRecordLine({ id: 3, date: '2026-01-01', text: 'd', version: 1, source: 'note', tags: [] }) +
          '\n\n',
      )
      // 尾部删除 [3,5]：区间含两个占位 → 实际删除 d；保留区 [a,b,c]
      expect((await store.deleteRange(3, 5)).removed).toBe(1)
      expect(await store.logLen()).toBe(3)
      expect((await store.logSlice(0, 3)).map(e => e.text)).toEqual(['a', 'b', 'c'])
      // 覆盖已删 d 的块 [2,4) 与其上层 [0,4) 被丢弃（越界）；未受影响的前缀块 [0,2) 保留
      expect(await store.treeGet(2, 4)).toBeNull()
      expect(await store.treeGet(0, 4)).toBeNull()
      expect(await store.treeGet(0, 2)).toBe('ab')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('越界/非法输入报错（lo<0、hi>=T、lo>hi、非整数、NaN）', async () => {
    const { store, dir } = makeStore()
    try {
      await store.logAppend([{ date: '2026-01-01', text: 'a' }])
      await expect(store.deleteRange(-1, 0)).rejects.toThrow(/No memory at index -1/)
      await expect(store.deleteRange(0, 1)).rejects.toThrow(/No memory at index 1/)
      await expect(store.deleteRange(1, 0)).rejects.toThrow(/No memory at index 1/)
      await expect(store.deleteRange(0.5, 1)).rejects.toThrow(/Invalid delete range/)
      await expect(store.deleteRange(NaN, 1)).rejects.toThrow(/Invalid delete range/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MemoryLogStore updateEntry', () => {
  test('保留 id/date、version+1、source 审计；空/换行/超长/越界拒绝', async () => {
    const { store, dir } = makeStore()
    try {
      await store.logAppend([{ date: '2026-01-01', text: 'a' }])
      await store.updateEntry(0, 'updated-text', 'update')
      const rec = JSON.parse(fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf-8').trim())
      expect(rec).toMatchObject({ id: 0, date: '2026-01-01', text: 'updated-text', version: 2, source: 'update' })

      await expect(store.updateEntry(0, '   ')).rejects.toThrow(/Empty/)
      await expect(store.updateEntry(0, 'a\nb')).rejects.toThrow(/one line/)
      await expect(store.updateEntry(0, 'x'.repeat(300))).rejects.toThrow(/Too long/)
      await expect(store.updateEntry(5, 'x')).rejects.toThrow(/No memory at index 5/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('同一存储锁内校验 snapshot revision，重编号后的旧 id 不会误改或误删', async () => {
    const { store, dir } = makeStore()
    try {
      await store.logAppend([
        { date: '2026-01-01', text: 'a' },
        { date: '2026-01-01', text: 'b' },
        { date: '2026-01-01', text: 'c' },
      ])
      const stale = await store.listEntriesSnapshot()
      await store.deleteRange(0, 0)

      await expect(store.updateEntry(1, 'wrong', 'update', stale.revision))
        .rejects.toBeInstanceOf(MemoryRevisionConflictError)
      await expect(store.deleteRange(1, 1, stale.revision))
        .rejects.toBeInstanceOf(MemoryRevisionConflictError)

      const current = await store.listEntriesSnapshot()
      expect(current.revision).not.toBe(stale.revision)
      expect(current.entries.map(entry => entry.text)).toEqual(['b', 'c'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MemoryLogStore 树摘要 treePut/treeGet/treeDrop/pending', () => {
  test('重复写入返回 false 不覆盖；缺槽报可操作错误；drop 只删覆盖块；按 lo 升序输出', async () => {
    const { store, dir } = makeStore()
    try {
      await store.logAppend([
        { date: '2026-01-01', text: 'a' },
        { date: '2026-01-01', text: 'b' },
        { date: '2026-01-01', text: 'c' },
        { date: '2026-01-01', text: 'd' },
      ])
      // 目标槽之前的同 size 块缺失 → 可操作错误（不是静默 return false）
      await expect(store.treePut(2, 4, 'cd', 'compress')).rejects.toThrow(/earlier blocks are missing/)
      // 按序写入
      expect(await store.treePut(0, 2, 'ab', 'compress')).toBe(true)
      expect(await store.treePut(2, 4, 'cd', 'compress')).toBe(true)
      // 重复写入返回 false，不覆盖
      expect(await store.treePut(0, 2, 'AB', 'compress')).toBe(false)
      expect(await store.treeGet(0, 2)).toBe('ab')
      expect(await store.treePut(0, 4, 'abcd', 'compress')).toBe(true)

      // pending：T=4 时所有块齐备 → 0
      expect(await store.pendingCount(4)).toBe(0)
      expect(await store.pending(4)).toEqual([])

      // treeDrop [0,2)：丢弃该块及其上层 [0,4)，不连带删除其后块 [2,4)
      const gone = await store.treeDrop(0, 2)
      expect(gone).toEqual([
        [0, 2],
        [0, 4],
      ])
      expect(await store.treeGet(0, 2)).toBeNull()
      expect(await store.treeGet(0, 4)).toBeNull()
      expect(await store.treeGet(2, 4)).toBe('cd')
      expect(await store.pendingCount(4)).toBe(2)

      // 摘要文件按 lo 升序确定性输出
      const lines = fs
        .readFileSync(path.join(dir, 'summaries.jsonl'), 'utf-8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { lo: number })
      expect(lines.map(line => line.lo)).toEqual([2])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MemoryLogStore 旧格式导入路径（store 层直测）', () => {
  test('320B LOG + TREE 槽位导入：legacyId 溯源、meta 统计、旧文件只读保留、新写入续号', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-store-import-'))
    const log = Buffer.concat([0, 1, 2].map(i => legacyRecord(320, i, '2024-01-01', `t${i}`)))
    fs.writeFileSync(path.join(dir, 'LOG.txt'), log)
    fs.mkdirSync(path.join(dir, 'TREE'))
    fs.writeFileSync(path.join(dir, 'TREE', '2'), pad('ab', TREE_REC))
    const logBefore = fs.readFileSync(path.join(dir, 'LOG.txt'))
    try {
      const store = new MemoryLogStore(dir, CONFIG)
      await store.ensureReady()
      expect(await store.logLen()).toBe(3)
      expect((await store.logSlice(0, 3)).map(e => e.text)).toEqual(['t0', 't1', 't2'])
      expect(await store.treeGet(0, 2)).toBe('ab')

      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'))
      expect(meta.formatVersion).toBe(1)
      expect(meta.importedFromLegacy).toMatchObject({
        logRec: 320,
        logImported: 3,
        logSkipped: 0,
        treeImported: 1,
        treeSkipped: 0,
        files: ['2'],
      })

      // LOG.txt 只读保留（字节级不动）
      expect(fs.readFileSync(path.join(dir, 'LOG.txt')).equals(logBefore)).toBe(true)

      // records 首条带 legacyId + source
      const first = JSON.parse(fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf-8').split('\n')[0]!)
      expect(first.legacyId).toBe(0)
      expect(first.source).toBe('legacy-import')

      // 新写入从导入计数继续（id=3）
      expect(await store.logAppend([{ date: '2024-01-02', text: 'new' }])).toBe(3)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('导入幂等：records.jsonl 存在后再次 ensureReady 不重复导入', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-store-import-'))
    const log = Buffer.concat([0, 1].map(i => legacyRecord(LOG_REC, i, '2024-01-01', `t${i}`)))
    fs.writeFileSync(path.join(dir, 'LOG.txt'), log)
    try {
      const store1 = new MemoryLogStore(dir, CONFIG)
      await store1.ensureReady()
      expect(await store1.logLen()).toBe(2)
      const recordsBefore = fs.readFileSync(path.join(dir, 'records.jsonl'))

      const store2 = new MemoryLogStore(dir, CONFIG)
      await store2.ensureReady()
      expect(await store2.logLen()).toBe(2)
      // 文件字节级不变（未重复导入）
      expect(fs.readFileSync(path.join(dir, 'records.jsonl')).equals(recordsBefore)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('meta.json formatVersion 过新：拒绝打开（checkMetaLocked）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-store-import-'))
    try {
      const store = new MemoryLogStore(dir, CONFIG)
      await store.ensureReady() // 建空新格式
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ formatVersion: 999, importedFromLegacy: null }))
      const store2 = new MemoryLogStore(dir, CONFIG)
      await expect(store2.ensureReady()).rejects.toThrow(/formatVersion 999 is newer/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
