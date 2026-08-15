/**
 * memory/forgetBatch 端点契约测试：confirm 门闸、ids 校验/去重、revision CAS、
 * 部分 notFound、成功删除计数与重编号安全（单次扫描批量删除，不误删）。
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
import { MemoryRevisionConflictError } from '../../src/memory/domain/MemoryLogStore.ts'
import {
  GRAY_REMOTE_ERROR_CODES,
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
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-remote-mem-batch-'))
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

async function listTexts(invoke: Env['invoke']): Promise<string[]> {
  const listed = await invoke('memory', 'list', { scope: 'global', limit: 100 })
  if (!listed.ok) throw new Error(`memory/list failed: ${listed.error.code}`)
  return (listed.value as GrayMemoryListResult).items.map(item => item.text)
}

function expectFailure(result: GrayRemoteResult<unknown>, code: string): void {
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe(code)
}

describe('memory/forgetBatch 门闸与入参校验', () => {
  it('confirm 缺失/非 true → GRAY_APPROVAL_REQUIRED（同 forget 语义）', async () => {
    const { invoke } = await makeEnv()
    expectFailure(
      await invoke('memory', 'forgetBatch', { scope: 'global', ids: [0], expectedRevision: 'x' }),
      GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED
    )
    expectFailure(
      await invoke('memory', 'forgetBatch', { scope: 'global', ids: [0], expectedRevision: 'x', confirm: false }),
      GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED
    )
    // confirm 类型错误仍报 INVALID_INPUT（与 forget 一致）
    expectFailure(
      await invoke('memory', 'forgetBatch', { scope: 'global', ids: [0], expectedRevision: 'x', confirm: 'yes' }),
      GRAY_REMOTE_ERROR_CODES.INVALID_INPUT
    )
  })

  it('ids 缺失/空数组/非数组 → GRAY_INVALID_INPUT', async () => {
    const { invoke } = await makeEnv()
    expectFailure(await invoke('memory', 'forgetBatch', { scope: 'global', confirm: true, expectedRevision: 'x' }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
    expectFailure(await invoke('memory', 'forgetBatch', { scope: 'global', ids: [], confirm: true, expectedRevision: 'x' }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
    expectFailure(await invoke('memory', 'forgetBatch', { scope: 'global', ids: '0,1', confirm: true, expectedRevision: 'x' }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })

  it('ids 含非安全/负数整数 → GRAY_INVALID_INPUT', async () => {
    const { invoke } = await makeEnv()
    for (const ids of [[1.5], [1, '2'], [NaN], [Number.MAX_SAFE_INTEGER + 1], [-1]]) {
      expectFailure(
        await invoke('memory', 'forgetBatch', { scope: 'global', ids, confirm: true, expectedRevision: 'x' }),
        GRAY_REMOTE_ERROR_CODES.INVALID_INPUT
      )
    }
  })

  it('缺 expectedRevision → GRAY_INVALID_INPUT', async () => {
    const { invoke } = await makeEnv()
    expectFailure(
      await invoke('memory', 'forgetBatch', { scope: 'global', ids: [0], confirm: true }),
      GRAY_REMOTE_ERROR_CODES.INVALID_INPUT
    )
  })

  it('workspace 写操作缺显式 workspace → GRAY_INVALID_INPUT（不回退宿主 cwd）', async () => {
    const { service, invoke } = await makeEnv()
    const result = await invoke('memory', 'forgetBatch', {
      scope: 'workspace',
      ids: [0],
      expectedRevision: 'x',
      confirm: true,
    })
    expectFailure(result, GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
    if (!result.ok) expect(result.error.details).toMatchObject({ kind: 'workspace-required' })
    expect(await service.getWorkspace(process.cwd(), false)).toBeNull()
  })

  it('workspace store 缺失 → GRAY_NOT_FOUND（kind: workspace-store）', async () => {
    const { invoke } = await makeEnv()
    const workspace = path.join(os.tmpdir(), 'missing-batch-ws')
    const result = await invoke('memory', 'forgetBatch', {
      scope: 'workspace',
      workspace,
      ids: [0],
      expectedRevision: 'x',
      confirm: true,
    })
    expectFailure(result, GRAY_REMOTE_ERROR_CODES.NOT_FOUND)
    if (!result.ok) expect(result.error.details).toMatchObject({ kind: 'workspace-store', workspace })
  })
})

describe('memory/forgetBatch 删除语义', () => {
  it('成功批量删除：返回 removed 计数，其余条目重编号且不误删', async () => {
    const { service, invoke } = await makeEnv()
    for (const text of ['a', 'b', 'c', 'd', 'e']) await note(service, text)
    // 删除 #1(b) 与 #3(d)：单次扫描按位置 id 集合删除，不能误删重编号后的其他条目
    const result = await invoke('memory', 'forgetBatch', {
      scope: 'global',
      ids: [1, 3],
      expectedRevision: await currentRevision(invoke),
      confirm: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ removed: 2, notFound: [] })
    }
    expect(await listTexts(invoke)).toEqual(['e', 'c', 'a'])
  })

  it('ids 去重：重复 id 只删一次', async () => {
    const { service, invoke } = await makeEnv()
    await note(service, 'a')
    await note(service, 'b')
    const result = await invoke('memory', 'forgetBatch', {
      scope: 'global',
      ids: [1, 1, 0, 1],
      expectedRevision: await currentRevision(invoke),
      confirm: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ removed: 2, notFound: [] })
    expect(await listTexts(invoke)).toEqual([])
  })

  it('部分不存在 → notFound 列表，存在的照删', async () => {
    const { service, invoke } = await makeEnv()
    await note(service, 'keep-me')
    await note(service, 'delete-me')
    const result = await invoke('memory', 'forgetBatch', {
      scope: 'global',
      ids: [0, 99, 1],
      expectedRevision: await currentRevision(invoke),
      confirm: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ removed: 2, notFound: [99] })
    }
    expect(await listTexts(invoke)).toEqual([])
  })

  it('全部不存在 → { removed: 0, notFound: 全量 }（不报错）', async () => {
    const { service, invoke } = await makeEnv()
    await note(service, 'only')
    const result = await invoke('memory', 'forgetBatch', {
      scope: 'global',
      ids: [7, 8],
      expectedRevision: await currentRevision(invoke),
      confirm: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ removed: 0, notFound: [7, 8] })
    }
    expect(await listTexts(invoke)).toEqual(['only'])
  })

  it('revision 冲突（过期 expectedRevision）→ GRAY_CONFLICT 且不删除任何条目', async () => {
    const { service, invoke } = await makeEnv()
    await note(service, 'a')
    await note(service, 'b')
    const staleRevision = await currentRevision(invoke)
    // 并发写入使 revision 过期
    await note(service, 'c')
    const result = await invoke('memory', 'forgetBatch', {
      scope: 'global',
      ids: [0, 1],
      expectedRevision: staleRevision,
      confirm: true,
    })
    expectFailure(result, GRAY_REMOTE_ERROR_CODES.CONFLICT)
    if (!result.ok) {
      expect(result.error.details).toMatchObject({
        kind: 'memory-revision',
        reason: 'stale',
        restartRequired: true,
      })
    }
    // 无条目被删除
    expect(await listTexts(invoke)).toEqual(['c', 'b', 'a'])
  })

  it('workspace 作用域批量删除（写路径已创建 store）', async () => {
    const { service, invoke } = await makeEnv()
    const cwd = path.join(os.tmpdir(), 'batch-ws')
    // 通过 note 写路径创建 workspace store 并写入两条
    const created = await invoke('memory', 'note', { scope: 'workspace', workspace: cwd, text: 'ws-a' })
    expect(created.ok).toBe(true)
    const created2 = await invoke('memory', 'note', { scope: 'workspace', workspace: cwd, text: 'ws-b' })
    expect(created2.ok).toBe(true)

    const listed = await invoke('memory', 'list', { scope: 'workspace', workspace: cwd })
    if (!listed.ok) throw new Error('workspace list failed')
    const revision = (listed.value as GrayMemoryListResult).revision

    const result = await invoke('memory', 'forgetBatch', {
      scope: 'workspace',
      workspace: cwd,
      ids: [0, 1],
      expectedRevision: revision,
      confirm: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ removed: 2, notFound: [] })

    const after = await invoke('memory', 'list', { scope: 'workspace', workspace: cwd })
    if (after.ok) {
      expect((after.value as GrayMemoryListResult).items).toHaveLength(0)
    }
  })

  it('空 store（0 条）批量删除任意 id → notFound 全量', async () => {
    const { invoke } = await makeEnv()
    const result = await invoke('memory', 'forgetBatch', {
      scope: 'global',
      ids: [0],
      expectedRevision: await currentRevision(invoke),
      confirm: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ removed: 0, notFound: [0] })
  })
})

describe('memory/forgetBatch 锁内 CAS（快照校验与删除同锁）', () => {
  it('快照后并发单删 → deleteEntries 锁内 revision 断言拒绝（GRAY_CONFLICT，零删除）', async () => {
    const { service, invoke } = await makeEnv()
    await note(service, 'a')
    await note(service, 'b')
    await note(service, 'c')
    const snapshot = await (await service.getGlobal()).listEntriesSnapshot()
    // 模拟并发：快照后另一请求删除 [0]，重编号使位置 id 语义失效
    const concurrent = await invoke('memory', 'forget', {
      scope: 'global',
      blockId: '0',
      expectedRevision: snapshot.revision,
      confirm: true,
    })
    expect(concurrent.ok).toBe(true)
    // 客户端用旧快照 revision 提交批量删除 → 锁内断言拦截，绝不重算后误删
    const result = await invoke('memory', 'forgetBatch', {
      scope: 'global',
      ids: [1],
      expectedRevision: snapshot.revision,
      confirm: true,
    })
    expectFailure(result, GRAY_REMOTE_ERROR_CODES.CONFLICT)
    // 零删除：剩余仍是并发删除后的状态（'c', 'b'）
    expect(await listTexts(invoke)).toEqual(['c', 'b'])
  })

  it('deleteEntries 直接调用携带旧 revision → MemoryRevisionConflictError', async () => {
    const { service } = await makeEnv()
    await note(service, 'a')
    await note(service, 'b')
    const mgr = await service.getGlobal()
    const snapshot = await mgr.listEntriesSnapshot()
    await mgr.deleteEntry(1, snapshot.revision)
    // 锁内 CAS：store 用旧 revision 断言当前记录数组 → MemoryRevisionConflictError
    //（与 memoryLogStore.spec.ts 的断言口径一致：按错误类而非消息文本）。
    await expect(mgr.deleteEntries([0], snapshot.revision)).rejects.toMatchObject({
      name: 'MemoryRevisionConflictError',
      expectedRevision: snapshot.revision,
    })
    // 零删除：deleteEntry(1) 后只剩 'a'，deleteEntries 未误删。
    expect(await mgr.listEntries()).toEqual([{ id: 0, date: expect.any(String), text: 'a' }])
  })
})
