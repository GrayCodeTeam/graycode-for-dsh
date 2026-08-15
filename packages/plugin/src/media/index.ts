import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createMediaToolDefinitions } from './tools.ts'
import { createDshFsMediaFs } from './adapters/mediaFs.ts'
import { createUnavailableChannelImagePort } from './adapters/modelChannel.ts'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'
import { DEFAULT_MAX_BATCH, MAX_MEDIA_MAX_BATCH } from './domain/types.ts'

export const name = 'graycode-media'

export const inject = ['agents', 'fs'] as const

/**
 * Media domain: crop_image / resize_image / rotate_image built on the sharp
 * npm dependency, plus generate_image / remove_background (model-channel
 * dependent). File access goes through `ctx.fs` (binary reads native; binary
 * writes are a documented rc.6 GAP with node-fs fallback, see
 * adapters/mediaFs.ts). The image model channel is fail-closed for now:
 * dsh-llm rc.6 exposes streaming text only, so `createUnavailableChannelImagePort`
 * is injected and channel tools return GRAY_MEDIA_MODEL_CHANNEL_UNAVAILABLE
 * until a real ChannelImagePort is wired — see README.md「模型渠道」节.
 */
export interface Config {
  /** Master switch: false skips tool registration entirely. Default true. */
  enabled: boolean
  /** Tool install scope: roots (default), all agents, or disabled (no registration). */
  agentScope: AgentScopeMode
  /** Max tasks per tool call (default 10, matches the legacy plugin). */
  maxBatch: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  agentScope: agentScopeSchema,
  // L9：maxBatch 设有硬顶（MAX_MEDIA_MAX_BATCH），配置超限在 settings 层即拒绝
  maxBatch: z.number().default(DEFAULT_MAX_BATCH).max(MAX_MEDIA_MAX_BATCH),
})

export function apply(ctx: Context, config: Config): () => void {
  if (!config.enabled) {
    return () => {}
  }
  const fsPort = createDshFsMediaFs(ctx.fs)
  // 模型渠道：rc.6 无公开图像生成 API，fail-closed（真实渠道稳定后替换为
  // ChannelImagePort 的真实实现，挂在 ctx.llm 或独立 provider 服务上）
  const channel = createUnavailableChannelImagePort()
  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  registrar.register(createMediaToolDefinitions({ fs: fsPort, maxBatch: config.maxBatch, channel }))
  return () => {
    registrar.dispose()
  }
}
