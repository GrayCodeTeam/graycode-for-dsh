import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BranchCoordinatorService } from './service.ts'
import { createDshBranchSessionAdapter } from './adapters/dshSessionAdapter.ts'
import { createBranchTools } from './tools.ts'
import { createBranchesRemoteHandlers } from './adapters/dsh/remote.ts'
import type { GrayRemoteService } from '../remote/service.ts'
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
  // C5：向根装配的 ctx.grayRemote 注册 branches 管理端点；grayRemote 是可选依赖——
  // 用 ctx.inject 声明，服务未 ACTIVE 时回调挂起、可用后自动补注册（修复组合根
  // LOADING 期间端点缺失导致的 GRAY_ENDPOINT_NOT_FOUND）。注销随 inject 纤维
  // 自动回收（HMR 重载后同 key 可重新注册）。
  ctx.inject(['grayRemote'], (child) => {
    const grayRemote = child.get('grayRemote') as GrayRemoteService | undefined
    const disposeRemote = grayRemote?.register(createBranchesRemoteHandlers(service))
    child.effect(() => () => disposeRemote?.())
  })
  return () => {
    registrar.dispose()
    service.dispose()
  }
}
