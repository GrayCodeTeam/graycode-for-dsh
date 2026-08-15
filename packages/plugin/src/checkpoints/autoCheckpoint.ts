/**
 * GrayCode - checkpoint 自动存档引擎（对齐审计 C-01/C-02/C-03，host 侧）。
 *
 * 挂点（DSH rc.6 事件面，均已核实 .d.ts）：
 * - `tools/execute`（waterfall，@deepseek-ai/dsh-tools lib/types/index.d.ts:49）：
 *   around 分发包装层，payload = ToolDispatchExecution。工具名在 `exec.name`
 *   （不是 toolName），调用方 agent 在 `exec.agent?`，取消信号在 `exec.signal`。
 *   包装 `next()` 前后分别创建 before/after 存档；监听器必须调用 `next()` 并
 *   把返回值原样传下去（包装层只能替换 signal，不允许改写参数）。
 * - `agent/pre-step`（waterfall，@deepseek-ai/dsh-agent lib/types/runtime-types.d.ts:235）：
 *   payload.turn 变化 = 新用户回合 → beforeMessages 含 'user' 时创建存档。
 *   首次见该 agent 也存档。存档在 `next()` 之后、本挂点返回前创建（决策已定，
 *   但快照 await 完成前 waterfall 不返回——只保证不延迟决策，不承诺不延迟挂点完成）。
 * - `agent/request`（waterfall，runtime-types.d.ts:254）：模型调用发起前 →
 *   beforeMessages 含 'model' 时创建存档（每个 step 一次；同回合多次模型调用
 *   各存一次，依赖 mergeUnchangedCheckpoints 去重无变更档）。
 * - `agent/turn-stopping`（serial，runtime-types.d.ts:301）：模型回合关闭 →
 *   afterMessages 含 'model' 时创建存档。
 *   「用户消息后」无宿主挂点（pre-step 只在新用户回合触发），故 afterMessages
 *   的 'user' 成员当前无对应行为，schema 保留字段但不暴露 UI。
 *
 * 语义：
 * - 全部存档 origin='auto'，title 形如 `auto: before <tool>` / `auto: after <tool>` /
 *   `auto: user message` / `auto: model message`；
 * - 失败降级：任何存档创建失败只 warn，绝不阻断工具执行 / 步骤决策（next() 结果
 *   原样返回，绝不二次调用 next()）；
 * - 串行化：同 agent 的存档创建按到达顺序执行（runSerialized，参考
 *   memory/autoInject.ts 模式），存档创建不相互重叠；
 * - modelOuterLayerOnly=true：仅根 agent 存档（isRoot 可注入，测试可替换）；
 * - mergeUnchangedCheckpoints=true：创建后判定「无变更」并回滚（详见 README：
 *   先按 sizeBytes===0 && type==='incremental' 启发式，再与本档/基快照 contentHash
 *   比对确认；确认失败（本档/基快照不在页内或列表读取失败）→ 保守保留 + warn，
 *   绝不按启发式回滚；回滚走 deleteCheckpoint（不 force），被链保护拒绝时保留 + warn）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { CheckpointService, CreateCheckpointResult } from './service.ts'

/** `agent/pre-step` 事件 payload（dsh-agent runtime-types）。 */
export interface PreStepPayload {
  readonly agent: Agent
  readonly messages: UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/** `agent/turn-stopping` 事件 payload（serial，无 next）。 */
export interface TurnStoppingPayload {
  readonly agent: Agent
  readonly turn: number
  readonly signal: AbortSignal
}

/** `agent/request` 事件 payload（waterfall，dsh-agent runtime-types:254）。 */
export interface RequestPayload {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/** 自动存档配置（index.ts 解析 schema 默认值后传入；测试直接构造）。 */
export interface AutoCheckpointConfig {
  /** 工具执行前存档的工具名白名单（DSH 工具名，见 index.ts 默认 24 工具）。 */
  readonly beforeTools: readonly string[]
  /** 工具执行后存档的工具名白名单。 */
  readonly afterTools: readonly string[]
  readonly messageCheckpoint: {
    /** pre-step 回合边界存档的消息种类（'user' 有挂点；缺省 ['user','model']）。 */
    readonly beforeMessages: ReadonlyArray<'user' | 'model'>
    /** turn-stopping 存档的消息种类（'model' 有挂点；'user' 无宿主挂点，缺省 []）。 */
    readonly afterMessages: ReadonlyArray<'user' | 'model'>
    /** 仅根 agent 自动存档（缺省 true）。 */
    readonly modelOuterLayerOnly: boolean
    /** 无变更不重复建档（创建后判定并回滚；缺省 true）。 */
    readonly mergeUnchangedCheckpoints: boolean
  }
}

/** 日志面（默认 no-op；index.ts 传 ctx.logger，测试注入 spy）。 */
export interface AutoCheckpointLogger {
  warn(message: string): void
}

/** 工厂选项：根 agent 判定与日志可注入（测试）。 */
export interface AutoCheckpointEngineOptions {
  /** 根 agent 判定（modelOuterLayerOnly=true 时使用；缺省恒 true = 不过滤）。 */
  isRoot?: (agent: Agent) => boolean
  logger?: AutoCheckpointLogger
}

/** 自动存档引擎：attach 挂接事件，监听器函数可直接调用（单元测试注入 fake payload）。 */
export interface AutoCheckpointEngine {
  /** 在 ctx 上挂接事件监听器；返回 detach（index.ts 并入 apply 清理）。 */
  attach(ctx: Context): () => void
  /** `tools/execute` 监听器（beforeTools/afterTools 存档）。 */
  onToolsExecute(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
  /** `agent/pre-step` 监听器（user 消息前存档）。 */
  onPreStep(payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
  /** `agent/request` 监听器（model 消息前存档：beforeMessages 含 'model'）。 */
  onRequest(payload: RequestPayload, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
  /** `agent/turn-stopping` 监听器（model 消息后存档）。 */
  onTurnStopping(payload: TurnStoppingPayload): Promise<void> | void
}

const TITLE_USER_MESSAGE = 'auto: user message'
const TITLE_MODEL_MESSAGE = 'auto: model message'
const TITLE_BEFORE_MODEL_MESSAGE = 'auto: before model message'

/**
 * 创建自动存档引擎（纯函数工厂，无状态挂载：引擎持有 WeakMap 状态，可在多个 ctx
 * 上复用 attach，但每实例应只 attach 一次）。
 */
export function createAutoCheckpointEngine(
  service: CheckpointService,
  config: AutoCheckpointConfig,
  options: AutoCheckpointEngineOptions = {},
): AutoCheckpointEngine {
  const logger = options.logger ?? { warn: () => {} }
  const isRoot = options.isRoot ?? (() => true)
  const rootOnly = config.messageCheckpoint.modelOuterLayerOnly
  const beforeTools = new Set(config.beforeTools)
  const afterTools = new Set(config.afterTools)
  const beforeUser = config.messageCheckpoint.beforeMessages.includes('user')
  const beforeModel = config.messageCheckpoint.beforeMessages.includes('model')
  const afterModel = config.messageCheckpoint.afterMessages.includes('model')
  const mergeUnchanged = config.messageCheckpoint.mergeUnchangedCheckpoints

  /** 每 agent 最后处理的 turn（pre-step 新用户回合判定）。 */
  const lastTurns = new WeakMap<Agent, number>()
  /** 每 agent 存档串行链：并发事件按到达顺序执行，存档创建不相互重叠。 */
  const chains = new WeakMap<Agent, Promise<unknown>>()

  /** 按 agent 串行化执行（并发调用排队，前一个完成后才执行下一个；参考 autoInject）。 */
  const runSerialized = <T>(agent: Agent, fn: () => Promise<T>): Promise<T> => {
    const previous = chains.get(agent) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(fn)
    chains.set(agent, next)
    next
      .finally(() => {
        if (chains.get(agent) === next) {
          chains.delete(agent)
        }
      })
      .catch(() => undefined)
    return next
  }

  /** rootOnly 时是否根 agent；无 agent 的调用（工具无 agent / 匿名）一律跳过。 */
  const shouldArchive = (agent: Agent | undefined): agent is Agent => {
    if (!agent) return false
    return !rootOnly || isRoot(agent)
  }

  /** cwd 解析（会话 header.cwd；缺省回退 process.cwd()，与 tools.ts resolveCwd 口径一致）。 */
  const cwdOf = (agent: Agent): string => agent.session?.header?.cwd ?? process.cwd()

  /**
   * 创建自动存档（origin='auto'）。失败降级：warn 后吞掉，绝不抛出
   * （调用方在工具执行/步骤决策热路径上，抛错会阻断工具/步骤）。
   */
  const createArchive = async (
    agent: Agent,
    title: string,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    try {
      if (signal?.aborted) return
      const result = await service.createCheckpoint(cwdOf(agent), { title, origin: 'auto', signal })
      if (!result) {
        // L-1：createCheckpoint 返回 null（非抛错）＝创建失败被服务吞掉——静默跳过会
        // 掩盖存档缺失，补 warn（失败降级语义不变：不抛错、不阻断调用方）。
        logger.warn(`graycode-checkpoints: auto checkpoint "${title}" skipped (createCheckpoint returned null)`)
        return
      }
      if (mergeUnchanged) {
        await rollbackIfUnchanged(agent, result)
      }
    } catch (err) {
      logger.warn(
        `graycode-checkpoints: auto checkpoint "${title}" degraded: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * mergeUnchanged：创建后判定「无变更」并回滚。
   *
   * 判定（两级）：
   * 1. 启发式门：`sizeBytes === 0 && type === 'incremental'` —— 增量且本次无新写
   *    blob 字节（内容与基快照全同，或全部命中既有 blob）；
   * 2. 确认：本档与基快照 contentHash 比对（listCheckpoints 读 records 一次）。相等
   *    → 确认无变更 → 回滚；不等（内容回退到既有 blob 的真实变更）→ 保留；
   *    本档/基快照不在页内或读取失败 → **保守保留 + warn（fail-closed）**——
   *    绝不回退启发式回滚：base 在 100 条分页窗口之外时「无法确认」≠「无变更」，
   *    按启发式回滚会静默误删真实状态点（复查 M-2）。
   *
   * 回滚走 `deleteCheckpoint`（不 force）：被链保护拒绝（期间有后继存档引用本档）
   * 时保留本档并 warn —— 接受该差异（README 已文档化）。
   */
  const rollbackIfUnchanged = async (agent: Agent, result: CreateCheckpointResult): Promise<void> => {
    if (result.type !== 'incremental' || result.sizeBytes !== 0) return
    if (!result.baseCheckpointId) return
    try {
      const listed = await service.listCheckpoints(cwdOf(agent), { limit: 100 })
      // CreateCheckpointResult 不含 contentHash：从列表取本档与基快照的摘要比对。
      const self = listed.items.find(item => item.id === result.checkpointId)
      const base = listed.items.find(item => item.id === result.baseCheckpointId)
      if (!self || !base) {
        // M-2：本档/基快照不在首页（>100 存档窗口）或已被并发删除——无法确认无变更，
        // 保守保留 + warn（fail-closed），绝不回退启发式回滚（会静默误删真实状态点）。
        logger.warn(
          `graycode-checkpoints: mergeUnchanged confirmation skipped for ${result.checkpointId} ` +
            `(self/base checkpoint not in list page); keeping checkpoint`,
        )
        return
      }
      if (self.contentHash !== base.contentHash) {
        // 内容确实变了（回退到既有 blob），不是无变更 —— 保留
        return
      }
      // 确认无变更 → 走下方回滚
    } catch {
      // M-2：列表读取失败 → 无法确认 → 保守保留 + warn（与「不在页内」同一 fail-closed 口径）
      logger.warn(
        `graycode-checkpoints: mergeUnchanged confirmation degraded for ${result.checkpointId} ` +
          `(list checkpoints failed); keeping checkpoint`,
      )
      return
    }
    try {
      const outcome = await service.deleteCheckpoint(cwdOf(agent), result.checkpointId)
      if (!outcome.success) {
        logger.warn(
          `graycode-checkpoints: mergeUnchanged rollback kept checkpoint ${result.checkpointId} ` +
            `(${outcome.reason ?? outcome.rejected ?? 'unknown'})`,
        )
      }
    } catch (err) {
      logger.warn(
        `graycode-checkpoints: mergeUnchanged rollback degraded for ${result.checkpointId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** `tools/execute` around 包装：before 存档在 next() 前，after 存档在 next() 后。 */
  const onToolsExecute = async (
    exec: ToolDispatchExecution,
    next: () => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> => {
    // 存档创建自身绝不抛错（createArchive 内部捕获 + warn），因此 next() 恰好调用
    // 一次、结果原样返回；next() 若抛错（管线异常）原样上抛，不二次调用。
    if (exec.agent && beforeTools.has(exec.name) && shouldArchive(exec.agent)) {
      await runSerialized(exec.agent, () => createArchive(exec.agent!, `auto: before ${exec.name}`, exec.signal))
    }
    const result = await next()
    if (exec.agent && afterTools.has(exec.name) && shouldArchive(exec.agent)) {
      await runSerialized(exec.agent, () => createArchive(exec.agent!, `auto: after ${exec.name}`, exec.signal))
    }
    return result
  }

  /** `agent/pre-step`：turn 变化（含首次）→ 新用户回合 → beforeMessages 含 'user' 时存档。 */
  const onPreStep = (payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> =>
    runSerialized(payload.agent, async () => {
      const downstream = await next()
      const lastTurn = lastTurns.get(payload.agent)
      if (lastTurn === payload.turn) return downstream
      lastTurns.set(payload.agent, payload.turn)
      if (beforeUser && shouldArchive(payload.agent)) {
        await createArchive(payload.agent, TITLE_USER_MESSAGE, payload.signal)
      }
      return downstream
    })

  /** `agent/request`：模型调用发起前存档（waterfall——先 next() 取回调用配置，快照完成前 waterfall 不返回，落点仍在真实模型调用之前）。 */
  const onRequest = (payload: RequestPayload, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig> =>
    runSerialized(payload.agent, async () => {
      const callConfig = await next()
      if (beforeModel && shouldArchive(payload.agent)) {
        await createArchive(payload.agent, TITLE_BEFORE_MODEL_MESSAGE, payload.signal)
      }
      return callConfig
    })

  /** `agent/turn-stopping`：模型回合关闭 → afterMessages 含 'model' 时存档。 */
  const onTurnStopping = (payload: TurnStoppingPayload): Promise<void> | void => {
    if (!afterModel || !shouldArchive(payload.agent)) return
    return runSerialized(payload.agent, () => createArchive(payload.agent, TITLE_MODEL_MESSAGE, payload.signal))
  }

  return {
    attach(ctx: Context): () => void {
      const disposers = [
        ctx.on('tools/execute', onToolsExecute),
        ctx.on('agent/pre-step', onPreStep),
        ctx.on('agent/request', onRequest),
        ctx.on('agent/turn-stopping', onTurnStopping),
      ]
      return () => {
        for (const dispose of disposers) {
          dispose()
        }
      }
    },
    onToolsExecute,
    onPreStep,
    onRequest,
    onTurnStopping,
  }
}
