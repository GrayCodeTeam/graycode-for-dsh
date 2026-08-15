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
 *
 * 跨域服务（ADR §6 后续动作 2 的接线）：本子插件在 apply 时经 cordis 公开 API
 * `ctx.provide('graycode.stagedDiff', handle)` 把 StagedDiffServiceHandle 共享给
 * workflows 等消费者；消费者（workflows/index.ts）用 `ctx.inject`/`ctx.get` 消费，
 * 组装「写前钩子」：stagedDiff enabled 时 Gray 写工具把写入意图先变成 staged 条目，
 * 用户接受后才落盘；enabled=false 时钩子不接管，行为与现状完全一致。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { StagedDiffService } from '../../application/service.ts'
import { EntrySidecarStore } from '../storage.ts'
import { createDshFsApplyFilePort } from './fsApplier.ts'
import { createStagedDiffTools, createStagedWorkspaceId } from './tools.ts'
import { createStagedDiffRemoteHandlers } from './remote.ts'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../../../agentScope.ts'
import type { GrayRemoteService } from '../../../remote/service.ts'

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

/** cordis service 名：staged-diff 子插件向 workflows 等消费者提供 StagedDiffServiceHandle */
export const STAGED_DIFF_SERVICE_KEY = 'graycode.stagedDiff'

/**
 * 跨域共享句柄：workflows 写前钩子只依赖本契约（application 层语义不变，
 * domain/application 不感知 cordis）。
 */
export interface StagedDiffServiceHandle {
  /** 写工具适配开关（config.enabled；默认 false）。false 时消费者不得接管写入。 */
  readonly enabled: boolean
  /** 核心用例服务（createEntry/listEntries/previewEntry/acceptEntry/rejectEntry/restoreFromSidecar） */
  readonly service: StagedDiffService
  /** workspaceId 派生（与 staged_diff_* 工具同口径：cwd sha256 前 16 位） */
  workspaceIdOf(cwd: string): string
}

/** 构造跨域共享句柄（enabled 与 service 引用同一实例） */
export function createStagedDiffServiceHandle(
  service: StagedDiffService,
  enabled: boolean
): StagedDiffServiceHandle {
  return { enabled, service, workspaceIdOf: createStagedWorkspaceId }
}

export async function apply(ctx: Context, config: Config): Promise<() => void> {
  const service = new StagedDiffService(
    new EntrySidecarStore({ dataRoot: config.dataRoot }),
    createDshFsApplyFilePort(ctx.fs)
  )
  // sidecar 恢复完成后才提供 service/工具/Remote，消除启动窗口里的
  // "service is not initialized"；拒绝由 Cordis fiber 正常收敛。
  await service.initialize()
  // 跨域共享：service 出现时 workflows 的 ctx.inject 回调被唤醒并安装写前钩子；
  // 本 fiber 卸载时 disposeService 使消费者侧钩子随 inject 纤维回收而移除。
  const handle = createStagedDiffServiceHandle(service, config.enabled)
  const disposeService = ctx.provide(STAGED_DIFF_SERVICE_KEY, handle)
  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  if (config.enabled) {
    registrar.register(createStagedDiffTools(service))
  }
  // Phase 4 host 侧 Remote 查询/命令层（staged diff 卡片）：grayRemote 是可选项——
  // 根装配提供 GrayRemoteService 时注册端点；独立挂载/测试（无该服务）时静默跳过。
  // 用 ctx.inject 声明依赖（而非顶层 inject），避免把可选增强变成强依赖：
  // 依赖不存在时本回调不执行，插件本身照常加载。
  ctx.inject(['grayRemote'], (child) => {
    const grayRemote = child.get('grayRemote') as GrayRemoteService | undefined
    const disposeRemote = grayRemote?.register(createStagedDiffRemoteHandlers(service))
    // 随 inject 纤维卸载注销端点（HMR：域级重载后同 key 可重新注册）
    child.effect(() => () => disposeRemote?.())
  })
  return () => {
    disposeService()
    registrar.dispose()
    service.dispose()
  }
}
