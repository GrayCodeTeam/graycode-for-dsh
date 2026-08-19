/**
 * GrayCode - migration 子插件入口（cordis）
 *
 * 旧数据迁移器（Phase 5，PLAN_V2 §7）：扫描旧 Gray Code 1.5.4 数据目录、
 * dry-run 报告、确认后逐域导入。源目录全程只读；凭据不迁移；
 * 幂等键（sourceFingerprint + objectType + legacyId）保证重跑不生成副本。
 *
 * Config：enabled 是唯一开关；开启即表示允许迁移工具读取旧版数据。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createScopedToolRegistrar } from '../agentScope.ts'
import { createMigrationService } from './adapters/compose.ts'
import { createMigrationTools } from './tools.ts'
import { createMigrationRemoteHandlers } from './adapters/dsh/remote.ts'
import type { GrayRemoteService } from '../remote/service.ts'

export const name = 'graycode-migration'

export const inject = ['agents'] as const

export interface Config {
  /** Plugin-private data root (resolved by the composition root). */
  dataRoot: string
  /** Master switch for the migration domain (default off: migration is explicit). */
  enabled: boolean
}

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  enabled: z.boolean().default(false),
})

export function apply(ctx: Context, config: Config): () => void {
  if (!config.enabled) return () => {}

  const service = createMigrationService({ dataRoot: config.dataRoot, ctx })
  const registrar = createScopedToolRegistrar(ctx, 'roots')
  registrar.register(createMigrationTools(service))
  // D-2 可视化：scope 映射 Remote 端点（仅安全门开启时暴露；client ScopeMapPanel 消费）。
  // grayRemote 是可选依赖——用 ctx.inject 声明，服务未 ACTIVE 时回调挂起、可用后
  // 自动补注册（修复组合根 LOADING 期间端点缺失导致的 GRAY_ENDPOINT_NOT_FOUND）。
  // 注销随 inject 纤维自动回收（HMR 重载后同 key 可重新注册）。
  ctx.inject(['grayRemote'], (child) => {
    const grayRemote = child.get('grayRemote') as GrayRemoteService | undefined
    const disposeRemote = grayRemote?.register(createMigrationRemoteHandlers(service))
    child.effect(() => () => disposeRemote?.())
  })
  return () => {
    registrar.dispose()
  }
}
