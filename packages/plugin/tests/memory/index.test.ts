/**
 * memory 域 enabled 门控（M-01）：enabled=false → 7 个记忆工具不注册
 * （工具不可见即不可用，对齐 agentScope=disabled 语义）；Remote 管理端点
 * 仍注册（管理面板在 enabled=false 时仍可浏览/删除记忆）。
 *
 * 装配模式参考 tests/branches/index.test.ts（真实 Context + ctx.plugin）；
 * grayRemote 注入时序参考 tests/prompt/lateRegistration.test.ts（轮询等待）。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as memory from '../../src/memory/index.ts'
import { GrayRemoteService } from '../../src/remote/service.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

const MEMORY_TOOL_NAMES = [
  'memory_wake',
  'memory_note',
  'memory_recall',
  'memory_compress',
  'memory_zoom',
  'memory_forget',
  'memory_config',
] as const

const MEMORY_REMOTE_ENDPOINTS = [
  'memory/list',
  'memory/note',
  'memory/edit',
  'memory/forget',
  'memory/forgetBatch',
  'memory/scopes',
  'memory/configGet',
  'memory/configUpdate',
]

interface FakeAgentScope {
  tools: {
    register(definition: ToolDefinition): () => void
  }
  registered: Map<string, ToolDefinition>
}

function makeFakeAgent(id: string): { agent: Agent; scope: FakeAgentScope } {
  const scope: FakeAgentScope = {
    tools: { register: () => () => {} },
    registered: new Map(),
  }
  scope.tools = {
    register: (definition: ToolDefinition) => {
      scope.registered.set(definition.name, definition)
      return () => scope.registered.delete(definition.name)
    },
  }
  const agent = {
    id,
    session: { id },
    ctx: scope,
  } as unknown as Agent
  return { agent, scope }
}

/** 等待 grayRemote inject 纤维完成端点注册（异步微任务链）。 */
async function waitForEndpoints(ctx: Context, endpoint: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const remote = ctx.get('grayRemote') as GrayRemoteService | undefined
    if (remote?.has(endpoint) === true) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`endpoint ${endpoint} was not registered after grayRemote became available`)
}

interface MountResult {
  ctx: Context
  remote: GrayRemoteService
  scopes: FakeAgentScope[]
  agents: Agent[]
  dispose(): Promise<void>
}

async function mountMemory(opts: { enabled?: boolean; preexistingAgent?: boolean }): Promise<MountResult> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-memory-index-'))
  tempDirs.push(dataRoot)
  const ctx = new Context()
  const entries: Array<{ agent: Agent; scope: FakeAgentScope }> = []
  if (opts.preexistingAgent !== false) {
    entries.push(makeFakeAgent('root-agent'))
  }
  // agents 服务最小 mock（registrar 只用 list/roots + ctx.on('agent/created')）。
  ctx.provide('agents', {
    list: () => entries.map(entry => entry.agent),
    roots: () => entries.map(entry => entry.agent),
  } as never)
  const remote = new GrayRemoteService(ctx)
  const fiber = await ctx.plugin(memory, {
    dataRoot,
    agentScope: 'roots',
    wakeLines: 96,
    entryChars: 280,
    partChars: 20_000,
    partLines: 500,
    ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
  })
  await waitForEndpoints(ctx, 'memory/scopes')
  return {
    ctx,
    remote,
    scopes: entries.map(entry => entry.scope),
    agents: entries.map(entry => entry.agent),
    dispose: async () => {
      await fiber.dispose()
    },
  }
}

describe('memoryToolsEnabled（M-01 门控纯函数）', () => {
  it('enabled 缺省/true → true；false → false', () => {
    expect(memory.memoryToolsEnabled({})).toBe(true)
    expect(memory.memoryToolsEnabled({ enabled: true })).toBe(true)
    expect(memory.memoryToolsEnabled({ enabled: false })).toBe(false)
  })
})

describe('memory 装配 enabled 门控（M-01）', () => {
  it('enabled=false → 7 个记忆工具不注册；Remote 管理端点仍注册', async () => {
    const mounted = await mountMemory({ enabled: false })
    try {
      expect(mounted.scopes).toHaveLength(1)
      for (const name of MEMORY_TOOL_NAMES) {
        expect(mounted.scopes[0]!.registered.has(name), name).toBe(false)
      }
      // Remote 管理端点不受 enabled 影响（管理面板仍可浏览/删除记忆）。
      const endpoints = mounted.remote.listEndpoints()
      for (const endpoint of MEMORY_REMOTE_ENDPOINTS) {
        expect(endpoints, endpoint).toContain(endpoint)
      }
    } finally {
      await mounted.dispose()
    }
  })

  it('enabled=true（显式）→ 7 个记忆工具全部注册（既有 agent 回填）', async () => {
    const mounted = await mountMemory({ enabled: true })
    try {
      expect(mounted.scopes).toHaveLength(1)
      for (const name of MEMORY_TOOL_NAMES) {
        expect(mounted.scopes[0]!.registered.has(name), name).toBe(true)
      }
    } finally {
      await mounted.dispose()
    }
  })

  it('enabled 缺省（默认 true）→ 工具注册，行为与显式 true 一致', async () => {
    const mounted = await mountMemory({})
    try {
      for (const name of MEMORY_TOOL_NAMES) {
        expect(mounted.scopes[0]!.registered.has(name), name).toBe(true)
      }
    } finally {
      await mounted.dispose()
    }
  })

  it('enabled=false 时后续创建的 agent 也不会拿到记忆工具（监听器路径）', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-memory-index-'))
    tempDirs.push(dataRoot)
    const ctx = new Context()
    const entries: Array<{ agent: Agent; scope: FakeAgentScope }> = []
    ctx.provide('agents', {
      list: () => entries.map(entry => entry.agent),
      roots: () => entries.map(entry => entry.agent),
    } as never)
    new GrayRemoteService(ctx)
    const fiber = await ctx.plugin(memory, { dataRoot, agentScope: 'roots', enabled: false, wakeLines: 96, entryChars: 280, partChars: 20_000, partLines: 500 })
    await waitForEndpoints(ctx, 'memory/scopes')
    try {
      // 装配后才出现的新 agent：模拟 agent/created 事件（registrar 监听路径）。
      const late = makeFakeAgent('late-agent')
      entries.push(late)
      ctx.emit('agent/created', { agent: late.agent })
      expect(late.scope.registered.size).toBe(0)
      expect(late.scope.registered.has('memory_note')).toBe(false)
    } finally {
      await fiber.dispose()
    }
  })

  it('enabled=false → agent/pre-step 不注入记忆快照（M-1 装配门控）', async () => {
    const mounted = await mountMemory({ enabled: false })
    try {
      const message = createUserMessage({
        content: [{ type: 'text', text: 'inbox' }],
        source: { kind: 'plugin', plugin: 'test' },
      })
      const decision = await mounted.ctx.waterfall(
        'agent/pre-step',
        {
          agent: mounted.agents[0]!,
          messages: [message],
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
      )
      // enabled=false → 监听器短路透传：消息原样返回，无记忆快照注入。
      expect(decision).toEqual({ kind: 'enter', messages: [message] })
    } finally {
      await mounted.dispose()
    }
  })

  it('enabled=true 时后续创建的 agent 经 agent/created 回填工具', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-memory-index-'))
    tempDirs.push(dataRoot)
    const ctx = new Context()
    const entries: Array<{ agent: Agent; scope: FakeAgentScope }> = []
    ctx.provide('agents', {
      list: () => entries.map(entry => entry.agent),
      roots: () => entries.map(entry => entry.agent),
    } as never)
    new GrayRemoteService(ctx)
    const fiber = await ctx.plugin(memory, { dataRoot, agentScope: 'roots', wakeLines: 96, entryChars: 280, partChars: 20_000, partLines: 500 })
    await waitForEndpoints(ctx, 'memory/scopes')
    try {
      const late = makeFakeAgent('late-agent')
      entries.push(late)
      ctx.emit('agent/created', { agent: late.agent })
      for (const name of MEMORY_TOOL_NAMES) {
        expect(late.scope.registered.has(name), name).toBe(true)
      }
    } finally {
      await fiber.dispose()
    }
  })
})
