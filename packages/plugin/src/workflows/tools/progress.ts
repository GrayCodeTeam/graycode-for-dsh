/**
 * progress 工具：create_progress / update_progress / record_progress_milestone /
 * validate_progress_document
 *
 * 语义与 GrayCode 一致：`.graycode/progress.md` 固定路径、per-path 写锁
 * （progressWriteLock）、create 已存在且有效时返回既有 snapshot、update/record
 * 基于最新盘面合并、validate 只读报告。
 *
 * DSH 差异：删除 autoSync 联动（vscode 依赖，暂缓项 DEFERRED）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import {
  buildProgressDocument,
  buildProgressValidationSummary,
  isProgressPhase,
  isProgressStatus,
  normalizeOptionalProgressSingleLineText,
  validateProgressDocument,
  validateProgressLogAppendInput,
  validateProgressRisksInput,
  validateProgressTodosInput,
} from '../domain/progress/documentLayout.ts'
import { withProgressWriteLock } from '../domain/progress/progressWriteLock.ts'
import { projectProgressToolResultData } from '../domain/progress/resultProjection.ts'
import type {
  ProgressArtifactRef,
  ProgressLogItem,
  ProgressLogType,
  ProgressMilestoneStatus,
  ProgressPhase,
  ProgressRiskItem,
  ProgressStatus,
  ProgressTodoItem,
  ProgressToolStructuredResultV1,
  ProgressValidationIssue,
  ProgressValidationSummaryV1,
} from '../domain/progress/schema.ts'
import { slugify } from '../domain/shared/slugify.ts'
import { omitUndefined } from '../domain/shared/omitUndefined.ts'
import {
  DEFAULT_PROGRESS_PATH,
  PROGRESS_PATH_SCOPE_LABEL,
  applyProgressArtifactPatch,
  buildPathRejectedError,
  depsFromExec,
  getWorkspaceDisplayName,
  isProgressModePathAllowedWithMultiRoot,
  normalizeProgressArtifactRef,
  readTargetText,
  resolveTarget,
  targetExists,
  validateProgressArtifactRefInput,
  writeTargetText,
  type ToolDeps,
} from '../workspace.ts'

function resolveProgressPath(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_PROGRESS_PATH
}

function assertProgressPathAllowed(deps: ToolDeps, targetPath: string): void {
  if (!isProgressModePathAllowedWithMultiRoot(targetPath, deps)) {
    throw new Error(buildPathRejectedError('progress', PROGRESS_PATH_SCOPE_LABEL, targetPath))
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/** staged-diff 接管提示（warnings 通道：staged 条目 id；默认 disabled / 直接落盘时为
 *  undefined。3.17-M2 起 staging 失败不再回退落盘，outcome.warnings 分支仅为防御保留） */
function buildProgressWriteWarnings(outcome: Awaited<ReturnType<typeof writeTargetText>>): string[] | undefined {
  const warnings: string[] = []
  if (outcome.staged && outcome.stagedEntryId) {
    warnings.push(
      `Progress document write staged as entry ${outcome.stagedEntryId} (pending user acceptance; not written to disk yet). Accept it with staged_diff_accept to land it.`
    )
  } else if (outcome.warnings && outcome.warnings.length > 0) {
    warnings.push(...outcome.warnings)
  }
  return warnings.length > 0 ? warnings : undefined
}

export interface CreateProgressArgs {
  path?: string
  projectName?: string
  projectId?: string
  status?: ProgressStatus
  phase?: ProgressPhase
  currentFocus?: string
  latestConclusion?: string
  currentBlocker?: string
  nextAction?: string
  activeArtifacts?: ProgressArtifactRef
  todos?: ProgressTodoItem[]
  risks?: ProgressRiskItem[]
}

export interface UpdateProgressArgs {
  path?: string
  status?: ProgressStatus
  phase?: ProgressPhase
  currentFocus?: string
  latestConclusion?: string
  currentBlocker?: string
  nextAction?: string
  activeArtifacts?: ProgressArtifactRef
  todos?: ProgressTodoItem[]
  risks?: ProgressRiskItem[]
  appendLog?: Array<{ type: ProgressLogType; refId?: string; message: string }>
}

export interface RecordProgressMilestoneArgs {
  path?: string
  milestoneId?: string
  title: string
  status?: ProgressMilestoneStatus
  summary: string
  relatedTodoIds?: string[]
  relatedReviewMilestoneIds?: string[]
  relatedArtifacts?: Partial<ProgressArtifactRef>
  startedAt?: string
  completedAt?: string
  nextAction?: string
  latestConclusion?: string
  currentBlocker?: string
}

export interface ValidateProgressDocumentArgs {
  path: string
}

export interface ValidateProgressDocumentToolResult extends ProgressToolStructuredResultV1 {
  progressValidation: ProgressValidationSummaryV1
  formatVersion: number | null
  isValid: boolean
  issueCount: number
  errorCount: number
  warningCount: number
  issues: ProgressValidationIssue[]
}

function buildAppendedLogEntries(
  value: UpdateProgressArgs['appendLog'],
  at: string
): ProgressLogItem[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const refId = typeof item.refId === 'string' && item.refId.trim() ? item.refId.trim() : undefined
    return {
      at,
      type: item.type,
      ...(refId !== undefined ? { refId } : {}),
      message: item.message.trim(),
    }
  })
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
}

function validateStringList(value: unknown, fieldName: string): string | null {
  if (!Array.isArray(value)) {
    return `${fieldName} must be an array`
  }
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      return `${fieldName} entries must be non-empty strings`
    }
  }
  return null
}

function generateNextMilestoneId(existing: Array<{ id: string }>): string {
  const existingIds = new Set(existing.map((item) => item.id.toLowerCase()))
  let max = 0
  for (const milestone of existing) {
    const match = /^PG(\d+)$/i.exec(milestone.id)
    if (!match) continue
    const numeric = Number(match[1])
    if (Number.isFinite(numeric)) {
      max = Math.max(max, numeric)
    }
  }
  let candidate = max > 0 ? max + 1 : existing.length + 1
  while (existingIds.has(`pg${candidate}`)) {
    candidate++
  }
  return `PG${candidate}`
}

export async function executeCreateProgress(
  deps: ToolDeps,
  rawArgs: Record<string, unknown>
): Promise<ProgressToolStructuredResultV1> {
  const outPath = resolveProgressPath(rawArgs.path)
  assertProgressPathAllowed(deps, outPath)

  if (hasOwn(rawArgs, 'status') && !isProgressStatus(rawArgs.status)) {
    throw new Error('status must be one of: active, blocked, completed, archived')
  }
  if (hasOwn(rawArgs, 'phase') && !isProgressPhase(rawArgs.phase)) {
    throw new Error('phase must be one of: design, plan, implementation, review, maintenance')
  }
  if (hasOwn(rawArgs, 'todos')) {
    const todosError = validateProgressTodosInput(rawArgs.todos)
    if (todosError) throw new Error(todosError)
  }
  if (hasOwn(rawArgs, 'risks')) {
    const risksError = validateProgressRisksInput(rawArgs.risks)
    if (risksError) throw new Error(risksError)
  }
  const artifactsError = validateProgressArtifactRefInput(rawArgs.activeArtifacts, {
    fieldName: 'activeArtifacts',
    allowEmptyString: true,
  }, deps)
  if (artifactsError) {
    throw new Error(artifactsError)
  }

  const target = await resolveTarget(deps, outPath)

  // 「检查已存在 → 构建 → 写入」整体进 per-path 写锁，与 update/record 同一队列
  return withProgressWriteLock(outPath, async () => {
    if (await targetExists(deps, target)) {
      const existingContent = await readTargetText(deps, target)
      const validation = validateProgressDocument(existingContent)
      if (!validation.success) {
        throw new Error(
          `Progress document already exists but is invalid: ${'error' in validation ? validation.error : outPath}`
        )
      }
      return projectProgressToolResultData({
        path: outPath,
        metadata: validation.metadata,
        delta: { type: 'updated', changedFields: [] },
        warnings: [
          `Progress document already exists at ${outPath}. Returned the existing snapshot instead of creating a second file.`,
        ],
      })
    }

    const now = new Date().toISOString()
    const projectName = typeof rawArgs.projectName === 'string' && rawArgs.projectName.trim()
      ? rawArgs.projectName.trim()
      : getWorkspaceDisplayName(deps)
    const projectId = typeof rawArgs.projectId === 'string' && rawArgs.projectId.trim()
      ? rawArgs.projectId.trim()
      : slugify(projectName || getWorkspaceDisplayName(deps) || 'project', 'project')

    const { metadata, content } = buildProgressDocument({
      projectId,
      projectName,
      createdAt: now,
      updatedAt: now,
      status: isProgressStatus(rawArgs.status) ? rawArgs.status : 'active',
      phase: isProgressPhase(rawArgs.phase) ? rawArgs.phase : 'design',
      ...(typeof rawArgs.currentFocus === 'string' ? { currentFocus: rawArgs.currentFocus } : {}),
      ...(typeof rawArgs.latestConclusion === 'string' ? { latestConclusion: rawArgs.latestConclusion } : {}),
      ...(typeof rawArgs.currentBlocker === 'string' ? { currentBlocker: rawArgs.currentBlocker } : {}),
      ...(typeof rawArgs.nextAction === 'string' ? { nextAction: rawArgs.nextAction } : {}),
      activeArtifacts: normalizeProgressArtifactRef(rawArgs.activeArtifacts),
      ...(Array.isArray(rawArgs.todos) ? { todos: rawArgs.todos as ProgressTodoItem[] } : {}),
      milestones: [],
      ...(Array.isArray(rawArgs.risks) ? { risks: rawArgs.risks as ProgressRiskItem[] } : {}),
      log: [{ at: now, type: 'created', message: '初始化项目进度' }],
    }, { generatedAt: now })

    const outcome = await writeTargetText(deps, target, content, outPath)

    return projectProgressToolResultData({
      path: outPath,
      metadata,
      delta: {
        type: 'created',
        changedFields: ['header', 'summary', 'artifacts', 'todos', 'risks', 'log'],
      },
      warnings: buildProgressWriteWarnings(outcome),
    })
  }, deps.cwd)
}

export async function executeUpdateProgress(
  deps: ToolDeps,
  rawArgs: Record<string, unknown>
): Promise<ProgressToolStructuredResultV1> {
  const targetPath = resolveProgressPath(rawArgs.path)
  assertProgressPathAllowed(deps, targetPath)

  if (hasOwn(rawArgs, 'status') && !isProgressStatus(rawArgs.status)) {
    throw new Error('status must be one of: active, blocked, completed, archived')
  }
  if (hasOwn(rawArgs, 'phase') && !isProgressPhase(rawArgs.phase)) {
    throw new Error('phase must be one of: design, plan, implementation, review, maintenance')
  }
  if (hasOwn(rawArgs, 'todos')) {
    const todosError = validateProgressTodosInput(rawArgs.todos)
    if (todosError) throw new Error(todosError)
  }
  if (hasOwn(rawArgs, 'risks')) {
    const risksError = validateProgressRisksInput(rawArgs.risks)
    if (risksError) throw new Error(risksError)
  }
  if (hasOwn(rawArgs, 'appendLog')) {
    const logError = validateProgressLogAppendInput(rawArgs.appendLog)
    if (logError) throw new Error(logError)
  }
  const artifactsError = validateProgressArtifactRefInput(rawArgs.activeArtifacts, {
    fieldName: 'activeArtifacts',
    allowEmptyString: true,
  }, deps)
  if (artifactsError) {
    throw new Error(artifactsError)
  }

  const target = await resolveTarget(deps, targetPath)

  // 「读 → 改 → 写」整体进 per-path 写锁：后一个更新总是基于前一个写回后的盘面重新读取合并
  return withProgressWriteLock(targetPath, async () => {
    if (!(await targetExists(deps, target))) {
      throw new Error(`Progress document does not exist: ${targetPath}`)
    }
    const existingContent = await readTargetText(deps, target)
    const validation = validateProgressDocument(existingContent)
    if (!validation.success) {
      throw new Error('error' in validation ? validation.error : 'Failed to validate progress document')
    }

    const now = new Date().toISOString()
    const currentMetadata = validation.metadata
    const nextLog = hasOwn(rawArgs, 'appendLog')
      ? [...currentMetadata.log, ...buildAppendedLogEntries(rawArgs.appendLog as UpdateProgressArgs['appendLog'], now)]
      : currentMetadata.log

    const nextMetadata = {
      ...currentMetadata,
      updatedAt: now,
      status: hasOwn(rawArgs, 'status')
        ? rawArgs.status as ProgressStatus
        : currentMetadata.status,
      phase: hasOwn(rawArgs, 'phase')
        ? rawArgs.phase as ProgressPhase
        : currentMetadata.phase,
      currentFocus: hasOwn(rawArgs, 'currentFocus')
        ? normalizeOptionalProgressSingleLineText(rawArgs.currentFocus)
        : currentMetadata.currentFocus,
      latestConclusion: hasOwn(rawArgs, 'latestConclusion')
        ? normalizeOptionalProgressSingleLineText(rawArgs.latestConclusion)
        : currentMetadata.latestConclusion,
      currentBlocker: hasOwn(rawArgs, 'currentBlocker')
        ? normalizeOptionalProgressSingleLineText(rawArgs.currentBlocker)
        : currentMetadata.currentBlocker,
      nextAction: hasOwn(rawArgs, 'nextAction')
        ? normalizeOptionalProgressSingleLineText(rawArgs.nextAction)
        : currentMetadata.nextAction,
      activeArtifacts: hasOwn(rawArgs, 'activeArtifacts')
        ? applyProgressArtifactPatch(currentMetadata.activeArtifacts, rawArgs.activeArtifacts)
        : currentMetadata.activeArtifacts,
      todos: hasOwn(rawArgs, 'todos')
        ? rawArgs.todos as ProgressTodoItem[]
        : currentMetadata.todos,
      risks: hasOwn(rawArgs, 'risks')
        ? rawArgs.risks as ProgressRiskItem[]
        : currentMetadata.risks,
      log: nextLog,
    }

    const changedFields = new Set<string>()
    if (hasOwn(rawArgs, 'status') || hasOwn(rawArgs, 'phase')) {
      changedFields.add('header')
    }
    if (
      hasOwn(rawArgs, 'currentFocus') ||
      hasOwn(rawArgs, 'latestConclusion') ||
      hasOwn(rawArgs, 'currentBlocker') ||
      hasOwn(rawArgs, 'nextAction')
    ) {
      changedFields.add('summary')
    }
    if (hasOwn(rawArgs, 'activeArtifacts')) {
      changedFields.add('artifacts')
    }
    if (hasOwn(rawArgs, 'todos')) {
      changedFields.add('todos')
    }
    if (hasOwn(rawArgs, 'risks')) {
      changedFields.add('risks')
    }
    if (hasOwn(rawArgs, 'appendLog')) {
      changedFields.add('log')
    }

    const { metadata, content } = buildProgressDocument(nextMetadata, { generatedAt: now })
    const outcome = await writeTargetText(deps, target, content, targetPath)

    return projectProgressToolResultData({
      path: targetPath,
      metadata,
      delta: {
        type: 'updated',
        changedFields: Array.from(changedFields.values()),
      },
      warnings: buildProgressWriteWarnings(outcome),
    })
  }, deps.cwd)
}

export async function executeRecordProgressMilestone(
  deps: ToolDeps,
  rawArgs: Record<string, unknown>
): Promise<ProgressToolStructuredResultV1> {
  const targetPath = resolveProgressPath(rawArgs.path)
  assertProgressPathAllowed(deps, targetPath)
  const title = typeof rawArgs.title === 'string' ? rawArgs.title.trim() : ''
  const summary = typeof rawArgs.summary === 'string' ? rawArgs.summary.trim() : ''

  if (!title) {
    throw new Error('title is required and must be a non-empty string')
  }
  if (!summary) {
    throw new Error('summary is required and must be a non-empty string')
  }
  if (hasOwn(rawArgs, 'status') && rawArgs.status !== 'in_progress' && rawArgs.status !== 'completed') {
    throw new Error('status must be one of: in_progress, completed')
  }
  if (hasOwn(rawArgs, 'relatedTodoIds')) {
    const error = validateStringList(rawArgs.relatedTodoIds, 'relatedTodoIds')
    if (error) throw new Error(error)
  }
  if (hasOwn(rawArgs, 'relatedReviewMilestoneIds')) {
    const error = validateStringList(rawArgs.relatedReviewMilestoneIds, 'relatedReviewMilestoneIds')
    if (error) throw new Error(error)
  }
  const artifactsError = validateProgressArtifactRefInput(rawArgs.relatedArtifacts, {
    fieldName: 'relatedArtifacts',
    allowEmptyString: true,
  }, deps)
  if (artifactsError) {
    throw new Error(artifactsError)
  }

  const target = await resolveTarget(deps, targetPath)

  return withProgressWriteLock(targetPath, async () => {
    if (!(await targetExists(deps, target))) {
      throw new Error(`Progress document does not exist: ${targetPath}`)
    }
    const existingContent = await readTargetText(deps, target)
    const validation = validateProgressDocument(existingContent)
    if (!validation.success) {
      throw new Error('error' in validation ? validation.error : 'Failed to validate progress document')
    }

    const currentMetadata = validation.metadata
    const requestedMilestoneId = typeof rawArgs.milestoneId === 'string' && rawArgs.milestoneId.trim()
      ? rawArgs.milestoneId.trim()
      : ''
    const milestoneId = requestedMilestoneId || generateNextMilestoneId(currentMetadata.milestones)
    // 重复 id 检查与自动生成器口径一致：大小写不敏感（PG1 与 pg1 视为同一里程碑）
    if (currentMetadata.milestones.some((item) => item.id.toLowerCase() === milestoneId.toLowerCase())) {
      throw new Error(`Milestone id already exists: ${milestoneId}`)
    }

    const now = new Date().toISOString()
    // 与源语义一致：仅显式传 in_progress 才是进行中；缺省（或 completed）一律为
    // completed，且 completedAt 缺省为当前时间（completedAt 赋值见下方 milestone 构造）。
    const milestoneStatus: ProgressMilestoneStatus = rawArgs.status === 'in_progress' ? 'in_progress' : 'completed'

    const milestone = {
      id: milestoneId,
      title,
      status: milestoneStatus,
      summary,
      relatedTodoIds: normalizeStringList(rawArgs.relatedTodoIds),
      relatedReviewMilestoneIds: normalizeStringList(rawArgs.relatedReviewMilestoneIds),
      relatedArtifacts: normalizeProgressArtifactRef(rawArgs.relatedArtifacts),
      startedAt: normalizeOptionalProgressSingleLineText(rawArgs.startedAt) || undefined,
      completedAt: milestoneStatus === 'completed'
        ? (normalizeOptionalProgressSingleLineText(rawArgs.completedAt) || now)
        : undefined,
      recordedAt: now,
      nextAction: typeof rawArgs.nextAction === 'string' && rawArgs.nextAction.trim()
        ? rawArgs.nextAction.trim()
        : null,
    }

    const nextMetadata = {
      ...currentMetadata,
      updatedAt: now,
      latestConclusion: hasOwn(rawArgs, 'latestConclusion')
        ? normalizeOptionalProgressSingleLineText(rawArgs.latestConclusion)
        : currentMetadata.latestConclusion,
      currentBlocker: hasOwn(rawArgs, 'currentBlocker')
        ? normalizeOptionalProgressSingleLineText(rawArgs.currentBlocker)
        : currentMetadata.currentBlocker,
      nextAction: hasOwn(rawArgs, 'nextAction')
        ? normalizeOptionalProgressSingleLineText(rawArgs.nextAction)
        : currentMetadata.nextAction,
      milestones: [...currentMetadata.milestones, milestone],
      log: [
        ...currentMetadata.log,
        {
          at: now,
          type: 'milestone_recorded' as const,
          refId: milestoneId,
          message: `记录里程碑：${title}`,
        },
      ],
    }

    const { metadata, content } = buildProgressDocument(nextMetadata, { generatedAt: now })
    const outcome = await writeTargetText(deps, target, content, targetPath)

    return projectProgressToolResultData({
      path: targetPath,
      metadata,
      delta: {
        type: 'milestone_recorded',
        milestoneId,
        changedFields: ['milestones', 'summary', 'log'],
      },
      warnings: buildProgressWriteWarnings(outcome),
    })
  }, deps.cwd)
}

export async function executeValidateProgressDocument(
  deps: ToolDeps,
  rawArgs: Record<string, unknown>
): Promise<ValidateProgressDocumentToolResult> {
  const targetPath = typeof rawArgs.path === 'string' ? rawArgs.path.trim() : ''
  if (!targetPath) {
    throw new Error('path is required and must be a non-empty string')
  }
  assertProgressPathAllowed(deps, targetPath)

  const target = await resolveTarget(deps, targetPath)
  if (!(await targetExists(deps, target))) {
    throw new Error(`Progress document does not exist: ${targetPath}`)
  }
  const content = await readTargetText(deps, target)
  const progressValidation = buildProgressValidationSummary(content)

  const progressData = progressValidation.metadata
    ? projectProgressToolResultData({
      path: targetPath,
      metadata: progressValidation.metadata,
      delta: { type: 'validated', changedFields: [] },
    })
    : {
      path: targetPath,
      progressDelta: { type: 'validated' as const, changedFields: [] as string[] },
    }

  // lossless-JSON 契约：返回值不得含值为 undefined 的键（含嵌套 metadata 内的
  // 可选字段），validate 结果整体过 omitUndefined。
  return omitUndefined({
    ...progressData,
    progressValidation,
    formatVersion: progressValidation.formatVersion,
    isValid: progressValidation.isValid,
    issueCount: progressValidation.issueCount,
    errorCount: progressValidation.errorCount,
    warningCount: progressValidation.warningCount,
    issues: progressValidation.issues,
  })
}

function renderToolResult<A, V>(_args: A, value: V): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function createCreateProgressTool(fs: FileSystem) {
  return defineTool({
    name: 'create_progress',
    description:
      'Create the project progress document at .graycode/progress.md. This initializes the project-level status ledger and returns a lightweight progress snapshot instead of the full markdown body.',
    parameters: {
      path: {
        type: 'string',
        description: 'Optional output path. Must be .graycode/progress.md (or workspace/.graycode/progress.md).',
      },
      projectName: { type: 'string', description: 'Optional human-readable project name.' },
      projectId: { type: 'string', description: 'Optional stable project id. Defaults to a slug from the project name.' },
      status: { type: 'string', enum: ['active', 'blocked', 'completed', 'archived'] },
      phase: { type: 'string', enum: ['design', 'plan', 'implementation', 'review', 'maintenance'] },
      currentFocus: { type: 'string' },
      latestConclusion: { type: 'string' },
      currentBlocker: { type: 'string' },
      nextAction: { type: 'string' },
      activeArtifacts: {
        type: 'object',
        additionalProperties: false,
        properties: {
          design: { type: 'string' },
          plan: { type: 'string' },
          review: { type: 'string' },
        },
      },
      todos: {
        type: 'array',
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
      risks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: ['active', 'resolved', 'accepted'] },
            description: { type: 'string', required: true },
          },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: renderToolResult,
    },
    async execute(args, exec) {
      return executeCreateProgress(depsFromExec(fs, exec, exec.signal), args as Record<string, unknown>) as never
    },
  })
}

export function createUpdateProgressTool(fs: FileSystem) {
  return defineTool({
    name: 'update_progress',
    description:
      'Update the project progress document at .graycode/progress.md. This refreshes summary fields, artifacts, TODO snapshot, risks, and recent log entries while returning a lightweight progress snapshot.',
    parameters: {
      path: {
        type: 'string',
        description: 'Optional target path. Must be .graycode/progress.md (or workspace/.graycode/progress.md).',
      },
      status: { type: 'string', enum: ['active', 'blocked', 'completed', 'archived'] },
      phase: { type: 'string', enum: ['design', 'plan', 'implementation', 'review', 'maintenance'] },
      currentFocus: { type: 'string' },
      latestConclusion: { type: 'string' },
      currentBlocker: { type: 'string' },
      nextAction: { type: 'string' },
      activeArtifacts: {
        type: 'object',
        additionalProperties: false,
        properties: {
          design: { type: 'string' },
          plan: { type: 'string' },
          review: { type: 'string' },
        },
      },
      todos: {
        type: 'array',
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
      risks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: ['active', 'resolved', 'accepted'] },
            description: { type: 'string', required: true },
          },
        },
      },
      appendLog: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', required: true, enum: ['created', 'updated', 'milestone_recorded', 'artifact_changed', 'risk_changed'] },
            refId: { type: 'string' },
            message: { type: 'string', required: true },
          },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: renderToolResult,
    },
    async execute(args, exec) {
      return executeUpdateProgress(depsFromExec(fs, exec, exec.signal), args as Record<string, unknown>) as never
    },
  })
}

export function createRecordProgressMilestoneTool(fs: FileSystem) {
  return defineTool({
    name: 'record_progress_milestone',
    description:
      'Record a project milestone into .graycode/progress.md and refresh the latest progress snapshot. This is for project-level progress nodes, not for full review findings or plan documents.',
    parameters: {
      path: {
        type: 'string',
        description: 'Optional target path. Must be .graycode/progress.md (or workspace/.graycode/progress.md).',
      },
      milestoneId: { type: 'string' },
      title: { type: 'string', required: true },
      status: { type: 'string', enum: ['in_progress', 'completed'] },
      summary: { type: 'string', required: true },
      relatedTodoIds: { type: 'array', items: { type: 'string' } },
      relatedReviewMilestoneIds: { type: 'array', items: { type: 'string' } },
      relatedArtifacts: {
        type: 'object',
        additionalProperties: false,
        properties: {
          design: { type: 'string' },
          plan: { type: 'string' },
          review: { type: 'string' },
        },
      },
      startedAt: { type: 'string' },
      completedAt: { type: 'string' },
      nextAction: { type: 'string' },
      latestConclusion: { type: 'string' },
      currentBlocker: { type: 'string' },
    },
    output: {
      schema: { type: 'json' },
      render: renderToolResult,
    },
    async execute(args, exec) {
      return executeRecordProgressMilestone(depsFromExec(fs, exec, exec.signal), args as Record<string, unknown>) as never
    },
  })
}

export function createValidateProgressDocumentTool(fs: FileSystem) {
  return defineTool({
    name: 'validate_progress_document',
    description:
      'Validate the fixed progress document at .graycode/progress.md without modifying it. Reports metadata health, section ordering, and basic invariants.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Target progress document path. Must be .graycode/progress.md (or workspace/.graycode/progress.md).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: renderToolResult,
    },
    async execute(args, exec) {
      return executeValidateProgressDocument(depsFromExec(fs, exec, exec.signal), args as Record<string, unknown>) as never
    },
  })
}
