import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'
import { initReviewSessionStore } from './sessionState.ts'
import {
  STAGED_DIFF_SERVICE_KEY,
  type StagedDiffServiceHandle,
} from '../stagedDiff/adapters/dsh/index.ts'
import { createStagedWriteHookFromHandle, createStagedWriteHookManager, installStagedWriteHookManager } from './stagedWriteHook.ts'
import { createCreateDesignTool, createUpdateDesignTool } from './tools/design.ts'
import {
  createCreateProgressTool,
  createRecordProgressMilestoneTool,
  createUpdateProgressTool,
  createValidateProgressDocumentTool,
} from './tools/progress.ts'
import {
  createCompareReviewDocumentsTool,
  createCreateReviewTool,
  createFinalizeReviewTool,
  createRecordReviewMilestoneTool,
  createReopenReviewTool,
  createValidateReviewDocumentTool,
} from './tools/review.ts'
import { createCreatePlanTool, createUpdatePlanTool } from './tools/plan.ts'
import { createWorkflowsRemoteHandlers } from './adapters/dsh/remote.ts'
import type { GrayRemoteService } from '../remote/service.ts'

export const name = 'graycode-workflows'

export const inject = ['tools', 'fs', 'agents'] as const

/**
 * Design / Progress / Review workflow domain: structured documents under
 * `<workspace>/.graycode/` with validation, milestones, and lifecycle tools.
 */
export interface Config {
  /** Plugin-private data root (resolved by the composition root). */
  dataRoot: string
  /** Document root directory name relative to the workspace (`.graycode`). */
  documentRoot: string
  /** Tool install scope: roots (default), all agents, or disabled (no registration). */
  agentScope: AgentScopeMode
}

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  documentRoot: z.string().default('.graycode'),
  agentScope: agentScopeSchema,
})

export function apply(ctx: Context, config: Config): void {
  // 会话门闸持久化（W-M2）：状态落在 <dataRoot>/workflows/review-sessions.json，
  // 重启后门闸仍生效；dataRoot 为空时退化为纯内存（与原行为一致）。
  ctx.effect(() => initReviewSessionStore(config.dataRoot))
  // staged-diff 写前钩子接线（ADR-0003 §6 后续动作 2）：钩子管理器实例化到本插件
  // scope（apply 内创建，消除模块级单例——多实例不再串扰、模块重载不静默丢钩子），
  // 并经 installStagedWriteHookManager 装为模块级读取面（writeTargetText 的写入时
  // 读取路径；卸载时恢复前一个读取面）。staged-diff 子插件经 cordis service
  // 'graycode.stagedDiff' 提供 handle：service 出现时把钩子原子装进管理器
  // （writeTargetText 开始把写入意图变成 staged 条目）；service 卸载时仅当当前钩子
  // 仍是本实例钩子才清除（clearIfCurrent——旧纤维的卸载不得覆盖新实例已安装的钩子，
  // 消除「stagedDiff 卸载与新实例 provide 之间钩子置 null」的窗口）。
  const hookManager = createStagedWriteHookManager()
  ctx.effect(() => installStagedWriteHookManager(hookManager))
  ctx.inject([STAGED_DIFF_SERVICE_KEY], (child) => {
    const handle = child.get(STAGED_DIFF_SERVICE_KEY) as StagedDiffServiceHandle | undefined
    const hook = handle ? createStagedWriteHookFromHandle(handle) : null
    // 原子替换：直接覆盖当前钩子，不经 null 中间态
    hookManager.set(hook)
    child.effect(() => () => hookManager.clearIfCurrent(hook))
  })
  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  registrar.register([
    createCreateDesignTool(ctx.fs),
    createUpdateDesignTool(ctx.fs),

    createCreateProgressTool(ctx.fs),
    createUpdateProgressTool(ctx.fs),
    createRecordProgressMilestoneTool(ctx.fs),
    createValidateProgressDocumentTool(ctx.fs),

    createCreateReviewTool(ctx.fs),
    createRecordReviewMilestoneTool(ctx.fs),
    createFinalizeReviewTool(ctx.fs),
    createReopenReviewTool(ctx.fs),
    createValidateReviewDocumentTool(ctx.fs),
    createCompareReviewDocumentsTool(ctx.fs),
    createCreatePlanTool(ctx.fs),
    createUpdatePlanTool(ctx.fs),
  ])
  // Phase 4 host 侧 Remote 查询层（workflow 总览）：向根装配的 ctx.grayRemote 注册端点。
  // 用 ctx.inject 声明可选依赖：grayRemote 未 ACTIVE 时回调挂起、可用后自动补注册，
  // 避免组合根 LOADING 期间属性访问/一次性 get 造成端点缺失（GRAY_ENDPOINT_NOT_FOUND）。
  // 注销随 inject 纤维自动回收（HMR 重载后同 key 可重新注册）。
  ctx.inject(['grayRemote'], (child) => {
    const grayRemote = child.get('grayRemote') as GrayRemoteService | undefined
    const disposeRemote = grayRemote?.register(
      createWorkflowsRemoteHandlers({ fs: ctx.fs, documentRoot: config.documentRoot })
    )
    child.effect(() => () => disposeRemote?.())
  })
  // The registrar binds its own teardown to this fiber; this effect keeps the
  // HMR contract explicit and idempotent.
  ctx.effect(() => () => {
    registrar.dispose()
  })
}
