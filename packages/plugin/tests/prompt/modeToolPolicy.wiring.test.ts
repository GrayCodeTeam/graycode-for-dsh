/**
 * B6 接线测试：prompt 插件 apply() 将 D-4 模式 toolPolicy 执行链挂接到
 * ctx.tools.guard()（真实 ToolRuntime 管线），并验证 Config.modeToolPolicy 开关。
 *
 * 世界 = 真实 DSH 服务组合（LocalFileSystem → SessionStore → AgentRegistry →
 * SystemPrompt → ToolRuntime → LlmRuntime → AgentLoop）+ 真实 prompt 子插件
 * （apply 注册 guard + agentScope=roots 的 prompt 工具），创建 root agent 后：
 * - 经 prompt_mode_set（工具体直调，绕过 guard 便于切换）改变当前模式；
 * - 经 ctx.tools.execute 走完整 pre-execute/guard 管线执行全局探针写工具
 *   probe_write，观察 guard 的放行/拒绝；
 * - 探针名不在任何内置白名单内，故放行与否只由当前模式决定：
 *   code（无策略）放行；design/plan/ask/review（强制白名单）拒绝。
 *
 * 覆盖：
 * - 默认 modeToolPolicy=true：ask 拒绝名单外工具（无 agent 与带 agent 均拒绝）、
 *   code 放行（默认语义 = 旧版 preflight）；
 * - 模式切换后 guard 行为实时变化（无需重新挂接）；
 * - modeToolPolicy=false：ask 模式下写工具照常执行（零侵入）；
 * - 插件 fiber dispose 后 guard 随 ctx.effect disposer 注销（HMR 契约）。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  ToolRuntime,
  defineTool,
  type ToolExecutionResult,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { CallId, LlmRuntime } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { ScriptedAdapter } from '../e2e/harness.ts'
import * as promptPlugin from '../../src/prompt/index.ts'

const PROBE_WRITE = 'probe_write'

interface World {
  ctx: Context
  agent: Agent
  /** The prompt plugin fiber; disposing it mid-test simulates plugin unload (HMR). */
  promptFiber: { dispose(): Promise<void> }
  dispose(): Promise<void>
}

const worlds: World[] = []
const TEMP_DIRS: string[] = []

afterEach(async () => {
  while (worlds.length > 0) {
    await worlds.pop()!.dispose()
  }
  await Promise.all(TEMP_DIRS.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

async function makeWorld(modeToolPolicy?: boolean): Promise<World> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-mtp-ws-'))
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-mtp-data-'))
  TEMP_DIRS.push(workspace, dataRoot)
  const ctx = new Context()
  const mounted: Array<{ dispose(): Promise<void> }> = []

  mounted.push(await ctx.plugin(LocalFileSystem, { cwd: workspace }))
  mounted.push(await ctx.plugin(SessionStore))
  mounted.push(await ctx.plugin(AgentRegistry))
  mounted.push(await ctx.plugin(SystemPrompt))
  mounted.push(await ctx.plugin(ToolRuntime))
  mounted.push(await ctx.plugin(LlmRuntime))
  mounted.push(await ctx.plugin(AgentLoop, { agents: [] }))
  ctx.llm.registerAdapter(['echo'], new ScriptedAdapter([]))

  const promptFiber = await ctx.plugin(promptPlugin, {
    dataRoot,
    enabled: true,
    agentScope: 'roots',
    sendHistoryThoughts: false,
    requestLayer: false,
    // 不传时显式走默认 true，与 Config schema 的 default(true) 一致
    modeToolPolicy: modeToolPolicy ?? true,
  })
  mounted.push(promptFiber)

  // 全局探针写工具：名字不在任何内置白名单内；经 ctx.tools.execute 走完整管线。
  ctx.tools.register(
    defineTool({
      name: PROBE_WRITE,
      description: 'Probe tool: a write-like tool outside every builtin allowlist.',
      parameters: {},
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        return { ok: true }
      },
    }),
  )

  const handle = await ctx.agents.create({
    sessionId: SessionId('mtp-session'),
    meta: { cwd: workspace },
    agentOptions: { provider: 'echo', model: 'echo-model' },
  })

  const world: World = {
    ctx,
    agent: handle.agent,
    promptFiber,
    async dispose() {
      // prompt 插件懒加载（getCurrentMode → injector.refresh）可能在 dispose 后
      // 才结算：先放行一个 macrotask 使其在活跃 ctx 上完成（同 staged-diff.spec）。
      await new Promise(resolve => setTimeout(resolve, 25))
      for (const fiber of mounted.reverse()) {
        await fiber.dispose()
      }
    },
  }
  worlds.push(world)
  return world
}

function execContext(agent: Agent): ToolRunContext {
  return {
    agent: agent as unknown as NonNullable<ToolRunContext['agent']>,
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
}

/** 经 prompt_mode_set 工具体直调切换模式（绕过 guard，guard 语义由其他用例覆盖）。 */
async function switchMode(world: World, modeId: string): Promise<void> {
  const set = world.ctx.tools.get('prompt_mode_set', world.agent)!
  const result = (await set.execute({ modeId }, execContext(world.agent))) as {
    success?: boolean
    error?: string
  }
  expect(result.success, `prompt_mode_set("${modeId}") failed: ${result.error ?? 'unknown'}`).toBe(true)
}

let callSeq = 0

/** 经 ctx.tools.execute 走完整 pre-execute/guard 管线执行探针写工具。 */
async function executeProbe(world: World, withAgent: boolean): Promise<ToolExecutionResult> {
  return world.ctx.tools.execute({
    callId: CallId(`mtp-call-${++callSeq}`),
    name: PROBE_WRITE,
    arguments: {},
    signal: new AbortController().signal,
    ...(withAgent ? { agent: world.agent } : {}),
  })
}

function expectDenied(result: ToolExecutionResult, modeId: string): void {
  expect(result.isError).toBe(true)
  if (result.isError) {
    expect(result.error.message).toContain(`not allowed in mode "${modeId}"`)
    expect(result.error.message).toContain(PROBE_WRITE)
  }
}

function expectAllowed(result: ToolExecutionResult): void {
  expect(result.isError).toBe(false)
  if (!result.isError) {
    expect(result.value).toEqual({ ok: true })
  }
}

describe('B6：prompt 插件 → ctx.tools.guard 模式 toolPolicy 接线', () => {
  it('默认 modeToolPolicy=true：ask 模式拒绝名单外写工具（无 agent 与带 agent 均拒绝），code 模式放行', async () => {
    const world = await makeWorld() // 不传 = Config 默认 true
    await switchMode(world, 'ask')
    expectDenied(await executeProbe(world, false), 'ask')
    expectDenied(await executeProbe(world, true), 'ask')

    await switchMode(world, 'code')
    expectAllowed(await executeProbe(world, false))
  })

  it('模式切换实时生效：design/plan/review 均拒绝，无需重新挂接 guard', async () => {
    const world = await makeWorld(true)
    for (const modeId of ['design', 'plan', 'review']) {
      await switchMode(world, modeId)
      expectDenied(await executeProbe(world, false), modeId)
    }
    await switchMode(world, 'code')
    expectAllowed(await executeProbe(world, false))
  })

  it('modeToolPolicy=false 零侵入：ask 模式下写工具照常执行', async () => {
    const world = await makeWorld(false)
    await switchMode(world, 'ask')
    expectAllowed(await executeProbe(world, false))
    expectAllowed(await executeProbe(world, true))
  })

  it('插件卸载后 guard 随 ctx.effect disposer 注销（HMR 契约）', async () => {
    const world = await makeWorld(true)
    await switchMode(world, 'ask')
    expectDenied(await executeProbe(world, false), 'ask')

    await world.promptFiber.dispose()
    // guard 已注销：ask 模式下写工具恢复执行
    expectAllowed(await executeProbe(world, false))
  })
})
