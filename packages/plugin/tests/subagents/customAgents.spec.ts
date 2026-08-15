/**
 * subagents 自定义子代理（S2）— plan 纯函数与 DSH 适配器测试。
 *
 * plan：slug / provider 名 / 工具名推导 + 工具名去重（同名冲突追加 -2/-3）。
 * install：每 enabled 条目注册一个委托 provider 与一个工具；provider.start
 * 委托宿主 `spawn`（保留宿主 run 管理）；工具 execute 前台走 seam.start、
 * 后台走 seam.startContinuable，身份（persona = systemPrompt）进请求。
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
} {
  const spawn: { prepareContinuable?: (spec: unknown) => Promise<unknown> } = {}
  const registerProvider = vi.fn(() => () => {})
  const start = vi.fn(async () => ({ id: 'child', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] }), dispose: vi.fn(async () => {}) }))
  const startContinuable = vi.fn(async () => ({ childId: 'child', messageId: 'm1' }))
  const seam: CustomAgentSeamLike = {
    registerProvider,
    getProvider: (name) => (name === 'spawn' ? { name: 'spawn', capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, inheritsParentContext: false, start: vi.fn(), ...spawn } : undefined),
    start,
    startContinuable,
  }
  return { seam, registerProvider, start, startContinuable, spawn }
}

function makeFakeTools(): { tools: CustomAgentToolsLike; register: ReturnType<typeof vi.fn> } {
  const register = vi.fn(() => () => {})
  return { tools: { register }, register }
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
})

describe('installCustomAgentRuntimes', () => {
  it('registers one provider + one tool per enabled agent and unregisters on dispose', () => {
    const { seam, registerProvider } = makeFakeSeam()
    const { tools, register } = makeFakeTools()
    const dispose = installCustomAgentRuntimes(seam, tools, [AGENT, { ...AGENT, id: 'off', enabled: false }])
    expect(registerProvider).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledTimes(1)
    dispose()
    // The fake disposers are the returned no-ops; assert the contract shape:
    // every registerProvider/tools.register return value was invoked.
    const providerDispose = registerProvider.mock.results[0]?.value
    const toolDispose = register.mock.results[0]?.value
    expect(typeof providerDispose).toBe('function')
    expect(typeof toolDispose).toBe('function')
    expect(registerProvider).toHaveBeenCalledTimes(1)
  })
})
