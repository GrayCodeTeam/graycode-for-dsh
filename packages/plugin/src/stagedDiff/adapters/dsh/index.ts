/**
 * GrayCode - staged-diff 子插件（cordis 表面；ADR-0003 首发工作包）
 *
 * 挂载方式（由主会话在收尾时统一接入根 index.ts，本文件自带可独立挂载的 apply）：
 * ```ts
 * ctx.plugin(stagedDiff, { dataRoot, enabled: true, agentScope: 'roots' })
 * ```
 *
 * Config：
 * - enabled 默认 false：本期不改任何现有写工具（ADR §6 后续动作 2 之前工具保持
 *   惰性），service 仍会初始化（sidecar 恢复），enabled 后工具注册生效；
 * - dataRoot：sidecar 位于 <dataRoot>/staged-diff/entries.json；
 * - agentScope：复用 agentScope.ts 的 createScopedToolRegistrar（roots/all/disabled）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { StagedDiffService } from '../../application/service.ts'
import { EntrySidecarStore } from '../storage.ts'
import { createDshFsApplyFilePort } from './fsApplier.ts'
import { createStagedDiffTools } from './tools.ts'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../../../agentScope.ts'

export const name = 'graycode-staged-diff'

export const inject = ['agents', 'fs'] as const

export interface Config {
  /** 插件私有数据根（sidecar 位于 <dataRoot>/staged-diff/entries.json） */
  dataRoot: string
  /** 默认关闭：写工具适配批次（ADR §6 后续动作 2）接入时由主会话显式开启 */
  enabled: boolean
  /** Tool install scope: roots (default), all agents, or disabled (no registration). */
  agentScope: AgentScopeMode
}

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  enabled: z.boolean().default(false),
  agentScope: agentScopeSchema,
})

export function apply(ctx: Context, config: Config): () => void {
  const service = new StagedDiffService(
    new EntrySidecarStore({ dataRoot: config.dataRoot }),
    createDshFsApplyFilePort(ctx.fs)
  )
  void service.initialize()
  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  if (config.enabled) {
    registrar.register(createStagedDiffTools(service))
  }
  return () => {
    registrar.dispose()
    service.dispose()
  }
}
