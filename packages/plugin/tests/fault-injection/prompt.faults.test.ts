/**
 * 故障注入：prompt 领域（规划 §9.5 的子集：模式切换时注入器抛错、
 * 差分指纹缓存写入失败、损坏的 modes.json、存储提交失败）。
 *
 * 注入手段：构造损坏输入文件（损坏的 modes.json / 存储目录被同名文件占用）、
 * vi.spyOn 服务方法（systemPrompt.section）、抛错的订阅者（模拟注入器 refresh）。
 * 全部使用临时数据根，不污染真实 dataRoot。
 *
 * 每个用例显式声明：注入什么故障 / 期望最终状态 / 允许的部分结果。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentRegistry, assembleContextFor } from '@deepseek-ai/dsh-agent'
import { SystemPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { PromptError, PromptErrorCode } from '../../src/prompt/domain/promptTypes.ts'
import { PromptSettingsService } from '../../src/prompt/service.ts'
import {
  createPromptInjector,
  PROMPT_SECTION_NAME,
  type PromptRenderState,
} from '../../src/prompt/promptInjector.ts'
import type { PromptMode } from '../../src/prompt/domain/promptTypes.ts'

// ─── 临时数据根（service 测试） ─────────────────────────────

let tmpDir: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true })
    tmpDir = undefined
  }
})

async function makeDataRoot(): Promise<string> {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'graycode-fault-prompt-'))
  return tmpDir
}

function storePath(root: string): string {
  return path.join(root, 'prompt', 'modes.json')
}

async function serviceOf(root: string): Promise<PromptSettingsService> {
  const service = new PromptSettingsService({ dataRoot: root })
  await service.getCurrentMode() // 触发 lazy load
  return service
}

// ─── 注入器世界（同 injector.spec.ts） ────────────────────────

const WS = 'X:/synthetic/graycode-fault-project'

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

async function makeAgent(host: Context, id: string, cwd: string | undefined): Promise<Agent> {
  const agent = {
    id,
    session: { id, header: cwd ? { cwd } : {} },
  } as unknown as Agent
  const scope = createScope(host, agent)
  await scope.ctx.fiber
  disposers.push(scope.rawDispose as () => Promise<void>)
  ;(agent as { ctx: Context }).ctx = scope.ctx
  host.agents.register(agent)
  return agent
}

async function assembleFor(agent: Agent): Promise<{ sections: Array<{ name: string; text: string }>; assembly: PromptAssembly }> {
  const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
  return { sections: assembly.sections, assembly }
}

function promptSection(sections: Array<{ name: string; text: string }>): { name: string; text: string } | undefined {
  return sections.find(section => section.name === PROMPT_SECTION_NAME)
}

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

describe('模式切换时注入器抛错', () => {
  test('订阅者（注入器 refresh）抛错 → 不破坏当前生效模式：切换已提交，服务后续可用', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)

    // 注入故障：mode-changed 事件到达注入器时 refresh 抛错（模拟注入器注册失败）
    const unsubscribe = service.subscribe(() => {
      throw new Error('injector refresh boom')
    })

    await expect(service.setCurrentMode('plan')).rejects.toThrow('injector refresh boom')

    // 期望最终状态：模式切换在 emit 之前已持久化——当前生效模式是 plan，
    // 内存与磁盘一致；调用方收到的错误只表示「通知/注入失败」，不是「切换失败」
    expect((await service.getCurrentMode()).id).toBe('plan')
    const reloaded = await serviceOf(root)
    expect((await reloaded.getCurrentMode()).id).toBe('plan')

    // 允许的部分结果：setCurrentMode 因通知链抛错而 reject，但模式本身已生效；
    // 故障消除（退订）后服务完全可用
    unsubscribe()
    expect((await service.setCurrentMode('review')).id).toBe('review')
    expect((await service.getCurrentMode()).id).toBe('review')
  })
})

describe('差分指纹缓存写入失败（注入器注册故障）', () => {
  test('section 注册抛错 → 缓存未写入、旧 section 已卸载；恢复后恰好注入一次（不重复不漏发）', async () => {
    const { ctx, host } = await makeWorld()
    let state: PromptRenderState = {
      mode: makeMode({ id: 'm1', name: 'M1', template: 'OLD-TEMPLATE' }),
      sendHistoryThoughts: false,
    }
    const injector = createPromptInjector(ctx, 'roots', () => state)

    const root = await makeAgent(host, 'root-1', WS)
    expect(promptSection((await assembleFor(root)).sections)!.text).toContain('OLD-TEMPLATE')

    // 切换模式，同时让 section 注册（指纹缓存写入路径）失败一次
    state = { mode: makeMode({ id: 'm2', name: 'M2', template: 'NEW-TEMPLATE' }), sendHistoryThoughts: false }
    const sectionSpy = vi.spyOn(root.ctx.systemPrompt, 'section')
      .mockImplementationOnce(() => { throw new Error('section registration failed') })

    expect(() => injector.refresh()).toThrow('section registration failed')

    // 允许的部分结果：切换中间态——旧 section 已卸载、新 section 未装上（暂时无模式 section），
    // 指纹缓存（installed map）未被写入，无重复、无残留
    expect(promptSection((await assembleFor(root)).sections)).toBeUndefined()
    sectionSpy.mockRestore()

    // 期望最终状态：恢复后下一次 refresh 恰好注入一次——不重复（只有一个 section）
    // 也不漏发（新模板出现、旧模板消失）
    injector.refresh()
    const after = (await assembleFor(root)).sections.filter(s => s.name === PROMPT_SECTION_NAME)
    expect(after).toHaveLength(1)
    expect(after[0]!.text).toContain('NEW-TEMPLATE')
    expect(after[0]!.text).not.toContain('OLD-TEMPLATE')

    // 同状态再 refresh：指纹去重仍生效（恢复后不重复）
    injector.refresh()
    expect((await assembleFor(root)).sections.filter(s => s.name === PROMPT_SECTION_NAME)).toHaveLength(1)
    injector.dispose()
  })
})

describe('损坏的 modes.json（JSON 语法错误）', () => {
  test('稳定 STORAGE_CORRUPT 错误码、不崩溃；组合层降级报告；修复后新实例回退内置默认', async () => {
    const root = await makeDataRoot()
    await mkdir(path.join(root, 'prompt'), { recursive: true })
    await writeFile(storePath(root), '{ not valid json !!!', 'utf8')

    const service = new PromptSettingsService({ dataRoot: root })

    // 期望最终状态：服务层响亮报错（稳定错误码），进程不崩溃
    const error = await service.getCurrentMode().catch(e => e)
    expect(error).toBeInstanceOf(PromptError)
    expect((error as PromptError).code).toBe(PromptErrorCode.STORAGE_CORRUPT)
    // 同一实例后续调用仍稳定报错（load 失败被缓存；恢复需要修复文件 + 重建实例）
    await expect(service.listModes()).rejects.toMatchObject({ code: PromptErrorCode.STORAGE_CORRUPT })

    // 组合层降级（prompt/index.ts 同款接线）：捕获并报告，不崩溃、不触发注入刷新
    const refresh = vi.fn()
    const warnings: string[] = []
    await new Promise<void>(resolve => {
      service.getCurrentMode().then(
        () => { refresh(); resolve() },
        (err: unknown) => {
          warnings.push(err instanceof Error ? err.message : String(err))
          resolve()
        },
      )
    })
    expect(refresh).not.toHaveBeenCalled()
    expect(warnings[0]).toContain('not valid JSON')

    // 允许的部分结果：损坏期间注入被禁用（无模式 section 可注入），但插件进程存活并报告

    // 修复存储（删除损坏文件）后，新实例回退内置默认模式
    await rm(storePath(root))
    const repaired = await serviceOf(root)
    expect((await repaired.getCurrentMode()).id).toBe('minimal')
    expect((await repaired.listModes()).map(mode => mode.id)).toEqual(['minimal', 'code', 'design', 'plan', 'ask', 'review'])
  })
})

describe('存储提交失败（persist 写入中抛错）', () => {
  test('persist 失败 → 稳定 STORAGE_WRITE_FAILED；内存回滚，无 内存新/磁盘旧 分叉', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)

    // 注入故障：把 prompt 目录替换成同名文件，persist 的 mkdir 必然失败（磁盘不可写）
    const promptDir = path.join(root, 'prompt')
    await rm(promptDir, { recursive: true, force: true })
    await writeFile(promptDir, 'not a directory', 'utf8')

    const error = await service.setCurrentMode('plan').catch(e => e)
    expect(error).toBeInstanceOf(PromptError)
    expect((error as PromptError).code).toBe(PromptErrorCode.STORAGE_WRITE_FAILED)

    // 期望最终状态（差距-1 已修复）：persist 失败 → 内存 currentModeId 回滚，
    // 内存与磁盘一致（都是旧模式 minimal）；调用方收到稳定错误码，绝不假报成功
    expect((await service.getCurrentMode()).id).toBe('minimal')

    // 修复存储后，新的提交可正常落盘并被新实例读到
    await rm(promptDir, { force: true })
    await mkdir(promptDir, { recursive: true })
    await service.setCurrentMode('design')
    const reloaded = await serviceOf(root)
    expect((await reloaded.getCurrentMode()).id).toBe('design')
  })
})
