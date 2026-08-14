import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'
import { createTodoUpdateTool } from './tools.ts'

export const name = 'graycode-todo'

export const inject = ['agents'] as const

/**
 * Todo domain (C3): todo_update thin adapter on top of DSH's whole-list
 * todo/write snapshot events. See domain/ops.ts for the ported semantics.
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
  registrar.register([createTodoUpdateTool()])
  return () => {
    registrar.dispose()
  }
}
