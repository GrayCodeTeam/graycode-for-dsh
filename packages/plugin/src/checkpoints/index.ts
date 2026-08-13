import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CheckpointService } from './service.ts'
import { createCheckpointToolDefinitions } from './tools.ts'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'

export const name = 'graycode-checkpoints'

export const inject = ['agents'] as const

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
  agentScope: agentScopeSchema,
})

export function apply(ctx: Context, config: Config): () => void {
  const service = new CheckpointService(config)
  void service.initialize()
  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  registrar.register(createCheckpointToolDefinitions(service))
  return () => {
    registrar.dispose()
    service.dispose()
  }
}
