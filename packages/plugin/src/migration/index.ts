/**
 * GrayCode - migration 子插件入口（cordis）
 *
 * 旧数据迁移器（Phase 5，PLAN_V2 §7）：扫描旧 Gray Code 1.5.4 数据目录、
 * dry-run 报告、确认后逐域导入。源目录全程只读；凭据不迁移；
 * 幂等键（sourceFingerprint + objectType + legacyId）保证重跑不生成副本。
 *
 * Config：
 * - enabled：总开关（默认关闭，迁移是显式操作）；
 * - allowLegacyReaders：读取旧扩展数据的安全门（默认关闭）。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createScopedToolRegistrar } from '../agentScope.ts'
import { createMigrationService } from './adapters/compose.ts'
import { createMigrationTools } from './tools.ts'

export const name = 'graycode-migration'

export const inject = ['agents'] as const

export interface Config {
  /** Plugin-private data root (resolved by the composition root). */
  dataRoot: string
  /** Master switch for the migration domain (default off: migration is explicit). */
  enabled: boolean
  /**
   * Gate for reading legacy extension data (default off). `migration_scan` /
   * `migration_apply` refuse to run while this is false.
   */
  allowLegacyReaders: boolean
}

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  enabled: z.boolean().default(false),
  allowLegacyReaders: z.boolean().default(false),
})

export function apply(ctx: Context, config: Config): () => void {
  if (!config.enabled) return () => {}

  const service = createMigrationService({ dataRoot: config.dataRoot, ctx })
  const registrar = createScopedToolRegistrar(ctx, 'roots')
  registrar.register(createMigrationTools(service, { allowLegacyReaders: config.allowLegacyReaders }))
  return () => {
    registrar.dispose()
  }
}
