/**
 * promptInjector.ts 测试：真实 Context + 真实 dsh-system-prompt / dsh-agent
 * 服务（同 persona.spec.ts 世界）。fake agent 走真实 `agent/created` 分发，
 * assembleContextFor 做真实 assemble：
 * - 模式 section 注册（template + 条目段落 + prefix/suffix + 占位符变量）；
 * - 切换模式后旧文本消失、新文本出现（refresh 重注册）；
 * - disabled / 无当前模式 / agentScope 各档；
 * - sendHistoryThoughts 两态（D-11=c 注入时门）；
 * - fingerprint 去重（同状态 refresh 不重复注册）；
 * - dispose 清理与后加载回填。
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentRegistry, assembleContextFor } from '@deepseek-ai/dsh-agent'
import { SystemPrompt, renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import {
  createPromptInjector,
  PROMPT_MODE_VARIABLE,
  PROMPT_ORDER,
  PROMPT_SECTION_NAME,
  type PromptRenderState,
} from '../../src/prompt/promptInjector.ts'
import { unavailablePlaceholderText } from '../../src/prompt/domain/template.ts'
import type { PromptMode } from '../../src/prompt/domain/promptTypes.ts'

const WS = 'X:/synthetic/graycode-project'

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  while (disposers.length > 0) {
    const dispose = disposers.pop()!
    await dispose()
  }
})

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

async function makeAgent(host: Context, id: string, cwd: string | undefined, parent?: Agent): Promise<Agent> {
  const agent = {
    id,
    session: { id, header: cwd ? { cwd } : {} },
  } as unknown as Agent
  const scope = createScope(host, agent)
  await scope.ctx.fiber
  disposers.push(scope.rawDispose as () => Promise<void>)
  ;(agent as { ctx: Context }).ctx = scope.ctx
  const registerCtx = parent ? scope.ctx.extend({ agent: parent }) : (host as { root: Context }).root
  registerCtx.agents.register(agent)
  return agent
}

async function assembleFor(agent: Agent): Promise<{ sections: Array<{ name: string; text: string }>; assembly: PromptAssembly }> {
  const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
  return { sections: assembly.sections, assembly }
}

function promptSection(sections: Array<{ name: string; text: string }>): { name: string; text: string } | undefined {
  return sections.find(section => section.name === PROMPT_SECTION_NAME)
}

/** 构造一个测试模式（可控的模板与条目） */
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

describe('createPromptInjector', () => {
  test('roots 模式：root agent 获得 graycode:prompt section（order 紧随 persona），subagent 不注入', async () => {
    const { ctx, host } = await makeWorld()
    let state = { mode: makeMode(), sendHistoryThoughts: false }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-1', WS)
    const { sections } = await assembleFor(root)
    const section = promptSection(sections)
    expect(section).toBeDefined()
    expect(section!.text).toContain('Mode template')
    expect(section!.text).toContain('{{graycode_prompt_mode}}')
    expect(PROMPT_ORDER).toBe(1)

    const sub = await makeAgent(host, 'sub-1', WS, root)
    const subAssembly = await assembleFor(sub)
    expect(promptSection(subAssembly.sections)).toBeUndefined()
    injector.dispose()
  })

  test('section 文本只含系统部分：user/assistant 条目与 fakeThought 不以文本出现（entries-first）', async () => {
    const { ctx, host } = await makeWorld()
    const mode = makeMode({
      template: 'tpl',
      promptEntries: [
        { id: 'u1', role: 'user', order: 0, enabled: true, content: 'user body' },
        { id: 'a1', role: 'assistant', order: 1, enabled: true, content: 'assistant body', fakeThought: 'thinking!' },
      ],
    })
    let state = { mode, sendHistoryThoughts: true }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-1', WS)
    const { sections } = await assembleFor(root)
    const text = promptSection(sections)!.text
    expect(text).toContain('tpl')
    expect(text).not.toContain('user body')
    expect(text).not.toContain('assistant body')
    expect(text).not.toContain('[GrayCode preset entry:')
    expect(text).not.toContain('[thinking]')
    expect(text).not.toContain('thinking!')
    injector.dispose()
  })

  test('sendHistoryThoughts 两态均不在 section 文本注入 [thinking]（typed-only，由 thoughts 域处理）', async () => {
    const { ctx, host } = await makeWorld()
    const mode = makeMode({
      template: 'tpl',
      promptEntries: [
        { id: 'a1', role: 'assistant', order: 0, enabled: true, content: 'body', fakeThought: 'secret' },
      ],
    })
    let state = { mode, sendHistoryThoughts: false }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-1', WS)
    const off = await assembleFor(root)
    expect(promptSection(off.sections)!.text).toContain('tpl')
    expect(promptSection(off.sections)!.text).not.toContain('[thinking]')
    expect(promptSection(off.sections)!.text).not.toContain('body')

    state = { mode, sendHistoryThoughts: true }
    injector.refresh()
    const on = await assembleFor(root)
    expect(promptSection(on.sections)!.text).not.toContain('[thinking]')
    expect(promptSection(on.sections)!.text).not.toContain('secret')
    injector.dispose()
  })

  test('模式切换（refresh）：旧模板文本消失、新模板文本出现', async () => {
    const { ctx, host } = await makeWorld()
    let state = { mode: makeMode({ id: 'm1', name: 'M1', template: 'OLD-TEMPLATE' }), sendHistoryThoughts: false }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-1', WS)
    expect(promptSection((await assembleFor(root)).sections)!.text).toContain('OLD-TEMPLATE')

    state = { mode: makeMode({ id: 'm2', name: 'M2', template: 'NEW-TEMPLATE' }), sendHistoryThoughts: false }
    injector.refresh()

    const { sections } = await assembleFor(root)
    const section = promptSection(sections)!
    expect(section.text).toContain('NEW-TEMPLATE')
    expect(section.text).not.toContain('OLD-TEMPLATE')
    // 只有唯一一个 graycode:prompt section（旧 section 已卸载）
    expect(sections.filter(s => s.name === PROMPT_SECTION_NAME)).toHaveLength(1)
    injector.dispose()
  })

  test('同状态 refresh 幂等：fingerprint 去重，不重复注册、文本不变', async () => {
    const { ctx, host } = await makeWorld()
    const mode = makeMode()
    let state = { mode, sendHistoryThoughts: false }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-1', WS)
    const before = (await assembleFor(root)).sections.filter(s => s.name === PROMPT_SECTION_NAME)
    expect(before).toHaveLength(1)

    injector.refresh()
    injector.refresh()
    const after = (await assembleFor(root)).sections.filter(s => s.name === PROMPT_SECTION_NAME)
    expect(after).toHaveLength(1)
    expect(after[0]!.text).toBe(before[0]!.text)
    injector.dispose()
  })

  test('placeholderValues 注入 {{$MODULE}}；section text 随占位符刷新（provider 式）', async () => {
    const { ctx, host } = await makeWorld()
    let state = {
      mode: makeMode({ template: 'Env: {{$ENVIRONMENT}}' }),
      sendHistoryThoughts: false,
      placeholderValues: { ENVIRONMENT: 'v1' },
    }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-1', WS)
    expect(promptSection((await assembleFor(root)).sections)!.text).toContain('Env: v1')

    state = { ...state, placeholderValues: { ENVIRONMENT: 'v2' } }
    // 同 key（template/entries/switch 未变），无需重注册：文本 provider 直接读到新值
    injector.refresh()
    expect(promptSection((await assembleFor(root)).sections)!.text).toContain('Env: v2')
    injector.dispose()
  })

  test('P-M7：默认 ENVIRONMENT 占位符值对齐旧版静态环境段（完整路径/OS/时区/语言提示）', async () => {
    const { ctx, host } = await makeWorld()
    let state = { mode: makeMode({ template: '{{$ENVIRONMENT}}' }), sendHistoryThoughts: false }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-1', WS)
    const text = promptSection((await assembleFor(root)).sections)!.text
    expect(text.startsWith('====\n\nENVIRONMENT\n\nCurrent Workspace: ' + WS)).toBe(true)
    expect(text).toContain('Operating System: ')
    expect(text).toContain('Timezone: ')
    expect(text).toContain('User Language: ')
    expect(text).toContain("Please respond using the user's language by default.")

    // 无 cwd 的 agent → No workspace open 分支
    const noCwd = await makeAgent(host, 'root-2', undefined)
    const noCwdText = promptSection((await assembleFor(noCwd)).sections)!.text
    expect(noCwdText).toContain('No workspace open')
    injector.dispose()
  })

  test('TODO_LIST 占位符：非空快照渲染为 Total 首行 + - [status] 行；空快照为 ""（dynamicTodo 门）', async () => {
    const { ctx, host } = await makeWorld()
    let state = {
      mode: makeMode({ template: 'TODO:\n{{$TODO_LIST}}' }),
      sendHistoryThoughts: false,
    }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-todo', WS)
    ;(root.session as unknown as { events: unknown[] }).events = [
      {
        type: 'todo/write',
        data: {
          todos: [
            { content: 'pending item', status: 'pending' },
            { content: 'doing item', status: 'in_progress' },
            { content: 'done item', status: 'completed' },
            { content: 'cancelled item', status: 'cancelled' },
          ],
        },
      },
    ]
    const text = promptSection((await assembleFor(root)).sections)!.text
    expect(text).toContain('Total: 4 | pending: 1 | in_progress: 1 | completed: 1 | cancelled: 1')
    expect(text).toContain('- [in_progress] doing item')
    expect(text).toContain('- [pending] pending item')
    expect(text).toContain('- [completed] done item')
    expect(text).toContain('- [cancelled] cancelled item')

    // 空快照 → TODO_LIST 值为 ''：占位符渲染为空，不出现 Total 行
    ;(root.session as unknown as { events: unknown[] }).events = []
    const empty = promptSection((await assembleFor(root)).sections)!.text
    expect(empty).toBe('TODO:')
    expect(empty).not.toContain('Total:')
    injector.dispose()
  })

  test('dynamicTodo=false：TODO_LIST 键省略，模板渲染 unavailable 提示', async () => {
    const { ctx, host } = await makeWorld()
    let state = {
      mode: makeMode({ template: '{{$TODO_LIST}}' }),
      sendHistoryThoughts: false,
      dynamicTodo: false,
    }
    const injector = createPromptInjector(ctx, 'roots', () => state)
    const root = await makeAgent(host, 'root-todo-off', WS)
    ;(root.session as unknown as { events: unknown[] }).events = [
      { type: 'todo/write', data: { todos: [{ content: 'x', status: 'pending' }] } },
    ]
    const text = promptSection((await assembleFor(root)).sections)!.text
    expect(text).toBe(unavailablePlaceholderText('TODO_LIST'))
    injector.dispose()
  })

  test('MEMORY 占位符：dynamicMemory=true 提供静态能力说明；false 时渲染 unavailable 提示', async () => {
    const { ctx, host } = await makeWorld()
    let state = {
      mode: makeMode({ template: '{{$MEMORY}}' }),
      sendHistoryThoughts: false,
      dynamicMemory: true,
    }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-mem', WS)
    const on = promptSection((await assembleFor(root)).sections)!.text
    expect(on).toContain('Permanent Memory')
    expect(on).toContain('memory_wake')

    state = { ...state, dynamicMemory: false }
    injector.refresh()
    const off = promptSection((await assembleFor(root)).sections)!.text
    expect(off).toBe(unavailablePlaceholderText('MEMORY'))
    injector.dispose()
  })

  test('waterfall 无条件提供 variables.graycode_tools 与 variables.tools 别名（overrideHostPrompt 开/关均提供）', async () => {
    const { ctx, host } = await makeWorld()
    let state: PromptRenderState = { mode: makeMode({ template: 'tpl {{$TOOLS}}' }), sendHistoryThoughts: false }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-1', WS)
    const { assembly, sections } = await assembleFor(root)
    // 无条件提供（即使本测试世界没有注册工具 → 空串也是 string，绝不 undefined）
    expect(typeof assembly.variables.graycode_tools).toBe('string')
    expect(typeof assembly.variables.tools).toBe('string')
    expect(assembly.variables.tools).toBe(assembly.variables.graycode_tools)
    expect(assembly.variables.graycode_tools).not.toBeUndefined()
    // {{$TOOLS}} 在 section 文本中渲染为 {{graycode_tools}}（延迟给 DSH 渲染期变量）
    expect(promptSection(sections)!.text).toContain('{{graycode_tools}}')
    // 完整 prompt 渲染不抛（graycode_tools 由瀑布提供）
    expect(() => renderPrompt(assembly)).not.toThrow()
    injector.dispose()

    // overrideHostPrompt=false：宿主提示保持原样，工具清单变量仍无条件提供
    state = {
      mode: makeMode({ template: 'tpl {{$TOOLS}}' }),
      sendHistoryThoughts: false,
      overrideHostPrompt: false,
    }
    const injector2 = createPromptInjector(ctx, 'roots', () => state)
    const root2 = await makeAgent(host, 'root-2', WS)
    const { assembly: assembly2 } = await assembleFor(root2)
    expect(typeof assembly2.variables.graycode_tools).toBe('string')
    expect(typeof assembly2.variables.tools).toBe('string')
    expect(assembly2.variables.tools).toBe(assembly2.variables.graycode_tools)
    injector2.dispose()
  })

  test('差距-2：variable 注册抛错 → 已注册的 section 被清理；重试不重复注入', async () => {
    const { ctx, host } = await makeWorld()
    let state = { mode: makeMode({ id: 'm1', name: 'M1', template: 'OLD-TEMPLATE' }), sendHistoryThoughts: false }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-1', WS)
    expect(promptSection((await assembleFor(root)).sections)!.text).toContain('OLD-TEMPLATE')

    // 模式切换使 key 变化 → 走重注册路径；section 成功、variable 抛错（部分注册）
    state = { mode: makeMode({ id: 'm2', name: 'M2', template: 'NEW-TEMPLATE' }), sendHistoryThoughts: false }
    const variableSpy = vi.spyOn(root.ctx.systemPrompt, 'variable')
      .mockImplementationOnce(() => { throw new Error('variable registration failed') })

    expect(() => injector.refresh()).toThrow('variable registration failed')

    // 已注册的 section 必须被清理：组装中无 graycode:prompt 段（不泄漏）
    expect(promptSection((await assembleFor(root)).sections)).toBeUndefined()
    variableSpy.mockRestore()

    // 重试：恰好注入一次（不重复、不漏发）
    injector.refresh()
    const after = (await assembleFor(root)).sections.filter(s => s.name === PROMPT_SECTION_NAME)
    expect(after).toHaveLength(1)
    expect(after[0]!.text).toContain('NEW-TEMPLATE')
    expect(after[0]!.text).not.toContain('OLD-TEMPLATE')
    injector.dispose()
  })

  test('{{graycode_prompt_mode}} 变量经 renderPrompt 插值为模式名', async () => {
    const { ctx, host } = await makeWorld()
    let state = { mode: makeMode({ name: 'Plan Mode' }), sendHistoryThoughts: false }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-1', WS)
    const { assembly } = await assembleFor(root)
    expect(renderPrompt(assembly)).toContain('Mode template: Plan Mode')
    injector.dispose()
  })

  test('customPrefix/customSuffix 进入 section 文本', async () => {
    const { ctx, host } = await makeWorld()
    let state = {
      mode: makeMode({ template: 'body', customPrefix: 'PREFIX', customSuffix: 'SUFFIX' }),
      sendHistoryThoughts: false,
    }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-1', WS)
    const text = promptSection((await assembleFor(root)).sections)!.text
    expect(text.startsWith('PREFIX')).toBe(true)
    expect(text.endsWith('SUFFIX')).toBe(true)
    injector.dispose()
  })

  test('BUG-01：customPrefix 含非法 {{...}}（{{$TOOLS}}/{{Foo}}）时注入不炸、产物无非法变量（B3-P2）', async () => {
    const { ctx, host } = await makeWorld()
    const mode = makeMode({
      template: 'tpl',
      customPrefix: 'PREFIX {{$TOOLS}} and {{Foo}}',
      customSuffix: '{{Bar}} SUFFIX',
    })
    let state = { mode, sendHistoryThoughts: false }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-1', WS)
    const { sections, assembly } = await assembleFor(root)
    const text = promptSection(sections)!.text
    expect(text).toContain('PREFIX')
    expect(text).toContain('SUFFIX')
    // 非法引用已被确定性说明替换：section 文本不含 {{$TOOLS}}/{{Foo}}/{{Bar}}
    // （否则 DSH 装配器会在渲染时抛 malformed prompt variable reference）
    expect(text).not.toContain('{{$TOOLS}}')
    expect(text).not.toContain('{{Foo}}')
    expect(text).not.toContain('{{Bar}}')
    // 注入不炸：完整 prompt 渲染（DSH interpolate）不再抛 malformed 错误
    expect(() => renderPrompt(assembly)).not.toThrow()
    injector.dispose()
  })

  test('mode=undefined：不注入；随后出现模式并 refresh 后回填', async () => {
    const { ctx, host } = await makeWorld()
    let state: { mode: PromptMode | undefined; sendHistoryThoughts: boolean } = {
      mode: undefined,
      sendHistoryThoughts: false,
    }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-1', WS)
    expect(promptSection((await assembleFor(root)).sections)).toBeUndefined()

    state = { mode: makeMode({ template: 'LATE' }), sendHistoryThoughts: false }
    injector.refresh()
    expect(promptSection((await assembleFor(root)).sections)!.text).toContain('LATE')
    injector.dispose()
  })

  test('后加载回填：registrar 创建前已存在的 agent 也获得模式 section', async () => {
    const { ctx, host } = await makeWorld()
    const existing = await makeAgent(host, 'root-0', WS)

    let state = { mode: makeMode(), sendHistoryThoughts: false }
    const injector = createPromptInjector(ctx, 'roots', () => state)
    expect(promptSection((await assembleFor(existing)).sections)).toBeDefined()
    injector.dispose()
  })

  test('all 模式：subagent 也注入；disabled：任何 agent 都不注入', async () => {
    const { ctx, host } = await makeWorld()
    const mode = makeMode()
    let state = { mode, sendHistoryThoughts: false }
    const injectorAll = createPromptInjector(ctx, 'all', () => state)
    const root = await makeAgent(host, 'root-1', WS)
    const sub = await makeAgent(host, 'sub-1', WS, root)
    for (const agent of [root, sub]) {
      expect(promptSection((await assembleFor(agent)).sections)).toBeDefined()
    }
    injectorAll.dispose()

    const injectorDisabled = createPromptInjector(ctx, 'disabled', () => state)
    const late = await makeAgent(host, 'root-2', WS)
    expect(promptSection((await assembleFor(late)).sections)).toBeUndefined()
    injectorDisabled.dispose()
  })

  test('dispose：卸载全部 scoped section/variable，新 agent 不再注入（幂等）', async () => {
    const { ctx, host } = await makeWorld()
    let state = { mode: makeMode(), sendHistoryThoughts: false }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const first = await makeAgent(host, 'root-1', WS)
    expect(promptSection((await assembleFor(first)).sections)).toBeDefined()

    injector.dispose()
    injector.dispose() // 幂等

    expect(promptSection((await assembleFor(first)).sections)).toBeUndefined()

    const late = await makeAgent(host, 'root-2', WS)
    expect(promptSection((await assembleFor(late)).sections)).toBeUndefined()
  })

  test('dispose 后 pending refresh（异步回调结算）不再注册 section（异步泄漏防护）', async () => {
    const { ctx, host } = await makeWorld()
    let state = { mode: makeMode(), sendHistoryThoughts: false }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-1', WS)
    expect(promptSection((await assembleFor(root)).sections)).toBeDefined()

    // 模拟 prompt/index.ts 的 dispose 竞态：dispose 之后才结算的
    // service.getCurrentMode().then(() => injector.refresh()) 回调
    injector.dispose()
    injector.refresh()

    // 存活 agent 的 section 不得被重新注册（不泄漏）
    expect(promptSection((await assembleFor(root)).sections)).toBeUndefined()
    // 新 agent 也不得被注入
    const late = await makeAgent(host, 'root-2', WS)
    expect(promptSection((await assembleFor(late)).sections)).toBeUndefined()
  })

  test('对外常量稳定（section 名 / variable 名 / order）', () => {
    expect(PROMPT_SECTION_NAME).toBe('graycode:prompt')
    expect(PROMPT_MODE_VARIABLE).toBe('graycode_prompt_mode')
    expect(PROMPT_ORDER).toBe(1)
  })
})


