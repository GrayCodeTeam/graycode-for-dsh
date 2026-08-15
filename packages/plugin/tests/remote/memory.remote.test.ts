/**
 * memory Remote 端点契约测试（list/edit/forget/config，含审批门闸与稳定错误码）。
 * 通过 GrayRemoteService.invoke 走完整信封路径（业务错误永不 reject）。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemoryService } from '../../src/memory/service.ts'
import { createMemoryRemoteHandlers } from '../../src/memory/adapters/dsh/remote.ts'
import { GrayRemoteService } from '../../src/remote/service.ts'
import {
  GRAY_REMOTE_ERROR_CODES,
  type GrayMemoryEntryView,
  type GrayMemoryListResult,
  type GrayRemoteResult,
} from '../../src/remote/types.ts'

const tempDirs: string[] = []

interface Env {
  service: MemoryService
  invoke: (
    namespace: string,
    method: string,
    args?: Record<string, unknown>
  ) => Promise<GrayRemoteResult<unknown>>
}

async function makeEnv(): Promise<Env> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-remote-mem-'))
  tempDirs.push(dataRoot)
  const service = new MemoryService({ dataRoot, wakeLines: 96, entryChars: 280, partChars: 20000, partLines: 500 })
  const remote = new GrayRemoteService(new Context())
  remote.register(createMemoryRemoteHandlers(service))
  return { service, invoke: (ns, method, args) => remote.invoke(ns, method, args) }
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function note(service: MemoryService, text: string): Promise<number> {
  const mgr = await service.getGlobal()
  const result = await mgr.note(text)
  return result.id
}

async function currentRevision(invoke: Env['invoke']): Promise<string> {
  const listed = await invoke('memory', 'list', { scope: 'global' })
  if (!listed.ok) throw new Error(`memory/list failed: ${listed.error.code}`)
  return (listed.value as GrayMemoryListResult).revision
}

function expectFailure(result: GrayRemoteResult<unknown>, code: string): void {
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe(code)
}

describe('memory/list', () => {
  it('返回全部条目（最新在前）+ total + 分页游标', async () => {
    const { service, invoke } = await makeEnv()
    const id1 = await note(service, 'first memory')
    const id2 = await note(service, 'second memory')

    const page1 = await invoke('memory', 'list', { scope: 'global', limit: 1 })
    expect(page1.ok).toBe(true)
    let cursor: string | undefined
    if (page1.ok) {
      const value = page1.value as GrayMemoryListResult
      expect(value.total).toBe(2)
      expect(value.revision).toMatch(/^sha256:/)
      expect(value.nextCursor).toEqual(expect.any(String))
      expect(value.nextCursor).not.toBe(String(id2))
      expect(value.items).toHaveLength(1)
      expect(value.items[0]).toMatchObject({ id: id2, text: 'second memory' })
      cursor = value.nextCursor
    }

    const page2 = await invoke('memory', 'list', { scope: 'global', cursor, limit: 1 })
    if (page2.ok) {
      const value = page2.value as GrayMemoryListResult
      expect(value.items).toHaveLength(1)
      expect(value.items[0]).toMatchObject({ id: id1, text: 'first memory' })
      expect(value.nextCursor).toBeUndefined()
    }
  })

  it('opaque cursor 在列表不变时稳定续页，并拒绝旧 numeric / 畸形 cursor', async () => {
    const { service, invoke } = await makeEnv()
    await note(service, 'first')
    await note(service, 'second')

    expectFailure(
      await invoke('memory', 'list', { scope: 'global', cursor: 1, limit: 1 }),
      GRAY_REMOTE_ERROR_CODES.INVALID_INPUT
    )
    const malformed = await invoke('memory', 'list', { scope: 'global', cursor: 'not-a-cursor', limit: 1 })
    expectFailure(malformed, GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
    if (!malformed.ok) {
      expect(malformed.error.details).toMatchObject({ kind: 'memory-cursor', reason: 'malformed' })
    }
  })

  it('删除导致 positional id 重编号时，旧 cursor 明确冲突；刷新后不重复也不漏项', async () => {
    const { service, invoke } = await makeEnv()
    for (const text of ['a', 'b', 'c', 'd', 'e', 'f']) await note(service, text)

    const first = await invoke('memory', 'list', { scope: 'global', limit: 2 })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const firstPage = first.value as GrayMemoryListResult
    expect(firstPage.items.map(item => [item.text, item.id])).toEqual([['f', 5], ['e', 4]])
    expect(firstPage.nextCursor).toEqual(expect.any(String))

    // 删除旧 #0 后 e 会从 #4 重编号为 #3；旧的 id cursor 会把 e 再返回一次。
    const manager = await service.getGlobal()
    await manager.deleteEntry(0)

    const continued = await invoke('memory', 'list', {
      scope: 'global',
      cursor: firstPage.nextCursor,
      limit: 2,
    })
    expectFailure(continued, GRAY_REMOTE_ERROR_CODES.CONFLICT)
    if (!continued.ok) {
      expect(continued.error.details).toMatchObject({
        kind: 'memory-cursor',
        reason: 'stale',
        restartRequired: true,
      })
    }

    // 客户端收到 restartRequired 后替换首屏；新快照只出现当前五条且顺序完整。
    const refreshed = await invoke('memory', 'list', { scope: 'global', limit: 20 })
    expect(refreshed.ok).toBe(true)
    if (refreshed.ok) {
      const texts = (refreshed.value as GrayMemoryListResult).items.map(item => item.text)
      expect(texts).toEqual(['f', 'e', 'd', 'c', 'b'])
      expect(new Set(texts).size).toBe(texts.length)
    }
  })

  it('cursor 绑定 search 查询，即使结果碰巧相同也不能跨查询复用', async () => {
    const { service, invoke } = await makeEnv()
    await note(service, 'alpha beta one')
    await note(service, 'alpha beta two')
    const first = await invoke('memory', 'list', { scope: 'global', search: 'alpha', limit: 1 })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const result = await invoke('memory', 'list', {
      scope: 'global',
      search: 'beta',
      cursor: (first.value as GrayMemoryListResult).nextCursor,
      limit: 1,
    })
    expectFailure(result, GRAY_REMOTE_ERROR_CODES.CONFLICT)
  })

  it('search 大小写不敏感子串过滤', async () => {
    const { service, invoke } = await makeEnv()
    await note(service, 'Alpha Beta')
    await note(service, 'gamma')
    const result = await invoke('memory', 'list', { scope: 'global', search: 'alpha' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const value = result.value as GrayMemoryListResult
      expect(value.total).toBe(1)
      expect(value.items[0]!.text).toBe('Alpha Beta')
    }
  })

  it('非法 scope / 缺失 workspace → GRAY_INVALID_INPUT', async () => {
    const { invoke } = await makeEnv()
    expectFailure(await invoke('memory', 'list', { scope: 'bogus' }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
    expectFailure(await invoke('memory', 'list', { scope: 'workspace' }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })

  it('workspace scope 未创建过 → GRAY_NOT_FOUND（只读不创建）', async () => {
    const { invoke } = await makeEnv()
    const cwd = path.join(os.tmpdir(), 'never-written-ws')
    const result = await invoke('memory', 'list', { scope: 'workspace', workspace: cwd })
    expectFailure(result, GRAY_REMOTE_ERROR_CODES.NOT_FOUND)
    if (!result.ok) expect(result.error.details).toMatchObject({ kind: 'workspace-store', workspace: cwd })
  })

  it('limit 非法类型 → GRAY_INVALID_INPUT；超限收敛', async () => {
    const { service, invoke } = await makeEnv()
    await note(service, 'one')
    expectFailure(await invoke('memory', 'list', { limit: 'x' }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
    const result = await invoke('memory', 'list', { limit: 10_000 })
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.value as GrayMemoryListResult).items.length).toBeGreaterThanOrEqual(1)
  })
})

describe('memory/note', () => {
  it('手动新增一条 global 记忆，返回 id/date/text', async () => {
    const { invoke } = await makeEnv()
    const result = await invoke('memory', 'note', { scope: 'global', text: '  manual note  ' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const value = result.value as GrayMemoryEntryView
      expect(value.id).toBe(0)
      expect(value.text).toBe('manual note')
      expect(value.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    const list = await invoke('memory', 'list', { scope: 'global' })
    if (list.ok) {
      expect((list.value as GrayMemoryListResult).items[0]!.text).toBe('manual note')
    }
  })

  it('workspace scope 写入路径创建缺失存储（与只读 list 不同）', async () => {
    const { invoke } = await makeEnv()
    const cwd = path.join(os.tmpdir(), 'note-created-ws')
    const result = await invoke('memory', 'note', { scope: 'workspace', workspace: cwd, text: 'ws note' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toMatchObject({ text: 'ws note' })
    }
    const list = await invoke('memory', 'list', { scope: 'workspace', workspace: cwd })
    if (list.ok) {
      expect((list.value as GrayMemoryListResult).items[0]!.text).toBe('ws note')
    }
  })

  it('缺 text / 空文本 / 多行 / 超长 → GRAY_INVALID_INPUT', async () => {
    const { invoke } = await makeEnv()
    expectFailure(await invoke('memory', 'note', { scope: 'global' }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
    expectFailure(await invoke('memory', 'note', { scope: 'global', text: '   ' }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
    expectFailure(await invoke('memory', 'note', { scope: 'global', text: 'two\nlines' }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
    expectFailure(
      await invoke('memory', 'note', { scope: 'global', text: '长'.repeat(1000) }),
      GRAY_REMOTE_ERROR_CODES.INVALID_INPUT
    )
  })

  it('workspace 写操作缺显式 workspace 全部拒绝，绝不回退宿主 cwd', async () => {
    const { service, invoke } = await makeEnv()
    const calls: Array<[string, Record<string, unknown>]> = [
      ['note', { scope: 'workspace', text: 'x' }],
      ['edit', { scope: 'workspace', id: 0, text: 'x' }],
      ['forget', { scope: 'workspace', blockId: '0', confirm: true }],
      ['configUpdate', { scope: 'workspace', updates: { entryChars: 300 } }],
    ]
    for (const [method, args] of calls) {
      const result = await invoke('memory', method, args)
      expectFailure(result, GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
      if (!result.ok) expect(result.error.details).toMatchObject({ kind: 'workspace-required' })
    }
    expect(await service.getWorkspace(process.cwd(), false)).toBeNull()
  })

  it('workspace store 缺失与具体 entry 缺失可由 details.kind 区分', async () => {
    const { service, invoke } = await makeEnv()
    const workspace = path.join(os.tmpdir(), 'missing-memory-store-for-edit')
    const missingStore = await invoke('memory', 'edit', {
      scope: 'workspace',
      workspace,
      id: 0,
      text: 'x',
    })
    expectFailure(missingStore, GRAY_REMOTE_ERROR_CODES.NOT_FOUND)
    if (!missingStore.ok) expect(missingStore.error.details).toMatchObject({ kind: 'workspace-store', workspace })
    expect(await service.getWorkspace(workspace, false)).toBeNull()

    const missingEntry = await invoke('memory', 'edit', {
      scope: 'global',
      id: 999,
      text: 'x',
      expectedRevision: await currentRevision(invoke),
    })
    expectFailure(missingEntry, GRAY_REMOTE_ERROR_CODES.NOT_FOUND)
    if (!missingEntry.ok) expect(missingEntry.error.details).toMatchObject({ kind: 'memory-entry', id: 999 })
  })
})

describe('memory/edit', () => {
  it('原地覆写文本（保留 id）', async () => {
    const { service, invoke } = await makeEnv()
    const id = await note(service, 'old text')
    const result = await invoke('memory', 'edit', {
      scope: 'global',
      id,
      text: 'new text',
      expectedRevision: await currentRevision(invoke),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toMatchObject({ id, text: 'new text' })
    }
    const list = await invoke('memory', 'list', { scope: 'global' })
    if (list.ok) {
      expect((list.value as GrayMemoryListResult).items[0]!.text).toBe('new text')
    }
  })

  it('不存在的 id → GRAY_NOT_FOUND；超长文本 → GRAY_INVALID_INPUT', async () => {
    const { service, invoke } = await makeEnv()
    expectFailure(await invoke('memory', 'edit', {
      scope: 'global',
      id: 999,
      text: 'x',
      expectedRevision: await currentRevision(invoke),
    }), GRAY_REMOTE_ERROR_CODES.NOT_FOUND)
    const id = await note(service, 'short')
    const longText = '长'.repeat(1000)
    expectFailure(await invoke('memory', 'edit', {
      scope: 'global',
      id,
      text: longText,
      expectedRevision: await currentRevision(invoke),
    }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })

  it('删除导致 id 重编号后，旧 revision 的编辑和删除都冲突且不触碰新位置条目', async () => {
    const { service, invoke } = await makeEnv()
    for (const text of ['a', 'b', 'c']) await note(service, text)
    const staleRevision = await currentRevision(invoke)

    // 原 #1 是 b；删除 #0 后，位置 #1 已经变成 c。
    const manager = await service.getGlobal()
    await manager.deleteEntry(0)

    const edit = await invoke('memory', 'edit', {
      scope: 'global',
      id: 1,
      text: 'must-not-overwrite-c',
      expectedRevision: staleRevision,
    })
    expectFailure(edit, GRAY_REMOTE_ERROR_CODES.CONFLICT)
    if (!edit.ok) {
      expect(edit.error.details).toMatchObject({
        kind: 'memory-revision',
        reason: 'stale',
        restartRequired: true,
      })
    }

    const forget = await invoke('memory', 'forget', {
      scope: 'global',
      blockId: '1',
      expectedRevision: staleRevision,
      confirm: true,
    })
    expectFailure(forget, GRAY_REMOTE_ERROR_CODES.CONFLICT)

    const current = await invoke('memory', 'list', { scope: 'global' })
    expect(current.ok).toBe(true)
    if (current.ok) {
      expect((current.value as GrayMemoryListResult).items.map(item => item.text)).toEqual(['c', 'b'])
    }
  })
})

describe('memory/forget', () => {
  it('confirm 缺失/非 true → GRAY_APPROVAL_REQUIRED（确认语义）', async () => {
    const { invoke } = await makeEnv()
    expectFailure(await invoke('memory', 'forget', { scope: 'global', blockId: '5' }), GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED)
    expectFailure(await invoke('memory', 'forget', { scope: 'global', blockId: '5', confirm: false }), GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED)
  })

  it('单 id 删除一条原始记忆（confirm: true）；删除后其余条目重编号', async () => {
    const { service, invoke } = await makeEnv()
    const id = await note(service, 'doomed')
    await note(service, 'kept')
    const result = await invoke('memory', 'forget', {
      scope: 'global',
      blockId: String(id),
      expectedRevision: await currentRevision(invoke),
      confirm: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toMatchObject({ mode: 'single', removed: 1 })
    }
    const list = await invoke('memory', 'list', { scope: 'global' })
    if (list.ok) {
      const items = (list.value as GrayMemoryListResult).items
      expect(items.map(e => e.text)).not.toContain('doomed')
      expect(items.map(e => e.text)).toContain('kept')
      expect(items).toHaveLength(1)
    }
  })

  it('闭区间 "lo,hi" 批量删除；lo>hi → GRAY_INVALID_INPUT', async () => {
    const { service, invoke } = await makeEnv()
    await note(service, 'a')
    await note(service, 'b')
    const result = await invoke('memory', 'forget', {
      scope: 'global',
      blockId: '0,1',
      expectedRevision: await currentRevision(invoke),
      confirm: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toMatchObject({ mode: 'range', removed: 2 })
    }
    const list = await invoke('memory', 'list', { scope: 'global' })
    if (list.ok) {
      expect((list.value as GrayMemoryListResult).items).toHaveLength(0)
    }
    expectFailure(await invoke('memory', 'forget', { scope: 'global', blockId: '5,2', confirm: true }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })

  it('树摘要模式：非法块 → GRAY_INVALID_INPUT；合法块无摘要 → GRAY_NOT_FOUND', async () => {
    const { invoke } = await makeEnv()
    expectFailure(await invoke('memory', 'forget', { scope: 'global', blockId: '7-9', confirm: true }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
    expectFailure(await invoke('memory', 'forget', { scope: 'global', blockId: '16-31', confirm: true }), GRAY_REMOTE_ERROR_CODES.NOT_FOUND)
  })

  it('删除不存在的单条 → GRAY_NOT_FOUND', async () => {
    const { invoke } = await makeEnv()
    expectFailure(await invoke('memory', 'forget', {
      scope: 'global',
      blockId: '42',
      expectedRevision: await currentRevision(invoke),
      confirm: true,
    }), GRAY_REMOTE_ERROR_CODES.NOT_FOUND)
  })
})

describe('memory/configGet / configUpdate', () => {
  it('读取共享配置；更新后持久化并反映到读取', async () => {
    const { invoke } = await makeEnv()
    const before = await invoke('memory', 'configGet', { scope: 'global' })
    expect(before.ok).toBe(true)
    if (before.ok) {
      expect(before.value).toMatchObject({ entryChars: 280 })
    }
    const updated = await invoke('memory', 'configUpdate', { scope: 'global', updates: { entryChars: 320 } })
    expect(updated.ok).toBe(true)
    if (updated.ok) {
      expect((updated.value as { entryChars: number }).entryChars).toBe(320)
    }
    const after = await invoke('memory', 'configGet', { scope: 'global' })
    if (after.ok) {
      expect((after.value as { entryChars: number }).entryChars).toBe(320)
    }
  })

  it('越界更新 → GRAY_INVALID_INPUT', async () => {
    const { invoke } = await makeEnv()
    expectFailure(await invoke('memory', 'configUpdate', { scope: 'global', updates: { entryChars: 5000 } }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })
})
