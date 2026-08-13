/**
 * logFormat 编解码 round-trip + 撕裂记录 + 320→1024 LOG 迁移测试
 * （改自 gray-code-plugin backend/__tests__/memory/logMigration.test.ts）
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { describe, expect, test } from 'vitest'
import { pad, parse, records, OLD_LOG_REC } from '../../src/memory/domain/logFormat.ts'
import { LOG_REC } from '../../src/memory/domain/types.ts'
import { MemoryManager } from '../../src/memory/domain/MemoryManager.ts'

describe('logFormat pad/parse/records', () => {
  test('pad 填充为固定宽度记录（空格填充 + 结尾换行），parse 可完整还原', () => {
    const buf = pad('#3 2024-01-01 hello', LOG_REC)
    expect(buf.length).toBe(LOG_REC)
    expect(buf[LOG_REC - 1]).toBe(0x0a)
    const entry = parse(buf.toString('utf-8').trimEnd())
    expect(entry).toEqual({ id: 3, date: '2024-01-01', text: 'hello' })
  })

  test('多字节文本（UTF-8）round-trip 不损坏', () => {
    const text = '记忆-β 中文内容'
    const entry = parse(pad(`#0 2024-01-01 ${text}`, LOG_REC).toString('utf-8').trimEnd())
    expect(entry?.text).toBe(text)
  })

  test('pad 拒绝超出记录宽度的文本', () => {
    expect(() => pad('x'.repeat(LOG_REC), LOG_REC)).toThrow(/Too long/)
  })

  test('损坏行（无空格头部/非数字 id/缺 text）返回 null', () => {
    expect(parse('garbage-no-header')).toBeNull()
    expect(parse('#abc 2024-01-01 text')).toBeNull()
    expect(parse('#1 2024-01-01')).toBeNull()
  })

  test('records 只解析完整记录：撕裂尾部半条记录被忽略', () => {
    const good = pad('#0 2024-01-01 a', LOG_REC)
    const buf = Buffer.concat([good, Buffer.from('partial-garbage-tail')])
    const entries = records(buf, LOG_REC)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.text).toBe('a')
  })
})

describe('MemoryManager LOG 旧格式（320B/条）→ 新格式（1024B/条）迁移', () => {
  /** 构造一条旧格式记录（320B：「#id date text」+ 空格填充 + 换行） */
  function oldRecord(id: number, date: string, text: string): Buffer {
    const rec = Buffer.alloc(OLD_LOG_REC)
    const line = Buffer.from(`#${id} ${date} ${text}`, 'utf-8')
    if (line.length > OLD_LOG_REC - 1) throw new Error(`fixture too long: ${line.length} bytes`)
    line.copy(rec)
    rec.fill(0x20, line.length, OLD_LOG_REC - 1)
    rec[OLD_LOG_REC - 1] = 0x0a
    return rec
  }

  function makeOldLog(texts: string[], tail?: Buffer): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-migrate-'))
    const records_ = texts.map((t, i) => oldRecord(i, '2024-01-01', t))
    fs.writeFileSync(path.join(dir, 'LOG.txt'), Buffer.concat([...records_, ...(tail ? [tail] : [])]))
    return dir
  }

  function readNewFormat(dir: string): Array<{ id: number; date: string; text: string }> {
    const buf = fs.readFileSync(path.join(dir, 'LOG.txt'))
    const out: Array<{ id: number; date: string; text: string }> = []
    for (let i = 0; i + LOG_REC <= buf.length; i += LOG_REC) {
      const str = buf.subarray(i, i + LOG_REC).toString('utf-8').trimEnd()
      if (!str) continue
      const m = str.match(/^#(\d+) (\S+) (.+)$/)
      if (m) out.push({ id: parseInt(m[1]!, 10), date: m[2]!, text: m[3]! })
    }
    return out
  }

  test('旧格式文件：打开后数据无损（含多字节文本），文件被重写为新格式', async () => {
    const texts = ['alpha', 'x'.repeat(270), '记忆-β']
    const dir = makeOldLog(texts)
    try {
      const mm = new MemoryManager(dir)
      await mm.init()
      const entries = await mm.listEntries() // 读取触发迁移
      expect(entries.map(e => e.text)).toEqual(texts)
      expect(entries.map(e => e.id)).toEqual([0, 1, 2])
      expect(entries.every(e => e.date === '2024-01-01')).toBe(true)

      const buf = fs.readFileSync(path.join(dir, 'LOG.txt'))
      expect(buf.length % LOG_REC).toBe(0)
      expect(buf.length % OLD_LOG_REC).not.toBe(0)
      expect(readNewFormat(dir).map(e => e.text)).toEqual(texts)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('旧格式 + 撕裂尾巴：完整记录无损迁移，撕裂尾巴被丢弃', async () => {
    const dir = makeOldLog(['a', 'b'], Buffer.from('partial-garbage-tail'))
    try {
      const mm = new MemoryManager(dir)
      await mm.init()
      expect((await mm.listEntries()).map(e => e.text)).toEqual(['a', 'b'])
      const buf = fs.readFileSync(path.join(dir, 'LOG.txt'))
      expect(buf.length % LOG_REC).toBe(0)
      expect(readNewFormat(dir).map(e => e.text)).toEqual(['a', 'b'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('歧义尺寸（5120 = 16×320 = 5×1024）：内容判别，旧格式正确迁移', async () => {
    const texts = Array.from({ length: 16 }, (_, i) => `memory-${i}`)
    const dir = makeOldLog(texts)
    try {
      const mm = new MemoryManager(dir)
      await mm.init()
      expect((await mm.listEntries()).map(e => e.text)).toEqual(texts)
      expect(fs.statSync(path.join(dir, 'LOG.txt')).size).toBe(16 * LOG_REC)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('320 对齐但内容非旧格式（垃圾）：不迁移、不抛错（fail-open）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-migrate-'))
    try {
      const garbage = Buffer.alloc(320, 0x58) // 'X' × 320
      fs.writeFileSync(path.join(dir, 'LOG.txt'), garbage)
      const mm = new MemoryManager(dir)
      await mm.init()
      expect(await mm.listEntries()).toHaveLength(0)
      expect(fs.readFileSync(path.join(dir, 'LOG.txt')).equals(garbage)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('迁移后可正常追加/编辑/删除', async () => {
    const dir = makeOldLog(['a', 'b', 'c'])
    try {
      const mm = new MemoryManager(dir)
      await mm.init()
      await mm.listEntries() // 迁移
      expect((await mm.note('d')).id).toBe(3)
      await mm.updateEntry(0, 'A')
      expect((await mm.listEntries()).map(e => e.text)).toEqual(['A', 'b', 'c', 'd'])
      await mm.deleteEntry(1)
      expect((await mm.listEntries()).map(e => e.text)).toEqual(['A', 'c', 'd'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
