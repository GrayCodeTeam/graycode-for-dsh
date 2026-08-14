/**
 * workflows 写前钩子（ADR-0003 §6 后续动作 2 的 workflows 侧接缝）
 *
 * staged-diff 子插件经 cordis service（'graycode.stagedDiff'）提供
 * StagedDiffServiceHandle；workflows/index.ts 用 ctx.inject 消费该 handle 后调用
 * setStagedWriteHook 安装本模块的「写前钩子」。workspace.ts 的 writeTargetText 在
 * 落盘前先询问钩子：enabled 且钩子存在 → 写入意图先变成 staged 条目（绝不提前写
 * workspace），用户接受后才落盘；enabled=false 或未安装钩子 → 行为与现状完全一致
 * （直接经 ctx.fs 落盘，默认关闭）。
 *
 * 失败语义（best-effort）：stageWrite 抛错由 writeTargetText 捕获并回退直接落盘，
 * 以 warnings 上报，不阻断主文档流程。
 */
import type { StagedDiffServiceHandle } from '../stagedDiff/adapters/dsh/index.ts'

/** 一次写入意图（stage 输入；语义对齐 StagedDiffService.createEntry） */
export interface StageWriteInput {
  /** workspace 相对目标路径（POSIX 分隔符；与工具 path 参数一致，如 `.graycode/design/foo.md`） */
  relPath: string
  /** LF 归一化后的目标内容 */
  content: string
  /** 落盘前快照（FsWriteOutcome.before 语义）；null = 目标不存在或快照不可得 */
  before: string | null
  /** 工作区绝对路径（session cwd；用于派生 workspaceId） */
  cwd: string
  /** 会话 id；缺失时按 'unknown' 归组（headless 调用不阻塞 staging） */
  sessionId?: string
}

/**
 * 写前钩子：stageWrite 返回条目 id 表示写入意图已被接管为 staged 条目，
 * 调用方（writeTargetText）不得再直接落盘。
 */
export interface StagedWriteHook {
  /** 是否接管写入（false 时 writeTargetText 直接落盘，与现状一致） */
  readonly enabled: boolean
  stageWrite(input: StageWriteInput): Promise<{ entryId: string }>
}

let activeHook: StagedWriteHook | null = null

/** 安装/替换当前写前钩子（由 workflows/index.ts 的 cordis inject 回调调用；测试可直接注入） */
export function setStagedWriteHook(hook: StagedWriteHook | null): void {
  activeHook = hook
}

/** 当前写前钩子（workspace.ts writeTargetText 每次写入时读取） */
export function getStagedWriteHook(): StagedWriteHook | null {
  return activeHook
}

/** 由 staged-diff service handle 构造写前钩子（handle.enabled=false 时钩子不接管） */
export function createStagedWriteHookFromHandle(handle: StagedDiffServiceHandle): StagedWriteHook {
  return {
    enabled: handle.enabled,
    async stageWrite(input) {
      const entry = await handle.service.createEntry({
        workspaceId: handle.workspaceIdOf(input.cwd),
        sessionId: input.sessionId ?? 'unknown',
        path: input.relPath,
        after: input.content,
        before: input.before,
      })
      return { entryId: entry.id }
    },
  }
}
