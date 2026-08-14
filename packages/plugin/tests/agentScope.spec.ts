/**
 * agentScope.ts 单元测试：roots/all/disabled 三档、agent 生命周期清理、
 * 后加载回填、HMR 重复加载不重复注册。DSH 侧行为（scoped shadow、agent
 * dispose 自动 unwind agent.ctx effects）由 harness 源码测试覆盖，这里
 * 以 fake context/agent 验证注册器的编排逻辑。
 */
import { describe, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScopedToolRegistrar } from '../src/agentScope.ts'
import type { AgentScopeMode } from '../src/agentScope.ts'
import type { Config } from '../src/workflows/index.ts'

interface FakeAgentScope {
  tools: {
    register(definition: ToolDefinition): () => void
  }
  registered: Map<string, ToolDefinition>
  disposers: Map<string, () => void>
  disposeAll(): void
}

interface FakeCtx {
  on(event: string, callback: (payload: { agent: Agent }) => void): () => void
  effect(setup: () => () => void): () => void
  agents: {
    list(): Agent[]
    roots(): Agent[]
  }
  createdListeners: Array<(payload: { agent: Agent }) => void>
  disposedListeners: Array<(payload: { agent: Agent }) => void>
}

function makeFakeScope(): FakeAgentScope {
  return {
    // 占位实现：makeFakeAgent 在安装前总会用真实 register 覆盖，此处仅为满足类型。
    tools: { register: () => () => {} },
    registered: new Map(),
    disposers: new Map(),
    disposeAll() {
      for (const dispose of [...this.disposers.values()]) dispose()
      this.disposers.clear()
    },
  }
}

function makeFakeAgent(id: string, root: boolean): { agent: Agent; scope: FakeAgentScope } {
  const scope = makeFakeScope()
  scope.tools = {
    register: (definition: ToolDefinition) => {
      if (scope.registered.has(definition.name)) {
        throw new Error(`tool "${definition.name}" is already registered in this scope`)
      }
      scope.registered.set(definition.name, definition)
      const dispose = () => {
        scope.registered.delete(definition.name)
        scope.disposers.delete(definition.name)
      }
      scope.disposers.set(definition.name, dispose)
      return dispose
    },
  }
  const agent = {
    id,
    session: { id },
    ctx: scope,
    root,
  } as unknown as Agent
  return { agent, scope }
}

/** FakeCtx 仅实现 Context 的测试相关子集；跨入真实 Context 类型边界。 */
function toContext(ctx: FakeCtx): Context {
  return ctx as unknown as Context
}

function makeFakeCtx(agents: Array<{ agent: Agent; scope: FakeAgentScope }>): FakeCtx {
  const createdListeners: FakeCtx['createdListeners'] = []
  const disposedListeners: FakeCtx['disposedListeners'] = []
  const ctx: FakeCtx = {
    agents: {
      list: () => agents.map(entry => entry.agent),
      roots: () => agents.filter(entry => (entry.agent as unknown as { root: boolean }).root).map(entry => entry.agent),
    },
    on: (event, callback) => {
      if (event === 'agent/created') {
        createdListeners.push(callback)
        return () => {
          const index = createdListeners.indexOf(callback)
          if (index >= 0) createdListeners.splice(index, 1)
        }
      }
      if (event === 'agent/disposed') {
        disposedListeners.push(callback)
        return () => {
          const index = disposedListeners.indexOf(callback)
          if (index >= 0) disposedListeners.splice(index, 1)
        }
      }
      throw new Error(`unexpected event ${event}`)
    },
    effect: setup => {
      const teardown = setup()
      return () => teardown()
    },
    createdListeners,
    disposedListeners,
  }
  return ctx
}

function fakeDefinitions(count: number): ToolDefinition[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `fake_tool_${index}`,
  })) as unknown as ToolDefinition[]
}

function emitCreated(ctx: FakeCtx, entry: { agent: Agent; scope: FakeAgentScope }): void {
  for (const listener of [...ctx.createdListeners]) listener({ agent: entry.agent })
}

function emitDisposed(ctx: FakeCtx, entry: { agent: Agent; scope: FakeAgentScope }): void {
  entry.scope.disposeAll()
  for (const listener of [...ctx.disposedListeners]) listener({ agent: entry.agent })
}

const TWO_DEFS = fakeDefinitions(2)

describe('createScopedToolRegistrar', () => {
  test('roots 模式：只装 root agent；后续创建的 root 也会装，subagent 不装', () => {
    const root = makeFakeAgent('root-1', true)
    const sub = makeFakeAgent('sub-1', false)
    const ctx = makeFakeCtx([root, sub])

    const registrar = createScopedToolRegistrar(toContext(ctx), 'roots')
    registrar.register(TWO_DEFS)

    expect([...root.scope.registered.keys()]).toEqual(['fake_tool_0', 'fake_tool_1'])
    expect(sub.scope.registered.size).toBe(0)

    const lateRoot = makeFakeAgent('root-2', true)
    ctx.agents.list = () => [root.agent, sub.agent, lateRoot.agent]
    ctx.agents.roots = () => [root.agent, lateRoot.agent]
    emitCreated(ctx, lateRoot)
    expect([...lateRoot.scope.registered.keys()]).toEqual(['fake_tool_0', 'fake_tool_1'])
  })

  test('all 模式：root 与 subagent 都安装', () => {
    const root = makeFakeAgent('root-1', true)
    const sub = makeFakeAgent('sub-1', false)
    const ctx = makeFakeCtx([root, sub])

    const registrar = createScopedToolRegistrar(toContext(ctx), 'all')
    registrar.register(TWO_DEFS)

    expect(root.scope.registered.size).toBe(2)
    expect(sub.scope.registered.size).toBe(2)
  })

  test('disabled 模式：任何 agent 都不注册', () => {
    const root = makeFakeAgent('root-1', true)
    const ctx = makeFakeCtx([root])

    const registrar = createScopedToolRegistrar(toContext(ctx), 'disabled')
    registrar.register(TWO_DEFS)
    emitCreated(ctx, root)

    expect(root.scope.registered.size).toBe(0)
    expect(ctx.createdListeners).toHaveLength(0)
    registrar.dispose()
  })

  test('后加载回填：插件 apply 时已存在的 agent 立即获得工具', () => {
    const existing = makeFakeAgent('root-0', true)
    const ctx = makeFakeCtx([existing])

    const registrar = createScopedToolRegistrar(toContext(ctx), 'roots')
    registrar.register(TWO_DEFS)

    expect([...existing.scope.registered.keys()]).toEqual(['fake_tool_0', 'fake_tool_1'])
  })

  test('dispose 卸载全部 scoped 工具且幂等；agent 销毁后清空追踪', () => {
    const root = makeFakeAgent('root-1', true)
    const ctx = makeFakeCtx([root])

    const registrar = createScopedToolRegistrar(toContext(ctx), 'roots')
    registrar.register(TWO_DEFS)
    emitDisposed(ctx, root)
    expect(root.scope.registered.size).toBe(0)

    // dispose 后幂等：不会对已卸载 scope 重复调用 disposer 或抛错。
    registrar.dispose()
    registrar.dispose()
  })

  test('HMR 重复加载：旧实例 dispose 后新实例不重复注册、无残留', () => {
    const root = makeFakeAgent('root-1', true)
    const ctx = makeFakeCtx([root])

    const first = createScopedToolRegistrar(toContext(ctx), 'roots')
    first.register(TWO_DEFS)
    expect(root.scope.registered.size).toBe(2)

    first.dispose()
    expect(root.scope.registered.size).toBe(0)

    const second = createScopedToolRegistrar(toContext(ctx), 'roots')
    second.register(TWO_DEFS)
    expect(root.scope.registered.size).toBe(2)

    // 同一实例重复 register 同一名称不重复安装（安装按 agent 幂等）。
    second.register(TWO_DEFS)
    expect(root.scope.registered.size).toBe(2)
  })

  test('已 active 时再次 register：既有 agent 补装新增定义（增量安装，不重复旧定义）', () => {
    const root = makeFakeAgent('root-1', true)
    const ctx = makeFakeCtx([root])

    const registrar = createScopedToolRegistrar(toContext(ctx), 'roots')
    registrar.register(fakeDefinitions(2))
    expect([...root.scope.registered.keys()]).toEqual(['fake_tool_0', 'fake_tool_1'])

    // 第二次 register（追加两个新定义）：既有 agent 立即获得新定义，旧定义不重装
    const appended = fakeDefinitions(2).map((definition, index) => ({
      ...definition,
      name: `fake_tool_${index + 2}`,
    }))
    registrar.register(appended)
    expect([...root.scope.registered.keys()]).toEqual(['fake_tool_0', 'fake_tool_1', 'fake_tool_2', 'fake_tool_3'])

    // 后创建的 agent 获得全部定义（含追加部分）
    const lateRoot = makeFakeAgent('root-2', true)
    ctx.agents.list = () => [root.agent, lateRoot.agent]
    ctx.agents.roots = () => [root.agent, lateRoot.agent]
    emitCreated(ctx, lateRoot)
    expect([...lateRoot.scope.registered.keys()]).toEqual(['fake_tool_0', 'fake_tool_1', 'fake_tool_2', 'fake_tool_3'])

    // 卸载后新实例可整体重装（HMR：dispose → 重载 → register）
    registrar.dispose()
    expect(root.scope.registered.size).toBe(0)
    const reloaded = createScopedToolRegistrar(toContext(ctx), 'roots')
    reloaded.register(fakeDefinitions(4))
    expect([...root.scope.registered.keys()]).toEqual(['fake_tool_0', 'fake_tool_1', 'fake_tool_2', 'fake_tool_3'])
  })

  test('agentScopeSchema 默认 roots 且只接受三档值（经域 Config 组合）', async () => {
    const config = (await import('../src/workflows/index.ts')).Config
    // schemastery 在运行时校验并应用默认值，允许传入缺省字段的部分配置；此处仅补类型。
    expect(config({} as Config)).toMatchObject({ agentScope: 'roots' })
    expect(config({ agentScope: 'all' } as Config)).toMatchObject({ agentScope: 'all' })
    expect(config({ agentScope: 'disabled' } as Config)).toMatchObject({ agentScope: 'disabled' })
    expect(() => config({ agentScope: 'global' as unknown as AgentScopeMode } as Config)).toThrow()
  })

  test('registrar.dispose 移除监听器：后续 agent/created 不再安装', () => {
    const root = makeFakeAgent('root-1', true)
    const ctx = makeFakeCtx([root])

    const registrar = createScopedToolRegistrar(toContext(ctx), 'roots')
    registrar.register(TWO_DEFS)
    registrar.dispose()
    expect(ctx.createdListeners).toHaveLength(0)
  })
})
