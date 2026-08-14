import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createMediaToolDefinitions } from './tools.ts'
import { createDshFsMediaFs } from './adapters/mediaFs.ts'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'
import { DEFAULT_MAX_BATCH } from './domain/types.ts'

export const name = 'graycode-media'

export const inject = ['agents', 'fs'] as const

/**
 * Media domain (Phase: local sharp processing): crop_image / resize_image /
 * rotate_image built on the sharp npm dependency. File access goes through
 * `ctx.fs` (binary reads native; binary writes are a documented rc.6 GAP with
 * node-fs fallback, see adapters/mediaFs.ts). generate_image and
 * remove_background are deferred (model-channel dependent) — see README.md.
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
  maxBatch: z.number().default(DEFAULT_MAX_BATCH),
})

export function apply(ctx: Context, config: Config): () => void {
  if (!config.enabled) {
    return () => {}
  }
  const fsPort = createDshFsMediaFs(ctx.fs)
  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  registrar.register(createMediaToolDefinitions({ fs: fsPort, maxBatch: config.maxBatch }))
  return () => {
    registrar.dispose()
  }
}
