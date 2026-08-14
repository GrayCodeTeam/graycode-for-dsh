import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BranchCoordinatorService } from './service.ts'
import { createDshBranchSessionAdapter } from './adapters/dshSessionAdapter.ts'
import { createBranchTools } from './tools.ts'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'

export const name = 'graycode-branches'

export const inject = ['agents', 'sessions'] as const

/**
 * Tree-branch coordinator (V2 §P3E): candidate conversations forked from a
 * root session via the dsh agent factory. The Gray sidecar holds grouping,
 * candidate order, labels, soft deletes, and the active pointer under
 * `<dataRoot>/branches/groups.json`; conversation content stays in the
 * append-only dsh Session logs (native lineage via parentSession/seedLength).
 */
export interface Config {
  /** Plugin-private data root (resolved by the composition root). */
  dataRoot: string
  /** Tool install scope: roots (default), all agents, or disabled (no registration). */
  agentScope: AgentScopeMode
}

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  agentScope: agentScopeSchema,
})

export function apply(ctx: Context, config: Config): () => void {
  const service = new BranchCoordinatorService(
    { dataRoot: config.dataRoot },
    createDshBranchSessionAdapter(ctx)
  )
  void service.initialize()
  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  registrar.register(createBranchTools(service))
  return () => {
    registrar.dispose()
    service.dispose()
  }
}
