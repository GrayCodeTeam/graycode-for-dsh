/**
 * Branch 工具层测试：直接调用 createBranchTools 返回的 7 个 execute（不经 ctx.tools
 * 注册管线），以 stub exec 模拟会话上下文；服务由假适配器 + 真实临时 dataRoot 支撑。
 *
 * F-07：每个用例在 beforeEach 中独立构建 service/group（测试隔离）——不再共享
 * beforeAll 状态，未来在文件前部插入任何分支操作测试都不会破坏 revision/candidates
 * 等依赖初始状态的断言。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { BranchCoordinatorService, createBranchWorkspaceId } from '../../src/branches/service.ts'
import type { BranchSessionAdapter } from '../../src/branches/service.ts'
import { BranchErrorCode } from '../../src/branches/domain/types.ts'
import type { BranchEventView } from '../../src/branches/domain/turnLocator.ts'
import { createBranchTools } from '../../src/branches/tools.ts'

const ROOT_SESSION = 'root-session'

/** 构造最小事件视图；data 允许携带 content 等额外负载（领域层只读前三个字段） */
function ev(type: string, seq: number, data: Record<string, unknown> = {}): BranchEventView {
  return { type, seq, data } as unknown as BranchEventView
}

/** 根会话事件：两个完整轮次，turn2 的直接用户消息内容为 second question */
function rootEvents(): BranchEventView[] {
  return [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, { source: { kind: 'user' }, content: [{ type: 'text', text: 'first question' }] }),
    ev('turn/end', 2, { turn: 1 }),
    ev('turn/start', 3, { turn: 2 }),
    ev('user/message', 4, { source: { kind: 'user' }, content: [{ type: 'text', text: 'second question' }] }),
    ev('turn/end', 5, { turn: 2 }),
  ]
}

/** 假适配器：内存会话 + 重发消息记录（与 service.test 同款最小端口） */
class FakeBranchSessionAdapter implements BranchSessionAdapter {
  readonly sessions = new Map<string, { events: BranchEventView[]; cwd?: string; agentPreset?: string }>()
  readonly sentMessages: Array<{ sessionId: string; content: readonly unknown[] }> = []

  addSession(sessionId: string, events: BranchEventView[]): void {
    this.sessions.set(sessionId, { events })
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
    emptySeed?: boolean
    childSessionId: string
    cwd?: string
    agentPreset?: string
  }): Promise<{ sessionId: string; agentAttached: boolean }> {
    // 与真实适配器同口径：seed 按 seq <= boundary 选取（事件流 seq 可能不连续）
    const boundary = input.boundary
    const seed = input.emptySeed === true
      ? []
      : boundary === undefined ? [...input.parent.events] : input.parent.events.filter(event => event.seq <= boundary)
    this.sessions.set(input.childSessionId, { events: seed, cwd: input.cwd, agentPreset: input.agentPreset })
    return { sessionId: input.childSessionId, agentAttached: false }
  }

  async sendUserMessage(input: { sessionId: string; content: readonly unknown[] }): Promise<boolean> {
    this.sentMessages.push(input)
    return true
  }
}

/** 工具统一返回形状（只取关心的字段） */
interface ToolOutput extends Record<string, unknown> {
  success: boolean
  code?: string
}

interface TestEnv {
  tmpDir: string
  dataRoot: string
  adapter: FakeBranchSessionAdapter
  service: BranchCoordinatorService
  tools: Map<string, ToolDefinition>
  groupId: string
}

let env: TestEnv

beforeEach(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-branch-tools-ws-'))
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-branch-tools-data-'))
  const adapter = new FakeBranchSessionAdapter()
  adapter.addSession(ROOT_SESSION, rootEvents())
  const service = new BranchCoordinatorService({ dataRoot }, adapter)
  await service.initialize()
  const group = await service.ensureGroup({ workspaceId: createBranchWorkspaceId(tmpDir), rootSessionId: ROOT_SESSION })
  env = {
    tmpDir,
    dataRoot,
    adapter,
    service,
    tools: new Map(createBranchTools(service).map(tool => [tool.name, tool])),
    groupId: group.id,
  }
})

afterEach(async () => {
  env.service.dispose()
  await fs.rm(env.tmpDir, { recursive: true, force: true })
  await fs.rm(env.dataRoot, { recursive: true, force: true })
})

function makeExec(): ToolRunContext {
  return {
    agent: { session: { id: ROOT_SESSION, header: { cwd: env.tmpDir } } },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
}

async function execute(name: string, args: Record<string, unknown>): Promise<ToolOutput> {
  const tool = env.tools.get(name)!
  return (await tool.execute(args, makeExec())) as ToolOutput
}

function groupCandidates(result: ToolOutput): Array<{ sessionId: string; deleted: boolean }> {
  const groups = result.groups as Array<{ candidates: Array<{ sessionId: string; deleted: boolean }> }>
  return groups[0]!.candidates
}

describe('branch tools', () => {
  it('branch_list returns the group with its root candidate and a turn summary for the active candidate', async () => {
    const result = await execute('branch_list', {})
    expect(result.success).toBe(true)

    const groups = result.groups as Array<{
      groupId: string
      workspaceId: string
      rootSessionId: string
      activeSessionId: string
      revision: number
      candidates: Array<{ sessionId: string; kind: string; deleted: boolean }>
      turns: Array<{ turn: number; closed: boolean; userMessages: number }>
    }>
    expect(groups).toHaveLength(1)
    expect(groups[0]!.groupId).toBe(env.groupId)
    expect(groups[0]!.workspaceId).toBe(createBranchWorkspaceId(env.tmpDir))
    expect(groups[0]!.rootSessionId).toBe(ROOT_SESSION)
    expect(groups[0]!.activeSessionId).toBe(ROOT_SESSION)
    // 独立 env：revision/candidates 为初始状态（无跨用例共享状态）
    expect(groups[0]!.revision).toBe(1)
    expect(groups[0]!.candidates).toHaveLength(1)
    expect(groups[0]!.candidates[0]).toMatchObject({ sessionId: ROOT_SESSION, kind: 'root', deleted: false })
    expect(groups[0]!.turns).toEqual([
      { turn: 1, closed: true, userMessages: 1 },
      { turn: 2, closed: true, userMessages: 1 },
    ])
  })

  it('branch_create forks the parent through the last complete turn and reports the new session', async () => {
    const result = await execute('branch_create', { sessionId: ROOT_SESSION, label: 'created' })
    expect(result.success).toBe(true)
    expect(String(result.sessionId)).toMatch(/^branch-/)
    expect(result.boundary).toBe(5) // 缺省边界 = 最近完整轮次末尾
    expect(result.kind).toBe('manual')
    expect(result.parentSessionId).toBe(ROOT_SESSION)
    expect(result.orphan).toBe(false)
    expect(result.agentAttached).toBe(false)
    expect(result.revision).toBe(2)
  })

  it('branch_reroll replays the original user message into the forked session', async () => {
    const result = await execute('branch_reroll', { sessionId: ROOT_SESSION, turn: 2 })
    expect(result.success).toBe(true)
    expect(result.messageSent).toBe(true)
    expect(result.targetTurn).toBe(2)
    expect(result.boundary).toBe(2) // turn/start(2) seq3 - 1
    expect(result.orphan).toBe(false)

    const sent = env.adapter.sentMessages.find(m => m.sessionId === result.sessionId)
    expect(sent).toBeTruthy()
    expect(sent!.content).toEqual([{ type: 'text', text: 'second question' }])
  })

  it('branch_reroll with an unknown turn returns an error code instead of throwing', async () => {
    const result = await execute('branch_reroll', { sessionId: ROOT_SESSION, turn: 99 })
    expect(result.success).toBe(false)
    expect(result.code).toBe(BranchErrorCode.TARGET_TURN_NOT_FOUND)
  })

  it('branch_switch moves the active pointer to the created candidate', async () => {
    const created = await execute('branch_create', { sessionId: ROOT_SESSION, label: 'switch target' })
    const result = await execute('branch_switch', { groupId: env.groupId, sessionId: created.sessionId })
    expect(result.success).toBe(true)
    expect(result.activeSessionId).toBe(created.sessionId)
    expect(result.revision).toBeGreaterThan(0)
  })

  it('branch_delete tombstones a non-active candidate; branch_list reports deleted true', async () => {
    const created = await execute('branch_create', { sessionId: ROOT_SESSION, label: 'delete me' })
    const result = await execute('branch_delete', { groupId: env.groupId, sessionId: created.sessionId })
    expect(result.success).toBe(true)

    const listed = await execute('branch_list', { groupId: env.groupId })
    const candidate = groupCandidates(listed).find(c => c.sessionId === created.sessionId)!
    expect(candidate.deleted).toBe(true)
  })

  it('branch_delete on the root candidate fails with GRAY_INVALID_INPUT', async () => {
    const result = await execute('branch_delete', { groupId: env.groupId, sessionId: ROOT_SESSION })
    expect(result.success).toBe(false)
    expect(result.code).toBe(BranchErrorCode.INVALID_INPUT)
  })

  it('branch_restore clears the tombstone of a deleted candidate', async () => {
    const created = await execute('branch_create', { sessionId: ROOT_SESSION, label: 'restore me' })
    await execute('branch_delete', { groupId: env.groupId, sessionId: created.sessionId })

    const result = await execute('branch_restore', { groupId: env.groupId, sessionId: created.sessionId })
    expect(result.success).toBe(true)

    const listed = await execute('branch_list', { groupId: env.groupId })
    const candidate = groupCandidates(listed).find(c => c.sessionId === created.sessionId)!
    expect(candidate.deleted).toBe(false)
  })

  it('branch_edit_retry sends the edited text into the forked session', async () => {
    const result = await execute('branch_edit_retry', { sessionId: ROOT_SESSION, turn: 2, text: 'edited second question' })
    expect(result.success).toBe(true)
    expect(result.messageSent).toBe(true)
    expect(result.targetTurn).toBe(2)

    const sent = env.adapter.sentMessages.find(m => m.sessionId === result.sessionId)
    expect(sent).toBeTruthy()
    expect(sent!.content).toEqual([{ type: 'text', text: 'edited second question' }])
  })

  it('branch_list with a nonexistent group id fails with GRAY_BRANCH_GROUP_NOT_FOUND', async () => {
    const result = await execute('branch_list', { groupId: 'no-such-group' })
    expect(result.success).toBe(false)
    expect(result.code).toBe('GRAY_BRANCH_GROUP_NOT_FOUND')
  })

  // ── D-2 回归：reroll / edit_retry 成功后新候选自动激活 ──

  it('branch_reroll auto-activates the forked session; branch_list reports it as active (D-2)', async () => {
    const result = await execute('branch_reroll', { sessionId: ROOT_SESSION, turn: 2 })
    expect(result.success).toBe(true)
    expect(result.activeSessionId).toBe(result.sessionId)

    const listed = await execute('branch_list', { groupId: env.groupId })
    const groups = listed.groups as Array<{ activeSessionId: string; candidates: Array<{ sessionId: string }> }>
    expect(groups[0]!.activeSessionId).toBe(result.sessionId)
    expect(groups[0]!.candidates.some(c => c.sessionId === result.sessionId)).toBe(true)
  })

  it('branch_edit_retry auto-activates the forked session (D-2)', async () => {
    const result = await execute('branch_edit_retry', { sessionId: ROOT_SESSION, turn: 2, text: 'edited again' })
    expect(result.success).toBe(true)
    expect(result.activeSessionId).toBe(result.sessionId)

    const listed = await execute('branch_list', { groupId: env.groupId })
    const groups = listed.groups as Array<{ activeSessionId: string }>
    expect(groups[0]!.activeSessionId).toBe(result.sessionId)
  })

  // ── C5：branch_rename ──

  it('branch_rename updates the display label and bumps the revision', async () => {
    const result = await execute('branch_rename', {
      groupId: env.groupId,
      sessionId: ROOT_SESSION,
      label: '新名字',
    })
    expect(result.success).toBe(true)
    expect(result.revision).toBeGreaterThan(0)

    const listed = await execute('branch_list', { groupId: env.groupId })
    const groups = listed.groups as Array<{ revision: number; candidates: Array<{ sessionId: string; label?: string }> }>
    const candidate = groups[0]!.candidates.find(c => c.sessionId === ROOT_SESSION)!
    expect(candidate.label).toBe('新名字')
    expect(groups[0]!.revision).toBe(2)
  })

  it('branch_rename with an empty label fails with GRAY_INVALID_INPUT', async () => {
    const result = await execute('branch_rename', {
      groupId: env.groupId,
      sessionId: ROOT_SESSION,
      label: '   ',
    })
    expect(result.success).toBe(false)
    expect(result.code).toBe(BranchErrorCode.INVALID_INPUT)
  })

  it('branch_rename with a label longer than 200 characters fails with GRAY_INVALID_INPUT', async () => {
    const result = await execute('branch_rename', {
      groupId: env.groupId,
      sessionId: ROOT_SESSION,
      label: 'x'.repeat(201),
    })
    expect(result.success).toBe(false)
    expect(result.code).toBe(BranchErrorCode.INVALID_INPUT)
  })

  it('branch_rename with a stale expectedRevision fails with GRAY_BRANCH_REVISION_CONFLICT', async () => {
    const result = await execute('branch_rename', {
      groupId: env.groupId,
      sessionId: ROOT_SESSION,
      label: 'conflict',
      expectedRevision: 99,
    })
    expect(result.success).toBe(false)
    expect(result.code).toBe(BranchErrorCode.REVISION_CONFLICT)
  })

  it('branch_rename on a session not in the group fails with GRAY_BRANCH_SESSION_NOT_IN_GROUP', async () => {
    const result = await execute('branch_rename', {
      groupId: env.groupId,
      sessionId: 'foreign-session',
      label: 'x',
    })
    expect(result.success).toBe(false)
    expect(result.code).toBe(BranchErrorCode.SESSION_NOT_IN_GROUP)
  })

  it('branch_rename without groupId resolves the group from the current session', async () => {
    const result = await execute('branch_rename', { sessionId: ROOT_SESSION, label: 'from-current' })
    expect(result.success).toBe(true)
    expect(result.groupId).toBe(env.groupId)
  })
})

describe('branch tools with a corrupt sidecar', () => {
  it('tools return the stable STORAGE_CORRUPT code instead of throwing (initialize must not reject)', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-branch-tools-corrupt-'))
    try {
      await fs.mkdir(path.join(dataRoot, 'branches'), { recursive: true })
      await fs.writeFile(path.join(dataRoot, 'branches', 'groups.json'), '{not json', 'utf-8')
      const service = new BranchCoordinatorService({ dataRoot }, new FakeBranchSessionAdapter())
      await service.initialize() // 损坏时内部捕获：不产生 unhandled rejection
      const tools = new Map(createBranchTools(service).map(tool => [tool.name, tool]))
      const exec = {
        agent: { session: { id: ROOT_SESSION, header: { cwd: process.cwd() } } },
        signal: new AbortController().signal,
      } as unknown as ToolRunContext

      const created = (await tools.get('branch_create')!.execute({ sessionId: ROOT_SESSION }, exec)) as ToolOutput
      expect(created.success).toBe(false)
      expect(created.code).toBe(BranchErrorCode.STORAGE_CORRUPT)

      const listed = (await tools.get('branch_list')!.execute({}, exec)) as ToolOutput
      expect(listed.success).toBe(false)
      expect(listed.code).toBe(BranchErrorCode.STORAGE_CORRUPT)

      const rerolled = (await tools.get('branch_reroll')!.execute({ sessionId: ROOT_SESSION, turn: 2 }, exec)) as ToolOutput
      expect(rerolled.success).toBe(false)
      expect(rerolled.code).toBe(BranchErrorCode.STORAGE_CORRUPT)
      service.dispose()
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true })
    }
  })
})
