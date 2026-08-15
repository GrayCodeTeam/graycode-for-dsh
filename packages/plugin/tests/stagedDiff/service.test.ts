/**
 * StagedDiffService 用例测试：内存假存储 + 假落盘端口（不触碰真实 fs）。
 *
 * 覆盖：createEntry 幂等、listEntries/reviewBatch 批视图、acceptEntry（CAS 冲突、
 * 落盘失败保持 accepted 可重试、落盘成功才置 done）、rejectEntry（不落盘、冲突
 * 策略）、restoreFromSidecar 重启重建（accepted 未落盘 → needs-reapply）。
 */
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { StagedDiffService, createStagedWorkspaceId } from '../../src/stagedDiff/application/service.ts'
import type { ApplyFilePort, EntryStorePort } from '../../src/stagedDiff/application/ports.ts'
import { StagedDiffError, StagedDiffErrorCode, type StagedEntry } from '../../src/stagedDiff/domain/types.ts'

const SESSION = 's1'
const ROOT = path.join('tmp', 'workspace')
const WS = createStagedWorkspaceId(ROOT)
const OTHER_ROOT = path.join('tmp', 'other-workspace')

class FakeStore implements EntryStorePort {
  entries: StagedEntry[] = []
  saves = 0
  failSave = false

  async load(): Promise<readonly StagedEntry[]> {
    return this.entries.map(e => ({ ...e }))
  }

  async save(entries: readonly StagedEntry[]): Promise<void> {
    if (this.failSave) throw new Error('disk full')
    this.entries = entries.map(e => ({ ...e }))
    this.saves += 1
  }
}

class FakeApplier implements ApplyFilePort {
  readonly writes: Array<{ destination: string; content: string; workspaceRoot: string }> = []
  /** destination -> 当前磁盘内容（模拟用户 workspace） */
  readonly disk = new Map<string, string>()
  failApply = false
  applyCalls = 0
  failReads = false

  async applyFile(destination: string, content: string, options: { workspaceRoot: string }): Promise<{ before: string | null }> {
    this.applyCalls += 1
    if (this.failApply) throw new Error('apply boom')
    const before = this.disk.get(destination) ?? null
    this.disk.set(destination, content)
    this.writes.push({ destination, content, workspaceRoot: options.workspaceRoot })
    return { before }
  }

  async readFile(destination: string): Promise<string | null> {
    if (this.failReads) throw new Error('read boom')
    return this.disk.get(destination) ?? null
  }
}

function setup() {
  const store = new FakeStore()
  const applier = new FakeApplier()
  const service = new StagedDiffService(store, applier)
  return { store, applier, service }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

async function expectRejectCode(promise: Promise<unknown>, code: string): Promise<StagedDiffError> {
  const error = await rejectionOf(promise)
  expect(error).toBeInstanceOf(StagedDiffError)
  expect((error as StagedDiffError).code).toBe(code)
  return error as StagedDiffError
}

describe('createEntry', () => {
  it('创建 pending 条目：路径规范化、revision=1、已持久化', async () => {
    const { store, service } = setup()
    await service.initialize()
    const entry = await service.createEntry({
      workspaceId: WS,
      sessionId: SESSION,
      path: './notes/../notes/a.md'.replace('notes/../notes/', 'notes/'),
      after: 'hello',
      toolCallId: 'call-1',
    })
    expect(entry.status).toBe('pending')
    expect(entry.revision).toBe(1)
    expect(entry.path).toBe('notes/a.md')
    expect(entry.before).toBeNull()
    expect(entry.toolCallId).toBe('call-1')
    expect(store.entries).toHaveLength(1)
  })

  it('幂等：同一 toolCallId+path 重复 stage 返回既有条目（不重复落盘）', async () => {
    const { store, service } = setup()
    await service.initialize()
    const first = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'x', toolCallId: 't1' })
    const savesAfterFirst = store.saves
    const second = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'x', toolCallId: 't1' })
    expect(second.id).toBe(first.id)
    expect(store.saves).toBe(savesAfterFirst)
    expect(store.entries).toHaveLength(1)
  })

  it('幂等：显式 entryId 已存在时直接返回', async () => {
    const { store, service } = setup()
    await service.initialize()
    const first = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'x', entryId: 'fixed-id' })
    const second = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'b.md', after: 'y', entryId: 'fixed-id' })
    expect(second.id).toBe(first.id)
    expect(second.path).toBe('a.md')
    expect(store.entries).toHaveLength(1)
  })

  it('同一 toolCallId+path 在条目 done 后可重新 stage（新意图）', async () => {
    const { service } = setup()
    await service.initialize()
    const first = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'x', toolCallId: 't1' })
    await service.acceptEntry({ entryId: first.id, workspaceRoot: ROOT })
    const second = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'y', toolCallId: 't1' })
    expect(second.id).not.toBe(first.id)
    expect(second.status).toBe('pending')
  })

  it('拒绝非法路径（.. / 绝对路径）→ GRAY_STAGED_INVALID_PATH', async () => {
    const { service } = setup()
    await service.initialize()
    await expectRejectCode(
      service.createEntry({ workspaceId: WS, sessionId: SESSION, path: '../evil.md', after: 'x' }),
      StagedDiffErrorCode.INVALID_PATH
    )
    await expectRejectCode(
      service.createEntry({ workspaceId: WS, sessionId: SESSION, path: '/etc/passwd', after: 'x' }),
      StagedDiffErrorCode.INVALID_PATH
    )
  })

  it('before/after 一致性：before === after（no-op 写）→ GRAY_INVALID_INPUT', async () => {
    const { service } = setup()
    await service.initialize()
    await expectRejectCode(
      service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'same', before: 'same' }),
      StagedDiffErrorCode.INVALID_INPUT
    )
    // before === null 允许（新建文件）
    const ok = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'b.md', after: 'same', before: null })
    expect(ok.status).toBe('pending')
  })

  it('空 workspaceId/sessionId → GRAY_INVALID_INPUT', async () => {
    const { service } = setup()
    await service.initialize()
    await expectRejectCode(
      service.createEntry({ workspaceId: '', sessionId: SESSION, path: 'a.md', after: 'x' }),
      StagedDiffErrorCode.INVALID_INPUT
    )
  })
})

describe('listEntries / reviewBatch', () => {
  it('listEntries 按 workspaceId/sessionId/status 过滤', async () => {
    const { service } = setup()
    await service.initialize()
    await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'x' })
    await service.createEntry({ workspaceId: WS, sessionId: 'other', path: 'b.md', after: 'x' })
    await service.createEntry({ workspaceId: 'ws-other', sessionId: SESSION, path: 'c.md', after: 'x' })

    expect(service.listEntries({ workspaceId: WS, sessionId: SESSION })).toHaveLength(1)
    expect(service.listEntries({ workspaceId: WS })).toHaveLength(2)
    expect(service.listEntries({ sessionId: SESSION })).toHaveLength(2)
    expect(service.listEntries({ statuses: ['pending'] })).toHaveLength(3)
    expect(service.listEntries({ statuses: ['done'] })).toHaveLength(0)
  })

  it('reviewBatch 聚合 pending/reviewing 为批视图：计数 + createdAt 升序排序', async () => {
    const { service } = setup()
    await service.initialize()
    await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'first.md', after: 'x', now: 100 })
    await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'second.md', after: 'x', now: 200 })
    await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'third.md', after: 'x', now: 150 })
    // 非本批条目（其他 session / 已终态）不进入批
    await service.createEntry({ workspaceId: WS, sessionId: 'other', path: 'other.md', after: 'x', now: 50 })

    const batch = service.reviewBatch(WS, SESSION)
    expect(batch.totalCount).toBe(3)
    expect(batch.pendingCount).toBe(3)
    expect(batch.reviewingCount).toBe(0)
    expect(batch.entries.map(e => e.path)).toEqual(['first.md', 'third.md', 'second.md'])

    // markReviewing 后：pending → reviewing，计数迁移
    const { reviewed } = await service.markReviewing({ workspaceId: WS, sessionId: SESSION })
    expect(reviewed).toBe(3)
    const batch2 = service.reviewBatch(WS, SESSION)
    expect(batch2.pendingCount).toBe(0)
    expect(batch2.reviewingCount).toBe(3)
    // 幂等：再 markReviewing 无变化
    expect((await service.markReviewing({ workspaceId: WS, sessionId: SESSION })).reviewed).toBe(0)
  })

  it('终态（accepted/done/rejected）条目不进入审阅批', async () => {
    const { service } = setup()
    await service.initialize()
    const a = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'x' })
    await service.acceptEntry({ entryId: a.id, workspaceRoot: ROOT })
    const b = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'b.md', after: 'x' })
    await service.rejectEntry({ entryId: b.id, workspaceRoot: ROOT })

    const batch = service.reviewBatch(WS, SESSION)
    expect(batch.totalCount).toBe(0)
    expect(service.listEntries({ workspaceId: WS, sessionId: SESSION })).toHaveLength(2)
  })
})

describe('acceptEntry', () => {
  it('workspace 错配时不推进状态也不调用落盘端口', async () => {
    const { applier, service, store } = setup()
    await service.initialize()
    const entry = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'x' })
    const savesBefore = store.saves

    const error = await expectRejectCode(
      service.acceptEntry({ entryId: entry.id, expectedRevision: 1, workspaceRoot: OTHER_ROOT }),
      StagedDiffErrorCode.WORKSPACE_CONFLICT,
    )

    expect(error.entry).toMatchObject({ id: entry.id, status: 'pending', revision: 1 })
    expect(service.previewEntry(entry.id)).toMatchObject({ status: 'pending', revision: 1 })
    expect(applier.applyCalls).toBe(0)
    expect(store.saves).toBe(savesBefore)
  })

  it('快乐路径：pending → accepted → 落盘 → done；落盘端口收到内容与目标', async () => {
    const { applier, service } = setup()
    await service.initialize()
    const entry = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a/b.md', after: 'final text' })

    const done = await service.acceptEntry({ entryId: entry.id, expectedRevision: 1, workspaceRoot: ROOT })
    expect(done.status).toBe('done')
    expect(done.revision).toBe(3) // pending→accepted→done 两次转换

    expect(applier.writes).toHaveLength(1)
    expect(applier.writes[0]!.destination).toBe(path.join(ROOT, 'a', 'b.md'))
    expect(applier.writes[0]!.content).toBe('final text')
    expect(applier.writes[0]!.workspaceRoot).toBe(ROOT)
    expect(applier.disk.get(path.join(ROOT, 'a', 'b.md'))).toBe('final text')
  })

  it('CAS：陈旧 expectedRevision 报 GRAY_STAGED_REVISION_CONFLICT 并携带权威条目', async () => {
    const { applier, service } = setup()
    await service.initialize()
    const entry = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'x' })
    await service.acceptEntry({ entryId: entry.id, expectedRevision: 1, workspaceRoot: ROOT })

    // 第二次用同一陈旧 revision（当前已是 3）→ 冲突
    const error = await expectRejectCode(
      service.acceptEntry({ entryId: entry.id, expectedRevision: 1, workspaceRoot: ROOT }),
      StagedDiffErrorCode.REVISION_CONFLICT
    )
    expect(error.entry?.status).toBe('done')
    expect(applier.applyCalls).toBe(1) // 冲突时不再落盘

    // 用当前 revision 再次 accept：done 条目幂等返回，不重复落盘
    const again = await service.acceptEntry({ entryId: entry.id, expectedRevision: 3, workspaceRoot: ROOT })
    expect(again.status).toBe('done')
    expect(applier.applyCalls).toBe(1)
  })

  it('落盘失败：保持 accepted（已持久化），不置 done；重试（新 revision）成功', async () => {
    const { applier, service } = setup()
    await service.initialize()
    const entry = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'x' })

    applier.failApply = true
    const error = await expectRejectCode(
      service.acceptEntry({ entryId: entry.id, expectedRevision: 1, workspaceRoot: ROOT }),
      StagedDiffErrorCode.APPLY_FAILED
    )
    // 权威条目：accepted 而非 done（不向 UI 假报完成）
    expect(error.entry?.status).toBe('accepted')
    expect(error.entry?.revision).toBe(2)
    expect(applier.disk.size).toBe(0)

    // 重试：expectedRevision 取权威条目的当前 revision
    applier.failApply = false
    const done = await service.acceptEntry({ entryId: entry.id, expectedRevision: 2, workspaceRoot: ROOT })
    expect(done.status).toBe('done')
    expect(done.revision).toBe(3)
    expect(applier.disk.get(path.join(ROOT, 'a.md'))).toBe('x')
  })

  it('needs-reapply 条目可接受（崩溃恢复后人工确认重放）', async () => {
    const store = new FakeStore()
    const applier = new FakeApplier()
    // 预置：一条 accepted 条目（模拟崩溃窗口的持久化状态：已 approved、未落盘）
    store.entries = [
      {
        id: 'crash-entry',
        workspaceId: WS,
        sessionId: SESSION,
        path: 'a.md',
        before: null,
        after: 'x',
        status: 'accepted',
        createdAt: 1,
        updatedAt: 2,
        revision: 2,
      },
    ]
    // 重启：新实例重建 → needs-reapply
    const service = new StagedDiffService(store, applier)
    const { reapply } = await service.initialize()
    expect(reapply).toBe(1)
    expect(service.reviewBatch(WS, SESSION).totalCount).toBe(0)
    const needsReapply = service.listEntries({ workspaceId: WS, sessionId: SESSION })[0]!
    expect(needsReapply.status).toBe('needs-reapply')

    // 人工确认后重放（accept）→ done
    const done = await service.acceptEntry({ entryId: 'crash-entry', expectedRevision: needsReapply.revision, workspaceRoot: ROOT })
    expect(done.status).toBe('done')
    expect(applier.disk.get(path.join(ROOT, 'a.md'))).toBe('x')
  })
})

describe('rejectEntry', () => {
  it('workspace 错配时不读取目标、不推进条目状态', async () => {
    const { applier, service, store } = setup()
    await service.initialize()
    const entry = await service.createEntry({
      workspaceId: WS,
      sessionId: SESSION,
      path: 'a.md',
      before: 'original',
      after: 'new',
    })
    const savesBefore = store.saves
    applier.disk.set(path.join(OTHER_ROOT, 'a.md'), 'original')

    const error = await expectRejectCode(
      service.rejectEntry({ entryId: entry.id, expectedRevision: 1, workspaceRoot: OTHER_ROOT }),
      StagedDiffErrorCode.WORKSPACE_CONFLICT,
    )

    expect(error.entry).toMatchObject({ id: entry.id, status: 'pending', revision: 1 })
    expect(service.previewEntry(entry.id)).toMatchObject({ status: 'pending', revision: 1 })
    expect(applier.applyCalls).toBe(0)
    expect(store.saves).toBe(savesBefore)
  })

  it('拒绝不落盘：applier.applyFile 从未被调用，磁盘无内容', async () => {
    const { applier, service } = setup()
    await service.initialize()
    const entry = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'x' })

    const rejected = await service.rejectEntry({ entryId: entry.id, expectedRevision: 1, workspaceRoot: ROOT })
    expect(rejected.status).toBe('rejected')
    expect(rejected.revision).toBe(2)
    expect(applier.applyCalls).toBe(0)
    expect(applier.disk.size).toBe(0)
  })

  it('冲突策略：目标文件已被其他流程修改且 before 存在 → GRAY_STAGED_REJECT_CONFLICT，不自动覆盖', async () => {
    const { applier, service } = setup()
    await service.initialize()
    const entry = await service.createEntry({
      workspaceId: WS,
      sessionId: SESSION,
      path: 'a.md',
      after: 'new',
      before: 'original',
    })
    // 另一流程把磁盘内容改成了 v2（≠ before）
    applier.disk.set(path.join(ROOT, 'a.md'), 'modified by checkpoint restore')

    const error = await expectRejectCode(
      service.rejectEntry({ entryId: entry.id, expectedRevision: 1, workspaceRoot: ROOT }),
      StagedDiffErrorCode.REJECT_CONFLICT
    )
    expect(error.entry?.status).toBe('pending') // 条目未被推进
    expect(applier.applyCalls).toBe(0)
  })

  it('磁盘内容与 before 一致（无冲突）→ 正常拒绝', async () => {
    const { applier, service } = setup()
    await service.initialize()
    const entry = await service.createEntry({
      workspaceId: WS,
      sessionId: SESSION,
      path: 'a.md',
      after: 'new',
      before: 'original',
    })
    applier.disk.set(path.join(ROOT, 'a.md'), 'original')

    const rejected = await service.rejectEntry({ entryId: entry.id, expectedRevision: 1, workspaceRoot: ROOT })
    expect(rejected.status).toBe('rejected')
  })

  it('before 为 null（新建意图）：即使文件已存在也不做冲突拦截（任务约束：仅 before 存在时检测）', async () => {
    const { applier, service } = setup()
    await service.initialize()
    const entry = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'new' })
    applier.disk.set(path.join(ROOT, 'a.md'), 'someone else created it')

    const rejected = await service.rejectEntry({ entryId: entry.id, workspaceRoot: ROOT })
    expect(rejected.status).toBe('rejected')
  })

  it('空 workspaceRoot 不能绕过工作区绑定', async () => {
    const { applier, service } = setup()
    await service.initialize()
    const entry = await service.createEntry({
      workspaceId: WS,
      sessionId: SESSION,
      path: 'a.md',
      after: 'new',
      before: 'original',
    })
    applier.disk.set(path.join(ROOT, 'a.md'), 'diverged')
    await expectRejectCode(
      service.rejectEntry({ entryId: entry.id, workspaceRoot: '' }),
      StagedDiffErrorCode.WORKSPACE_CONFLICT,
    )
    expect(service.previewEntry(entry.id).status).toBe('pending')
    expect(applier.applyCalls).toBe(0)
  })

  it('幂等：rejected 条目同 revision 再拒绝返回既有；done 条目拒绝报 ILLEGAL_TRANSITION', async () => {
    const { service } = setup()
    await service.initialize()
    const entry = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'x' })
    await service.rejectEntry({ entryId: entry.id, workspaceRoot: ROOT })
    const again = await service.rejectEntry({ entryId: entry.id, expectedRevision: 2, workspaceRoot: ROOT })
    expect(again.status).toBe('rejected')

    const doneEntry = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'b.md', after: 'x' })
    await service.acceptEntry({ entryId: doneEntry.id, workspaceRoot: ROOT })
    await expectRejectCode(
      service.rejectEntry({ entryId: doneEntry.id, workspaceRoot: ROOT }),
      StagedDiffErrorCode.ILLEGAL_TRANSITION
    )
  })
})

describe('restoreFromSidecar（重启重建）', () => {
  it('新实例 load 后条目恢复；accepted 未落盘（崩溃窗口）→ needs-reapply', async () => {
    const { store, applier, service } = setup()
    await service.initialize()

    // 实例 A：两条 pending + 一条 accepted（模拟「accepted 已持久化但落盘未完成」崩溃窗口）
    const e1 = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'x' })
    await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'b.md', after: 'y' })
    const accepted = { ...e1, status: 'accepted' as const, revision: 2, updatedAt: Date.now() }
    store.entries = store.entries.map(e => (e.id === e1.id ? accepted : e))

    // 实例 B：同一存储，重启重建
    const serviceB = new StagedDiffService(store, applier)
    const result = await serviceB.initialize()
    expect(result.restored).toBe(2)
    expect(result.reapply).toBe(1)

    const entries = serviceB.listEntries({ workspaceId: WS, sessionId: SESSION })
    const byPath = new Map(entries.map(e => [e.path, e]))
    expect(byPath.get('b.md')!.status).toBe('pending') // 普通条目原样恢复
    const reapply = byPath.get('a.md')!
    expect(reapply.status).toBe('needs-reapply')
    expect(reapply.revision).toBe(3) // accepted(2) → needs-reapply 再 +1

    // needs-reapply 持久化：再次重建不再重复标记（幂等恢复）
    const serviceC = new StagedDiffService(store, applier)
    const resultC = await serviceC.initialize()
    expect(resultC.reapply).toBe(0)
  })

  it('未初始化即操作用例 → GRAY_STORAGE_CORRUPT（服务未加载）', async () => {
    const { service } = setup()
    await expectRejectCode(
      service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'x' }),
      StagedDiffErrorCode.STORAGE_CORRUPT
    )
  })

  it('dispose 与在途 restore 竞态：完成后不回填已弃用实例、不写盘', async () => {
    const { store, applier, service } = setup()
    await service.initialize()
    // 制造 accepted 条目（崩溃窗口形态）：restore 若执行会 reapply 并触发写盘
    const e1 = await service.createEntry({ workspaceId: WS, sessionId: SESSION, path: 'a.md', after: 'x' })
    const accepted = { ...e1, status: 'accepted' as const, revision: 2, updatedAt: Date.now() }
    store.entries = store.entries.map(e => (e.id === e1.id ? accepted : e))
    const savesBefore = store.saves

    // 第二个实例：门控 load，模拟「initialize 未 await、dispose 先到」的 HMR 卸载竞态
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalLoad = store.load.bind(store)
    store.load = () => gate.then(() => originalLoad())
    const serviceB = new StagedDiffService(store, applier)

    const initPromise = serviceB.initialize()
    serviceB.dispose() // 在途加载完成前弃用
    release()
    const result = await initPromise

    // 已弃用实例不回填：loaded 未置位（requireLoaded 抛错）、不触发 reapply 写盘
    expect(result).toEqual({ restored: 0, reapply: 0 })
    expect(() => serviceB.listEntries()).toThrow(/not initialized/)
    expect(store.saves).toBe(savesBefore)
  })
})
