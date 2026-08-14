/**
 * EntrySidecarStore 测试：真实临时 dataRoot（原子 tmp+rename 写盘、损坏隔离）。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EntrySidecarStore } from '../../src/stagedDiff/adapters/storage.ts'
import type { StagedEntry } from '../../src/stagedDiff/domain/types.ts'

function makeEntry(id: string, overrides: Partial<StagedEntry> = {}): StagedEntry {
  return {
    id,
    workspaceId: 'ws-test',
    sessionId: 's1',
    path: 'a.md',
    before: null,
    after: 'content',
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides,
  }
}

let dataRoot: string
let storePath: string

beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-staged-store-'))
  storePath = path.join(dataRoot, 'staged-diff', 'entries.json')
})

afterEach(async () => {
  await fs.rm(dataRoot, { recursive: true, force: true })
})

async function corruptFiles(): Promise<string[]> {
  return (await fs.readdir(path.dirname(storePath))).filter(name => name.startsWith('entries.json'))
}

describe('EntrySidecarStore', () => {
  it('空库：文件缺失 load 返回 []', async () => {
    const store = new EntrySidecarStore({ dataRoot })
    expect(await store.load()).toEqual([])
  })

  it('save/load 往返：字段完整保留（before null、toolCallId 可选）', async () => {
    const store = new EntrySidecarStore({ dataRoot })
    const entries = [
      makeEntry('e1', { before: 'old text', toolCallId: 'call-1', status: 'reviewing', revision: 2 }),
      makeEntry('e2', { before: null }),
    ]
    await store.save(entries)
    expect(await store.load()).toEqual(entries)

    // sidecar 确实落盘为版本化信封
    const raw = await fs.readFile(storePath, 'utf8')
    const parsed = JSON.parse(raw) as { version: number; entries: StagedEntry[] }
    expect(parsed.version).toBe(1)
    expect(parsed.entries).toHaveLength(2)
  })

  it('save 原子性：成功后无 .tmp 残留', async () => {
    const store = new EntrySidecarStore({ dataRoot })
    await store.save([makeEntry('e1')])
    await store.save([makeEntry('e1'), makeEntry('e2')])
    const names = await fs.readdir(path.dirname(storePath))
    expect(names.filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(await store.load()).toHaveLength(2)
  })

  it('损坏隔离：非法 JSON → 备份坏文件 + 重建空库（不崩溃），后续 save 正常', async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true })
    await fs.writeFile(storePath, '{definitely not json!!', 'utf8')

    const store = new EntrySidecarStore({ dataRoot })
    expect(await store.load()).toEqual([])

    // 坏文件被备份（原始内容保留，不静默删除）
    const names = await corruptFiles()
    const backup = names.find(name => name.includes('.corrupt-'))
    expect(backup, `backup file among ${names.join(',')}`).toBeDefined()
    expect(await fs.readFile(path.join(path.dirname(storePath), backup!), 'utf8')).toBe('{definitely not json!!')

    // 空库重建后可继续正常读写
    await store.save([makeEntry('e1')])
    expect((await store.load()).map(e => e.id)).toEqual(['e1'])
  })

  it('形状非法（版本不支持 / entries 非数组 / 条目字段非法）同样隔离为空库', async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true })
    const store = new EntrySidecarStore({ dataRoot })

    // 版本不支持
    await fs.writeFile(storePath, JSON.stringify({ version: 2, entries: [] }), 'utf8')
    expect(await store.load()).toEqual([])

    // entries 非数组
    await fs.writeFile(storePath, JSON.stringify({ version: 1, entries: 'nope' }), 'utf8')
    expect(await store.load()).toEqual([])

    // 条目字段非法（id 非字符串）
    await fs.writeFile(storePath, JSON.stringify({ version: 1, entries: [{ id: 123 }] }), 'utf8')
    expect(await store.load()).toEqual([])

    // 非法 status
    await fs.writeFile(
      storePath,
      JSON.stringify({ version: 1, entries: [makeEntry('e1', { status: 'bogus' as never })] }),
      'utf8'
    )
    expect(await store.load()).toEqual([])

    // 每次损坏都留下备份证据
    const backups = (await corruptFiles()).filter(name => name.includes('.corrupt-'))
    expect(backups.length).toBe(4)
  })
})
