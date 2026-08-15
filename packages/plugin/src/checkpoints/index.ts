import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CheckpointService } from './service.ts'
import { createCheckpointToolDefinitions } from './tools.ts'
import { createCheckpointsRemoteHandlers } from './adapters/dsh/remote.ts'
import type { GrayRemoteService } from '../remote/service.ts'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'
import { createDshFsRestoreWorkspaceWriter } from './domain/RestoreWorkspaceWriter.ts'

export const name = 'graycode-checkpoints'

export const inject = ['agents', 'fs'] as const

/**
 * Workspace checkpoint domain: full/incremental snapshots with exclusion
 * rules, chain protection, preview-first restore, and content-addressed
 * blob storage under the plugin-private data root (V2 §7.6 layout:
 * checkpoints/<workspace-id>/{blobs,manifests,staging,quarantine}).
 */
export interface Config {
  /** Plugin-private data root (resolved by the composition root). */
  dataRoot: string
  /** Maximum retained checkpoints per workspace (<= 0 = unlimited). */
  maxCheckpoints: number
  /** Default exclusion profile toggles (profileId -> enabled; {} = all defaults). */
  excludeProfiles: Record<string, boolean>
  /** Custom exclusion patterns (gitignore syntax; `!` negation cannot override forced exclusions). */
  excludePatterns: string[]
  /** Per-file size cap in bytes (<= 0 = unlimited; default 50 MiB). */
  maxFileSizeBytes: number
  /** Blob GC grace period in days (<= 0 = collect orphans immediately). */
  blobGracePeriodDays: number
  /** Create a rollback checkpoint before restore (best effort). */
  restoreProtectionPoint: boolean
  /** Tool install scope: roots (default), all agents, or disabled (no registration). */
  agentScope: AgentScopeMode
}

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  maxCheckpoints: z.number().default(-1),
  excludeProfiles: z.dict(z.boolean()).default({}),
  excludePatterns: z.array(z.string()).default([]),
  maxFileSizeBytes: z.number().default(50 * 1024 * 1024),
  blobGracePeriodDays: z.number().default(7),
  restoreProtectionPoint: z.boolean().default(true),
  agentScope: agentScopeSchema,
})

export async function apply(ctx: Context, config: Config): Promise<() => void> {
  // P0-08：恢复向用户 workspace 写文件必须经 DSH fs 路径——注入 ctx.fs（writeText 原子写、
  // 经过 fs/write-intent 策略缝、可携带 sandboxPolicy）；插件私有 blob root 仍由服务 node fs 管理。
  const service = new CheckpointService(config, createDshFsRestoreWorkspaceWriter(ctx.fs))
  // 初始化失败交给 Cordis fiber；成功前不注册任何可调用表面。
  await service.initialize()
  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  registrar.register(createCheckpointToolDefinitions(service))
  // Phase 4 host 侧 Remote 查询/命令层（checkpoint 列表/恢复预览）：注册端点；
  // grayRemote 是可选依赖——用 ctx.inject 声明，服务未 ACTIVE 时回调挂起、可用后
  // 自动补注册（修复组合根 LOADING 期间端点缺失导致的 GRAY_ENDPOINT_NOT_FOUND）。
  // 注销随 inject 纤维自动回收（HMR 重载后同 key 可重新注册）。
  ctx.inject(['grayRemote'], (child) => {
    const grayRemote = child.get('grayRemote') as GrayRemoteService | undefined
    const disposeRemote = grayRemote?.register(createCheckpointsRemoteHandlers(service))
    child.effect(() => () => disposeRemote?.())
  })
  return () => {
    registrar.dispose()
    service.dispose()
  }
}
