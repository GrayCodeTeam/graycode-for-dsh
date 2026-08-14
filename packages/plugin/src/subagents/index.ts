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
 * - G3 maxConcurrent（默认 2，老 Gray subagents.maxConcurrent）：委派前并发上限检查。
 * 0 均表示关闭对应守卫。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSubagentsGuards, type SubagentsGuard } from './adapters/dsh/guard.ts'
import { countRunningChildrenViaList } from './adapters/dsh/counting.ts'
import type { SubagentsSeamLike } from './adapters/dsh/seamTypes.ts'

export const name = 'graycode-subagents'

/** 依赖 `agents`（G2 判断主会话）与 `subagents`（seam，base 层挂载）。 */
export const inject = ['agents', 'subagents'] as const

export interface Config {
  /**
   * G1：每子线程 hop 上限（老 Gray MAX_HOP_DEPTH=5 硬熔断）。同一子代理的
   * 父子消息链（followup/reportFrom 各算一跳）超限后拒绝投递。0 = 关闭熔断。
   */
  maxHopDepth: number
  /**
   * G3：每父会话同时运行子代理上限（老 Gray settings subagents.maxConcurrent
   * 默认 2）。超限拒绝新委派并说明。0 = 不限。
   */
  maxConcurrent: number
}

export const Config: z<Config> = z.object({
  maxHopDepth: z.number().step(1).min(0).default(5),
  maxConcurrent: z.number().step(1).min(0).default(2),
})

/** 跨域服务名：G2/G1/G3 守卫句柄（Gray 侧代码经 ctx.get 取用，可选）。 */
export const SUBAGENTS_GUARD_SERVICE_KEY = 'graycode.subagents.guard'

export function apply(ctx: Context, config: Config): void {
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
  const disposeProvide = ctx.provide(SUBAGENTS_GUARD_SERVICE_KEY, guard)
  ctx.effect(() => () => {
    disposeProvide()
    guard.dispose()
  })
}
