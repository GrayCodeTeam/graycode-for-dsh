import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CheckpointService } from './service.ts'
import { createCheckpointToolDefinitions } from './tools.ts'
import { createCheckpointsRemoteHandlers } from './adapters/dsh/remote.ts'
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

export function apply(ctx: Context, config: Config): () => void {
  // P0-08：恢复向用户 workspace 写文件必须经 DSH fs 路径——注入 ctx.fs（writeText 原子写、
  // 经过 fs/write-intent 策略缝、可携带 sandboxPolicy）；插件私有 blob root 仍由服务 node fs 管理。
  const service = new CheckpointService(config, createDshFsRestoreWorkspaceWriter(ctx.fs))
  void service.initialize()
  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  registrar.register(createCheckpointToolDefinitions(service))
  // Phase 4 host 侧 Remote 查询/命令层（checkpoint 列表/恢复预览）：注册端点；
  // 独立挂载（无 grayRemote）时静默跳过，工具行为不受影响。注销函数随本 fiber
  // 卸载（HMR：旧端点先注销，新实例同 key 可重新注册）。
  const disposeRemote = ctx.grayRemote?.register(createCheckpointsRemoteHandlers(service))
  return () => {
    disposeRemote?.()
    registrar.dispose()
    service.dispose()
  }
}
