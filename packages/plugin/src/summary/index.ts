/**
 * GrayCode - summary 域（手动上下文总结）。
 *
 * 移植参考实现的 SummarizeService 手动总结语义，落地为 DSH append-only 宿主
 * 的简化形态：总结不截断历史、不插入消息，只生成总结文本返回客户端弹层展示。
 *
 * 架构：
 * - policy.ts：纯逻辑（转录/裁剪/prompt/质量校验，零宿主依赖，可单测）；
 * - service.ts：宿主侧服务——ctx.sessions 读会话派生消息、ctx.llm.stream
 *   调模型（LLM 通道选型依据见 service.ts 模块注释）、质量校验；
 * - 端点：`summary/generate` { sessionId } → { ok:true, text }（失败抛
 *   GrayRemoteError，由 grayRemote 层统一转失败信封；details.code 携带域码）。
 *
 * 挂载（本域是可挂载模块，不在此接线）：
 * 集成阶段在根 index.ts apply() 中：
 *   1. `import * as summary from './summary/index.ts'`；
 *   2. 根 Config 增加 `summary: summary.Config`（默认全量）并入 schema 与
 *      liveConfig（settings/defaults.ts 同步登记）——本域 Config 无 dataRoot，
 *      liveConfig 直接透传；
 *   3. fibers 增加 `summary: ctx.plugin(summary, liveConfig.summary)`；
 *   4. 域 apply() 内调用本文件 install(ctx, config)（见下）。
 * 在此之前端点不注册、服务不激活；install 依赖根装配的 ctx.grayRemote
 *（GrayRemoteService）与宿主 ctx.llm / ctx.sessions，缺失时降级告警不抛错。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { GrayRemoteError } from '../remote/errors.ts'
import { GRAY_REMOTE_ERROR_CODES, type GrayRemoteErrorCode } from '../remote/types.ts'
import type { GrayRemoteArgs, GrayRemoteHandlers } from '../remote/types.ts'
import { requireString } from '../remote/validate.ts'
import { DEFAULT_KEEP_RECENT_ROUNDS, DEFAULT_KEEP_RECENT_TOKENS } from './policy.ts'
import { SummaryService, type SummaryErrorCode } from './service.ts'

export const name = 'graycode-summary'

/**
 * summary 域配置。
 * keepRecentTokens 兼容数字与百分比字符串（'50%' 默认）；summarizePrompt
 * 为空串时回落内置模板。
 */
export interface Config {
  /** 总开关（默认 true：挂载即启用）。 */
  enabled: boolean
  /** 保留最近 N 轮不参与总结（下限保护；默认 2，1-10）。 */
  keepRecentRounds: number
  /** 保留预算：绝对 token 数或百分比（百分比基数为历史总量；默认 '50%'）。 */
  keepRecentTokens: string | number
  /** 用户 prompt 模板（可含 {history} 占位；空 = 内置模板）。 */
  summarizePrompt: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  keepRecentRounds: z.number().min(1).max(10).default(DEFAULT_KEEP_RECENT_ROUNDS),
  keepRecentTokens: z.union([z.string(), z.number()]).default(DEFAULT_KEEP_RECENT_TOKENS),
  summarizePrompt: z.string().default(''),
})

export function createSummaryService(ctx: Context, config: Config): SummaryService {
  return new SummaryService(ctx, {
    keepRecentRounds: config.keepRecentRounds,
    keepRecentTokens: config.keepRecentTokens,
    summarizePrompt: config.summarizePrompt,
  })
}

/** Cordis 子插件入口：挂载 summary 域（端点注册 + 服务激活），返回注销函数。 */
export function apply(ctx: Context, config: Config): () => void {
  return install(ctx, config)
}

/** 域码 → grayRemote 稳定机器码（失败信封的 GRAY_* 码；details.code 保留域码）。 */
function mapSummaryCode(code: SummaryErrorCode): GrayRemoteErrorCode {
  switch (code) {
    case 'SESSION_NOT_FOUND':
      return GRAY_REMOTE_ERROR_CODES.NOT_FOUND
    case 'EMPTY_INPUT':
      return GRAY_REMOTE_ERROR_CODES.INVALID_INPUT
    default:
      return GRAY_REMOTE_ERROR_CODES.INTERNAL
  }
}

/**
 * 端点处理器（命名空间 `summary`）：
 * - `summary/generate` { sessionId } → { ok: true, text }
 *   业务失败抛 GrayRemoteError（grayRemote 层统一转失败信封，永不 reject）；
 *   细节详情 details.code 携带域码（如 EMPTY_INPUT），客户端据此展示本地化文案。
 */
export function createSummaryRemoteHandlers(service: SummaryService): GrayRemoteHandlers {
  return {
    'summary/generate': async (args: GrayRemoteArgs, signal?: AbortSignal) => {
      const sessionId = requireString(args, 'sessionId')
      const result = await service.generateSummary(sessionId, signal)
      if (!result.ok) {
        throw new GrayRemoteError(
          mapSummaryCode(result.error.code),
          result.error.message,
          { code: result.error.code }
        )
      }
      return { ok: true, text: result.text }
    },
  }
}

/**
 * 挂载 summary 域：注册 `summary/generate` 端点并返回注销函数。
 *
 * - enabled=false → no-op；
 * - grayRemote 服务缺失（未通过根 index.ts 装配、或独立挂载）→ 告警 + no-op，
 *   不抛错（与 branches 域的静默跳过同策略，但失败要可观测）；
 * - 注销函数由集成阶段挂进 fiber 生命周期（HMR 重载时旧端点先注销，
 *   新实例同 key 才能重新注册——grayRemote.register 同端点重复注册会抛错）。
 */
export function install(ctx: Context, config: Config): () => void {
  if (!config.enabled) return () => undefined
  const dispose = ctx.grayRemote?.register(
    createSummaryRemoteHandlers(createSummaryService(ctx, config))
  )
  if (dispose === undefined) {
    ctx.logger.warn(
      '[graycode-summary] grayRemote service unavailable; summary/generate was not registered'
    )
    return () => undefined
  }
  return dispose
}
