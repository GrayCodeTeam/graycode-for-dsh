/**
 * ProjectionJournal 契约测试：环形缓冲、订阅、sidecar 回放、损坏行隔离、滚动。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectionJournal } from '../../src/remote/projection.ts'

const tempDirs: string[] = []

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-projection-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('ProjectionJournal（内存）', () => {
  it('record 写入并通知订阅者；退订后不再通知', async () => {
    const journal = new ProjectionJournal()
    const seen: unknown[] = []
    const off = journal.on(entry => seen.push(entry))
    await journal.record('query:test', { ok: true })
    await journal.record('query:test2', { ok: false })
    expect(seen).toHaveLength(2)
    off()
    await journal.record('query:test3', { ok: true })
    expect(seen).toHaveLength(2)

    const replay = await journal.replay()
    expect(replay.map(e => e.kind)).toEqual(['query:test', 'query:test2', 'query:test3'])
    expect(replay[0]!.seq).toBe(1)
    expect(replay[2]!.seq).toBe(3)
    expect(replay.every(e => typeof e.at === 'number')).toBe(true)
  })

  it('环形缓冲按 maxEntries 截断（保留最新）', async () => {
    const journal = new ProjectionJournal({ maxEntries: 3 })
    for (let i = 1; i <= 5; i++) {
      await journal.record(`kind-${i}`, i)
    }
    const replay = await journal.replay()
    expect(replay).toHaveLength(3)
    expect(replay.map(e => e.kind)).toEqual(['kind-3', 'kind-4', 'kind-5'])
  })

  it('监听器抛错不影响其余订阅者与记录', async () => {
    const journal = new ProjectionJournal()
    const seen: string[] = []
    journal.on(() => {
      throw new Error('listener boom')
    })
    journal.on(entry => seen.push(entry.kind))
    await journal.record('kind-a', {})
    expect(seen).toEqual(['kind-a'])
  })
})

describe('ProjectionJournal（sidecar 回放通道）', () => {
  it('record 落盘；同路径新实例 replay 合并（按 seq 去重升序）', async () => {
    const dir = await tmpDir()
    const journalPath = path.join(dir, 'projections.jsonl')
    const a = new ProjectionJournal({ journalPath })
    await a.record('k1', 1)
    await a.record('k2', 2)
    // 等待串行写链完成
    await new Promise(resolve => setTimeout(resolve, 20))

    const b = new ProjectionJournal({ journalPath })
    const replay = await b.replay()
    expect(replay.map(e => e.kind)).toEqual(['k1', 'k2'])
    expect(replay.map(e => e.seq)).toEqual([1, 2])

    // 续写 seq 递增（新实例 seq 从 0 起但文件 seq 更大 → 合并取最大）
    await b.record('k3', 3)
    await new Promise(resolve => setTimeout(resolve, 20))
    const c = new ProjectionJournal({ journalPath })
    const replay2 = await c.replay()
    expect(replay2.map(e => e.kind)).toEqual(['k1', 'k2', 'k3'])
  })

  it('损坏行跳过不阻塞回放（尽力通道）', async () => {
    const dir = await tmpDir()
    const journalPath = path.join(dir, 'projections.jsonl')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(journalPath, '{"seq":1,"kind":"ok","at":1,"payload":1}\nnot-json-line\n{"seq":3,"kind":"ok2","at":3,"payload":3}\n', 'utf8')
    const journal = new ProjectionJournal({ journalPath })
    const replay = await journal.replay()
    expect(replay.map(e => e.kind)).toEqual(['ok', 'ok2'])
  })

  it('行数超上限后滚动（保留后半）', async () => {
    const dir = await tmpDir()
    const journalPath = path.join(dir, 'projections.jsonl')
    const journal = new ProjectionJournal({ journalPath, maxFileLines: 8 })
    for (let i = 1; i <= 12; i++) {
      await journal.record(`k-${i}`, i)
    }
    await new Promise(resolve => setTimeout(resolve, 30))
    const replay = await journal.replay()
    // 12 行 → 保留最后 4 行（maxFileLines/2），但内存环还有 12 条 → 合并后应含全部 12
    expect(replay).toHaveLength(12)
    // 文件行数已被压缩
    const content = await fs.readFile(journalPath, 'utf8')
    const lineCount = content.split('\n').filter(Boolean).length
    expect(lineCount).toBeLessThanOrEqual(8)
    expect(lineCount).toBeGreaterThan(0)
  })

  it('clear 清空内存与 sidecar', async () => {
    const dir = await tmpDir()
    const journalPath = path.join(dir, 'projections.jsonl')
    const journal = new ProjectionJournal({ journalPath })
    await journal.record('k1', 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    await journal.clear()
    expect(await journal.replay()).toHaveLength(0)
    await expect(fs.stat(journalPath)).rejects.toThrow()
  })
})
