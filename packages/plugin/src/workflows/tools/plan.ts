/**
 * plan 工具：create_plan / update_plan
 *
 * 语义与 GrayCode 一致（`backend/tools/plan/create_plan.ts` / `update_plan.ts`）：
 * - 文档写入 `.graycode/plans/**.md`（默认文件名 `<slug>.plan.md`）；
 * - `## TODO LIST` 区块（GRAYCODE_TODO_LIST_START/END 标记 + `- [x] 内容 #id` 渲染）；
 * - sourceArtifactSection（绑定 design/review 来源文档，内嵌 JSON {type,path,contentHash}，
 *   2MB 大小护栏，四种新鲜度 up_to_date/mismatched/missing_source/untracked）；
 * - create 拒绝覆盖既有文档；update 双模式（revision 重写正文 / progress_sync 只更新
 *   TODO 快照，sourceArtifact 在 progress_sync 中被忽略并给出 warning）；
 * - 写后 best-effort 同步 progress（autoSync，失败只进 warnings）。
 *
 * DSH 差异（与 tools/design.ts 一致）：
 * - 无 `requiresUserConfirmation` 语义（GrayCode 中需要用户确认后才落盘；DSH 没有
 *   对应物），文件在工具调用内立即落盘；
 * - staged-diff 适配（ADR-0003 §6 后续动作 2）：stagedDiff enabled 时写入意图先变成
 *   staged 条目（返回 `staged.entryId` + warnings 提示），接受后才落盘；
 * - 路径白名单复用 workspace.ts 的 isProgressArtifactPathAllowedWithMultiRoot('plan', ...)
 *   （与源 isPlanModePathAllowedWithMultiRoot 同一语义，含 multi-root 前缀剥离）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { withProgressWriteLock } from '../domain/progress/progressWriteLock.ts'
import { omitUndefined } from '../domain/shared/omitUndefined.ts'
import { slugify } from '../domain/shared/slugify.ts'
import { normalizeLineEndingsToLF } from '../domain/shared/textUtils.ts'
import { buildPlanDocument, extractPlanBodyContent } from '../domain/plan/documentLayout.ts'
import {
  MAX_SOURCE_ARTIFACT_BYTES,
  buildPlanSourceArtifact,
  computeSourceArtifactHash,
  extractPlanSourceArtifactSection,
  getPlanSourceStatusFromContent,
  isPlanSourceArtifactType,
  renderPlanSourceArtifactSection,
  type PlanSourceArtifact,
  type PlanSourceArtifactInput,
  type PlanSourceStatusResult,
} from '../domain/plan/sourceArtifactSection.ts'
import { normalizePlanTodoList, type PlanTodoItem } from '../domain/plan/todoListSection.ts'
import { syncProgressFromPlanArtifact } from '../autoSync.ts'
import {
  PLAN_PATH_SCOPE_LABEL,
  buildPathRejectedError,
  depsFromExec,
  isProgressArtifactPathAllowedWithMultiRoot,
  readTargetText,
  resolveTarget,
  targetExists,
  writeTargetText,
  type ToolDeps,
} from '../workspace.ts'

export type PlanUpdateMode = 'revision' | 'progress_sync'

export interface PlanToolResultData {
  path: string
  content: string
  todos: PlanTodoItem[]
  updateMode?: PlanUpdateMode
  changeSummary?: string
  /** 绑定来源工件（create/update 提供 sourceArtifact 时） */
  sourceArtifact?: PlanSourceArtifact
  /** 绑定来源的新鲜度（update 时对既有绑定计算；create 提供 sourceArtifact 时为 up_to_date） */
  sourceStatus?: PlanSourceStatusResult
  /** autoSync / staging 的非阻断警告（与源 `data.warnings` 语义一致） */
  warnings?: string[]
  /** staged-diff 接管时：条目 id（供 staged_diff_accept / staged_diff_reject 使用） */
  staged?: { entryId: string; status: 'pending' }
}

const PROGRESS_SYNC_SOURCE_ARTIFACT_WARNING =
  'sourceArtifact was provided in progress_sync mode and has been ignored. Use updateMode: \'revision\' if you need to change the plan source.'

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/** plan 文档路径白名单（复用 workspace.ts 的 plan kind 校验，含 multi-root 前缀语义） */
function assertPlanPathAllowed(deps: ToolDeps, targetPath: string): void {
  if (!isProgressArtifactPathAllowedWithMultiRoot('plan', targetPath, deps)) {
    throw new Error(buildPathRejectedError('plan', PLAN_PATH_SCOPE_LABEL, targetPath))
  }
}

/**
 * 读取并跟踪来源工件：路径白名单 → stat（2MB 大小护栏，超限立即报错不读入）→
 * 读取 → 二次字节数校验（防 TOCTOU）→ 计算 sha256 contentHash。
 * IO 属于工具层；纯函数部分（哈希/构造）在 domain/plan/sourceArtifactSection.ts。
 */
async function buildTrackedSourceArtifact(
  deps: ToolDeps,
  input: PlanSourceArtifactInput
): Promise<PlanSourceArtifact> {
  const type = input?.type
  const path = typeof input?.path === 'string' ? input.path.trim() : ''
  if (!isPlanSourceArtifactType(type) || !path) {
    throw new Error('sourceArtifact must include a valid type and path')
  }
  if (!isProgressArtifactPathAllowedWithMultiRoot(type, path, deps)) {
    throw new Error(`Invalid sourceArtifact path for type "${type}": ${path}`)
  }

  const target = await resolveTarget(deps, path)
  const info = await deps.fs.stat(target, deps.signal)
  if (!info) {
    throw new Error(`sourceArtifact file does not exist: ${path}`)
  }
  if (info.size !== undefined && info.size > MAX_SOURCE_ARTIFACT_BYTES) {
    throw new Error(`sourceArtifact file is too large (${info.size} bytes, limit ${MAX_SOURCE_ARTIFACT_BYTES})`)
  }
  const content = await readTargetText(deps, target)
  const byteLength = new TextEncoder().encode(content).byteLength
  if (byteLength > MAX_SOURCE_ARTIFACT_BYTES) {
    throw new Error(`sourceArtifact file is too large (${byteLength} bytes, limit ${MAX_SOURCE_ARTIFACT_BYTES})`)
  }
  return buildPlanSourceArtifact({ type, path }, computeSourceArtifactHash(content))
}

/** 新鲜度判定的 best-effort 源读取器：不存在/IO 失败/超 2MB 一律返回 null（→ missing_source） */
async function readSourceContentForFreshness(deps: ToolDeps, sourcePath: string): Promise<string | null> {
  try {
    const target = await resolveTarget(deps, sourcePath)
    const info = await deps.fs.stat(target, deps.signal)
    if (!info) return null
    if (info.size !== undefined && info.size > MAX_SOURCE_ARTIFACT_BYTES) return null
    const content = await readTargetText(deps, target)
    if (new TextEncoder().encode(content).byteLength > MAX_SOURCE_ARTIFACT_BYTES) return null
    return content
  } catch {
    return null
  }
}

/** 文档含来源区块时计算其新鲜度；无区块返回 undefined（不参与结果） */
async function computeSourceStatusFromContent(
  deps: ToolDeps,
  content: string
): Promise<PlanSourceStatusResult | undefined> {
  if (!extractPlanSourceArtifactSection(content)) return undefined
  return getPlanSourceStatusFromContent(content, (sourcePath) => readSourceContentForFreshness(deps, sourcePath))
}

/** 组装结果：autoSync warnings + staging 提示（staged 时 entryId 双通道：字段 + warnings 文案） */
function buildPlanResult(
  base: PlanToolResultData,
  progressWarnings: string[],
  outcome: Awaited<ReturnType<typeof writeTargetText>>
): PlanToolResultData {
  const warnings: string[] = [...progressWarnings]
  if (outcome.staged && outcome.stagedEntryId) {
    warnings.push(
      `Document write staged as entry ${outcome.stagedEntryId} (pending user acceptance; not written to disk yet). Accept it with staged_diff_accept to land it.`
    )
  } else if (outcome.warnings && outcome.warnings.length > 0) {
    warnings.push(...outcome.warnings)
  }
  // lossless-JSON 契约：返回值不得含值为 undefined 的键（dsh-tools 快照会抛
  // ToolOutputError），可选字段用条件展开省略而非携带 undefined。
  return omitUndefined({
    ...base,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(outcome.staged && outcome.stagedEntryId
      ? { staged: { entryId: outcome.stagedEntryId, status: 'pending' as const } }
      : {}),
  })
}

export async function executeCreatePlan(
  deps: ToolDeps,
  rawArgs: Record<string, unknown>
): Promise<PlanToolResultData> {
  const plan = typeof rawArgs.plan === 'string' ? rawArgs.plan : ''
  if (!plan.trim()) {
    throw new Error('plan is required and must be a non-empty string')
  }
  if (!Array.isArray(rawArgs.todos)) {
    throw new Error('todos must be an array')
  }

  const title = typeof rawArgs.title === 'string' ? rawArgs.title : ''
  const defaultPath = `.graycode/plans/${slugify(title || 'plan', `plan-${Date.now()}`)}.plan.md`
  const outPath = typeof rawArgs.path === 'string' && rawArgs.path.trim() ? rawArgs.path.trim() : defaultPath

  assertPlanPathAllowed(deps, outPath)

  const target = await resolveTarget(deps, outPath)

  // 「存在性检查 → 构建 → 写入」整体进 per-path 写锁：并行子代理并发 create/update
  // 同一路径时串行化，「create 不覆盖既有文档」语义不被 TOCTOU 竞态破坏。
  return withProgressWriteLock(outPath, async () => {
    if (await targetExists(deps, target)) {
      throw new Error(
        `Plan document already exists at ${outPath}. Use update_plan to revise it instead of overwriting.`
      )
    }

    const normalizedPlan = normalizeLineEndingsToLF(plan)
    const sourceInput = rawArgs.sourceArtifact
    const trackedSourceArtifact = sourceInput !== undefined
      ? await buildTrackedSourceArtifact(deps, sourceInput as PlanSourceArtifactInput)
      : undefined
    const sourceSection = trackedSourceArtifact
      ? renderPlanSourceArtifactSection(trackedSourceArtifact)
      : undefined
    const { content, todos } = buildPlanDocument(normalizedPlan, rawArgs.todos, sourceSection)
    const outcome = await writeTargetText(deps, target, content, outPath)
    const progressWarnings = await syncProgressFromPlanArtifact(deps, {
      planPath: outPath,
      ...(title ? { title } : {}),
      todos,
      updateMode: 'revision',
    })

    return buildPlanResult({
      path: outPath,
      content,
      todos,
      updateMode: 'revision',
      ...(trackedSourceArtifact ? {
        sourceArtifact: trackedSourceArtifact,
        // 刚由当前源内容哈希构造，按构造即为 up_to_date
        sourceStatus: {
          sourceStatus: 'up_to_date' as const,
          sourceArtifactType: trackedSourceArtifact.type,
          sourcePath: trackedSourceArtifact.path,
          sourceArtifact: trackedSourceArtifact,
        },
      } : {}),
    }, progressWarnings, outcome)
  }, deps.cwd)
}

export async function executeUpdatePlan(
  deps: ToolDeps,
  rawArgs: Record<string, unknown>
): Promise<PlanToolResultData> {
  // 延续字段护栏（与源 update_plan 一致）：拒绝 continuation/source-artifact 携带字段
  const allowedKeys = new Set([
    'path', 'plan', 'todos', 'title', 'overview', 'changeSummary', 'updateMode', 'sourceArtifact',
  ])
  const unexpectedKeys = Object.keys(rawArgs).filter(key => !allowedKeys.has(key))
  if (unexpectedKeys.length > 0) {
    throw new Error(`Unexpected update_plan fields: ${unexpectedKeys.join(', ')}`)
  }

  const targetPath = typeof rawArgs.path === 'string' ? rawArgs.path.trim() : ''
  if (!targetPath) {
    throw new Error('path is required and must be a non-empty string')
  }
  if (!Array.isArray(rawArgs.todos)) {
    throw new Error('todos must be an array')
  }

  const plan = typeof rawArgs.plan === 'string' ? rawArgs.plan : ''
  const changeSummary = typeof rawArgs.changeSummary === 'string' ? rawArgs.changeSummary.trim() : ''
  const updateMode: PlanUpdateMode = rawArgs.updateMode === 'progress_sync' ? 'progress_sync' : 'revision'
  const hasSourceArtifactArg = hasOwn(rawArgs, 'sourceArtifact')
  const shouldIgnoreSourceArtifact = updateMode === 'progress_sync' && hasSourceArtifactArg
  const warnings = shouldIgnoreSourceArtifact ? [PROGRESS_SYNC_SOURCE_ARTIFACT_WARNING] : []
  const nextSourceArtifact = shouldIgnoreSourceArtifact ? undefined : rawArgs.sourceArtifact

  if (updateMode === 'revision' && !plan.trim()) {
    throw new Error('plan is required and must be a non-empty string in revision mode')
  }

  assertPlanPathAllowed(deps, targetPath)
  const target = await resolveTarget(deps, targetPath)

  // 「读 → 改 → 写」整体进 per-path 写锁：后一个更新总是基于前一个写回后的盘面重新读取合并
  const written = await withProgressWriteLock(targetPath, async () => {
    if (!(await targetExists(deps, target))) {
      throw new Error(`Plan document does not exist: ${targetPath}`)
    }
    const existingContent = normalizeLineEndingsToLF(await readTargetText(deps, target))

    // revision 提供 sourceArtifact 时重建来源区块；progress_sync 保留盘面既有区块
    const existingSourceSection = extractPlanSourceArtifactSection(existingContent)
    const sourceSection = nextSourceArtifact !== undefined
      ? renderPlanSourceArtifactSection(
        await buildTrackedSourceArtifact(deps, nextSourceArtifact as PlanSourceArtifactInput)
      )
      : existingSourceSection

    // progress_sync：正文保持盘面原样（只更新 TODO 快照）；revision 才重写正文
    const bodyContent = updateMode === 'progress_sync'
      ? extractPlanBodyContent(existingContent)
      : normalizeLineEndingsToLF(plan)

    const { content, todos } = buildPlanDocument(bodyContent, rawArgs.todos, sourceSection)
    const outcome = await writeTargetText(deps, target, content, targetPath)
    return { content, todos, outcome }
  }, deps.cwd)

  const progressWarnings = await syncProgressFromPlanArtifact(deps, {
    planPath: targetPath,
    ...(typeof rawArgs.title === 'string' && rawArgs.title ? { title: rawArgs.title } : {}),
    todos: written.todos,
    updateMode,
  })
  const sourceStatus = await computeSourceStatusFromContent(deps, written.content)

  return buildPlanResult({
    path: targetPath,
    content: written.content,
    todos: written.todos,
    updateMode,
    ...(changeSummary ? { changeSummary } : {}),
    ...(sourceStatus ? { sourceStatus } : {}),
  }, [...warnings, ...progressWarnings], written.outcome)
}

function renderToolResult<A, V>(_args: A, value: V): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function createCreatePlanTool(fs: FileSystem) {
  return defineTool({
    name: 'create_plan',
    description:
      'Create a plan document (markdown) and write it under .graycode/plans/**.md. This tool only creates the plan; it does NOT execute it. The document is written to disk immediately (no user confirmation step).',
    parameters: {
      title: { type: 'string', description: 'Optional plan title (used for default filename)' },
      overview: { type: 'string', description: 'Optional one-line overview' },
      plan: { type: 'string', required: true, description: 'Plan content in markdown' },
      todos: {
        type: 'array',
        required: true,
        description: 'TODO checklist (Cursor-style)',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            content: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
          },
        },
      },
      sourceArtifact: {
        type: 'object',
        additionalProperties: false,
        description:
          'Optional source artifact to track plan freshness against a confirmed design or review document. The source file content is hashed (sha256) and embedded in the plan document.',
        properties: {
          type: { type: 'string', required: true, enum: ['design', 'review'] },
          path: { type: 'string', required: true },
        },
      },
      path: {
        type: 'string',
        description:
          'Optional output path. Must be under .graycode/plans/**.md (or workspace/.graycode/plans/**.md).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: renderToolResult,
    },
    async execute(args, exec) {
      return executeCreatePlan(depsFromExec(fs, exec, exec.signal), args as Record<string, unknown>) as never
    },
  })
}

export function createUpdatePlanTool(fs: FileSystem) {
  return defineTool({
    name: 'update_plan',
    description:
      'Update an existing plan document (markdown) under .graycode/plans/**.md. Use revision mode to revise the plan itself, or progress_sync mode to sync the latest TODO snapshot during implementation. In progress_sync mode, only send path, todos, updateMode, and optional changeSummary. If sourceArtifact is accidentally included, it will be ignored with a warning. Do NOT forward continuation/source-artifact carry-over fields such as sourceArtifactType, sourcePath, sourceContent, planPath, planContent, continuationPrompt, planExecutionPrompt, continuationApproved, or continuationIntent. The document is written to disk immediately (no user confirmation step).',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description:
          'Target existing plan document path under .graycode/plans/**.md. Reuse the approved plan path here; do not send separate sourcePath or planPath fields.',
      },
      title: { type: 'string', description: 'Optional updated plan title.' },
      overview: { type: 'string', description: 'Optional updated one-line overview.' },
      plan: {
        type: 'string',
        description: 'Updated plan content in markdown. Required in revision mode.',
      },
      todos: {
        type: 'array',
        required: true,
        description: 'Updated TODO checklist for the plan.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            content: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
          },
        },
      },
      updateMode: {
        type: 'string',
        description:
          'revision rewrites the plan and requires re-confirmation. progress_sync only updates TODO state during implementation. In progress_sync mode, only send path, todos, updateMode, and optional changeSummary. If sourceArtifact is included by mistake, it will be ignored with a warning.',
        enum: ['revision', 'progress_sync'],
      },
      sourceArtifact: {
        type: 'object',
        additionalProperties: false,
        description:
          'Optional source artifact to rebind the plan to the latest confirmed design or review document. Allowed only in revision mode. Use this nested object only when the schema explicitly allows it. Do NOT send sibling carry-over fields such as sourceArtifactType, sourcePath, or sourceContent.',
        properties: {
          type: { type: 'string', required: true, enum: ['design', 'review'] },
          path: { type: 'string', required: true },
        },
      },
      changeSummary: {
        type: 'string',
        description: 'Optional short summary of what changed in this plan revision.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: renderToolResult,
    },
    async execute(args, exec) {
      return executeUpdatePlan(depsFromExec(fs, exec, exec.signal), args as Record<string, unknown>) as never
    },
  })
}
