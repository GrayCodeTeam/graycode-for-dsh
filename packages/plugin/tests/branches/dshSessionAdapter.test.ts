/**
 * dshSessionAdapter 契约测试（BUG-04 回归）：真实 createDshBranchSessionAdapter +
 * 最小假 ctx，验证 sendUserMessage 对 followup 的 await 与拒绝传播，以及经 service
 * 的 reroll 端到端 messageSent 语义（followup 失败不得产生 unhandled rejection）。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createDshBranchSessionAdapter } from '../../src/branches/adapters/dshSessionAdapter.ts'
import { BranchCoordinatorService } from '../../src/branches/service.ts'
import type { BranchEventView } from '../../src/branches/domain/turnLocator.ts'

/** 构造最小事件视图；data 允许携带 content 等额外负载（领域层只读前三个字段） */
function ev(type: string, seq: number, data: Record<string, unknown> = {}): BranchEventView {
  return { type, seq, data } as unknown as BranchEventView
}

/** 两个完整轮次：turn2 的直接用户消息内容为 hello */
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

interface FakeCtxOptions {
  followup?: () => Promise<void>
  /** agents.get 的返回值；null 表示无 live agent */
  agent?: unknown
}

/** 最小假 ctx：sessions.get 返回带两个完整轮次的会话；agents.create 成功发布 child */
function makeFakeCtx(options: FakeCtxOptions = {}): Context {
  const followup = options.followup ?? (async () => undefined)
  return {
    sessions: {
      get: () => ({ header: { cwd: '/workspace' }, events: twoClosedTurns() }),
      create: () => undefined,
    },
    agents: {
      get: () => (options.agent === undefined ? { followup } : options.agent),
      create: async () => ({ agent: { id: 'child-1' } }),
    },
  } as unknown as Context
}

const tmpDirs: string[] = []

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('dshSessionAdapter.sendUserMessage', () => {
  it('awaits followup: a rejecting followup rejects sendUserMessage (BUG-04)', async () => {
    const followup = vi.fn().mockRejectedValue(new Error('followup failed'))
    const adapter = createDshBranchSessionAdapter(makeFakeCtx({ followup }))
    await expect(
      adapter.sendUserMessage({ sessionId: 's1', content: [{ type: 'text', text: 'hi' }] }),
    ).rejects.toThrow('followup failed')
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('resolves false when no live agent exists (message was not delivered)', async () => {
    const adapter = createDshBranchSessionAdapter(makeFakeCtx({ agent: null }))
    await expect(
      adapter.sendUserMessage({ sessionId: 's1', content: [{ type: 'text', text: 'hi' }] }),
    ).resolves.toBe(false)
  })
})

describe('dshSessionAdapter.forkChild', () => {
  it('supports an empty first-turn seed and inherits the parent model options', async () => {
    const create = vi.fn(async () => ({ agent: { id: 'child-1' } }))
    const ctx = {
      sessions: { get: () => ({ header: {}, events: twoClosedTurns() }), create: vi.fn() },
      agents: {
        get: (id: string) => id === 'root-session'
          ? { options: { provider: 'echo', model: 'echo-model', maxTokens: 2048 } }
          : undefined,
        create,
      },
    } as unknown as Context
    const adapter = createDshBranchSessionAdapter(ctx)
    await adapter.forkChild({
      parent: { id: 'root-session', events: twoClosedTurns() },
      boundary: undefined,
      emptySeed: true,
      childSessionId: 'child-1',
    })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      seed: [],
      agentOptions: { provider: 'echo', model: 'echo-model', maxTokens: 2048 },
    }))
  })
})

describe('reroll through the real adapter', () => {
  it('a rejecting followup yields messageSent false and no unhandled rejection (BUG-04)', async () => {
    const followup = vi.fn().mockRejectedValue(new Error('followup failed'))
    const adapter = createDshBranchSessionAdapter(makeFakeCtx({ followup }))
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-branches-adapter-'))
    tmpDirs.push(dataRoot)
    const service = new BranchCoordinatorService({ dataRoot }, adapter)
    await service.initialize()
    try {
      const group = await service.ensureGroup({ workspaceId: 'ws-1', rootSessionId: 'root-session' })
      const result = await service.reroll({ groupId: group.id, sessionId: 'root-session', turn: 2 })
      expect(result.messageSent).toBe(false)
      expect(result.orphan).toBe(false)
      // 候选已记录，但消息未送达（3.15-M2）→ 不自动激活，激活指针保持原候选
      const current = service.getGroup(group.id)!
      expect(current.candidates.some(c => c.sessionId === result.sessionId && c.kind === 'reroll')).toBe(true)
      expect(result.activeSessionId).toBe('root-session')
      expect(current.activeSessionId).toBe('root-session')
      expect(followup).toHaveBeenCalledTimes(1)
    } finally {
      service.dispose()
    }
  })

  it('a resolved followup yields messageSent true', async () => {
    const followup = vi.fn().mockResolvedValue(undefined)
    const adapter = createDshBranchSessionAdapter(makeFakeCtx({ followup }))
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-branches-adapter-'))
    tmpDirs.push(dataRoot)
    const service = new BranchCoordinatorService({ dataRoot }, adapter)
    await service.initialize()
    try {
      const group = await service.ensureGroup({ workspaceId: 'ws-1', rootSessionId: 'root-session' })
      const result = await service.reroll({ groupId: group.id, sessionId: 'root-session', turn: 2 })
      expect(result.messageSent).toBe(true)
    } finally {
      service.dispose()
    }
  })

  it('reroll reports messageSent false when no agent factory is registered (no live agent)', async () => {
    // agents.create 抛 NO_FACTORY（未装载 agent-loop）→ forkChild 降级为仅建会话；
    // agents.get 无 live agent → sendUserMessage 返回 false，不得误报 messageSent true
    const ctx = {
      sessions: {
        get: () => ({ header: { cwd: '/workspace' }, events: twoClosedTurns() }),
        create: () => undefined,
      },
      agents: {
        get: () => undefined,
        create: async () => {
          throw new Error('no agent factory registered (load an agent-loop plugin)')
        },
      },
    } as unknown as Context
    const adapter = createDshBranchSessionAdapter(ctx)
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-branches-adapter-'))
    tmpDirs.push(dataRoot)
    const service = new BranchCoordinatorService({ dataRoot }, adapter)
    await service.initialize()
    try {
      const group = await service.ensureGroup({ workspaceId: 'ws-1', rootSessionId: 'root-session' })
      const result = await service.reroll({ groupId: group.id, sessionId: 'root-session', turn: 2 })
      expect(result.messageSent).toBe(false)
      expect(result.agentAttached).toBe(false)
      expect(result.orphan).toBe(false)
      // 会话已建并记录候选，只是没有 agent 可驱动；未投递（3.15-M2）→ 不自动激活
      const current = service.getGroup(group.id)!
      expect(current.candidates.some(c => c.sessionId === result.sessionId && c.kind === 'reroll')).toBe(true)
      expect(result.activeSessionId).toBe('root-session')
      expect(current.activeSessionId).toBe('root-session')
    } finally {
      service.dispose()
    }
  })
})
