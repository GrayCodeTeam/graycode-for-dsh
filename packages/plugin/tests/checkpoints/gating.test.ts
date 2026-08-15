/**
 * checkpoints 插件装配门控测试（C-01/C-02/C-03，index.ts apply）。
 *
 * 模式（参考 branches/index.test.ts + stagedDiff/tools.test.ts）：真实 DSH 服务组合
 * （LocalFileSystem → SessionStore → AgentRegistry → SystemPrompt → ToolRuntime →
 * LlmRuntime → AgentLoop），挂载 checkpoints 子插件（agentScope: 'all' 使工具注册
 * 面最大化），创建 agent 后经 ctx.tools.get(name, agent) 解析 scoped 工具。
 *
 * 覆盖：
 * - enabled=false → 7 个模型工具不注册；remote 查询端点仍可用
 * - modelToolsEnabled=false → 工具不注册；默认（true）→ 注册
 * - autoCheckpoint=false → 插件正常装配（remote 可用）
 * - remote checkpoints/create 保持 manual（origin 契约）
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { ScriptedAdapter } from '../e2e/harness.ts'
import * as checkpoints from '../../src/checkpoints/index.ts'
import { GrayRemoteService } from '../../src/remote/service.ts'

/** 插件 Config（TS 面新字段可缺省 → schema 默认值兜底；agentScope 恒 'all' 放大注册面）。 */
function pluginConfig(over: Partial<checkpoints.Config> = {}): checkpoints.Config {
  return {
    dataRoot: '',
    maxCheckpoints: -1,
    excludeProfiles: {},
    excludePatterns: [],
    maxFileSizeBytes: 50 * 1024 * 1024,
    blobGracePeriodDays: 7,
    restoreProtectionPoint: true,
    agentScope: 'all',
    ...over,
  }
}

interface World {
  ctx: Context
  workspace: string
  dataRoot: string
  remote: GrayRemoteService
  mounted: Array<{ dispose(): Promise<void> }>
}

async function mountWorld(over: Partial<checkpoints.Config>): Promise<World> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gc-checkpoints-gating-ws-'))
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gc-checkpoints-gating-data-'))
  const ctx = new Context()
  const mounted: Array<{ dispose(): Promise<void> }> = []
  try {
    mounted.push(await ctx.plugin(LocalFileSystem, { cwd: workspace }))
    mounted.push(await ctx.plugin(SessionStore))
    mounted.push(await ctx.plugin(AgentRegistry))
    mounted.push(await ctx.plugin(SystemPrompt))
    mounted.push(await ctx.plugin(ToolRuntime))
    mounted.push(await ctx.plugin(LlmRuntime))
    mounted.push(await ctx.plugin(AgentLoop, { agents: [] }))
    ctx.llm.registerAdapter(['echo'], new ScriptedAdapter([]))
    const remote = new GrayRemoteService(ctx)
    mounted.push(await ctx.plugin(checkpoints, { ...pluginConfig(over), dataRoot }))
    return { ctx, workspace, dataRoot, remote, mounted }
  } catch (err) {
    for (const fiber of mounted.reverse()) await fiber.dispose().catch(() => undefined)
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(dataRoot, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

async function createAgent(ctx: Context, workspace: string) {
  const handle = await ctx.agents.create({
    sessionId: SessionId('gating-session'),
    meta: { cwd: workspace },
    agentOptions: { provider: 'echo', model: 'echo-model' },
  })
  return handle.agent
}

async function disposeWorld(world: World): Promise<void> {
  for (const fiber of world.mounted.reverse()) {
    await fiber.dispose()
  }
  await fs.rm(world.workspace, { recursive: true, force: true })
  await fs.rm(world.dataRoot, { recursive: true, force: true })
}

describe('checkpoints 装配门控（index.ts apply）', () => {
  it('enabled=false → 模型工具不注册，remote 查询端点仍可用', async () => {
    const world = await mountWorld({ enabled: false })
    try {
      const agent = await createAgent(world.ctx, world.workspace)
      expect(world.ctx.tools.get('checkpoint_create', agent)).toBeUndefined()
      expect(world.ctx.tools.get('checkpoint_list', agent)).toBeUndefined()

      const result = await world.remote.invoke('checkpoints', 'list', { workspace: world.workspace })
      expect(result).toEqual({ ok: true, value: { items: [], total: 0, nextCursor: undefined } })
    } finally {
      await disposeWorld(world)
    }
  })

  it('modelToolsEnabled=false → 工具不注册；默认（true）→ 注册', async () => {
    const gated = await mountWorld({ modelToolsEnabled: false })
    try {
      const agent = await createAgent(gated.ctx, gated.workspace)
      expect(gated.ctx.tools.get('checkpoint_create', agent)).toBeUndefined()
      expect(gated.ctx.tools.get('checkpoint_gc', agent)).toBeUndefined()
    } finally {
      await disposeWorld(gated)
    }

    const open = await mountWorld({})
    try {
      const agent = await createAgent(open.ctx, open.workspace)
      expect(open.ctx.tools.get('checkpoint_create', agent)).toBeDefined()
      expect(open.ctx.tools.get('checkpoint_list', agent)).toBeDefined()
      expect(open.ctx.tools.get('checkpoint_gc', agent)).toBeDefined()
    } finally {
      await disposeWorld(open)
    }
  })

  it('autoCheckpoint=false → 插件正常装配（remote 可用，工具照常注册）', async () => {
    const world = await mountWorld({ autoCheckpoint: false })
    try {
      const agent = await createAgent(world.ctx, world.workspace)
      expect(world.ctx.tools.get('checkpoint_create', agent)).toBeDefined()
      const result = await world.remote.invoke('checkpoints', 'list', { workspace: world.workspace })
      expect(result).toEqual({ ok: true, value: { items: [], total: 0, nextCursor: undefined } })
    } finally {
      await disposeWorld(world)
    }
  })

  it('remote checkpoints/create 保持 manual origin（工具/端点路径不受自动存档影响）', async () => {
    const world = await mountWorld({})
    try {
      const created = await world.remote.invoke('checkpoints', 'create', {
        workspace: world.workspace,
        title: 'remote manual',
      })
      expect(created.ok).toBe(true)

      const listed = await world.remote.invoke('checkpoints', 'list', { workspace: world.workspace })
      const items = (listed as { ok: true; value: { items: Array<{ origin: string }> } }).value.items
      expect(items).toHaveLength(1)
      expect(items[0]!.origin).toBe('manual')
    } finally {
      await disposeWorld(world)
    }
  })
})
