/**
 * GrayCode - subagents 薄适配层（C1 缺口补齐 G1/G2/G3）
 *
 * 挂载位置（由主代理在收尾时统一接入根 index.ts；本文件自带独立 apply）：
 * ```ts
 * // packages/plugin/src/index.ts
 * import * as subagents from './subagents/index.ts'
 * // Config 接口加：subagents: subagents.Config   （即 config.subagents.maxConcurrent）
 * // Config 对象加：subagents: subagents.Config
 * // apply() 加：  ctx.plugin(subagents, config.subagents)
 * ```
 *
 * 本域不复制 DSH 配置、不改 agentScope（新域自身管理作用于 ctx.subagents seam）。
 * 三个缺口：
 * - G1 maxHopDepth（默认 5，老 Gray MAX_HOP_DEPTH）：followup/reportFrom 外层 hop 熔断；
 * - G2 任意寻址：DSH reportFrom 仅直接父代理（能力边界），sendToAgent fail-closed；
 * - G3 maxConcurrent（默认 3，对齐老 Gray subagents.maxConcurrentAgents=3）：委派前
 *   并发上限检查，超出的进入每父会话 FIFO 队列等待（老 Gray 全局配置语义）：
 *   queueTimeoutSeconds 排队超时（默认 600，-1 不限，超时以失败结算）、
 *   defaultMaxRuntimeSeconds 默认运行时间（默认 1800，-1 不限，到时 dispose run 句柄
 *   取消并失败结算；continuable 无取消句柄，不适用）。
 * 0 均表示关闭对应守卫。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSubagentsGuards, type SubagentsGuard } from './adapters/dsh/guard.ts'
import { countRunningChildrenViaList } from './adapters/dsh/counting.ts'
import type { SubagentsSeamLike } from './adapters/dsh/seamTypes.ts'
import { installCustomAgentRuntimes, type CustomAgentSeamLike, type CustomAgentToolsLike } from './customAgents/adapters/dsh/install.ts'
import { deriveProviderName, slugify, type CustomAgentConfig } from './customAgents/domain/plan.ts'

export const name = 'graycode-subagents'

/** 依赖 `agents`（G2 判断主会话）、`subagents`（seam，base 层挂载）与 `tools`（自定义子代理工具）。 */
export const inject = ['agents', 'subagents', 'tools'] as const

export interface Config {
  /**
   * G1：每子线程 hop 上限（老 Gray MAX_HOP_DEPTH=5 硬熔断）。同一子代理的
   * 父子消息链（followup/reportFrom 各算一跳）超限后拒绝投递。0 = 关闭熔断。
   */
  maxHopDepth: number
  /**
   * G3：每父会话同时运行子代理上限（对齐老 Gray settings
   * subagents.maxConcurrentAgents 默认 3）。超出的新委派进入每父会话 FIFO 队列
   * 等待名额释放（排队而不是拒绝）。0 = 不限（不排队）。
   */
  maxConcurrent: number
  /**
   * G3：排队等待并发名额的超时（秒，对齐老 Gray subagents.queueTimeoutSeconds
   * 默认 600）。排队超过该时长的委派以失败结算（SubagentQueueTimeoutError，
   * 委派未启动）。-1 = 无限等待。
   */
  queueTimeoutSeconds: number
  /**
   * G3：one-shot 委派的默认最大运行时间（秒，对齐老 Gray
   * subagents.defaultMaxRuntimeSeconds 默认 1800）。到时 dispose run 句柄（seam
   * 公开取消手段）→ 以非 completed stopReason 失败结算。-1 = 不限。
   * continuable 子代理无 run 句柄（宿主 continuation manager 持有全生命周期，
   * 无取消口），不适用本项。
   */
  defaultMaxRuntimeSeconds: number
  /**
   * S2 自定义子代理：每个 enabled 条目注册一个委托给宿主 `spawn` 的 provider
   * 与一个模型可见工具（`subagent_<name>`，身份 = 名称/描述/systemPrompt）。
   * 热更新：配置变更 → 域 fiber 重启 → 旧注册随 effect disposer 清理后按新配置重挂。
   */
  customAgents: CustomAgentConfig[]
}

const customAgentSchema = z.object({
  id: z.string().required(),
  name: z.string().required(),
  description: z.string().default(''),
  systemPrompt: z.string().default(''),
  enabled: z.boolean().default(true),
})

export const Config: z<Config> = z.object({
  maxHopDepth: z.number().step(1).min(0).default(5),
  maxConcurrent: z.number().step(1).min(0).default(3),
  queueTimeoutSeconds: z.number().step(1).min(-1).default(600),
  defaultMaxRuntimeSeconds: z.number().step(1).min(-1).default(1800),
  customAgents: z.array(customAgentSchema).default([]),
})

/**
 * M2：customAgents 配置校验——id 可 slug 化 + 派生 provider 名唯一性（覆盖重复 id
 * 与同形 id）。在 apply 前整体校验，非法配置明确报错，不再等到运行时
 * DUPLICATE_PROVIDER 炸或空 slug 退化。（schemastery 3.x 无 schema 级自定义
 * 校验 API，故以导出纯函数形式提供，apply 与测试共用。）
 */
export function validateCustomAgentConfig(customAgents: readonly CustomAgentConfig[]): void {
  const seen = new Map<string, string>()
  for (const agent of customAgents) {
    if (slugify(agent.id).length === 0) {
      throw new Error(
        `custom agent id "${agent.id}" is not slug-able — it must contain at least one ASCII alphanumeric character (the id drives the derived provider name)`,
      )
    }
    const providerName = deriveProviderName(agent.id)
    const owner = seen.get(providerName)
    if (owner !== undefined) {
      throw new Error(
        `duplicate custom agent id/derived provider — "${owner}" and "${agent.id}" both derive provider "${providerName}"`,
      )
    }
    seen.set(providerName, agent.id)
  }
}

/** 跨域服务名：G2/G1/G3 守卫句柄（Gray 侧代码经 ctx.get 取用，可选）。 */
export const SUBAGENTS_GUARD_SERVICE_KEY = 'graycode.subagents.guard'

export function apply(ctx: Context, config: Config): void {
  // M2：自定义子代理配置整体校验（id 可 slug 化 + 派生 provider 名唯一）。
  validateCustomAgentConfig(config.customAgents)
  // 经公开 service 读取 API 取 seam（src 不直接依赖 dsh-subagent 的类型 augmentation；
  // inject 已声明 subagents，apply 触发时必在场，此处仅为类型安全与独立挂载兜底）。
  const runtime = ctx.get('subagents') as unknown as SubagentsSeamLike | undefined
  if (!runtime) {
    ctx.logger.warn('graycode-subagents: ctx.subagents seam absent — guards not installed')
    return
  }
  const seam = runtime as unknown as SubagentsSeamLike
  const guard: SubagentsGuard = installSubagentsGuards(
    seam,
    {
      maxHopDepth: config.maxHopDepth,
      maxConcurrent: config.maxConcurrent,
      queueTimeoutSeconds: config.queueTimeoutSeconds,
      defaultMaxRuntimeSeconds: config.defaultMaxRuntimeSeconds,
      countRunning: countRunningChildrenViaList(seam),
      isRootSession: (id) => ctx.agents.roots().some((root) => String(root.id) === id),
      logger: { warn: (message) => ctx.logger.warn(message) },
    },
    {
      // cordis 通用 on 重载：'subagent/start' / 'subagent/end' 为 seam 公开事件。
      // src 不依赖 dsh-subagent 的类型 augmentation（ADR-0001 公开契约），
      // 事件名由 seam 公开契约保证——此处为唯一受控断言点（非 as any 绕过）。
      on: (event, listener) => ctx.on(event as never, listener as never),
    },
  )
  // 跨域共享（可选增强）：守卫句柄供 Gray 侧工作流做「子→父任意寻址 fail-closed」
  // 与受守卫的消息投递。fiber 卸载时随 provide 与 effect 一并注销。
  // H-4a ③：自定义子代理安装先于任何 ctx.provide/ctx.effect 注册——配置非法时
  // installCustomAgentRuntimes 整体拒绝并在内部回滚已注册项后抛错；此处兜底释放
  // guard 包装，保证 apply 失败后 seam 与 ctx 无任何残留（不因残留导致 reload 持续失败）。
  let disposeCustomAgents: () => void
  try {
    disposeCustomAgents = installCustomAgentRuntimes(
      runtime as unknown as CustomAgentSeamLike,
      ctx.tools as unknown as CustomAgentToolsLike,
      config.customAgents,
    )
  } catch (error) {
    guard.dispose()
    throw error
  }
  const disposeProvide = ctx.provide(SUBAGENTS_GUARD_SERVICE_KEY, guard)
  ctx.effect(() => () => {
    disposeProvide()
    guard.dispose()
    disposeCustomAgents()
  })
}
