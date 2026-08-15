/**
 * memory 跨域提示词服务（graycode.memoryPrompt）与 prompt 注入集成测试。
 *
 * 覆盖：
 * - memory.Config schema：systemPrompt / enabled 字段默认值与透传；
 * - apply 提供的跨域服务：getSystemPrompt（trim 语义，空 = 用内置说明）/
 *   isEnabled（enabled !== false，对齐原版 MemorySettingsService.isMemoryEnabled）；
 * - 服务随 fiber 注销（fiber dispose 后 ctx.get 返回 undefined）；
 * - 集成（真实 SystemPrompt + AgentRegistry + memory + promptInjector）：
 *   memory.systemPrompt 自定义文本进入 {{$MEMORY}} 占位符与 graycode.memory
 *   context；memory.enabled=false → MEMORY 为空（对齐原版
 *   contextSections.generateMemorySection L148-188）；未挂 memory 域 → 内置
 *   英文说明兜底；空白 systemPrompt → 内置说明；dynamicMemory=false 仍优先；
 * - 宿主 complete section 检测告警（只告警不干预，fail-open）。
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentRegistry, assembleContextFor } from '@deepseek-ai/dsh-agent'
import { SystemPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as memory from '../../src/memory/index.ts'
import {
  CONTEXT_MEMORY_NAME,
  createPromptInjector,
  PROMPT_SECTION_NAME,
} from '../../src/prompt/promptInjector.ts'
import { unavailablePlaceholderText } from '../../src/prompt/domain/template.ts'
import type { PromptMode } from '../../src/prompt/domain/promptTypes.ts'

const WS = 'X:/synthetic/graycode-project'

const disposers: Array<() => Promise<void>> = []
const dataRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (disposers.length > 0) {
    const dispose = disposers.pop()!
    await dispose()
  }
  for (const dir of dataRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeDataRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-memprompt-'))
  dataRoots.push(dir)
  return dir
}

async function makeWorld(): Promise<{ ctx: Context; host: Context }> {
  const ctx = new Context()
  // memory.apply 经 ctx.grayRemote?.register 挂载 Remote 端点；测试世界不挂
  // GrayRemoteService，提供 no-op stub（生产组合根总是先提供 grayRemote）。
  ctx.provide('grayRemote', { register: () => () => {} })
  const fibers = [await ctx.plugin(SystemPrompt), await ctx.plugin(AgentRegistry)]
  disposers.push(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  })
  const fiber = await ctx.plugin({ inject: ['systemPrompt', 'agents'], apply() {} })
  disposers.push(fiber.dispose as () => Promise<void>)
  return { ctx, host: fiber.ctx }
}

/** 挂载 memory 域（工具作用域 disabled：本测试只关心跨域服务与提示词注入）。 */
async function mountMemory(ctx: Context, overrides: Partial<memory.Config> = {}): Promise<void> {
  const config = Object.assign(
    {
      dataRoot: makeDataRoot(),
      wakeLines: 96,
      entryChars: 280,
      partChars: 20_000,
      partLines: 500,
      agentScope: 'disabled' as const,
      enabled: true,
      systemPrompt: '',
    },
    overrides,
  )
  const fiber = await ctx.plugin(memory, config)
  disposers.push(fiber.dispose as () => Promise<void>)
}

async function makeAgent(host: Context, id: string, cwd: string | undefined): Promise<Agent> {
  const agent = { id, session: { id, header: cwd ? { cwd } : {} } } as unknown as Agent
  const scope = createScope(host, agent)
  await scope.ctx.fiber
  disposers.push(scope.rawDispose as () => Promise<void>)
  ;(agent as { ctx: Context }).ctx = scope.ctx
  host.root.agents.register(agent)
  return agent
}

async function assembleFor(agent: Agent): Promise<{ sections: Array<{ name: string; text: string }>; assembly: PromptAssembly }> {
  const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
  return { sections: assembly.sections, assembly }
}

function promptSection(sections: Array<{ name: string; text: string }>): { name: string; text: string } | undefined {
  return sections.find(section => section.name === PROMPT_SECTION_NAME)
}

function memoryContext(assembly: PromptAssembly): { name: string; text: string } | undefined {
  return assembly.contexts.find(context => context.name === CONTEXT_MEMORY_NAME)
}

/** 构造一个测试模式（可控的模板与条目）。 */
function makeMode(overrides: Partial<PromptMode> = {}): PromptMode {
  return {
    id: 'test-mode',
    name: 'Test Mode',
    kind: 'custom',
    template: 'Mode template: {{graycode_prompt_mode}}',
    promptEntries: [],
    ...overrides,
  }
}

describe('memory.Config schema', () => {
  test("systemPrompt 默认 ''、enabled 默认 true；自定义值透传（不 trim）", () => {
    const parsed = memory.Config({ enabled: false, systemPrompt: '  custom  ' } as memory.Config)
    expect(parsed.enabled).toBe(false)
    expect(parsed.systemPrompt).toBe('  custom  ')
    const defaults = memory.Config()
    expect(defaults.enabled).toBe(true)
    expect(defaults.systemPrompt).toBe('')
  })
})

describe('graycode.memoryPrompt 跨域服务', () => {
  test('apply 提供服务：getSystemPrompt 返回 trim 后文本；isEnabled = enabled !== false', async () => {
    const { ctx } = await makeWorld()
    await mountMemory(ctx, { enabled: false, systemPrompt: '  Custom MEMORY prompt.  ' })

    const svc = ctx.get(memory.MEMORY_PROMPT_SERVICE) as memory.MemoryPromptService | undefined
    expect(svc).toBeDefined()
    expect(svc!.getSystemPrompt()).toBe('Custom MEMORY prompt.')
    expect(svc!.isEnabled()).toBe(false)
  })

  test("systemPrompt 空白 / 缺省 → getSystemPrompt 返回 ''；enabled 缺省 → isEnabled true", async () => {
    const { ctx } = await makeWorld()
    await mountMemory(ctx, { systemPrompt: '   \n  ' })

    const svc = ctx.get(memory.MEMORY_PROMPT_SERVICE) as memory.MemoryPromptService | undefined
    expect(svc).toBeDefined()
    expect(svc!.getSystemPrompt()).toBe('')
    expect(svc!.isEnabled()).toBe(true)
  })

  test('fiber dispose → 服务注销（ctx.get 返回 undefined）', async () => {
    const { ctx } = await makeWorld()
    const fiber = await ctx.plugin(memory, { dataRoot: makeDataRoot(), agentScope: 'disabled' } as memory.Config)
    expect(ctx.get(memory.MEMORY_PROMPT_SERVICE)).toBeDefined()
    await fiber.dispose()
    expect(ctx.get(memory.MEMORY_PROMPT_SERVICE)).toBeUndefined()
  })
})

describe('prompt 注入 × memory 跨域服务集成', () => {
  test('自定义 systemPrompt → MEMORY 占位符与 graycode.memory context 均用自定义文本', async () => {
    const { ctx, host } = await makeWorld()
    await mountMemory(ctx, { systemPrompt: 'Always call memory_wake first.' })
    const injector = createPromptInjector(ctx, 'roots', () => ({
      mode: makeMode({ template: 'MEMORY:\n{{$MEMORY}}' }),
      sendHistoryThoughts: false,
    }))

    const root = await makeAgent(host, 'root-mem', WS)
    const { sections, assembly } = await assembleFor(root)
    const section = promptSection(sections)!
    expect(section.text).toContain('Always call memory_wake first.')
    expect(section.text).not.toContain('Permanent Memory')
    expect(memoryContext(assembly)?.text).toBe('Always call memory_wake first.')
    injector.dispose()
  })

  test('enabled=false → MEMORY 占位符为空、context 为空（不注入，对齐原版 generateMemorySection）', async () => {
    const { ctx, host } = await makeWorld()
    await mountMemory(ctx, { enabled: false, systemPrompt: 'Should not appear' })
    const injector = createPromptInjector(ctx, 'roots', () => ({
      mode: makeMode({ template: 'MEMORY:\n{{$MEMORY}}' }),
      sendHistoryThoughts: false,
    }))

    const root = await makeAgent(host, 'root-mem-off', WS)
    const { sections, assembly } = await assembleFor(root)
    expect(promptSection(sections)!.text).toBe('MEMORY:')
    expect(memoryContext(assembly)?.text).toBe('')
    injector.dispose()
  })

  test('未挂 memory 域（无跨域服务）→ 内置英文说明兜底', async () => {
    const { ctx, host } = await makeWorld()
    const injector = createPromptInjector(ctx, 'roots', () => ({
      mode: makeMode({ template: 'MEMORY:\n{{$MEMORY}}' }),
      sendHistoryThoughts: false,
    }))

    const root = await makeAgent(host, 'root-mem-fallback', WS)
    const { sections, assembly } = await assembleFor(root)
    const section = promptSection(sections)!
    expect(section.text).toContain('Permanent Memory')
    expect(section.text).toContain('memory_wake')
    expect(memoryContext(assembly)?.text).toContain('Permanent Memory')
    injector.dispose()
  })

  test('systemPrompt 仅空白 → 视为未自定义（内置说明兜底）', async () => {
    const { ctx, host } = await makeWorld()
    await mountMemory(ctx, { systemPrompt: '   \n\t ' })
    const injector = createPromptInjector(ctx, 'roots', () => ({
      mode: makeMode({ template: '{{$MEMORY}}' }),
      sendHistoryThoughts: false,
    }))

    const root = await makeAgent(host, 'root-mem-blank', WS)
    const { sections } = await assembleFor(root)
    expect(promptSection(sections)!.text).toContain('Permanent Memory')
    injector.dispose()
  })

  test('dynamicMemory=false 仍优先于跨域服务：占位符键省略 → unavailable 提示，context 为空', async () => {
    const { ctx, host } = await makeWorld()
    await mountMemory(ctx, { systemPrompt: 'Custom text' })
    const injector = createPromptInjector(ctx, 'roots', () => ({
      mode: makeMode({ template: '{{$MEMORY}}' }),
      sendHistoryThoughts: false,
      dynamicMemory: false,
    }))

    const root = await makeAgent(host, 'root-mem-dyn-off', WS)
    const { sections, assembly } = await assembleFor(root)
    expect(promptSection(sections)!.text).toBe(unavailablePlaceholderText('MEMORY'))
    expect(memoryContext(assembly)?.text).toBe('')
    injector.dispose()
  })
})

describe('宿主 complete section 检测告警（fail-open）', () => {
  /** 宿主 complete section 生效时装配器产物的形状：downstream.sections 仅含该段（非 graycode:prompt）。 */
  const completeDownstream = (): PromptAssembly => ({
    sections: [{ name: 'host:complete', text: 'HOST COMPLETE' }],
    contexts: [],
    tools: [],
    variables: {},
  })

  test('downstream 仅剩单个非 graycode:prompt section → 告警且不干预', async () => {
    const { ctx, host } = await makeWorld()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const injector = createPromptInjector(ctx, 'roots', () => ({
      mode: makeMode({ template: 'tpl' }),
      sendHistoryThoughts: false,
      overrideHostPrompt: true,
    }))
    const root = await makeAgent(host, 'root-1', WS)

    // 直接驱动 agent 作用域的瀑布（等价 assemble 的 system-prompt/assemble 分发）。
    const downstream = completeDownstream()
    const result = await root.ctx.waterfall('system-prompt/assemble', downstream, {}, () => Promise.resolve(downstream))

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toBe(
      '[graycode-prompt] host complete section "host:complete" overrides prompt filtering (overrideHostPrompt ineffective); remove the complete flag or disable it',
    )
    // fail-open：告警不改变原有过滤行为（非 graycode section 仍被折叠进 host prompt 变量）
    expect(result.sections).toEqual([])
    expect(result.variables.graycode_dsh_prompt).toBe('HOST COMPLETE')
    injector.dispose()
  })

  test('overrideHostPrompt=false：宿主 complete section 原样保留，不告警', async () => {
    const { ctx, host } = await makeWorld()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const injector = createPromptInjector(ctx, 'roots', () => ({
      mode: makeMode({ template: 'tpl' }),
      sendHistoryThoughts: false,
      overrideHostPrompt: false,
    }))
    const root = await makeAgent(host, 'root-2', WS)

    const downstream = completeDownstream()
    const result = await root.ctx.waterfall('system-prompt/assemble', downstream, {}, () => Promise.resolve(downstream))

    expect(warn).not.toHaveBeenCalled()
    expect(result.sections).toEqual(downstream.sections)
    injector.dispose()
  })

  test('完整装配：真实 complete section 注册后最终 sections 仅剩该段（当前库在瀑布后恢复，覆盖我们的过滤）', async () => {
    const { ctx, host } = await makeWorld()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const injector = createPromptInjector(ctx, 'roots', () => ({
      mode: makeMode({ template: 'tpl' }),
      sendHistoryThoughts: false,
    }))
    const root = await makeAgent(host, 'root-3', WS)
    root.ctx.systemPrompt.section({
      name: 'host:complete',
      order: 5,
      text: 'HOST COMPLETE TEXT',
      complete: true,
    })
    const { sections } = await assembleFor(root)
    // 当前安装的 dsh-system-prompt 在瀑布之后把 complete section 恢复为唯一段；
    // 这正是告警要提示的“覆盖”情形。告警条件（downstream 单段）在当前库版本下
    // 不触发（downstream 仍含全部段），最终产物由库强制为 complete 段——fail-open。
    expect(sections).toEqual([{ name: 'host:complete', text: 'HOST COMPLETE TEXT' }])
    injector.dispose()
  })
})
