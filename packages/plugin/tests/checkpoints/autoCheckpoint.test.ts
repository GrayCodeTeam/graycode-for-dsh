/**
 * checkpoint 自动存档引擎（autoCheckpoint.ts）单元测试。
 *
 * 模式（参考 memory/autoInject.spec.ts）：直接构造引擎并调用其监听器函数
 * （onToolsExecute / onPreStep / onTurnStopping），注入 fake next / fake payload /
 * stub CheckpointService；mergeUnchanged 行为用真实服务（临时 workspace + dataRoot）。
 *
 * 覆盖：
 * - tools/execute before/after 触发（title/origin/顺序/结果透传）；工具名不在列表不触发；
 *   无 agent 的调用跳过
 * - pre-step turn 变化触发 user 存档、同 turn 不重复、首次也触发；决策原样透传
 * - turn-stopping 触发 model 存档（afterMessages 配置）；缺省不触发
 * - modelOuterLayerOnly：非根 agent 跳过（可注入 isRoot）；带 parentSession header 的
 *   fork 子会话即使被 roots() 误判为根也跳过（跨域 M-2）
 * - 失败降级：createCheckpoint 抛错不阻断 next()，warn 记录；返回 null 也 warn（L-1）
 * - mergeUnchanged：无变更回滚 / 有变更保留 / 回退到既有 blob 的内容变化保留 /
 *   base 不在分页窗口或列表读取失败 → 保守保留 + warn（M-2 fail-closed）/ 回滚失败 warn + 保留
 * - 串行化：同 agent 并发 pre-step 只创建一次
 * - attach/detach：真实 Context 上 ctx.waterfall / ctx.serial 分发验证挂接与拆除
 */
import { describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  createAutoCheckpointEngine,
  type AutoCheckpointConfig,
  type AutoCheckpointEngine,
  type PreStepPayload,
  type RequestPayload,
  type TurnStoppingPayload,
} from '../../src/checkpoints/autoCheckpoint.ts'
import type { CheckpointService } from '../../src/checkpoints/service.ts'
import { makeEnv, writeFile, cleanup } from './helpers.ts'

const WS = 'X:/synthetic/graycode-project'

/** fake agent（只暴露引擎用到的 id / session.header；header 可注入 parentSession 等谱系字段）。 */
function fakeAgent(id: string, cwd = WS, header: Record<string, unknown> = {}): Agent {
  return { id, session: { header: { cwd, ...header } } } as unknown as Agent
}

/** fake tools/execute payload（ToolDispatchExecution；引擎只用 name/agent/signal）。 */
function toolExec(name: string, agent: Agent | undefined, signal = new AbortController().signal): ToolDispatchExecution {
  return {
    name,
    agent,
    signal,
    callId: 'call-1',
    rootCallId: 'call-1',
    token: Symbol('token'),
    arguments: {},
  } as unknown as ToolDispatchExecution
}

/** fake tools/execute next() 结果。 */
function okResult(): ToolExecutionResult {
  return { isError: false, value: { ok: true }, content: [] }
}

/** fake pre-step payload。 */
function preStep(agent: Agent, turn: number, signal = new AbortController().signal): PreStepPayload {
  return { agent, messages: [], turn, step: 1, signal }
}

/** fake turn-stopping payload。 */
function turnStop(agent: Agent, signal = new AbortController().signal): TurnStoppingPayload {
  return { agent, turn: 1, signal }
}

const enter = (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [] as UserMessage[] })

/** `agent/request` payload 夹具（模型调用发起前）。 */
function modelRequest(agent: Agent, step = 1, signal = new AbortController().signal): RequestPayload {
  return { agent, turn: 1, step, signal }
}

/** stub CheckpointService（引擎只调 create/delete/list 三个方法；overrides 宽松接受任意 stub）。 */
function stubService(overrides: Partial<Record<keyof CheckpointService, unknown>> = {}): CheckpointService {
  return {
    createCheckpoint: vi.fn(async () => null),
    deleteCheckpoint: vi.fn(async () => ({ success: true, deleted: true })),
    listCheckpoints: vi.fn(async () => ({ items: [], total: 0 })),
    ...overrides,
  } as unknown as CheckpointService
}

/** 引擎配置覆盖（messageCheckpoint 可部分覆盖，浅合并到默认值）。 */
type EngineConfigOverrides = Partial<Omit<AutoCheckpointConfig, 'messageCheckpoint'>> & {
  messageCheckpoint?: Partial<AutoCheckpointConfig['messageCheckpoint']>
}

/** 引擎配置（带默认值 + 浅合并 messageCheckpoint）。 */
function engineConfig(over: EngineConfigOverrides = {}): AutoCheckpointConfig {
  const base: AutoCheckpointConfig = {
    beforeTools: ['write', 'edit'],
    afterTools: ['bash', 'grep'],
    messageCheckpoint: {
      beforeMessages: ['user'],
      afterMessages: [],
      modelOuterLayerOnly: false,
      mergeUnchangedCheckpoints: true,
    },
  }
  return {
    ...base,
    ...over,
    messageCheckpoint: { ...base.messageCheckpoint, ...(over.messageCheckpoint ?? {}) },
  }
}

function makeEngine(
  service: CheckpointService,
  config: AutoCheckpointConfig = engineConfig(),
  options: { isRoot?: (agent: Agent) => boolean; logger?: { warn(message: string): void } } = {},
): AutoCheckpointEngine {
  return createAutoCheckpointEngine(service, config, options)
}

describe('tools/execute 监听器（beforeTools/afterTools）', () => {
  test('before 工具：next() 前创建存档（title/origin/signal），结果原样返回', async () => {
    const order: string[] = []
    const createCheckpoint = vi.fn(async () => {
      order.push('create')
      return null
    })
    const engine = makeEngine(stubService({ createCheckpoint }), engineConfig({ beforeTools: ['write'], afterTools: [] }))
    const agent = fakeAgent('root')

    const result = await engine.onToolsExecute(toolExec('write', agent), async () => {
      order.push('next')
      return okResult()
    })

    expect(order).toEqual(['create', 'next'])
    expect(createCheckpoint).toHaveBeenCalledTimes(1)
    expect(createCheckpoint).toHaveBeenCalledWith(WS, {
      title: 'auto: before write',
      origin: 'auto',
      signal: expect.any(AbortSignal),
    })
    expect(result).toEqual(okResult())
  })

  test('after 工具：next() 返回后创建存档', async () => {
    const order: string[] = []
    const createCheckpoint = vi.fn(async () => {
      order.push('create')
      return null
    })
    const engine = makeEngine(stubService({ createCheckpoint }), engineConfig({ beforeTools: [], afterTools: ['bash'] }))
    const agent = fakeAgent('root')

    const result = await engine.onToolsExecute(toolExec('bash', agent), async () => {
      order.push('next')
      return okResult()
    })

    expect(order).toEqual(['next', 'create'])
    expect(createCheckpoint).toHaveBeenCalledWith(WS, { title: 'auto: after bash', origin: 'auto', signal: expect.any(AbortSignal) })
    expect(result).toEqual(okResult())
  })

  test('工具名不在 beforeTools/afterTools 不触发；结果透传', async () => {
    const createCheckpoint = vi.fn(async () => null)
    const engine = makeEngine(stubService({ createCheckpoint }), engineConfig({ beforeTools: [], afterTools: [] }))
    const agent = fakeAgent('root')

    const result = await engine.onToolsExecute(toolExec('memory_note', agent), () => Promise.resolve(okResult()))
    expect(result).toEqual(okResult())
    expect(createCheckpoint).not.toHaveBeenCalled()
  })

  test('无 agent 的调用（agent-less）跳过存档', async () => {
    const createCheckpoint = vi.fn(async () => null)
    const engine = makeEngine(stubService({ createCheckpoint }), engineConfig({ beforeTools: ['write'], afterTools: [] }))
    const result = await engine.onToolsExecute(toolExec('write', undefined), () => Promise.resolve(okResult()))
    expect(result).toEqual(okResult())
    expect(createCheckpoint).not.toHaveBeenCalled()
  })

  test('next() 抛错原样上抛（不二次调用 next，不吞错）', async () => {
    const createCheckpoint = vi.fn(async () => null)
    const engine = makeEngine(stubService({ createCheckpoint }), engineConfig({ beforeTools: ['write'], afterTools: [] }))
    const agent = fakeAgent('root')
    let nextCalls = 0
    await expect(
      engine.onToolsExecute(toolExec('write', agent), async () => {
        nextCalls += 1
        throw new Error('pipeline boom')
      }),
    ).rejects.toThrow('pipeline boom')
    expect(nextCalls).toBe(1)
  })
})

describe('agent/pre-step 监听器（user 消息前）', () => {
  test('turn 变化触发存档（含首次）；同 turn 不重复；新 turn 再触发', async () => {
    const createCheckpoint = vi.fn(async () => null)
    const engine = makeEngine(stubService({ createCheckpoint }), engineConfig())
    const agent = fakeAgent('root')

    await engine.onPreStep(preStep(agent, 1), enter)
    expect(createCheckpoint).toHaveBeenCalledTimes(1)
    expect(createCheckpoint).toHaveBeenCalledWith(WS, { title: 'auto: user message', origin: 'auto', signal: expect.any(AbortSignal) })

    // 同 turn 的后续 step 不重复
    await engine.onPreStep(preStep(agent, 1), enter)
    expect(createCheckpoint).toHaveBeenCalledTimes(1)

    // 新 turn 再触发
    await engine.onPreStep(preStep(agent, 2), enter)
    expect(createCheckpoint).toHaveBeenCalledTimes(2)
  })

  test('决策原样透传（enter/reject），不因存档改变决策', async () => {
    const engine = makeEngine(stubService(), engineConfig())
    const agent = fakeAgent('root')

    const entered = await engine.onPreStep(preStep(agent, 1), enter)
    expect(entered).toEqual({ kind: 'enter', messages: [] })

    const rejected = await engine.onPreStep(preStep(agent, 2), async () => ({ kind: 'reject' } as const))
    expect(rejected).toEqual({ kind: 'reject' })
  })

  test("beforeMessages 不含 user 不触发（'model' 无 pre-step 挂点）", async () => {
    const createCheckpoint = vi.fn(async () => null)
    const engine = makeEngine(
      stubService({ createCheckpoint }),
      engineConfig({ messageCheckpoint: { beforeMessages: ['model'] } }),
    )
    const agent = fakeAgent('root')
    await engine.onPreStep(preStep(agent, 1), enter)
    expect(createCheckpoint).not.toHaveBeenCalled()
  })
})

describe('agent/request 监听器（model 消息前）', () => {
  test("beforeMessages 含 'model' → 每次模型调用前创建存档（title auto: before model message）", async () => {
    const createCheckpoint = vi.fn(async () => null)
    const engine = makeEngine(
      stubService({ createCheckpoint }),
      engineConfig({ messageCheckpoint: { beforeMessages: ['user', 'model'] } }),
    )
    const agent = fakeAgent('root')
    await engine.onRequest(modelRequest(agent, 1), async () => ({ messages: [] as UserMessage[] }) as unknown as LlmCallConfig)
    expect(createCheckpoint).toHaveBeenCalledTimes(1)
    expect(createCheckpoint).toHaveBeenCalledWith(WS, { title: 'auto: before model message', origin: 'auto', signal: expect.any(AbortSignal) })
    // 同回合第二个 step（工具循环中的又一次模型调用）再次触发
    await engine.onRequest(modelRequest(agent, 2), async () => ({ messages: [] as UserMessage[] }) as unknown as LlmCallConfig)
    expect(createCheckpoint).toHaveBeenCalledTimes(2)
  })

  test("beforeMessages 不含 'model' → 不触发；调用配置原样透传", async () => {
    const createCheckpoint = vi.fn(async () => null)
    const engine = makeEngine(
      stubService({ createCheckpoint }),
      engineConfig({ messageCheckpoint: { beforeMessages: ['user'] } }),
    )
    const config = { messages: [] as UserMessage[] } as unknown as LlmCallConfig
    const returned = await engine.onRequest(modelRequest(fakeAgent('root')), async () => config)
    expect(createCheckpoint).not.toHaveBeenCalled()
    expect(returned).toBe(config)
  })
})

describe('agent/turn-stopping 监听器（model 消息后）', () => {
  test('afterMessages 含 model → 创建存档；缺省 [] 不触发', async () => {
    const createCheckpoint = vi.fn(async () => null)
    const agent = fakeAgent('root')

    const off = makeEngine(stubService({ createCheckpoint }), engineConfig())
    await off.onTurnStopping(turnStop(agent))
    expect(createCheckpoint).not.toHaveBeenCalled()

    const on = makeEngine(
      stubService({ createCheckpoint }),
      engineConfig({ messageCheckpoint: { afterMessages: ['model'] } }),
    )
    await on.onTurnStopping(turnStop(agent))
    expect(createCheckpoint).toHaveBeenCalledTimes(1)
    expect(createCheckpoint).toHaveBeenCalledWith(WS, { title: 'auto: model message', origin: 'auto', signal: expect.any(AbortSignal) })
  })

  test('afterMessages 不含 model（仅 user）不触发', async () => {
    const createCheckpoint = vi.fn(async () => null)
    const engine = makeEngine(
      stubService({ createCheckpoint }),
      engineConfig({ messageCheckpoint: { afterMessages: ['user'] } }),
    )
    await engine.onTurnStopping(turnStop(fakeAgent('root')))
    expect(createCheckpoint).not.toHaveBeenCalled()
  })
})

describe('modelOuterLayerOnly（仅根 agent 存档）', () => {
  test('非根 agent 在三个挂点全部跳过；根 agent 正常存档', async () => {
    const createCheckpoint = vi.fn(async () => null)
    const service = stubService({ createCheckpoint })
    const isRoot = (agent: Agent): boolean => agent.id === 'root'
    const engine = makeEngine(
      service,
      engineConfig({
        beforeTools: ['write'],
        afterTools: ['bash'],
        messageCheckpoint: { beforeMessages: ['user'], afterMessages: ['model'], modelOuterLayerOnly: true },
      }),
      { isRoot },
    )
    const root = fakeAgent('root')
    const sub = fakeAgent('sub')

    // tools/execute
    await engine.onToolsExecute(toolExec('write', sub), () => Promise.resolve(okResult()))
    expect(createCheckpoint).not.toHaveBeenCalled()
    await engine.onToolsExecute(toolExec('write', root), () => Promise.resolve(okResult()))
    expect(createCheckpoint).toHaveBeenCalledTimes(1)

    // pre-step
    await engine.onPreStep(preStep(sub, 1), enter)
    expect(createCheckpoint).toHaveBeenCalledTimes(1)
    await engine.onPreStep(preStep(root, 2), enter)
    expect(createCheckpoint).toHaveBeenCalledTimes(2)

    // turn-stopping
    await engine.onTurnStopping(turnStop(sub))
    expect(createCheckpoint).toHaveBeenCalledTimes(2)
    await engine.onTurnStopping(turnStop(root))
    expect(createCheckpoint).toHaveBeenCalledTimes(3)
  })

  test('带 parentSession header 的 fork 子会话不存档（跨域 M-2：branches reroll 重放防护）', async () => {
    const createCheckpoint = vi.fn(async () => null)
    // 与 index.ts 注入的 isRoot 同一判据：roots() 命中 且 header.parentSession === undefined
    const isRoot = (agent: Agent): boolean =>
      agent.id === 'root' && agent.session?.header?.parentSession === undefined
    const engine = makeEngine(
      stubService({ createCheckpoint }),
      engineConfig({
        beforeTools: ['write'],
        afterTools: ['bash'],
        messageCheckpoint: { beforeMessages: ['user'], afterMessages: ['model'], modelOuterLayerOnly: true },
      }),
      { isRoot },
    )
    // fork 子会话：AgentRegistry.roots() 只认 owner===undefined 会把它误判为根，但
    // header.parentSession 已设置（branches dshSessionAdapter forkChild 写 meta.parentSession）
    // ——三个挂点全部跳过，reroll 重放不再对同一 workspace 重复建档
    const forkChild = fakeAgent('root', WS, { parentSession: 'session://parent-root' })
    await engine.onToolsExecute(toolExec('write', forkChild), () => Promise.resolve(okResult()))
    expect(createCheckpoint).not.toHaveBeenCalled()
    await engine.onPreStep(preStep(forkChild, 1), enter)
    expect(createCheckpoint).not.toHaveBeenCalled()
    await engine.onTurnStopping(turnStop(forkChild))
    expect(createCheckpoint).not.toHaveBeenCalled()

    // 真根 agent（无 parentSession）正常存档
    const root = fakeAgent('root')
    await engine.onToolsExecute(toolExec('write', root), () => Promise.resolve(okResult()))
    expect(createCheckpoint).toHaveBeenCalledTimes(1)
  })
})

describe('失败降级', () => {
  test('createCheckpoint 抛错 → next() 不被阻断、结果原样返回、warn 记录', async () => {
    const service = stubService({
      createCheckpoint: vi.fn(async () => {
        throw new Error('storage boom')
      }),
    })
    const warnings: string[] = []
    const engine = makeEngine(service, engineConfig({ beforeTools: ['write'], afterTools: ['bash'] }), {
      logger: { warn: message => warnings.push(message) },
    })
    const agent = fakeAgent('root')

    const result = await engine.onToolsExecute(toolExec('write', agent), () => Promise.resolve(okResult()))
    expect(result).toEqual(okResult())
    expect(warnings.some(w => w.includes('auto: before write') && w.includes('degraded'))).toBe(true)

    const decision = await engine.onPreStep(preStep(agent, 1), enter)
    expect(decision).toEqual({ kind: 'enter', messages: [] })

    await engine.onTurnStopping(turnStop(agent))
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })

  test('createCheckpoint 返回 null（非抛错）→ warn 记录，不阻断 next()（L-1）', async () => {
    const warnings: string[] = []
    const engine = makeEngine(
      stubService({ createCheckpoint: vi.fn(async () => null) }),
      engineConfig({ beforeTools: ['write'], afterTools: [] }),
      { logger: { warn: message => warnings.push(message) } },
    )

    const result = await engine.onToolsExecute(toolExec('write', fakeAgent('root')), () => Promise.resolve(okResult()))
    expect(result).toEqual(okResult())
    expect(warnings.some(w => w.includes('auto: before write') && w.includes('returned null'))).toBe(true)
  })

  test('signal 已 abort 时跳过存档（不产生 warn）', async () => {
    const createCheckpoint = vi.fn(async () => null)
    const warnings: string[] = []
    const controller = new AbortController()
    controller.abort()
    const engine = makeEngine(
      stubService({ createCheckpoint }),
      engineConfig({ beforeTools: ['write'] }),
      { logger: { warn: message => warnings.push(message) } },
    )
    const agent = fakeAgent('root')
    await engine.onToolsExecute(toolExec('write', agent, controller.signal), () => Promise.resolve(okResult()))
    expect(createCheckpoint).not.toHaveBeenCalled()
    expect(warnings).toHaveLength(0)
  })
})

describe('串行化（同 agent 存档不重叠）', () => {
  test('并发 pre-step（同 agent 同 turn）只创建一次', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const createCheckpoint = vi.fn(async () => {
      await gate
      return null
    })
    const engine = makeEngine(stubService({ createCheckpoint }), engineConfig())
    const agent = fakeAgent('root')

    const p1 = engine.onPreStep(preStep(agent, 1), enter)
    const p2 = engine.onPreStep(preStep(agent, 1), enter)
    release()
    await Promise.all([p1, p2])

    expect(createCheckpoint).toHaveBeenCalledTimes(1)
  })
})

describe('mergeUnchangedCheckpoints（真实服务）', () => {
  async function setupWithService() {
    const env = await makeEnv()
    const engine = makeEngine(env.service, engineConfig({ beforeTools: ['write'], afterTools: [] }), {
      isRoot: () => true,
    })
    const agent = fakeAgent('root', env.workspaceDir)
    return { ...env, engine, agent }
  }

  test('无变更的自动存档被回滚；有变更的保留（origin=auto）', async () => {
    const { workspaceDir, dataRoot, service, engine, agent } = await setupWithService()
    try {
      await writeFile(workspaceDir, 'a.txt', 'v1')
      const manual = await service.createCheckpoint(workspaceDir, { title: 'manual' })
      expect(manual!.type).toBe('full')

      // 无变更：auto 存档创建后被判定无变更并回滚
      await engine.onToolsExecute(toolExec('write', agent), () => Promise.resolve(okResult()))
      let listed = await service.listCheckpoints(workspaceDir)
      expect(listed.total).toBe(1)
      expect(listed.items[0]!.origin).toBe('manual')

      // 有变更：保留，origin=auto
      await writeFile(workspaceDir, 'a.txt', 'v2')
      await engine.onToolsExecute(toolExec('write', agent), () => Promise.resolve(okResult()))
      listed = await service.listCheckpoints(workspaceDir)
      expect(listed.total).toBe(2)
      expect(listed.items[0]!.origin).toBe('auto')
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })

  test('内容回退到既有 blob（0 新字节但 contentHash 变化）→ 保留（防误删）', async () => {
    const { workspaceDir, dataRoot, service, engine, agent } = await setupWithService()
    try {
      await writeFile(workspaceDir, 'a.txt', 'v1')
      await service.createCheckpoint(workspaceDir) // cp1: full (v1)
      await writeFile(workspaceDir, 'a.txt', 'v2')
      await engine.onToolsExecute(toolExec('write', agent), () => Promise.resolve(okResult())) // cp2: auto (v2) 保留
      await writeFile(workspaceDir, 'a.txt', 'v1') // 回退内容（v1 blob 已存在 → 0 新字节）
      await engine.onToolsExecute(toolExec('write', agent), () => Promise.resolve(okResult())) // cp3: 0 新字节但内容 != base(cp2)

      const listed = await service.listCheckpoints(workspaceDir)
      expect(listed.total).toBe(3) // cp3 未被误删
      expect(listed.items[0]!.contentHash).not.toBe(listed.items[1]!.contentHash)
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })

  test('回滚失败 → warn + 保留存档（接受差异）', async () => {
    const { workspaceDir, dataRoot, service, engine, agent } = await setupWithService()
    try {
      await writeFile(workspaceDir, 'a.txt', 'v1')
      await service.createCheckpoint(workspaceDir) // manual full
      service.deleteCheckpoint = vi.fn(async () => ({ success: false, deleted: false, reason: 'metadata write failed' }))

      const warnings: string[] = []
      const engineWithLogger = createAutoCheckpointEngine(
        service,
        engineConfig({ beforeTools: ['write'], afterTools: [] }),
        { isRoot: () => true, logger: { warn: message => warnings.push(message) } },
      )
      await engineWithLogger.onToolsExecute(toolExec('write', fakeAgent('root', workspaceDir)), () => Promise.resolve(okResult()))

      expect(warnings.some(w => w.includes('mergeUnchanged rollback'))).toBe(true)
      const listed = await service.listCheckpoints(workspaceDir)
      expect(listed.total).toBe(2) // 回滚失败 → 保留
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })

  test('base 不在分页窗口（>100 存档）→ 保守保留 + warn，不回滚（M-2）', async () => {
    const warnings: string[] = []
    const deleteCheckpoint = vi.fn(async () => ({ success: true, deleted: true }))
    const service = stubService({
      // 创建成功：incremental、0 新字节、有 base——但 base 排在首 100 条之外
      createCheckpoint: vi.fn(async () => ({
        checkpointId: 'cp_self0000000000000000000000000000',
        type: 'incremental',
        fileCount: 1,
        sizeBytes: 0,
        excludedCount: 0,
        baseCheckpointId: 'cp_base0000000000000000000000000000',
      })),
      deleteCheckpoint,
      // 首页只含 self、不含 base（total=150 说明 base 在窗口之外）
      listCheckpoints: vi.fn(async () => ({
        items: [
          { id: 'cp_self0000000000000000000000000000', contentHash: 'a'.repeat(64) },
          { id: 'cp_other000000000000000000000000000', contentHash: 'b'.repeat(64) },
        ],
        total: 150,
      })),
    })
    const engine = createAutoCheckpointEngine(
      service,
      engineConfig({ beforeTools: ['write'], afterTools: [] }),
      { isRoot: () => true, logger: { warn: message => warnings.push(message) } },
    )

    await engine.onToolsExecute(toolExec('write', fakeAgent('root')), () => Promise.resolve(okResult()))

    // 无法确认 ≠ 无变更：绝不回滚，保守保留 + warn（fail-closed）
    expect(deleteCheckpoint).not.toHaveBeenCalled()
    expect(warnings.some(w => w.includes('mergeUnchanged confirmation skipped') && w.includes('keeping checkpoint'))).toBe(true)
  })

  test('列表读取失败 → 保守保留 + warn（fail-closed，M-2）', async () => {
    const warnings: string[] = []
    const deleteCheckpoint = vi.fn(async () => ({ success: true, deleted: true }))
    const service = stubService({
      createCheckpoint: vi.fn(async () => ({
        checkpointId: 'cp_self0000000000000000000000000000',
        type: 'incremental',
        fileCount: 1,
        sizeBytes: 0,
        excludedCount: 0,
        baseCheckpointId: 'cp_base0000000000000000000000000000',
      })),
      deleteCheckpoint,
      listCheckpoints: vi.fn(async () => {
        throw new Error('records read failure')
      }),
    })
    const engine = createAutoCheckpointEngine(
      service,
      engineConfig({ beforeTools: ['write'], afterTools: [] }),
      { isRoot: () => true, logger: { warn: message => warnings.push(message) } },
    )

    await engine.onToolsExecute(toolExec('write', fakeAgent('root')), () => Promise.resolve(okResult()))

    expect(deleteCheckpoint).not.toHaveBeenCalled()
    expect(warnings.some(w => w.includes('mergeUnchanged confirmation degraded') && w.includes('keeping checkpoint'))).toBe(true)
  })
})

describe('attach/detach（真实 Context 分发）', () => {
  test('attach 挂接三个事件；detach 后不再响应', async () => {
    const ctx = new Context()
    const createCheckpoint = vi.fn(async () => null)
    const engine = makeEngine(
      stubService({ createCheckpoint }),
      engineConfig({
        beforeTools: ['write'],
        afterTools: ['bash'],
        messageCheckpoint: { beforeMessages: ['user'], afterMessages: ['model'] },
      }),
    )
    const agent = fakeAgent('root')
    const detach = engine.attach(ctx)

    // tools/execute（waterfall）：before 存档 + next 透传
    const toolResult = await ctx.waterfall('tools/execute', toolExec('write', agent), () => Promise.resolve(okResult()))
    expect(toolResult).toEqual(okResult())
    // agent/pre-step（waterfall）
    const decision = await ctx.waterfall('agent/pre-step', preStep(agent, 1), enter)
    expect(decision).toEqual({ kind: 'enter', messages: [] })
    // agent/turn-stopping（serial）
    await ctx.serial('agent/turn-stopping', turnStop(agent))
    expect(createCheckpoint).toHaveBeenCalledTimes(3)

    detach()
    await ctx.serial('agent/turn-stopping', turnStop(agent))
    await ctx.waterfall('agent/pre-step', preStep(agent, 2), enter)
    await ctx.waterfall('tools/execute', toolExec('write', agent), () => Promise.resolve(okResult()))
    expect(createCheckpoint).toHaveBeenCalledTimes(3)
  })
})
