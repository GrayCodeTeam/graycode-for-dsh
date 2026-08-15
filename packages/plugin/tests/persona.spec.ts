/**
 * persona.ts 测试：真实 Context + 真实 dsh-system-prompt / dsh-agent 服务。
 * fake agent 通过 AgentRegistry.register 走真实的 `agent/created` 分发，
 * 再用 assembleContextFor 对 agent scope 做真实 assemble：验证 graycode
 * persona section 的注册、模板覆盖与 {{variable}} 插值、enabled/agentScope
 * 两档开关、roots/all 目标选择与 dispose 清理。
 */
import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentRegistry, assembleContextFor } from '@deepseek-ai/dsh-agent'
import { SystemPrompt, renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import {
  createPersonaRegistrar,
  DEFAULT_PERSONA_TEMPLATE,
  PERSONA_SECTION_NAME,
  PERSONA_WORKSPACE_VARIABLE,
  workspaceNameOf,
  type Config as PersonaConfig,
} from '../src/persona.ts'

const WS = 'X:/synthetic/graycode-project'

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (disposers.length > 0) {
    const dispose = disposers.pop()!
    await dispose()
  }
})

/** Host fiber that injects the services agent scopes must read (matches the agent-loop inject surface). */
async function makeHost(ctx: Context): Promise<Context> {
  const fiber = await ctx.plugin({
    inject: ['systemPrompt', 'agents'],
    apply() {},
  })
  disposers.push(fiber.dispose as () => Promise<void>)
  return fiber.ctx
}

async function makeWorld(): Promise<{ ctx: Context; host: Context }> {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(AgentRegistry),
  ]
  disposers.push(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  })
  return { ctx, host: await makeHost(ctx) }
}

/** Build a fake agent whose scoped ctx is a real dsh-scope scope, then register it (emits agent/created). */
async function makeAgent(host: Context, id: string, cwd: string | undefined, parent?: Agent): Promise<Agent> {
  const agent = {
    id,
    session: { id, header: cwd ? { cwd } : {} },
  } as unknown as Agent
  const scope = createScope(host, agent)
  // createScope mounts its own plugin fiber; wait for it before using the ctx.
  await scope.ctx.fiber
  disposers.push(scope.rawDispose as () => Promise<void>)
  ;(agent as { ctx: Context }).ctx = scope.ctx
  const registerCtx = parent ? scope.ctx.extend({ agent: parent }) : ctxRoot(host)
  registerCtx.agents.register(agent)
  return agent
}

/** The root context of a host fiber (agent registration there marks the agent as a root). */
function ctxRoot(host: Context): Context {
  return (host as { root: Context }).root
}

async function assembleFor(agent: Agent): Promise<{ sections: Array<{ name: string; text: string }>; assembly: PromptAssembly }> {
  const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
  return { sections: assembly.sections, assembly }
}

function graycodeSection(sections: Array<{ name: string; text: string }>): { name: string; text: string } | undefined {
  return sections.find(section => section.name === PERSONA_SECTION_NAME)
}

describe('createPersonaRegistrar', () => {
  test('roots 模式（默认）：root agent 获得默认 persona section；subagent 不注入', async () => {
    const { ctx, host } = await makeWorld()
    const registrar = createPersonaRegistrar(ctx, { enabled: true, agentScope: 'roots' })

    const root = await makeAgent(host, 'root-1', WS)
    const { sections } = await assembleFor(root)
    const section = graycodeSection(sections)
    expect(section).toBeDefined()
    expect(section!.text).toBe(DEFAULT_PERSONA_TEMPLATE)
    expect(section!.text).toContain('GrayCode-enhanced')

    const sub = await makeAgent(host, 'sub-1', WS, root)
    const subAssembly = await assembleFor(sub)
    expect(graycodeSection(subAssembly.sections)).toBeUndefined()
    registrar.dispose()
  })

  test('all 模式：root 与 subagent 都注入', async () => {
    const { ctx, host } = await makeWorld()
    const registrar = createPersonaRegistrar(ctx, { enabled: true, agentScope: 'all' })

    const root = await makeAgent(host, 'root-1', WS)
    const sub = await makeAgent(host, 'sub-1', WS, root)

    for (const agent of [root, sub]) {
      const { sections } = await assembleFor(agent)
      expect(graycodeSection(sections)).toBeDefined()
    }
    registrar.dispose()
  })

  test('disabled 模式（agentScope）：任何 agent 都不注入', async () => {
    const { ctx, host } = await makeWorld()
    const registrar = createPersonaRegistrar(ctx, { enabled: true, agentScope: 'disabled' })

    const root = await makeAgent(host, 'root-1', WS)
    const { sections } = await assembleFor(root)
    expect(graycodeSection(sections)).toBeUndefined()
    registrar.dispose()
  })

  test('enabled=false：整体不注册', async () => {
    const { ctx, host } = await makeWorld()
    const registrar = createPersonaRegistrar(ctx, { enabled: false, agentScope: 'roots' })

    const root = await makeAgent(host, 'root-1', WS)
    const { sections } = await assembleFor(root)
    expect(graycodeSection(sections)).toBeUndefined()
    registrar.dispose()
  })

  test('后加载回填：registrar 创建前已存在的 agent 也获得 persona', async () => {
    const { ctx, host } = await makeWorld()
    const existing = await makeAgent(host, 'root-0', WS)

    const registrar = createPersonaRegistrar(ctx, { enabled: true, agentScope: 'roots' })
    const { sections } = await assembleFor(existing)
    expect(graycodeSection(sections)).toBeDefined()
    registrar.dispose()
  })

  test('自定义 template 支持 {{}} 占位符，经 system-prompt variable 插值', async () => {
    const { ctx, host } = await makeWorld()
    const registrar = createPersonaRegistrar(ctx, {
      enabled: true,
      agentScope: 'roots',
      template: 'GrayCode workspace: {{graycode_workspace}}',
    })

    const root = await makeAgent(host, 'root-1', WS)
    const { sections, assembly } = await assembleFor(root)
    const section = graycodeSection(sections)
    expect(section).toBeDefined()
    expect(section!.text).toBe('GrayCode workspace: {{graycode_workspace}}')

    // assemble() 保留未插值文本；renderPrompt 通过已注册的 graycode_workspace
    // variable 完成插值（basename(cwd)）。
    const rendered = renderPrompt(assembly)
    expect(rendered).toContain('GrayCode workspace: graycode-project')
    registrar.dispose()
  })

  test('dispose：卸载全部 scoped section/variable，新 agent 不再注入', async () => {
    const { ctx, host } = await makeWorld()
    const registrar = createPersonaRegistrar(ctx, { enabled: true, agentScope: 'roots' })

    const first = await makeAgent(host, 'root-1', WS)
    const before = await assembleFor(first)
    expect(graycodeSection(before.sections)).toBeDefined()

    registrar.dispose()
    registrar.dispose() // 幂等

    const afterDispose = await assembleFor(first)
    expect(graycodeSection(afterDispose.sections)).toBeUndefined()

    const late = await makeAgent(host, 'root-2', WS)
    const lateAssembly = await assembleFor(late)
    expect(graycodeSection(lateAssembly.sections)).toBeUndefined()
  })

  test('variable 名与 section 槽位对外稳定（preset 替换目标）', () => {
    expect(PERSONA_SECTION_NAME).toBe('graycode:persona')
    expect(PERSONA_WORKSPACE_VARIABLE).toBe('graycode_workspace')
    const config: PersonaConfig = { enabled: true, agentScope: 'roots' }
    expect(config.agentScope).toBe('roots')
  })
})

describe('workspaceNameOf（L6：cwd → 工作区显示名，判空 + 盘符根安全降级）', () => {
  test('常规路径取 basename；反斜杠 / 尾部斜杠归一', () => {
    expect(workspaceNameOf('X:/synthetic/graycode-project')).toBe('graycode-project')
    expect(workspaceNameOf('C:\\Users\\me\\project')).toBe('project')
    expect(workspaceNameOf('C:/project/')).toBe('project')
    expect(workspaceNameOf('//server/share')).toBe('share')
  })

  test('空值 / 路径根 / 盘符根 → undefined（不退化空串）', () => {
    expect(workspaceNameOf(undefined)).toBeUndefined()
    expect(workspaceNameOf('')).toBeUndefined()
    expect(workspaceNameOf('/')).toBeUndefined()
    expect(workspaceNameOf('C:/')).toBeUndefined()
    expect(workspaceNameOf('C:\\')).toBeUndefined()
  })
})
