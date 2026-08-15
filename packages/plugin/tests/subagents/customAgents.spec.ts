/**
 * subagents 自定义子代理（S2）— plan 纯函数与 DSH 适配器测试。
 *
 * plan：slug / provider 名 / 工具名推导 + 工具名去重（同名冲突追加 -2/-3）。
 * install：每 enabled 条目注册一个委托 provider 与一个工具；provider.start
 * 委托宿主 `spawn`（保留宿主 run 管理）；工具 execute 前台走 seam.start、
 * 后台走 seam.startContinuable，身份（persona = systemPrompt）进请求。
 * 工具名经 deriveToolNames 去重（-2/-3 后缀）；provider 名碰撞/不可 slug 化的 id
 * 在注册前整体拒绝；注册中途失败回滚已注册项（H-4a 无残留）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  deriveProviderName,
  deriveToolName,
  deriveToolNames,
  slugify,
  type CustomAgentConfig,
} from '../../src/subagents/customAgents/domain/plan.ts'
import {
  createCustomAgentTool,
  createDelegatingProvider,
  installCustomAgentRuntimes,
  type CustomAgentSeamLike,
  type CustomAgentToolsLike,
} from '../../src/subagents/customAgents/adapters/dsh/install.ts'

const AGENT: CustomAgentConfig = {
  id: 'agent-1',
  name: 'Code Reviewer',
  description: 'Reviews code for regressions',
  systemPrompt: 'You are a careful code reviewer.',
  enabled: true,
}

/** Structural tool object returned by defineTool (only the fields tests touch). */
interface ToolLike {
  name: string
  description: string
  parameters: Record<string, { type: string; required?: boolean }>
  execute(args: { description: string; prompt: string; run_in_background?: boolean }, exec: { agent?: unknown; signal: AbortSignal }): Promise<unknown>
}

function toolOf(value: unknown): ToolLike {
  return value as unknown as ToolLike
}

function makeFakeSeam(): {
  seam: CustomAgentSeamLike
  registerProvider: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  startContinuable: ReturnType<typeof vi.fn>
  spawn: { prepareContinuable?: (spec: unknown) => Promise<unknown> }
  /** 每次 registerProvider 返回的 disposer（真实可断言，不再是无用 no-op）。 */
  providerDisposes: Array<ReturnType<typeof vi.fn>>
} {
  const spawn: { prepareContinuable?: (spec: unknown) => Promise<unknown> } = {}
  const providerDisposes: Array<ReturnType<typeof vi.fn>> = []
  const registerProvider = vi.fn(() => {
    const dispose = vi.fn(() => {})
    providerDisposes.push(dispose)
    return dispose
  })
  const start = vi.fn(async () => ({ id: 'child', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }), dispose: vi.fn(async () => {}) }))
  const startContinuable = vi.fn(async () => ({ childId: 'child', messageId: 'm1' }))
  const seam: CustomAgentSeamLike = {
    registerProvider,
    getProvider: (name) => (name === 'spawn' ? { name: 'spawn', capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, inheritsParentContext: false, start: vi.fn(), ...spawn } : undefined),
    start,
    startContinuable,
  }
  return { seam, registerProvider, start, startContinuable, spawn, providerDisposes }
}

function makeFakeTools(): { tools: CustomAgentToolsLike; register: ReturnType<typeof vi.fn>; toolDisposes: Array<ReturnType<typeof vi.fn>> } {
  const toolDisposes: Array<ReturnType<typeof vi.fn>> = []
  const register = vi.fn(() => {
    const dispose = vi.fn(() => {})
    toolDisposes.push(dispose)
    return dispose
  })
  return { tools: { register }, register, toolDisposes }
}

describe('custom agent identity planning', () => {
  it('slugifies to an ASCII fragment', () => {
    expect(slugify('Code Reviewer')).toBe('code-reviewer')
    expect(slugify('  A__B  ')).toBe('a-b')
    expect(slugify('中文名字')).toBe('')
    expect(slugify('')).toBe('')
  })

  it('derives the stable provider name from the agent id', () => {
    expect(deriveProviderName('agent-1')).toBe('graycode-custom-agent-1')
    expect(deriveProviderName('My Agent!')).toBe('graycode-custom-my-agent')
  })

  it('derives a model-facing tool name from the name (id fallback for CJK)', () => {
    expect(deriveToolName(AGENT)).toBe('subagent_code-reviewer')
    expect(deriveToolName({ ...AGENT, name: '中文审查' })).toBe('subagent_agent-1')
  })

  it('de-duplicates colliding tool names in list order', () => {
    const a: CustomAgentConfig = { ...AGENT, id: 'a', name: 'Reviewer' }
    const b: CustomAgentConfig = { ...AGENT, id: 'b', name: 'Reviewer' }
    const c: CustomAgentConfig = { ...AGENT, id: 'c', name: 'R2' }
    const names = deriveToolNames([a, b, c])
    expect(names.get('a')).toBe('subagent_reviewer')
    expect(names.get('b')).toBe('subagent_reviewer-2')
    expect(names.get('c')).toBe('subagent_r2')
  })

  it('skips disabled agents when resolving tool names', () => {
    const a: CustomAgentConfig = { ...AGENT, id: 'a' }
    const off: CustomAgentConfig = { ...AGENT, id: 'off', enabled: false }
    const names = deriveToolNames([a, off])
    expect(names.has('off')).toBe(false)
  })
})

describe('delegating provider', () => {
  it('registers with the spawn-compatible capabilities and fresh-child wording', () => {
    const { seam, registerProvider } = makeFakeSeam()
    installCustomAgentRuntimes(seam, { register: () => () => {} }, [AGENT])
    expect(registerProvider).toHaveBeenCalledTimes(1)
    const provider = registerProvider.mock.calls[0]![0] as { name: string; capabilities: unknown; inheritsParentContext: boolean }
    expect(provider.name).toBe('graycode-custom-agent-1')
    expect(provider.capabilities).toEqual({ outputSchema: true, depthLimit: true, toolFilter: true, persona: true })
    expect(provider.inheritsParentContext).toBe(false)
  })

  it('start delegates to the host spawn provider through the service', async () => {
    const { seam, start } = makeFakeSeam()
    const provider = createDelegatingProvider(AGENT, seam)
    const request = { parent: {}, signal: new AbortController().signal, prompt: [] }
    await provider.start(request as never)
    expect(start).toHaveBeenCalledWith('spawn', request)
  })

  it('prepareContinuable delegates to spawn when it supports it and degrades otherwise', async () => {
    const spec = { provider: 'x' }
    const { seam, spawn } = makeFakeSeam()
    spawn.prepareContinuable = vi.fn(async (s: unknown) => ({ seeded: s }))
    const provider = createDelegatingProvider(AGENT, seam)
    await expect(provider.prepareContinuable?.(spec)).resolves.toEqual({ seeded: spec })
    const bare = makeFakeSeam()
    const bareProvider = createDelegatingProvider(AGENT, bare.seam)
    await expect(bareProvider.prepareContinuable?.(spec)).resolves.toEqual({})
  })
})

describe('custom agent tool', () => {
  it('carries the agent identity in name and description', () => {
    const { seam } = makeFakeSeam()
    const tool = toolOf(createCustomAgentTool(AGENT, 'subagent_code_reviewer', seam))
    expect(tool.name).toBe('subagent_code_reviewer')
    expect(tool.description).toContain('Reviews code for regressions')
    expect(tool.description).toContain('does not see this conversation')
  })

  it('foreground execute starts via the seam with the persona system prompt and settles the result', async () => {
    const { seam, start } = makeFakeSeam()
    const tool = toolOf(createCustomAgentTool(AGENT, 'subagent_code_reviewer', seam))
    const result = await tool.execute({ description: 'review', prompt: 'check x', run_in_background: false }, { agent: { id: 'parent' }, signal: new AbortController().signal })
    const [providerName, request] = start.mock.calls[0]!
    expect(providerName).toBe('graycode-custom-agent-1')
    expect(request.persona).toBe('You are a careful code reviewer.')
    expect(request.label).toBe('review')
    expect(request.parent).toEqual({ id: 'parent' })
    expect(result).toMatchObject({ kind: 'foreground', output: [{ type: 'text', text: 'ok' }] })
  })

  it('background execute (default) goes through startContinuable', async () => {
    const { seam, startContinuable } = makeFakeSeam()
    const tool = toolOf(createCustomAgentTool(AGENT, 'subagent_code_reviewer', seam))
    const result = await tool.execute({ description: 'review', prompt: 'check x' }, { agent: { id: 'parent' }, signal: new AbortController().signal })
    expect(startContinuable).toHaveBeenCalledTimes(1)
    const spec = startContinuable.mock.calls[0]![0]
    expect(spec.provider).toBe('graycode-custom-agent-1')
    expect(spec.label).toBe('review')
    expect(spec.request.persona).toBe('You are a careful code reviewer.')
    expect(result).toEqual({ kind: 'continuable', subagentId: 'child' })
  })

  it('omits persona when the system prompt is empty', async () => {
    const { seam, start } = makeFakeSeam()
    const tool = toolOf(createCustomAgentTool({ ...AGENT, systemPrompt: '   ' }, 'subagent_x', seam))
    await tool.execute({ description: 'review', prompt: 'check x', run_in_background: false }, { agent: { id: 'parent' }, signal: new AbortController().signal })
    expect(start.mock.calls[0]![1]).not.toHaveProperty('persona')
  })

  it('L1：前台执行失败且 dispose 也失败 → AggregateError 同时上报两者（不丢 dispose 失败）', async () => {
    const { seam } = makeFakeSeam()
    const tool = toolOf(createCustomAgentTool(AGENT, 'subagent_code_reviewer', seam))
    const execError = new Error('run failed')
    const disposeError = new Error('dispose failed')
    seam.start = vi.fn(async () => ({
      id: 'child',
      result: Promise.reject(execError),
      dispose: vi.fn(async () => { throw disposeError }),
    }))
    const error = await tool.execute(
      { description: 'review', prompt: 'x', run_in_background: false },
      { agent: { id: 'parent' }, signal: new AbortController().signal },
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toContain(execError)
    expect((error as AggregateError).errors).toContain(disposeError)
  })

  it('L1：执行成功但 dispose 失败 → 上报 dispose 失败', async () => {
    const { seam } = makeFakeSeam()
    const tool = toolOf(createCustomAgentTool(AGENT, 'subagent_code_reviewer', seam))
    const disposeError = new Error('dispose failed')
    seam.start = vi.fn(async () => ({
      id: 'child',
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }),
      dispose: vi.fn(async () => { throw disposeError }),
    }))
    const error = await tool.execute(
      { description: 'review', prompt: 'x', run_in_background: false },
      { agent: { id: 'parent' }, signal: new AbortController().signal },
    ).catch((e: unknown) => e)
    expect(error).toBe(disposeError)
  })
})

describe('installCustomAgentRuntimes', () => {
  it('registers one provider + one tool per enabled agent and unregisters on dispose', () => {
    const { seam, registerProvider, providerDisposes } = makeFakeSeam()
    const { tools, register, toolDisposes } = makeFakeTools()
    const dispose = installCustomAgentRuntimes(seam, tools, [AGENT, { ...AGENT, id: 'off', enabled: false }])
    expect(registerProvider).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledTimes(1)
    expect(providerDisposes).toHaveLength(1)
    expect(toolDisposes).toHaveLength(1)
    // 真实断言：dispose 调用每个 registerProvider / tools.register 返回的 disposer。
    dispose()
    expect(providerDisposes[0]).toHaveBeenCalledTimes(1)
    expect(toolDisposes[0]).toHaveBeenCalledTimes(1)
    // 幂等：二次 dispose 不重复释放。
    dispose()
    expect(providerDisposes[0]).toHaveBeenCalledTimes(1)
    expect(toolDisposes[0]).toHaveBeenCalledTimes(1)
  })

  it('同名工具经 deriveToolNames 去重后注册（-2/-3 后缀，注册期不再抛重复名）', () => {
    const { seam } = makeFakeSeam()
    const { tools, register } = makeFakeTools()
    const a: CustomAgentConfig = { ...AGENT, id: 'a', name: 'Reviewer' }
    const b: CustomAgentConfig = { ...AGENT, id: 'b', name: 'Reviewer' }
    installCustomAgentRuntimes(seam, tools, [a, b])
    expect(register).toHaveBeenCalledTimes(2)
    expect(toolOf(register.mock.calls[0]![0]).name).toBe('subagent_reviewer')
    expect(toolOf(register.mock.calls[1]![0]).name).toBe('subagent_reviewer-2')
  })

  it('provider 名碰撞（重复/同形 id）在注册前整体拒绝：零注册、零残留', () => {
    const { seam, registerProvider } = makeFakeSeam()
    const { tools, register } = makeFakeTools()
    const dupId = [AGENT, { ...AGENT, name: 'Second' }]
    expect(() => installCustomAgentRuntimes(seam, tools, dupId)).toThrow(/collision/)
    expect(registerProvider).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
    // 同形 id（slug 化后撞 provider 名）同样整体拒绝。
    const sameSlug = [{ ...AGENT, id: 'a b' }, { ...AGENT, id: 'a-b' }]
    expect(() => installCustomAgentRuntimes(seam, tools, sameSlug)).toThrow(/collision/)
    expect(registerProvider).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
  })

  it('不可 slug 化的 id（纯非 ASCII）在注册前拒绝', () => {
    const { seam, registerProvider } = makeFakeSeam()
    const { tools, register } = makeFakeTools()
    expect(() => installCustomAgentRuntimes(seam, tools, [{ ...AGENT, id: '中文审查' }])).toThrow()
    expect(registerProvider).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
  })

  it('注册中途失败 → 回滚已注册的 provider/tool 后向上抛错（无残留，H-4a）', () => {
    const { seam, registerProvider, providerDisposes } = makeFakeSeam()
    const { tools, register, toolDisposes } = makeFakeTools()
    const a: CustomAgentConfig = { ...AGENT, id: 'a', name: 'Reviewer' }
    const b: CustomAgentConfig = { ...AGENT, id: 'b', name: 'Bouncer' }
    // 第二个工具注册抛错（模拟与宿主既有工具重名，运行时 register 才会撞）。
    register.mockImplementationOnce(() => {
      const dispose = vi.fn(() => {})
      toolDisposes.push(dispose)
      return dispose
    }).mockImplementationOnce(() => {
      throw new Error('tool "subagent_bouncer" is already registered')
    })
    expect(() => installCustomAgentRuntimes(seam, tools, [a, b])).toThrow(/already registered/)
    // a 的 provider + a 的工具 + b 的 provider 已注册 → 全部回滚释放。
    expect(registerProvider).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenCalledTimes(2)
    expect(providerDisposes).toHaveLength(2)
    expect(providerDisposes[0]).toHaveBeenCalledTimes(1)
    expect(providerDisposes[1]).toHaveBeenCalledTimes(1)
    expect(toolDisposes).toHaveLength(1)
    expect(toolDisposes[0]).toHaveBeenCalledTimes(1)
  })
})
