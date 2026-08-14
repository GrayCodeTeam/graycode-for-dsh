/**
 * BranchCoordinatorService 集成测试：真实临时 dataRoot（sidecar 原子写盘）+ 内存假适配器。
 *
 * 假适配器只实现 BranchSessionAdapter 端口（eventsOf/cwdOf/agentPresetOf/forkChild/
 * sendUserMessage），记录 fork 调用参数与重发的用户消息；不触碰真实 dsh 适配器。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BranchCoordinatorService } from '../../src/branches/service.ts'
import type { BranchSessionAdapter } from '../../src/branches/service.ts'
import { BranchError, BranchErrorCode } from '../../src/branches/domain/types.ts'
import type { BranchEventView } from '../../src/branches/domain/turnLocator.ts'

const ROOT_SESSION = 'root-session'
const WS = 'ws-test'

/** 构造最小事件视图；data 允许携带 content 等额外负载（领域层只读前三个字段） */
function ev(type: string, seq: number, data: Record<string, unknown> = {}): BranchEventView {
  return { type, seq, data } as unknown as BranchEventView
}

/** 两个完整轮次：turn1 (seq0-2)，turn2 (seq3-5，直接用户消息内容 hello) */
function twoClosedTurns(): BranchEventView[] {
  return [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, { source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] }),
    ev('turn/end', 2, { turn: 1 }),
    ev('turn/start', 3, { turn: 2 }),
    ev('user/message', 4, { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }),
    ev('turn/end', 5, { turn: 2 }),
  ]
}

/** 假适配器：内存会话 + fork/send 调用记录；可按需注入 fork/send 失败 */
class FakeBranchSessionAdapter implements BranchSessionAdapter {
  readonly sessions = new Map<string, { events: BranchEventView[]; cwd?: string; agentPreset?: string }>()
  readonly forkCalls: Array<{
    childSessionId: string
    boundary: number | undefined
    parentSessionId: string
    cwd?: string
    agentPreset?: string
  }> = []
  readonly sentMessages: Array<{ sessionId: string; content: readonly unknown[] }> = []
  /** forkChild 对命中 parent 抛错的集合 */
  readonly failForkParents = new Set<string>()
  /** 置位后 forkChild 把子会话命名为 'fail-send'（sendUserMessage 对它抛错） */
  failSendOnFork = false

  addSession(sessionId: string, events: BranchEventView[], meta: { cwd?: string; agentPreset?: string } = {}): void {
    this.sessions.set(sessionId, { events, ...meta })
  }

  eventsOf(sessionId: string): readonly BranchEventView[] {
    return this.sessions.get(sessionId)?.events ?? []
  }

  cwdOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd
  }

  agentPresetOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.agentPreset
  }

  async forkChild(input: {
    parent: { id: string; events: readonly BranchEventView[] }
    boundary: number | undefined
    childSessionId: string
    cwd?: string
    agentPreset?: string
  }): Promise<{ sessionId: string; agentAttached: boolean }> {
    this.forkCalls.push({
      childSessionId: input.childSessionId,
      boundary: input.boundary,
      parentSessionId: input.parent.id,
      cwd: input.cwd,
      agentPreset: input.agentPreset,
    })
    if (this.failForkParents.has(input.parent.id)) {
      throw new Error('fork rejected by fake host')
    }
    const sessionId = this.failSendOnFork ? 'fail-send' : input.childSessionId
    const seed =
      input.boundary === undefined ? [...input.parent.events] : input.parent.events.slice(0, input.boundary + 1)
    this.sessions.set(sessionId, { events: seed, cwd: input.cwd, agentPreset: input.agentPreset })
    return { sessionId, agentAttached: false }
  }

  async sendUserMessage(input: { sessionId: string; content: readonly unknown[] }): Promise<void> {
    if (input.sessionId === 'fail-send') {
      throw new Error('send rejected by fake host')
    }
    this.sentMessages.push(input)
  }
}

/** 取 promise 的拒绝值；未拒绝时测试失败 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

/** 断言 promise 以指定 BranchError code 拒绝 */
async function expectRejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await rejectionOf(promise)
  expect(error).toBeInstanceOf(BranchError)
  expect((error as BranchError).code).toBe(code)
}

interface Env {
  dataRoot: string
  adapter: FakeBranchSessionAdapter
  service: BranchCoordinatorService
}

let env: Env

beforeEach(async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-branches-'))
  const adapter = new FakeBranchSessionAdapter()
  adapter.addSession(ROOT_SESSION, twoClosedTurns(), { cwd: '/workspace/root', agentPreset: 'coder' })
  const service = new BranchCoordinatorService({ dataRoot }, adapter)
  await service.initialize()
  env = { dataRoot, adapter, service }
})

afterEach(async () => {
  env.service.dispose()
  await fs.rm(env.dataRoot, { recursive: true, force: true })
})

async function sidecarStore(dataRoot: string): Promise<{ version: number; groups: unknown[] }> {
  return JSON.parse(await fs.readFile(path.join(dataRoot, 'branches', 'groups.json'), 'utf-8'))
}

describe('BranchCoordinatorService initialize', () => {
  it('a missing sidecar file loads an empty store', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-branches-empty-'))
    try {
      const service = new BranchCoordinatorService({ dataRoot }, new FakeBranchSessionAdapter())
      await service.initialize()
      expect(service.listGroups()).toEqual([])
      service.dispose()
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true })
    }
  })

  it('a corrupt sidecar file throws STORAGE_CORRUPT on initialize', async () => {
    await fs.mkdir(path.join(env.dataRoot, 'branches'), { recursive: true })
    await fs.writeFile(path.join(env.dataRoot, 'branches', 'groups.json'), '{not json', 'utf-8')
    const service = new BranchCoordinatorService({ dataRoot: env.dataRoot }, new FakeBranchSessionAdapter())
    await expectRejectCode(service.initialize(), BranchErrorCode.STORAGE_CORRUPT)
    service.dispose()
  })
})

describe('BranchCoordinatorService ensureGroup', () => {
  it('creates a group rooted at the session; a repeated call returns the same group', async () => {
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    expect(group.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(group.workspaceId).toBe(WS)
    expect(group.rootSessionId).toBe(ROOT_SESSION)
    expect(group.activeSessionId).toBe(ROOT_SESSION)
    expect(group.revision).toBe(1)
    expect(group.candidates).toHaveLength(1)
    expect(group.candidates[0]).toMatchObject({ sessionId: ROOT_SESSION, kind: 'root' })
    expect(group.createdAt).toBeGreaterThan(0)

    const again = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    expect(again.id).toBe(group.id)
    expect(env.service.listGroups()).toHaveLength(1)
  })
})

describe('BranchCoordinatorService createBranch', () => {
  it('forks through an explicit boundary and records the manual candidate in the sidecar', async () => {
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    const result = await env.service.createBranch({
      groupId: group.id,
      parentSessionId: ROOT_SESSION,
      boundary: 2,
      label: 'manual-1',
    })

    expect(result.orphan).toBe(false)
    expect(result.agentAttached).toBe(false)
    expect(result.kind).toBe('manual')
    expect(result.parentSessionId).toBe(ROOT_SESSION)
    expect(result.boundary).toBe(2)
    expect(result.revision).toBe(2)
    expect(result.sessionId).toMatch(/^branch-/)

    // 假适配器收到带边界/父会话/cwd/agentPreset 的 fork 调用，seed 为 slice(0, boundary+1)
    expect(env.adapter.forkCalls).toHaveLength(1)
    expect(env.adapter.forkCalls[0]).toMatchObject({
      boundary: 2,
      parentSessionId: ROOT_SESSION,
      cwd: '/workspace/root',
      agentPreset: 'coder',
    })
    expect(env.adapter.eventsOf(result.sessionId)).toHaveLength(3)

    // 组内新增 manual 候选 + revision 递增
    const updated = env.service.getGroup(group.id)!
    expect(updated.revision).toBe(2)
    const candidate = updated.candidates.find(c => c.sessionId === result.sessionId)!
    expect(candidate).toMatchObject({
      kind: 'manual',
      parentSessionId: ROOT_SESSION,
      boundary: 2,
      label: 'manual-1',
    })

    // sidecar 文件已原子写盘：version === 1 且候选在列
    const store = await sidecarStore(env.dataRoot)
    expect(store.version).toBe(1)
    const persisted = store.groups[0] as { candidates: Array<{ sessionId: string; kind: string }> }
    expect(persisted.candidates.some(c => c.sessionId === result.sessionId && c.kind === 'manual')).toBe(true)
  })

  it('defaults the boundary to the last complete turn end when a later turn is still open', async () => {
    env.adapter.addSession(ROOT_SESSION, [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1, { source: { kind: 'user' } }),
      ev('turn/end', 2, { turn: 1 }),
      ev('turn/start', 3, { turn: 2 }),
    ])
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    const result = await env.service.createBranch({ groupId: group.id, parentSessionId: ROOT_SESSION })
    expect(result.boundary).toBe(2)
    expect(env.adapter.forkCalls[0]!.boundary).toBe(2)
    expect(env.adapter.eventsOf(result.sessionId)).toHaveLength(3)
  })

  it('rejects when the parent has an open turn and no closed turn (NO_PREVIOUS_TURN)', async () => {
    env.adapter.addSession(ROOT_SESSION, [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1, { source: { kind: 'user' } }),
    ])
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    await expectRejectCode(
      env.service.createBranch({ groupId: group.id, parentSessionId: ROOT_SESSION }),
      BranchErrorCode.NO_PREVIOUS_TURN,
    )
  })

  it('rejects an unknown group with GROUP_NOT_FOUND', async () => {
    await expectRejectCode(
      env.service.createBranch({ groupId: 'no-such-group', parentSessionId: ROOT_SESSION }),
      BranchErrorCode.GROUP_NOT_FOUND,
    )
  })

  it('rejects when the host fork fails with FORK_REJECTED', async () => {
    env.adapter.failForkParents.add(ROOT_SESSION)
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    await expectRejectCode(
      env.service.createBranch({ groupId: group.id, parentSessionId: ROOT_SESSION }),
      BranchErrorCode.FORK_REJECTED,
    )
    // 失败后组未变化
    expect(env.service.getGroup(group.id)!.candidates).toHaveLength(1)
  })
})

describe('BranchCoordinatorService reroll', () => {
  it('forks before the target turn and replays its original user message', async () => {
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    const result = await env.service.reroll({ groupId: group.id, sessionId: ROOT_SESSION, turn: 2 })

    expect(result.boundary).toBe(2) // turn/start(2) seq3 - 1
    expect(result.targetTurn).toBe(2)
    expect(result.messageSent).toBe(true)
    expect(result.orphan).toBe(false)
    expect(result.sessionId).toMatch(/^branch-/)

    expect(env.adapter.sentMessages).toHaveLength(1)
    expect(env.adapter.sentMessages[0]!.sessionId).toBe(result.sessionId)
    expect(env.adapter.sentMessages[0]!.content).toEqual([{ type: 'text', text: 'hello' }])

    const candidate = env.service.getGroup(group.id)!.candidates.find(c => c.sessionId === result.sessionId)!
    expect(candidate).toMatchObject({ kind: 'reroll', parentSessionId: ROOT_SESSION, boundary: 2 })
  })

  it('rejects a turn whose only user message is plugin-injected (NO_USER_MESSAGE)', async () => {
    env.adapter.addSession(ROOT_SESSION, [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1, { source: { kind: 'user' } }),
      ev('turn/end', 2, { turn: 1 }),
      ev('turn/start', 3, { turn: 2 }),
      ev('user/message', 4, { source: { kind: 'plugin' } }),
      ev('turn/end', 5, { turn: 2 }),
    ])
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    await expectRejectCode(
      env.service.reroll({ groupId: group.id, sessionId: ROOT_SESSION, turn: 2 }),
      BranchErrorCode.NO_USER_MESSAGE,
    )
  })

  it('rejects an unknown turn with TARGET_TURN_NOT_FOUND', async () => {
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    await expectRejectCode(
      env.service.reroll({ groupId: group.id, sessionId: ROOT_SESSION, turn: 99 }),
      BranchErrorCode.TARGET_TURN_NOT_FOUND,
    )
  })

  it('rejects the first turn with NO_PREVIOUS_TURN', async () => {
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    await expectRejectCode(
      env.service.reroll({ groupId: group.id, sessionId: ROOT_SESSION, turn: 1 }),
      BranchErrorCode.NO_PREVIOUS_TURN,
    )
  })

  it('reports messageSent false when sendUserMessage throws, but still records the candidate', async () => {
    env.adapter.failSendOnFork = true
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    const result = await env.service.reroll({ groupId: group.id, sessionId: ROOT_SESSION, turn: 2 })

    expect(result.messageSent).toBe(false)
    expect(result.orphan).toBe(false)
    expect(result.sessionId).toBe('fail-send')
    const candidate = env.service.getGroup(group.id)!.candidates.find(c => c.sessionId === 'fail-send')!
    expect(candidate.kind).toBe('reroll')
    expect(env.adapter.sentMessages).toHaveLength(0)
  })
})

describe('BranchCoordinatorService editRetry', () => {
  it('forks before the target turn and sends the edited text', async () => {
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    const result = await env.service.editRetry({ groupId: group.id, sessionId: ROOT_SESSION, turn: 2, text: 'edited hello' })

    expect(result.boundary).toBe(2)
    expect(result.targetTurn).toBe(2)
    expect(result.messageSent).toBe(true)
    expect(env.adapter.sentMessages).toHaveLength(1)
    expect(env.adapter.sentMessages[0]!.sessionId).toBe(result.sessionId)
    expect(env.adapter.sentMessages[0]!.content).toEqual([{ type: 'text', text: 'edited hello' }])
  })
})

describe('BranchCoordinatorService switchCandidate', () => {
  it('moves the active pointer and bumps the revision', async () => {
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    const child = await env.service.createBranch({ groupId: group.id, parentSessionId: ROOT_SESSION, boundary: 2 })

    const switched = await env.service.switchCandidate({ groupId: group.id, sessionId: child.sessionId })
    expect(switched.activeSessionId).toBe(child.sessionId)
    expect(switched.revision).toBe(3)
    expect(env.service.getGroup(group.id)!.activeSessionId).toBe(child.sessionId)
  })

  it('switching to a deleted candidate throws CANDIDATE_DELETED', async () => {
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    const childA = await env.service.createBranch({ groupId: group.id, parentSessionId: ROOT_SESSION, boundary: 2 })
    const childB = await env.service.createBranch({ groupId: group.id, parentSessionId: ROOT_SESSION, boundary: 2 })
    await env.service.deleteCandidate({ groupId: group.id, sessionId: childA.sessionId })
    await env.service.switchCandidate({ groupId: group.id, sessionId: childB.sessionId })
    await expectRejectCode(
      env.service.switchCandidate({ groupId: group.id, sessionId: childA.sessionId }),
      BranchErrorCode.CANDIDATE_DELETED,
    )
  })
})

describe('BranchCoordinatorService deleteCandidate / restoreCandidate', () => {
  it('delete → restore round-trip clears the tombstone and bumps the revision', async () => {
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    const child = await env.service.createBranch({ groupId: group.id, parentSessionId: ROOT_SESSION, boundary: 2 })

    const deleted = await env.service.deleteCandidate({ groupId: group.id, sessionId: child.sessionId })
    expect(deleted.revision).toBe(3)
    expect(deleted.sessionId).toBe(child.sessionId)
    expect(env.service.getGroup(group.id)!.candidates.find(c => c.sessionId === child.sessionId)!.deletedAt).toBeGreaterThan(0)

    const restored = await env.service.restoreCandidate({ groupId: group.id, sessionId: child.sessionId })
    expect(restored.revision).toBe(4)
    expect(env.service.getGroup(group.id)!.candidates.find(c => c.sessionId === child.sessionId)!.deletedAt).toBeUndefined()
  })

  it('the root candidate and the active candidate cannot be deleted (INVALID_INPUT)', async () => {
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    await expectRejectCode(
      env.service.deleteCandidate({ groupId: group.id, sessionId: ROOT_SESSION }),
      BranchErrorCode.INVALID_INPUT,
    )

    const child = await env.service.createBranch({ groupId: group.id, parentSessionId: ROOT_SESSION, boundary: 2 })
    await env.service.switchCandidate({ groupId: group.id, sessionId: child.sessionId })
    await expectRejectCode(
      env.service.deleteCandidate({ groupId: group.id, sessionId: child.sessionId }),
      BranchErrorCode.INVALID_INPUT,
    )
  })
})

describe('BranchCoordinatorService optimistic concurrency (CAS)', () => {
  it('a stale expectedRevision fails with REVISION_CONFLICT carrying the authoritative group', async () => {
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    const child = await env.service.createBranch({ groupId: group.id, parentSessionId: ROOT_SESSION, boundary: 2 })

    // 第一次：expectedRevision 2（当前 revision）通过，revision 升到 3
    const first = await env.service.switchCandidate({ groupId: group.id, sessionId: child.sessionId, expectedRevision: 2 })
    expect(first.revision).toBe(3)

    // 第二次：仍带旧 revision 2 → REVISION_CONFLICT，权威快照为 revision 3
    const error = await rejectionOf(
      env.service.switchCandidate({ groupId: group.id, sessionId: ROOT_SESSION, expectedRevision: 2 }),
    )
    expect(error).toBeInstanceOf(BranchError)
    expect((error as BranchError).code).toBe(BranchErrorCode.REVISION_CONFLICT)
    expect((error as BranchError).authoritativeGroup?.revision).toBe(3)
    expect((error as BranchError).authoritativeGroup?.activeSessionId).toBe(child.sessionId)
  })
})

describe('BranchCoordinatorService persistence', () => {
  it('a fresh service on the same dataRoot reloads revision, activeSessionId and candidates', async () => {
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })
    const child = await env.service.createBranch({ groupId: group.id, parentSessionId: ROOT_SESSION, boundary: 2, label: 'persist-me' })
    await env.service.switchCandidate({ groupId: group.id, sessionId: child.sessionId })
    env.service.dispose()

    const reloadedService = new BranchCoordinatorService(
      { dataRoot: env.dataRoot },
      new FakeBranchSessionAdapter(),
    )
    await reloadedService.initialize()
    try {
      const groups = reloadedService.listGroups()
      expect(groups).toHaveLength(1)
      expect(groups[0]!.revision).toBe(3)
      expect(groups[0]!.activeSessionId).toBe(child.sessionId)
      const candidate = groups[0]!.candidates.find(c => c.sessionId === child.sessionId)!
      expect(candidate).toMatchObject({
        kind: 'manual',
        parentSessionId: ROOT_SESSION,
        boundary: 2,
        label: 'persist-me',
      })
    } finally {
      reloadedService.dispose()
    }
  })

  it('a sidecar write failure leaves the fork session as an orphan outside the group', async () => {
    const group = await env.service.ensureGroup({ workspaceId: WS, rootSessionId: ROOT_SESSION })

    // 把 groups.json 替换成同名目录 → 原子写盘的最终 rename 必然失败
    // （注：persist 里 mkdir 在 try 之外，故不能走「branches 是文件」的注入路径）
    await fs.rm(path.join(env.dataRoot, 'branches', 'groups.json'), { force: true })
    await fs.mkdir(path.join(env.dataRoot, 'branches', 'groups.json'))

    const result = await env.service.createBranch({ groupId: group.id, parentSessionId: ROOT_SESSION, boundary: 2 })
    expect(result.orphan).toBe(true)
    expect(result.sessionId).toMatch(/^branch-/)
    expect(result.revision).toBe(1) // 组未变更，revision 保持

    // fork 确实发生了，但候选没有进入组
    expect(env.adapter.forkCalls).toHaveLength(1)
    expect(env.service.getGroup(group.id)!.candidates.some(c => c.sessionId === result.sessionId)).toBe(false)
    expect(env.service.getGroup(group.id)!.candidates).toHaveLength(1)
  })
})
