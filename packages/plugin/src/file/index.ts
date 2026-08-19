import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'
import { createDeleteCodeTool } from './tools.ts'
import { createInsertCodeTool } from './insert.ts'
import { createListFilesTool } from './list.ts'
import { createSearchInFilesTool } from './search.ts'

export const name = 'graycode-file'

export const inject = ['agents', 'fs'] as const

/**
 * Gray Code file compatibility tools that are not equivalently covered by DSH:
 * line insertion/deletion, directory listings with line counts, and the
 * search_in_files replacement mode. Writes use ctx.fs, per-path locks and the
 * staged-diff hook; every path is constrained to the active workspace.
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
  registrar.register([
    createDeleteCodeTool(ctx.fs),
    createInsertCodeTool(ctx.fs),
    createListFilesTool(ctx.fs),
    createSearchInFilesTool(ctx.fs),
  ])
  return () => {
    registrar.dispose()
  }
}
