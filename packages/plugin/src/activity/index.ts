/**
 * GrayCode - activity 域子插件（DSH）
 *
 * 「人在 IDE 前」活跃时间统计的 DSH 适配：DSH Web 环境没有窗口聚焦事件，
 * 改用以下信号做活跃采样（只存时间戳，不含任何用户内容）：
 * 1. 用户消息：`agent/inbox/inserted` 中 source.kind === 'user' 的消息进入 inbox；
 * 2. agent 活动：`agent/pre-step` 每个步骤（模型请求/工具调用）都是 agent 在工作；
 * 3. 心跳：惰性——存储原始事件时间戳，查询时按 60s 会话跨度回算活跃分钟，
 *    不常驻任何定时器。
 *
 * 采样落盘于 <dataRoot>/activity/YYYY-MM-DD.json（与 memory 同款 tmp+rename 原子写）。
 * 工具安装与活跃采样按 agentScope 过滤（roots 默认 / all / disabled）。
 * 事件订阅随本 fiber dispose 卸载。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ActivityService } from './service.ts'
import { createActivityTools } from './tools.ts'
import { createActivityRemoteHandlers } from './adapters/dsh/remote.ts'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'
import { ACTIVITY_HEARTBEAT_MS } from './domain/types.ts'

export const name = 'graycode-activity'

export const inject = ['agents'] as const

/**
 * Activity domain (DSH): usage-time stats sampled from user messages and agent
 * steps, persisted under the plugin-private data root as per-day timestamp
 * files. Sampling and the get_activity_stats tool share the agent scope.
 */
export interface Config {
  /** Plugin-private data root (resolved by the composition root). */
  dataRoot: string
  /** Master switch: disable sampling and tool registration entirely (default true). */
  enabled: boolean
  /** Tool install + sampling scope: roots (default), all agents, or disabled. */
  agentScope: AgentScopeMode
  /** Sampling interval / minute granularity in ms (default 60s): events within one window count once. */
  sampleIntervalMs: number
}

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  enabled: z.boolean().default(true),
  agentScope: agentScopeSchema,
  sampleIntervalMs: z.number().step(1).min(1000).max(3_600_000).default(ACTIVITY_HEARTBEAT_MS),
})

/**
 * 判断某 agent 的活动是否计入采样（纯函数，便于单元测试）：
 * - 'disabled'：任何 agent 都不计（工具也不注册）；
 * - 'all'：所有 agent（含子代理）都计；
 * - 'roots'：只计根 agent（顶层会话，无运行时 owner）。
 */
export function isTrackedAgent(agentId: string, mode: AgentScopeMode, rootIds: readonly string[]): boolean {
  if (mode === 'disabled') return false
  if (mode === 'all') return true
  return rootIds.includes(agentId)
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return

  const service = new ActivityService({
    dataRoot: config.dataRoot,
    sampleIntervalMs: config.sampleIntervalMs,
  })

  // get_activity_stats 按 agentScope 安装（roots 默认）；fiber 卸载时注销。
  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  registrar.register(createActivityTools(service))

  // C6：向根装配的 ctx.grayRemote 注册 activity/stats 端点（前端面板数据源）；
  // 独立挂载（无 grayRemote）时静默跳过。注销函数挂进本 fiber：HMR 重载时
  // 旧端点先注销，新实例同 key 可重新注册。
  const disposeRemote = ctx.grayRemote?.register(createActivityRemoteHandlers(service))

  const logger = ctx.logger
  const warn = (error: unknown): void => {
    logger.warn(`graycode-activity: sample append failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const tracked = (agent: Agent): boolean =>
    isTrackedAgent(agent.id, config.agentScope, ctx.agents.roots().map(root => root.id))

  // 信号 1：真实用户消息进入 inbox 即活跃（plugin/工具注入消息不计）。
  // emit 事件，监听器不得抛错——写入失败降级为告警，不阻断事件流。
  const detachInbox = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source.kind !== 'user') return
    if (!tracked(agent)) return
    void service.markActive().catch(warn)
  })

  // 信号 2：每个 agent 步骤（模型请求/工具调用）都是 agent 在工作。
  // waterfall 事件：必须调用 next() 并把结果返回给下游，不能阻塞步骤。
  const detachPreStep = ctx.on('agent/pre-step', (payload, next) => {
    if (tracked(payload.agent)) {
      void service.markActive().catch(warn)
    }
    return next()
  })

  // 订阅随本 fiber dispose 卸载；停用时立即落盘尽量不丢数据。
  ctx.effect(() => () => {
    disposeRemote?.()
    registrar.dispose()
    detachInbox()
    detachPreStep()
    void service.dispose()
  })
}
