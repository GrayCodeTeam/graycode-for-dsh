/**
 * 模式工具策略
 * 定义不同模式下允许使用的工具和路径规则
 */

/**
 * 检查路径是否允许在指定 GrayCode 文档目录下写入
 *
 * 通用拒绝规则：
 * - 不在指定目录下的路径
 * - 绝对路径
 * - 包含路径穿越（..）的路径
 * - 非 .md 扩展名的文件
 * - 空字符串或目录路径
 */
function isScopedMarkdownPathAllowed(path: string, scopeRoot: string): boolean {
    // 空字符串不允许
    if (!path || path.length === 0) {
        return false;
    }

    // 处理 Windows 路径分隔符：将 \ 转换为 /；Windows 文件系统大小写不敏感，
    // 校验前统一转小写（scopeRoot 同步转小写），与 normalizeProgressPathKey 口径一致，
    // 避免 `.GRAYCODE/design/foo.MD` 等合法路径被误拒。
    const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
    const normalizedScopeRoot = scopeRoot.toLowerCase();

    // 拒绝绝对路径（以 / 开头）
    if (normalizedPath.startsWith('/')) {
        return false;
    }

    // 防止路径穿越：只拒绝等于 .. 的路径段（文件名字符串里的 .. 如 foo..bar.md
    // 不构成目录穿越，不应被误拒）
    if (normalizedPath.split('/').some((segment) => segment === '..')) {
        return false;
    }

    // 必须以指定目录开头
    if (!normalizedPath.startsWith(normalizedScopeRoot)) {
        return false;
    }

    // 不能只是目录名（以 / 结尾）
    if (normalizedPath.endsWith('/')) {
        return false;
    }

    // 必须是一个文件路径（不能只是目录本身）
    const relativePath = normalizedPath.substring(normalizedScopeRoot.length);
    if (!relativePath || relativePath.length === 0) {
        return false;
    }

    // 仅允许 Markdown 文件
    return relativePath.endsWith('.md');
}

/**
 * 检查路径是否允许在 Plan 模式下写入
 * 
 * 允许的路径：
 * - .graycode/plans/xxx.plan.md
 * - .graycode/plans/sub/xxx.md
 * 
 * 拒绝的路径：
 * - 不在 .graycode/plans/ 下的路径
 * - 绝对路径
 * - 包含路径穿越（..）的路径
 * - 非 .md 或 .plan.md 扩展名的文件
 * - 空字符串或目录路径
 * 
 * @param path 要检查的路径
 * @returns 如果路径允许则返回 true，否则返回 false
 */
export function isPlanPathAllowed(path: string): boolean {
    return isScopedMarkdownPathAllowed(path, '.graycode/plans/');
}

/**
 * 检查路径是否允许在 Design 模式下写入
 *
 * 允许的路径：
 * - .graycode/design/xxx.md
 * - .graycode/design/sub/xxx.md
 *
 * 拒绝的路径：
 * - 不在 .graycode/design/ 下的路径
 * - 绝对路径
 * - 包含路径穿越（..）的路径
 * - 非 .md 扩展名的文件
 * - 空字符串或目录路径
 *
 * @param path 要检查的路径
 * @returns 如果路径允许则返回 true，否则返回 false
 */
export function isDesignPathAllowed(path: string): boolean {
    return isScopedMarkdownPathAllowed(path, '.graycode/design/');
}

/**
 * 检查路径是否允许在 Review 模式下写入
 *
 * 允许的路径：
 * - .graycode/review/xxx.md
 * - .graycode/review/sub/xxx.md
 *
 * 拒绝的路径：
 * - 不在 .graycode/review/ 下的路径
 * - 绝对路径
 * - 包含路径穿越（..）的路径
 * - 非 .md 扩展名的文件
 * - 空字符串或目录路径
 */
export function isReviewPathAllowed(path: string): boolean {
    return isScopedMarkdownPathAllowed(path, '.graycode/review/');
}

/**
 * 检查路径是否允许在 Progress 能力下写入
 *
 * 首版仅允许固定文件：
 * - .graycode/progress.md
 *
 * 拒绝：
 * - 绝对路径
 * - 包含路径穿越（..）的路径
 * - 空字符串、目录路径或其他 Markdown 文件
 */
export function isProgressPathAllowed(path: string): boolean {
    // Windows 文件系统大小写不敏感：转小写后与固定路径比较（与 normalizeProgressPathKey 口径一致）
    const normalizedPath = (path || '').replace(/\\/g, '/').toLowerCase();
    if (!normalizedPath
        || normalizedPath.startsWith('/')
        || normalizedPath.split('/').some((segment) => segment === '..')
        || normalizedPath.endsWith('/')) {
        return false;
    }
    return normalizedPath === '.graycode/progress.md';
}

/**
 * 通用文件写工具集合。
 *
 * search_in_files 是读写混合工具：replace 模式等价于通用文件写操作。
 * 若某模式的 toolPolicy allowlist 只授予了 search_in_files 而未授予
 * 任一通用写工具，则 replace 模式构成权限逃逸（只读模式借搜索工具写文件）。
 * 该集合与 tools/subagents/presets.ts 的 WRITE_TOOLS 保持一致，
 * 供模式工具策略与工具执行服务共用判定口径。
 */
export const GENERAL_FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
    'write_file',
    'apply_diff',
    'insert_code',
    'delete_code',
    'delete_file',
    'create_directory',
]);

/**
 * 判断模式的 allowlist 是否允许 search_in_files 的 replace 模式。
 *
 * 规则：allowlist 授予了 search_in_files，但未授予任何通用文件写工具时，
 * replace 模式必须被拒绝（防止只读模式借搜索工具修改文件）；search 模式不受影响。
 *
 * @param toolPolicy 模式工具策略 allowlist（undefined/空数组视为未启用过滤，不限制）
 * @returns true 表示 replace 模式被禁止
 */
export function isSearchInFilesReplaceForbidden(toolPolicy: readonly string[] | undefined): boolean {
    if (!toolPolicy || toolPolicy.length === 0) {
        return false;
    }
    if (!toolPolicy.includes('search_in_files')) {
        return false;
    }
    return !toolPolicy.some(name => GENERAL_FILE_WRITE_TOOLS.has(name));
}

/**
 * 获取只读模式下被认为是危险的工具集合
 * 
 * @returns 危险工具名称的 Set
 */
export function getReadonlyModeDangerousTools(): Set<string> {
    return new Set([
        'apply_diff',
        'write_file',
        'delete_file',
        'create_directory',
        'execute_command'
    ]);
}


// ============================================================================
// 执行层：模式 toolPolicy allowlist 强制（审计 R1-M3 / R3-H3，决策 D-4）
//
// 旧版 Gray Code 在工具执行前经 preflight.ts 强制模式白名单：
//   1) 模式 toolPolicy 非空数组时，不在名单的工具直接拒绝；
//   2) search_in_files 的 replace 模式越权检查（只授予搜索工具而未授予通用写
//      工具时拒绝 replace，防只读模式借搜索工具写文件）；
//   3) plan 模式 write_file 受控例外（仅允许写入 .graycode/plans/**.md）。
// 新版移植后本文件曾只剩路径白名单纯函数，执行链缺失（审计 M3/H3）。
//
// 探针结论（D-4，VERIFIED）：DSH rc.6（@deepseek-ai/dsh-tools@0.1.0-rc.6）
// 提供公开等价执行面：
//   - 'tools/pre-execute' waterfall（allow/deny/ask，scope 过滤）：
//     node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts:38
//   - ctx.tools.guard(guard) 单调拥有方守卫：返回 reason 即拒绝，无 allow 结果，
//     监听器顺序无法把拒绝翻回放行（index.d.ts:481-488 ToolGuard、:613-622 guard）；
//   - dsh-agent-loop README L80 明确该面承载 sandbox/permission/plan mode 语义。
// 因此接入方式 = 在工具注册流程之外用 ctx.tools.guard()（或 agent-scoped
// 'tools/pre-execute' listener）挂接本文件导出的拦截器工厂
// （createModeToolPolicyGuard）；注册流程本身保持不变。接线说明见任务报告。
// ============================================================================

/**
 * 旧版四个只读模式（design/plan/ask/review）toolPolicy 的公共子集。
 * 与旧 backend/modules/settings/promptModes.ts:314-418 逐字一致。
 */
export const READONLY_MODE_COMMON_TOOLS: readonly string[] = [
  'read_file',
  'list_files',
  'find_files',
  'search_in_files',
  'goto_definition',
  'find_references',
  'get_symbols',
  'history_search',
  'subagents',
]

/**
 * 长期记忆工具名（与旧 backend/modules/memory/types.ts:8-16 的
 * MEMORY_TOOL_NAMES 一致；新插件 memory/tools.ts 注册名相同）。
 */
export const MEMORY_TOOL_NAMES: readonly string[] = [
  'memory_wake',
  'memory_note',
  'memory_recall',
  'memory_compress',
  'memory_zoom',
  'memory_forget',
  'memory_config',
]

/**
 * 内置模式默认 toolPolicy 映射（与旧 backend/modules/settings/promptModes.ts
 * :443-448 BUILTIN_MODE_TOOL_POLICIES 对齐，逐字保留各名单）。
 *
 * 差异注记：
 * - code 模式无白名单（旧版 CODE_PROMPT_MODE 无 toolPolicy 字段），故不入表；
 * - review 名单额外包含 compare_review_documents（新插件新增的纯只读审查工具，
 *   旧版无此工具；加入白名单符合 review 只读语义）；
 * - todo_write/todo_update/create_plan/update_plan 为新插件未迁移工具，保留在
 *   名单中与旧版逐字对齐——allowlist 多含一个不存在的名字无副作用（拒绝语义
 *   只看「不在名单」）。
 */
export const BUILTIN_MODE_TOOL_POLICIES: Readonly<Record<string, readonly string[]>> = {
  design: [
    ...READONLY_MODE_COMMON_TOOLS,
    'todo_write',
    'todo_update',
    'create_progress',
    'update_progress',
    'record_progress_milestone',
    'validate_progress_document',
    'create_design',
    'update_design',
    ...MEMORY_TOOL_NAMES,
  ],
  plan: [
    ...READONLY_MODE_COMMON_TOOLS,
    'todo_write',
    'todo_update',
    'create_progress',
    'update_progress',
    'record_progress_milestone',
    'validate_progress_document',
    'create_plan',
    'update_plan',
    ...MEMORY_TOOL_NAMES,
  ],
  ask: [...READONLY_MODE_COMMON_TOOLS, 'todo_write', 'todo_update'],
  review: [
    ...READONLY_MODE_COMMON_TOOLS,
    'create_review',
    'validate_review_document',
    'compare_review_documents',
    'create_progress',
    'update_progress',
    'record_progress_milestone',
    'validate_progress_document',
    'record_review_milestone',
    'finalize_review',
    'reopen_review',
    ...MEMORY_TOOL_NAMES,
  ],
}

/**
 * 解析内置模式的默认 toolPolicy。
 *
 * code 与未知/自定义模式返回 undefined（无过滤）；design/plan/ask/review 返回
 * 对应默认名单。自定义模式的策略由接线方在 resolveToolPolicy 中覆盖。
 *
 * @param modeId 当前 prompt mode id（undefined 视为无模式）
 * @returns allowlist；undefined 表示未启用过滤（放行一切）
 */
export function resolveBuiltinModeToolPolicy(modeId: string | undefined): readonly string[] | undefined {
  if (!modeId) {
    return undefined
  }
  return BUILTIN_MODE_TOOL_POLICIES[modeId]
}

/**
 * 解析模式最终生效的 toolPolicy（模式数据层 per-mode toolPolicy 持久化后的
 * 运行时入口，字段定义见 promptTypes.PromptMode.toolPolicy / toolPolicyCustomized）。
 *
 * 语义（对齐旧 PromptSettingsService.normalizePromptModeSnapshot）：
 * - mode 为空 → undefined（无过滤）；
 * - toolPolicyCustomized === true 且 toolPolicy 为数组 → 直接使用模式自身名单
 *   （用户主动定制，含显式空数组 = 未启用过滤）；
 * - 否则 → 回退 resolveBuiltinModeToolPolicy(mode.id)（内置默认名单；code 与
 *   未知/自定义模式返回 undefined，未启用过滤）。
 *
 * @param mode 当前 prompt mode（可缺省）
 * @returns allowlist；undefined 表示未启用过滤（放行一切）
 */
export function resolveModeToolPolicy(
  mode:
    | {
        id: string
        toolPolicy?: readonly string[] | undefined
        toolPolicyCustomized?: boolean | undefined
      }
    | undefined,
): readonly string[] | undefined {
  if (!mode) {
    return undefined
  }
  if (mode.toolPolicyCustomized === true && Array.isArray(mode.toolPolicy)) {
    return mode.toolPolicy
  }
  return resolveBuiltinModeToolPolicy(mode.id)
}

/**
 * allowlist 判定（旧 preflight.ts:128-134 语义）：
 * toolPolicy 为 undefined/空数组时未启用过滤，一律放行；否则仅放行名单内工具。
 *
 * @param toolName 工具名
 * @param toolPolicy 模式工具策略 allowlist（undefined/空数组视为未启用过滤）
 * @returns true 表示允许
 */
export function isToolAllowedByPolicy(toolName: string, toolPolicy: readonly string[] | undefined): boolean {
  if (!toolPolicy || toolPolicy.length === 0) {
    return true
  }
  return toolPolicy.includes(toolName)
}

/**
 * 模式工具策略单次调用判定输入。
 */
export interface ModeToolPolicyEvaluation {
  /** 待执行的工具名 */
  toolName: string
  /** 工具参数（search_in_files 的 mode、write_file 的 path 等）；可缺省 */
  args?: Readonly<Record<string, unknown>> | undefined
  /** 当前模式 allowlist；undefined/空数组 = 未启用过滤 */
  toolPolicy?: readonly string[] | undefined
  /** 当前模式 id（仅用于拒绝消息文案） */
  modeId?: string | undefined
  /** 工作区 basename（multi-root 前缀剥离判定用；缺省时不剥离前缀） */
  workspaceName?: string | undefined
}

/**
 * multi-root 前缀剥离判定（与 workspace.ts isScopedPathAllowedWithMultiRoot 口径一致；
 * 以 workspaceName 取代 ToolDeps 解耦，避免循环依赖）：先直接判定，首段与 workspace
 * basename 一致时剥离前缀后再次判定（等价于单工作区下显式工作区前缀）。
 */
function isPlanPathAllowedWithWorkspacePrefix(pathStr: string, workspaceName: string | undefined): boolean {
  if (isPlanPathAllowed(pathStr)) return true
  if (!workspaceName) return false

  const normalized = (pathStr || '').replace(/\\/g, '/')
  const slashIndex = normalized.indexOf('/')
  if (slashIndex <= 0) return false

  const workspacePrefix = normalized.slice(0, slashIndex)
  if (workspacePrefix === '.' || workspacePrefix === '..') return false
  if (workspacePrefix.includes(':')) return false
  // Windows 文件系统大小写不敏感：workspace 前缀比较忽略大小写
  if (process.platform === 'win32'
    ? workspacePrefix.toLowerCase() !== workspaceName.toLowerCase()
    : workspacePrefix !== workspaceName) {
    return false
  }

  return isPlanPathAllowed(normalized.slice(slashIndex + 1))
}

/**
 * 模式工具策略执行判定（旧 preflight.ts getToolRejectionReason 的模式相关部分，
 * L114-157 语义逐条对齐）：
 *
 * 1. allowlist 非空数组且不含 toolName → 拒绝；
 * 2. search_in_files replace 越权：allowlist 含 search_in_files 但未授予任何通用
 *    写工具时，replace 模式拒绝（search 只读模式不受影响）；
 * 3. plan 模式 write_file 受控例外：即使 allowlist 允许 write_file，路径也必须
 *    落在 .graycode/plans/**.md（大小写不敏感，与 isPlanPathAllowed 口径一致；
 *    提供 workspaceName 时接受 workspaceName/.graycode/plans/**.md multi-root 前缀）。
 *
 * @returns 拒绝原因字符串；undefined 表示放行
 */
export function evaluateModeToolPolicy(evaluation: ModeToolPolicyEvaluation): string | undefined {
  const { toolName, args, toolPolicy, modeId, workspaceName } = evaluation
  const modeLabel = modeId ?? 'unknown'

  // 1) allowlist 过滤（非空数组才启用，与旧 preflight.ts:128-134 一致）
  if (!isToolAllowedByPolicy(toolName, toolPolicy)) {
    return `Tool "${toolName}" is not allowed in mode "${modeLabel}".`
  }

  // 2) search_in_files replace 越权检查（旧 preflight.ts:136-141）
  if (
    toolName === 'search_in_files'
    && (args as Readonly<Record<string, unknown>> | undefined)?.mode === 'replace'
    && isSearchInFilesReplaceForbidden(toolPolicy)
  ) {
    return `search_in_files with mode "replace" is not allowed in mode "${modeLabel}": this mode only permits read-only search. Use mode "search" instead.`
  }

  // 3) plan 模式 write_file 受控例外（旧 preflight.ts:143-149 + validatePlanModeWriteFileArgs）
  if (modeId === 'plan' && toolName === 'write_file') {
    const rawPath = (args as Readonly<Record<string, unknown>> | undefined)?.path
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      return 'In plan mode, write_file requires a non-empty "path" string.'
    }
    if (!isPlanPathAllowedWithWorkspacePrefix(rawPath, workspaceName)) {
      return `In plan mode, write_file is only allowed to write ".graycode/plans/**.md". Rejected path: ${rawPath}`
    }
  }

  return undefined
}

/**
 * 与 @deepseek-ai/dsh-tools ToolExecution 结构兼容的只读视图（结构类型，
 * 保持本文件零宿主导入；DSH ToolExecution 为
 * { token, callId, name, arguments, signal, agent?, parent? }，此处只需 name
 * 与 arguments，故字段超集赋值兼容）。
 */
export interface ToolExecutionLike {
  readonly name: string
  readonly arguments?: unknown
  readonly agent?: unknown
}

/**
 * 模式工具策略拦截器（与 DSH ToolGuard 签名一致：同步返回拒绝原因或 undefined）。
 */
export type ModeToolPolicyGuard = (execution: Readonly<ToolExecutionLike>) => string | undefined

/**
 * 拦截器工厂选项。
 */
export interface ModeToolPolicyGuardOptions {
  /**
   * 总开关（默认 true）。false 时拦截器恒放行且不调用任何 resolve（零侵入）。
   */
  enabled?: boolean
  /**
   * 解析当前生效的 allowlist。每次调用实时求值，因此模式切换无需重新挂接
   * （与 prompt 注入器的 mode 切换机制解耦）。返回 undefined/空数组 = 未启用过滤。
   * 未提供时恒放行（纯装饰性挂接）。
   */
  resolveToolPolicy?: () => readonly string[] | undefined
  /**
   * 解析当前模式 id（仅用于拒绝消息文案；未提供时消息使用 'unknown'）。
   */
  resolveModeId?: () => string | undefined
  /**
   * 解析当前工作区 basename（plan 模式 write_file 的 multi-root 前缀剥离判定用；
   * 未提供时不剥离前缀，行为与旧版一致）。
   */
  resolveWorkspaceName?: () => string | undefined
}

/**
 * 创建可挂接到 DSH 工具执行管线的模式工具策略拦截器。
 *
 * 接线（由插件组合根执行，注册流程不变）：
 *
 * ```ts
 * import { createModeToolPolicyGuard, resolveBuiltinModeToolPolicy } from './workflows/domain/modeToolsPolicy.ts'
 *
 * ctx.tools.guard(createModeToolPolicyGuard({
 *   enabled: config.modeToolPolicy !== false,
 *   resolveToolPolicy: () => resolveBuiltinModeToolPolicy(promptService.currentModeSnapshot()?.id),
 *   resolveModeId: () => promptService.currentModeSnapshot()?.id,
 * }))
 * ```
 *
 * 语义：
 * - 拒绝 = 返回 reason 字符串（DSH 将其作为工具错误回喂模型）；
 * - guard 是单调拥有方策略：任何匹配的 guard 返回 reason 即拒绝，且监听器顺序
 *   无法把拒绝翻回放行（dsh-tools index.d.ts:481-488）——适合作为安全边界；
 * - resolveToolPolicy 抛错时 fail-closed（拒绝），策略不可用不得静默放行。
 *
 * @param options 工厂选项
 * @returns 与 DSH ToolGuard 兼容的同步拦截器
 */
export function createModeToolPolicyGuard(options: ModeToolPolicyGuardOptions = {}): ModeToolPolicyGuard {
  // 总开关关闭：零侵入，不调用任何 resolve。
  if (options.enabled === false) {
    return () => undefined
  }

  const resolveToolPolicy = options.resolveToolPolicy ?? (() => undefined)
  const resolveModeId = options.resolveModeId ?? (() => undefined)
  const resolveWorkspaceName = options.resolveWorkspaceName ?? (() => undefined)

  return (execution: Readonly<ToolExecutionLike>): string | undefined => {
    // fail-closed：策略解析失败时拒绝，而不是静默放行。
    let toolPolicy: readonly string[] | undefined
    let modeId: string | undefined
    let workspaceName: string | undefined
    try {
      toolPolicy = resolveToolPolicy()
      modeId = resolveModeId()
      workspaceName = resolveWorkspaceName()
    } catch {
      return `[graycode:mode-tool-policy] tool policy resolution failed; denying tool "${execution.name}" to stay fail-closed.`
    }

    // 参数归一化：DSH arguments 为 lossless JSON（unknown），仅需 mode/path 字段。
    const rawArgs = execution.arguments
    const args: Readonly<Record<string, unknown>> | undefined =
      typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)
        ? (rawArgs as Readonly<Record<string, unknown>>)
        : undefined

    return evaluateModeToolPolicy({ toolName: execution.name, args, toolPolicy, modeId, workspaceName })
  }
}
