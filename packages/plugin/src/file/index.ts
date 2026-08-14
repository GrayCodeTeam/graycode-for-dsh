import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'
import { createDeleteCodeTool } from './tools.ts'

export const name = 'graycode-file'

export const inject = ['agents', 'fs'] as const

/**
 * File domain (C7): generic file editing tools not covered by DSH built-ins
 * (str_replace_editor has insert but no line-range delete). delete_code is
 * ported from the legacy Gray Code `file` category with DSH adaptations
 * (ctx.fs IO, per-path write lock, staged-diff hook).
 */
export interface Config {
  /** Master switch: false skips tool registration entirely. Default true. */
  enabled: boolean
  /** Tool install scope: roots (default), all agents, or disabled (no registration). */
  agentScope: AgentScopeMode
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  agentScope: agentScopeSchema,
})

export function apply(ctx: Context, config: Config): () => void {
  if (!config.enabled) {
    return () => {}
  }
  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  registrar.register([createDeleteCodeTool(ctx.fs)])
  return () => {
    registrar.dispose()
  }
}
