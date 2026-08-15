/**
 * P0-02 Host apply(ctx) lifecycle/HMR 补测
 *
 * 验收标准（docs/PLAN_V2.md P0-02）：Host `apply(ctx)` 生命周期/HMR —— 重载
 * 20 次后工具、监听器、定时器数量不增长；修正 Fiber/effect 边界。
 * docs/PROGRESS.md 标记 P0-02 为「done（部分）…HMR 重载测试待补」，本文件补上
 * 该「待补」的重载测试。
 *
 * cordis reload/HMR 机制探明结论（依据：packages/plugin/node_modules/@deepseek-ai/cordis）：
 * - `ctx.plugin(plugin, config)` 返回 `Fiber & PromiseLike<Fiber>`（registry.d.ts:120）；
 * - `Fiber.restart()`：`Dispose and immediately reload this plugin with its
 *   current config`（fiber.d.ts:187）——cordis 自带的 HMR 原语，因此本测试直接
 *   用它循环重载，无需「dispose + 重新 apply」的人工模拟；
 * - 卸载语义：`_unload()` 反向清空 fiber 的 disposables；子插件 fiber 的 dispose
 *   以 effect 注册在父 fiber 上，父卸载时子一并卸载（fiber.ts:265-297、675-696）；
 * - 重载语义：`_reload()` 用同一 config 重跑 apply()（fiber.ts:692），因此
 *   `await fiber.restart()` 即真实 HMR 热更新路径。
 * - 与「dispose + 重新 apply」模拟的差异：restart() 复用同一 fiber/运行时，只
 *   重置 effect 收集，等价于 DSH 的插件热重载；而 dispose+重新 apply 会重建
 *   runtime 记录，覆盖插件移除后再挂载的场景。两者都要求旧实例的 disposers
 *   完整卸载，本测试断言的不变量对两种路径同样适用。
 *
 * 测试组合（零网络、零模型）：
 * - 真实 @deepseek-ai/cordis Context + 真实 DSH 服务（LocalFileSystem /
 *   SessionStore / AgentRegistry / SystemPrompt / ToolRuntime）；
 * - 真实 agent scope（createScope + agents.register，同 persona.spec.ts 模式），
 *   在插件加载前创建，触发每个重载周期的「后加载回填」路径；
 * - 完整 graycode 插件（src/index.ts composition root，12 个子插件），
 *   `ctx.plugin(graycode, fullConfig)`。
 *
 * 逐轮计数：
 * - 工具：`ctx.tools.schemas(agent)` 可见工具名集合。dsh-tools 同层同名注册会
 *   fail loudly（重复注册抛错 → restart() 拒绝 → 测试失败）；若 dispose 泄漏
 *   导致集合增长，toEqual 也会失败。
 * - 监听器：`ctx.events._hooks` 事件总线监听器总数（ctx.on 注册的 effect）。
 * - 定时器：`process.getActiveResourcesInfo()` 的 Timeout 计数（best-effort；
 *   插件源码无任何 setInterval/setTimeout，稳定时应与基线持平，仅允许测试
 *   框架自身的小浮动）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentRegistry, assembleContextFor } from '@deepseek-ai/dsh-agent'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as graycode from '../../src/index.ts'
import type { Config as GraycodeConfig } from '../../src/index.ts'
import { PERSONA_SECTION_NAME } from '../../src/persona.ts'

/** 验收标准规定的重载次数。 */
const RELOADS = 20
/** 定时器计数容差：vitest/运行时的惰性 timer 允许的小浮动（泄漏按轮增长会远超它）。 */
const TIMER_SLACK = 5

/** 等一个 macrotask 轮，让子插件 fiber 的异步激活与事件派发全部落定后再计数。 */
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/** agent 可见工具名集合（scoped shadow 后的最终视图），排序后逐轮可比。 */
function toolNames(ctx: Context, agent: Agent): string[] {
  return ctx.tools.schemas(agent).map(schema => schema.name).sort()
}

/** 事件总线（ctx.events._hooks）上的监听器总数。 */
function listenerCount(ctx: Context): number {
  const hooks = (ctx.events as unknown as { _hooks: Record<string, unknown[]> })._hooks
  let total = 0
  for (const name of Object.keys(hooks)) total += hooks[name]!.length
  return total
}

/** best-effort：当前进程的 Timeout 活动资源数；环境不支持时返回 0（断言退化为空转）。 */
function timeoutCount(): number {
  const info = (process as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo
  if (typeof info !== 'function') return 0
  return info().filter(type => type === 'Timeout').length
}

/**
 * 组装完整 graycode 配置：显式给出每个域 Config 接口的全部必填字段（TS 层），
 * 数值与各域 schema 默认一致（运行时语义与缺省相同）。
 */
function graycodeConfig(dataRoot: string): GraycodeConfig {
  return {
    dataRoot,
    workflows: { dataRoot, documentRoot: '.graycode', agentScope: 'roots' },
    memory: { dataRoot, wakeLines: 96, entryChars: 280, partChars: 20000, partLines: 500, agentScope: 'roots' },
    checkpoints: {
      dataRoot,
      maxCheckpoints: -1,
      excludeProfiles: {},
      excludePatterns: [],
      maxFileSizeBytes: 50 * 1024 * 1024,
      blobGracePeriodDays: 7,
      restoreProtectionPoint: true,
      agentScope: 'roots',
    },
    branches: { dataRoot, agentScope: 'roots' },
    persona: { enabled: true, agentScope: 'roots' },
    prompt: { dataRoot, enabled: true, agentScope: 'roots', sendHistoryThoughts: false, modeToolPolicy: true, requestLayer: false },
    migration: { dataRoot, enabled: false, allowLegacyReaders: false },
    stagedDiff: { dataRoot, enabled: false, agentScope: 'roots' },
    activity: { dataRoot, enabled: true, agentScope: 'roots', sampleIntervalMs: 60_000 },
    media: { enabled: true, agentScope: 'roots', maxBatch: 10 },
    file: { enabled: true, agentScope: 'roots' },
    todo: { enabled: true, agentScope: 'roots' },
    subagents: { maxHopDepth: 5, maxConcurrent: 2, customAgents: [] },
    notifications: { enabled: true, agentScope: 'roots', windowsToast: true },
    thoughts: { enabled: false, sendHistoryThoughts: false },
  }
}

interface World {
  ctx: Context
  agent: Agent
  dataRoot: string
  fiber: Fiber
  /** 另建一个 root agent（覆盖 reload 后 agent/created 监听路径）。 */
  createAgent(id: string): Promise<Agent>
  disposeAll(): Promise<void>
}

async function makeWorld(): Promise<World> {
  const ctx = new Context()
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'graycode-hmr-ws-'))
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'graycode-hmr-data-'))
  const mounted: Array<{ dispose(): Promise<void> }> = [
    await ctx.plugin(LocalFileSystem, { cwd: workspace }),
    await ctx.plugin(SessionStore),
    await ctx.plugin(AgentRegistry),
    await ctx.plugin(SystemPrompt),
    await ctx.plugin(ToolRuntime),
    // C1 subagents guards 依赖的 seam（base 层挂载；测试环境显式补上）。
    await ctx.plugin(SubagentRuntime),
  ]
  // Host fiber：agent scope 的铸造上下文（镜像 persona.spec.ts，补 tools 依赖，
  // 使 agent.ctx.tools 沿作用域链解析到根 ToolRuntime）。
  const hostFiber = await ctx.plugin({
    inject: ['systemPrompt', 'agents', 'tools'],
    apply() {},
  })
  mounted.push(hostFiber)

  const scopes: Array<{ dispose(): Promise<void> }> = []
  const createAgent = async (id: string): Promise<Agent> => {
    const agent = { id, session: { id, header: { cwd: workspace } } } as unknown as Agent
    const scope = createScope(hostFiber.ctx, agent)
    await scope.ctx.fiber
    scopes.push(scope)
    ;(agent as { ctx: Context }).ctx = scope.ctx
    // 从根上下文注册 → 顶层 root agent（agentScope=roots 的目标）。
    ;(hostFiber.ctx as unknown as { root: Context }).root.agents.register(agent)
    return agent
  }

  const agent = await createAgent('hmr-root')
  // 完整 composition root：agent 已存在，走「后加载回填」路径。
  const fiber = await ctx.plugin(graycode, graycodeConfig(dataRoot))

  const disposeAll = async (): Promise<void> => {
    await fiber.dispose()
    for (const scope of scopes.reverse()) await scope.dispose()
    for (const entry of mounted.reverse()) await entry.dispose()
    await rm(workspace, { recursive: true, force: true })
    await rm(dataRoot, { recursive: true, force: true })
  }
  return { ctx, agent, dataRoot, fiber, createAgent, disposeAll }
}

/** agent scope 组装出的 `graycode:persona` section 数量（泄漏会翻倍）。 */
async function personaSectionCount(agent: Agent): Promise<number> {
  const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
  return assembly.sections.filter(section => section.name === PERSONA_SECTION_NAME).length
}

describe('P0-02 Host apply(ctx) lifecycle/HMR', () => {
  test('重载 20 次：工具/监听器/定时器数量不增长，工具名集合逐轮相等', async () => {
    const world = await makeWorld()
    try {
      const { ctx, agent, fiber } = world
      await settle()

      // 基线（首次挂载后）
      const baselineTools = toolNames(ctx, agent)
      const baselineListeners = listenerCount(ctx)
      const baselineTimers = timeoutCount()
      expect(baselineTools.length, '完整插件应至少安装若干 scoped 工具').toBeGreaterThan(0)
      expect(await personaSectionCount(agent)).toBe(1)

      const listenerCounts: number[] = []
      const timerCounts: number[] = []
      for (let i = 0; i < RELOADS; i++) {
        // 真实 HMR 原语：dispose + 立即用当前 config 重跑 apply()
        await fiber.restart()
        await settle()

        const tools = toolNames(ctx, agent)
        const listeners = listenerCount(ctx)
        const timers = timeoutCount()
        listenerCounts.push(listeners)
        timerCounts.push(timers)

        // 工具：数量与名称集合逐轮相等（重复注册会 fail loudly 或使集合增长）
        expect(tools, `reload #${i + 1} 后工具名集合与基线不一致`).toEqual(baselineTools)
        // 监听器：不增长（≤ 基线+1，容忍总线繁忙期的一次性监听）
        expect(listeners, `reload #${i + 1} 后监听器数量增长`).toBeLessThanOrEqual(baselineListeners + 1)
      }

      // 监听器最终稳定：最大值不超过基线+1（不允许逐轮单调爬升）。
      expect(
        Math.max(...listenerCounts),
        `监听器计数序列 ${JSON.stringify([baselineListeners, ...listenerCounts])}`,
      ).toBeLessThanOrEqual(baselineListeners + 1)

      // 定时器 best-effort：总体不增长（序列见 message，可诊断）。
      expect(
        Math.max(baselineTimers, ...timerCounts),
        `Timeout 计数序列 ${JSON.stringify([baselineTimers, ...timerCounts])}`,
      ).toBeLessThanOrEqual(baselineTimers + TIMER_SLACK)

      // persona section 不重复（重载后仍恰一个）。
      expect(await personaSectionCount(agent)).toBe(1)

      // 重载后的插件仍对新 agent 响应 agent/created（监听器路径未失效）。
      const late = await world.createAgent('hmr-late')
      await settle()
      expect(toolNames(ctx, late)).toEqual(baselineTools)
    } finally {
      await world.disposeAll()
    }
  })

  test('update(config)：配置 HMR 换 persona 模板后不泄漏，重载前后计数稳定', async () => {
    const world = await makeWorld()
    try {
      const { ctx, agent, fiber } = world
      await settle()

      const baselineTools = toolNames(ctx, agent)
      const baselineListeners = listenerCount(ctx)
      expect(await personaSectionCount(agent)).toBe(1)

      const next = graycodeConfig(world.dataRoot)
      // 换 persona 模板：section 文本应随新模板变化（section 重注册而非叠加）。
      next.persona = { enabled: true, agentScope: 'roots', template: 'HMR persona template marker' }
      await fiber.update(next)
      await settle()

      const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent))
      const persona = assembly.sections.filter(section => section.name === PERSONA_SECTION_NAME)
      expect(persona).toHaveLength(1)
      expect(persona[0]!.text).toContain('HMR persona template marker')

      // 工具与监听器计数在 update 后仍稳定（旧实例已完整卸载）。
      expect(toolNames(ctx, agent)).toEqual(baselineTools)
      expect(listenerCount(ctx)).toBeLessThanOrEqual(baselineListeners + 1)
    } finally {
      await world.disposeAll()
    }
  })
})
