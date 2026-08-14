/**
 * workflows 写前钩子（ADR-0003 §6 后续动作 2 的 workflows 侧接缝）
 *
 * staged-diff 子插件经 cordis service（'graycode.stagedDiff'）提供
 * StagedDiffServiceHandle；workflows/index.ts 用 ctx.inject 消费该 handle 后把钩子
 * 装进本插件 scope 的 StagedWriteHookManager。workspace.ts 的 writeTargetText 在
 * 落盘前先询问当前读取面的钩子：enabled 且钩子存在 → 写入意图先变成 staged 条目
 * （绝不提前写 workspace），用户接受后才落盘；enabled=false 或未安装钩子 → 行为与
 * 现状完全一致（直接经 ctx.fs 落盘，默认关闭）。
 *
 * 生命周期设计（消除模块级可变状态）：
 * - 钩子绑定（createStagedWriteHookFromHandle 的结果）与持有它的 manager 都实例化
 *   到插件 scope（workflows/index.ts apply 内创建）；模块级只保留「当前读取面」指针，
 *   由 installStagedWriteHookManager 原子安装/恢复——writeTargetText 是模块函数，
 *   工具调用链（tools → workspace.ts）无法携带插件实例引用，读取面指针是该约束下
 *   唯一可行的写入时读取路径。多实例（测试/多 ctx）各自持有独立 manager，卸载时
 *   恢复前一个读取面，互不串扰；模块自身重载后 apply 重新安装新 manager。
 * - 原子替换：新钩子直接覆盖当前钩子，不经 null 中间态；旧实例卸载用
 *   clearIfCurrent 只清理「仍是自己安装」的钩子——旧 stagedDiff 纤维的卸载不会把
 *   新实例刚安装的钩子置 null（消除「卸载与新 provide 之间钩子丢失」窗口）。
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

/**
 * 写前钩子管理器：每个 workflows 插件实例一个（apply 内创建）。
 * 状态留在实例内，模块级不持有钩子值——多实例互不串扰。
 */
export interface StagedWriteHookManager {
  /** 当前钩子（writeTargetText 每次写入时经模块级读取面读取） */
  get(): StagedWriteHook | null
  /** 原子替换：直接覆盖当前钩子，不经 null 中间态 */
  set(hook: StagedWriteHook | null): void
  /**
   * 仅当当前钩子仍是 `expected` 时置 null：旧 stagedDiff 纤维卸载时调用，
   * 不会覆盖新实例已安装的钩子（「置 null 窗口」消除）。
   */
  clearIfCurrent(expected: StagedWriteHook | null): void
}

/** 创建插件 scope 的钩子管理器（初始无钩子）。 */
export function createStagedWriteHookManager(): StagedWriteHookManager {
  let hook: StagedWriteHook | null = null
  return {
    get: () => hook,
    set: next => {
      hook = next
    },
    clearIfCurrent(expected) {
      if (hook === expected) hook = null
    },
  }
}

// ─── 模块级读取面（兼容 API；workflows/index.ts 与测试使用） ────────────────

const liveManagers = new Set<StagedWriteHookManager>()
let activeManager: StagedWriteHookManager | null = null

/**
 * 把某插件实例的 manager 安装为模块级当前读取面（apply 内调用）；
 * 返回恢复前一个读取面的 disposer（插件卸载时经 ctx.effect 执行）。
 * 只恢复到仍存活的 manager，避免恢复已卸载实例的陈旧指针。
 */
export function installStagedWriteHookManager(manager: StagedWriteHookManager): () => void {
  liveManagers.add(manager)
  const previous = activeManager
  activeManager = manager
  return () => {
    liveManagers.delete(manager)
    if (activeManager === manager) {
      activeManager = previous && liveManagers.has(previous) ? previous : null
    }
  }
}

/** 当前写前钩子（workspace.ts writeTargetText 每次写入时读取） */
export function getStagedWriteHook(): StagedWriteHook | null {
  return activeManager?.get() ?? null
}

/**
 * 测试/兼容快捷入口：设置当前读取面的钩子；无读取面时临时安装一个
 * （供不经过插件装配的单元测试直接注入）。
 */
export function setStagedWriteHook(hook: StagedWriteHook | null): void {
  if (!activeManager) {
    const manager = createStagedWriteHookManager()
    installStagedWriteHookManager(manager)
    activeManager = manager
  }
  activeManager.set(hook)
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
