import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BranchCoordinatorService } from './service.ts'
import { createDshBranchSessionAdapter } from './adapters/dshSessionAdapter.ts'
import { createBranchTools } from './tools.ts'
import { createBranchesRemoteHandlers } from './adapters/dsh/remote.ts'
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

export async function apply(ctx: Context, config: Config): Promise<() => void> {
  const service = new BranchCoordinatorService(
    { dataRoot: config.dataRoot },
    createDshBranchSessionAdapter(ctx)
  )
  // Cordis 会等待 async apply；初始化完成前不暴露工具/Remote，失败由 fiber
  // 生命周期接管并记录，不产生 fire-and-forget 的 unhandled rejection。
  await service.initialize()
  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  registrar.register(createBranchTools(service))
  // C5：向根装配的 ctx.grayRemote 注册 branches 管理端点；独立挂载时静默跳过。
  // 注销函数挂进本 fiber：HMR 重载时旧端点先注销，新实例同 key 可重新注册。
  const disposeRemote = ctx.grayRemote?.register(createBranchesRemoteHandlers(service))
  return () => {
    disposeRemote?.()
    registrar.dispose()
    service.dispose()
  }
}
