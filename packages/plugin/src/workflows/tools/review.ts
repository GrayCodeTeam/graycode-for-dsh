/**
 * review 工具：create_review / record_review_milestone / finalize_review /
 * reopen_review / validate_review_document / compare_review_documents
 *
 * 语义与 GrayCode 一致：`.graycode/review/**.md` 白名单、会话门闸（sessionState）、
 * 读改写整体进 progress per-path 写锁（源行为）、V4 文档生命周期
 * （in_progress → completed → reopen）。
 *
 * DSH 差异：
 * - 会话门闸持久化（W-M2）：状态落在 <dataRoot>/workflows/review-sessions.json，
 *   重启后门闸仍生效（见 sessionState.ts）。
 * - staged-diff 适配（ADR-0003 §6 后续动作 2）：stagedDiff enabled 时写入意图先
 *   变成 staged 条目（extra.staged.entryId + warnings 提示），接受后才落盘；
 *   默认 disabled 行为与源一致（立即落盘）。
 * - autoSync 联动（审计项 W-M1 恢复）：写入后 best-effort 同步 `.graycode/progress.md`
 *   （失败只进 extra.warnings，不阻断主流程），warnings 字段与源一致。
 * - create_review 已存在检查用 `ctx.fs.stat(...) === undefined`（源用 FileNotFound 码）。
 */

import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { syncProgressFromReviewArtifact } from '../autoSync.ts'
import type {
  ReviewEvidenceRef,
  ReviewFindingInput,
  ReviewOverallDecision,
  ReviewToolStructuredResultV4,
} from '../domain/review/schema.ts'
import {
  appendReviewMilestone,
  buildInitialReviewDocument,
  finalizeReviewDocument,
  getCurrentReviewDocumentLocale,
  reopenReviewDocument,
  summarizeReviewDocument,
  validateReviewDocument,
} from '../domain/review/reviewDocumentSection.ts'
import { projectReviewToolResultData, buildReviewValidationSummaryFromResult } from '../domain/review/resultProjection.ts'
import { slugify } from '../domain/shared/slugify.ts'
import { normalizeLineEndingsToLF } from '../domain/shared/textUtils.ts'
import {
  ensureMatchingActiveReviewSession,
  ensureNoActiveReviewSession,
  loadReviewSessionState,
  saveReviewSessionState,
  withReviewSessionLock,
} from '../sessionState.ts'
import { withProgressWriteLock } from '../domain/progress/progressWriteLock.ts'
import {
  REVIEW_PATH_SCOPE_LABEL,
  buildPathReceivedError,
  buildPathRejectedError,
  depsFromExec,
  isProgressArtifactPathAllowedWithMultiRoot,
  readTargetText,
  resolveTarget,
  targetExists,
  writeTargetText,
  type ToolDeps,
} from '../workspace.ts'

function assertReviewPathAllowed(deps: ToolDeps, pathStr: string): void {
  if (!isProgressArtifactPathAllowedWithMultiRoot('review', pathStr, deps)) {
    throw new Error(buildPathRejectedError('review', REVIEW_PATH_SCOPE_LABEL, pathStr))
  }
}

export interface CreateReviewArgs {
  title?: string
  overview?: string
  review: string
  path?: string
}

export interface RecordReviewMilestoneArgs {
  path: string
  milestoneId?: string
  milestoneTitle: string
  summary: string
  status?: 'in_progress' | 'completed'
  conclusion?: string
  evidenceFiles?: string[]
  evidence?: ReviewEvidenceRef[]
  findings?: string[]
  structuredFindings?: ReviewFindingInput[]
  reviewedModules?: string[]
  recommendedNextAction?: string
}

export interface FinalizeReviewArgs {
  path: string
  conclusion: string
  overallDecision?: ReviewOverallDecision
  recommendedNextAction?: string
  reviewedModules?: string[]
}

export interface ReopenReviewArgs {
  path: string
}

export interface ValidateReviewDocumentArgs {
  path: string
}

export interface CompareReviewDocumentsArgs {
  basePath: string
  targetPath: string
  includeUnchanged?: boolean
}

export interface ValidateReviewDocumentToolResult extends ReviewToolStructuredResultV4 {
  reviewValidation: ReturnType<typeof buildReviewValidationSummaryFromResult>
  reviewDelta: { type: 'validated'; changedFields: string[] }
  issueCount: number
  errorCount: number
  warningCount: number
  currentStatus?: ReviewToolStructuredResultV4['status']
  totalMilestones?: number
  completedMilestones?: number
}

export interface CompareReviewDocumentsToolResult {
  base: unknown
  target: unknown
  summary: {
    addedFindings: number
    removedFindings: number
    persistedFindings: number
    severityChanged: number
    trackingChanged: number
    evidenceChanged: number
    relatedMilestoneChanged: number
  }
  findings: {
    added: unknown[]
    removed: unknown[]
    persisted: Array<{ key: string; base: unknown; target: unknown; changes: string[] }>
  }
  statsDelta: unknown
  baseValidation: ReturnType<typeof buildReviewValidationSummaryFromResult>
  targetValidation: ReturnType<typeof buildReviewValidationSummaryFromResult>
}

function renderToolResult<A, V>(_args: A, value: V): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function toOverallDecision(value: unknown): ReviewOverallDecision | undefined {
  return value === 'accepted'
    || value === 'conditionally_accepted'
    || value === 'rejected'
    || value === 'needs_follow_up'
    ? value
    : undefined
}

/** 组装 extra：autoSync warnings + staging 提示（staged 时 entryId 双通道：字段 + warnings 文案） */
function buildReviewExtra(
  progressWarnings: string[],
  outcome: Awaited<ReturnType<typeof writeTargetText>>
): Record<string, unknown> | undefined {
  const warnings: string[] = [...progressWarnings]
  if (outcome.staged && outcome.stagedEntryId) {
    warnings.push(
      `Document write staged as entry ${outcome.stagedEntryId} (pending user acceptance; not written to disk yet). Accept it with staged_diff_accept to land it.`
    )
  } else if (outcome.warnings && outcome.warnings.length > 0) {
    warnings.push(...outcome.warnings)
  }
  const extra: Record<string, unknown> = {}
  if (warnings.length > 0) extra.warnings = warnings
  if (outcome.staged && outcome.stagedEntryId) {
    extra.staged = { entryId: outcome.stagedEntryId, status: 'pending' }
  }
  return Object.keys(extra).length > 0 ? extra : undefined
}

export async function executeCreateReview(
  deps: ToolDeps,
  rawArgs: Record<string, unknown>
): Promise<ReviewToolStructuredResultV4> {
  const review = typeof rawArgs.review === 'string' ? rawArgs.review : ''
  if (!review.trim()) {
    throw new Error('review is required and must be a non-empty string')
  }

  const title = typeof rawArgs.title === 'string' ? rawArgs.title : ''
  const defaultPath = `.graycode/review/${slugify(title || 'review', `review-${Date.now()}`)}.md`
  const outPath = typeof rawArgs.path === 'string' && rawArgs.path.trim() ? rawArgs.path.trim() : defaultPath

  assertReviewPathAllowed(deps, outPath)

  const target = await resolveTarget(deps, outPath)

  // 会话门闸检查移入临界区：per-path 写锁（串行化同路径创建）之内、per-session 锁
  // （串行化同会话跨路径创建）之内「重查门闸 → 写文档 → 保存会话状态」整体原子化，
  // 避免并发 create 双双通过门闸后互相覆盖会话状态、产生孤儿 review 文档。
  return withProgressWriteLock(outPath, async () => {
    return withReviewSessionLock(deps.sessionId, async () => {
      const sessionCheck = ensureNoActiveReviewSession(deps.sessionId, outPath)
      if (sessionCheck.ok === false) {
        throw new Error(sessionCheck.error)
      }

      if (await targetExists(deps, target)) {
        throw new Error(
          `Review document already exists at ${outPath}. Continue it with record_review_milestone or finalize_review, or choose a different path.`
        )
      }

      const locale = getCurrentReviewDocumentLocale()
      const content = buildInitialReviewDocument({
        title,
        overview: typeof rawArgs.overview === 'string' ? rawArgs.overview : '',
        review,
      }, locale)
      const summary = summarizeReviewDocument(content)
      const outcome = await writeTargetText(deps, target, content, outPath)
      const progressWarnings = await syncProgressFromReviewArtifact(deps, {
        reviewPath: outPath,
        title: summary.title || title || undefined,
        eventMessage: `同步审查文档：${outPath}`,
      })

      const warnings = [...progressWarnings]
      // 写入意图只产生 staged 条目（未落盘）时不得记录 in_progress 会话：
      // reject 后门闸会指向不存在的文档，导致 create_review 被拦截、
      // record_review_milestone 读盘失败。会话状态只在真正落盘后记录。
      // 会话保存是非关键步骤：失败降级为 warnings，不阻断已落盘的主流程。
      if (summary.reviewSnapshot && !outcome.staged) {
        try {
          saveReviewSessionState(deps.sessionId, {
            reviewRunId: summary.reviewSnapshot.reviewRunId,
            reviewPath: outPath,
            status: summary.reviewSnapshot.status,
            createdAt: summary.reviewSnapshot.createdAt,
            finalizedAt: summary.reviewSnapshot.finalizedAt,
          })
        } catch (error) {
          warnings.push(`Failed to save review session state: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      return projectReviewToolResultData({
        path: outPath,
        content,
        delta: {
          type: 'created',
          changedFields: ['header', 'scope', 'reviewSnapshot', 'reviewSession'],
        },
        extra: buildReviewExtra(warnings, outcome),
      })
    })
  })
}

export async function executeRecordReviewMilestone(
  deps: ToolDeps,
  rawArgs: Record<string, unknown>
): Promise<ReviewToolStructuredResultV4> {
  const path = typeof rawArgs.path === 'string' ? rawArgs.path.trim() : ''
  const milestoneTitle = typeof rawArgs.milestoneTitle === 'string' ? rawArgs.milestoneTitle : ''
  const summary = typeof rawArgs.summary === 'string' ? rawArgs.summary : ''

  if (!path) {
    throw new Error('path is required and must be a non-empty string')
  }
  if (!milestoneTitle.trim()) {
    throw new Error('milestoneTitle is required and must be a non-empty string')
  }
  if (!summary.trim()) {
    throw new Error('summary is required and must be a non-empty string')
  }

  assertReviewPathAllowed(deps, path)

  const sessionCheck = ensureMatchingActiveReviewSession(deps.sessionId, path)
  if (sessionCheck.ok === false) {
    throw new Error(sessionCheck.error)
  }

  const target = await resolveTarget(deps, path)

  // 读改写整体进 per-path 写锁：并行子代理不会基于同一份旧盘面互相覆盖
  const next = await withProgressWriteLock(path, async () => {
    const originalContent = normalizeLineEndingsToLF(await readTargetText(deps, target))
    const locale = getCurrentReviewDocumentLocale()
    const result = appendReviewMilestone(originalContent, {
      milestoneId: typeof rawArgs.milestoneId === 'string' ? rawArgs.milestoneId : '',
      milestoneTitle,
      summary,
      status: rawArgs.status === 'completed' ? 'completed' : undefined,
      conclusion: typeof rawArgs.conclusion === 'string' ? rawArgs.conclusion : '',
      evidenceFiles: Array.isArray(rawArgs.evidenceFiles) ? rawArgs.evidenceFiles : [],
      evidence: Array.isArray(rawArgs.evidence) ? rawArgs.evidence : [],
      findings: Array.isArray(rawArgs.findings) ? rawArgs.findings : [],
      structuredFindings: Array.isArray(rawArgs.structuredFindings) ? rawArgs.structuredFindings : [],
      reviewedModules: Array.isArray(rawArgs.reviewedModules) ? rawArgs.reviewedModules : [],
      recommendedNextAction: typeof rawArgs.recommendedNextAction === 'string' ? rawArgs.recommendedNextAction : '',
    }, locale)
    const outcome = await writeTargetText(deps, target, result.content, path)
    return { result, outcome }
  })

  const progressWarnings = await syncProgressFromReviewArtifact(deps, {
    reviewPath: path,
    title: next.result.reviewSnapshot.header.title,
    latestConclusion: next.result.reviewSnapshot.summary.latestConclusion || undefined,
    nextAction: next.result.reviewSnapshot.summary.recommendedNextAction || undefined,
    eventMessage: `同步审查里程碑：${next.result.milestoneId}`,
  })

  const warnings = [...progressWarnings]
  // 与 create 一致：写入意图只 staged（未落盘）时跳过会话状态更新，
  // 会话状态始终反映磁盘真相；保存失败降级为 warnings（非关键步骤）。
  if (!next.outcome.staged) {
    try {
      saveReviewSessionState(deps.sessionId, {
        reviewRunId: next.result.reviewSnapshot.reviewRunId,
        reviewPath: path,
        status: next.result.reviewSnapshot.status,
        createdAt: next.result.reviewSnapshot.createdAt,
        finalizedAt: next.result.reviewSnapshot.finalizedAt,
      })
    } catch (error) {
      warnings.push(`Failed to save review session state: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return projectReviewToolResultData({
    path,
    content: next.result.content,
    delta: {
      type: 'milestone_recorded',
      milestoneId: next.result.milestoneId,
      addedFindingIds: next.result.addedFindingIds,
      changedFields: ['milestones', 'findings', 'summary', 'stats', 'reviewSnapshot', 'reviewSession'],
    },
    extra: {
      ...(buildReviewExtra(warnings, next.outcome) ?? {}),
      milestoneId: next.result.milestoneId,
      findings: next.result.findings,
      structuredFindings: next.result.structuredFindings,
    },
  })
}

export async function executeFinalizeReview(
  deps: ToolDeps,
  rawArgs: Record<string, unknown>
): Promise<ReviewToolStructuredResultV4> {
  const path = typeof rawArgs.path === 'string' ? rawArgs.path.trim() : ''
  const conclusion = typeof rawArgs.conclusion === 'string' ? rawArgs.conclusion : ''

  if (!path) {
    throw new Error('path is required and must be a non-empty string')
  }
  if (!conclusion.trim()) {
    throw new Error('conclusion is required and must be a non-empty string')
  }

  assertReviewPathAllowed(deps, path)

  const sessionCheck = ensureMatchingActiveReviewSession(deps.sessionId, path)
  if (sessionCheck.ok === false) {
    throw new Error(sessionCheck.error)
  }

  const target = await resolveTarget(deps, path)

  // 读改写整体进 per-path 写锁
  const next = await withProgressWriteLock(path, async () => {
    const originalContent = normalizeLineEndingsToLF(await readTargetText(deps, target))
    const locale = getCurrentReviewDocumentLocale()
    const result = finalizeReviewDocument(originalContent, {
      conclusion,
      overallDecision: toOverallDecision(rawArgs.overallDecision),
      recommendedNextAction: typeof rawArgs.recommendedNextAction === 'string' ? rawArgs.recommendedNextAction : '',
      reviewedModules: Array.isArray(rawArgs.reviewedModules) ? rawArgs.reviewedModules : [],
    }, locale)
    const outcome = await writeTargetText(deps, target, result.content, path)
    return { result, outcome }
  })

  const progressWarnings = await syncProgressFromReviewArtifact(deps, {
    reviewPath: path,
    title: next.result.reviewSnapshot.header.title,
    latestConclusion: next.result.reviewSnapshot.summary.latestConclusion || undefined,
    nextAction: next.result.reviewSnapshot.summary.recommendedNextAction || undefined,
    eventMessage: `同步审查结论：${path}`,
  })

  const warnings = [...progressWarnings]
  // 与 create 一致：写入意图只 staged（未落盘）时跳过会话状态更新；
  // 保存失败降级为 warnings（非关键步骤，文档已落盘不阻断主流程）。
  if (!next.outcome.staged) {
    try {
      saveReviewSessionState(deps.sessionId, {
        reviewRunId: next.result.reviewSnapshot.reviewRunId,
        reviewPath: path,
        status: next.result.reviewSnapshot.status,
        createdAt: next.result.reviewSnapshot.createdAt,
        finalizedAt: next.result.reviewSnapshot.finalizedAt,
      })
    } catch (error) {
      warnings.push(`Failed to save review session state: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return projectReviewToolResultData({
    path,
    content: next.result.content,
    delta: {
      type: 'finalized',
      changedFields: ['status', 'overallDecision', 'finalizedAt', 'summary', 'reviewSnapshot', 'reviewSession'],
    },
    extra: {
      ...(buildReviewExtra(warnings, next.outcome) ?? {}),
      findings: next.result.findings,
      structuredFindings: next.result.structuredFindings,
    },
  })
}

export async function executeReopenReview(
  deps: ToolDeps,
  rawArgs: Record<string, unknown>
): Promise<ReviewToolStructuredResultV4> {
  const path = typeof rawArgs.path === 'string' ? rawArgs.path.trim() : ''

  if (!path) {
    throw new Error('path is required and must be a non-empty string')
  }

  assertReviewPathAllowed(deps, path)

  const session = loadReviewSessionState(deps.sessionId)
  if (session?.status === 'in_progress') {
    if (session.reviewPath === path) {
      throw new Error(`The review session is already active for path: ${path}`)
    }
    throw new Error(`Another active review session already exists for this conversation: ${session.reviewPath}`)
  }

  const target = await resolveTarget(deps, path)

  // 读改写整体进 per-path 写锁
  const next = await withProgressWriteLock(path, async () => {
    const originalContent = normalizeLineEndingsToLF(await readTargetText(deps, target))
    const locale = getCurrentReviewDocumentLocale()
    const result = reopenReviewDocument(originalContent, locale)
    const outcome = await writeTargetText(deps, target, result.content, path)
    return { result, outcome }
  })

  const progressWarnings = await syncProgressFromReviewArtifact(deps, {
    reviewPath: path,
    title: next.result.reviewSnapshot.header.title,
    eventMessage: `重新打开审查：${path}`,
  })

  const warnings = [...progressWarnings]
  // 与 create 一致：写入意图只 staged（未落盘）时跳过会话状态更新；
  // 保存失败降级为 warnings（非关键步骤）。
  if (!next.outcome.staged) {
    try {
      saveReviewSessionState(deps.sessionId, {
        reviewRunId: next.result.reviewSnapshot.reviewRunId,
        reviewPath: path,
        status: next.result.reviewSnapshot.status,
        createdAt: next.result.reviewSnapshot.createdAt,
        finalizedAt: next.result.reviewSnapshot.finalizedAt,
      })
    } catch (error) {
      warnings.push(`Failed to save review session state: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return projectReviewToolResultData({
    path,
    content: next.result.content,
    delta: {
      type: 'reopened',
      changedFields: ['status', 'overallDecision', 'finalizedAt', 'reviewSnapshot', 'reviewSession'],
    },
    extra: {
      ...(buildReviewExtra(warnings, next.outcome) ?? {}),
      findings: next.result.findings,
      structuredFindings: next.result.structuredFindings,
    },
  })
}

export async function executeValidateReviewDocument(
  deps: ToolDeps,
  rawArgs: Record<string, unknown>
): Promise<ValidateReviewDocumentToolResult> {
  const path = typeof rawArgs.path === 'string' ? rawArgs.path.trim() : ''

  if (!path) {
    throw new Error('path is required and must be a non-empty string')
  }

  assertReviewPathAllowed(deps, path)

  const target = await resolveTarget(deps, path)
  if (!(await targetExists(deps, target))) {
    throw new Error(`Review document does not exist: ${path}`)
  }
  const content = normalizeLineEndingsToLF(await readTargetText(deps, target))
  const validation = validateReviewDocument(content)
  let summary: ReturnType<typeof summarizeReviewDocument> | undefined

  try {
    if (validation.detectedFormat !== 'unknown') {
      summary = summarizeReviewDocument(content)
    }
  } catch {
    summary = undefined
  }

  const reviewValidation = buildReviewValidationSummaryFromResult(validation)

  return {
    path,
    ...validation,
    reviewSnapshot: validation.reviewSnapshot,
    reviewValidation,
    reviewDelta: {
      type: 'validated',
      changedFields: [],
    },
    metadata: validation.metadata,
    title: summary?.title,
    date: summary?.date,
    status: summary?.status,
    currentStatus: summary?.status,
    overallDecision: summary?.overallDecision,
    milestoneCount: summary?.totalMilestones,
    totalMilestones: summary?.totalMilestones,
    completedMilestones: summary?.completedMilestones,
    currentProgress: summary?.currentProgress,
    totalFindings: summary?.totalFindings,
    findingsBySeverity: summary?.findingsBySeverity,
    latestConclusion: summary?.latestConclusion,
    recommendedNextAction: summary?.recommendedNextAction,
    reviewedModules: summary?.reviewedModules,
    issueCount: reviewValidation.issueCount,
    errorCount: reviewValidation.errorCount,
    warningCount: reviewValidation.warningCount,
  }
}

function normalizeComparableText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function normalizeEvidenceKey(ref: ReviewEvidenceRef): string {
  return [
    normalizeComparableText(ref.path),
    ref.lineStart ?? '',
    ref.lineEnd ?? '',
    normalizeComparableText(ref.symbol),
    normalizeComparableText(ref.excerptHash),
  ].join('|')
}

function sortUnique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort()
}

/**
 * finding 匹配 key：稳定身份 = category + title + severity（归一化后哈希）。
 *
 * severity 参与 key：同标题同类别但不同 severity 的是两个独立 finding（与领域层
 * getFindingMergeKey 的 severity|category|title 口径一致）；修复前只取 category+title
 * 时两者在 baseMap/targetMap 中互相覆盖，比较结果静默丢失其中一个。
 * description / evidence / recommendation / trackingStatus / relatedMilestoneIds
 * 等易变字段仍不参与 key——它们的变化走 persisted 分支的 changes 列表。
 */
function hashFindingKey(finding: { category: string; title: string; severity: string }): string {
  const payload = [
    normalizeComparableText(finding.category),
    normalizeComparableText(finding.title),
    normalizeComparableText(finding.severity),
  ].join('||')

  return `finding:${createHash('sha256').update(payload, 'utf8').digest('hex')}`
}

export async function executeCompareReviewDocuments(
  deps: ToolDeps,
  rawArgs: Record<string, unknown>
): Promise<CompareReviewDocumentsToolResult> {
  const basePath = typeof rawArgs.basePath === 'string' ? rawArgs.basePath.trim() : ''
  const targetPath = typeof rawArgs.targetPath === 'string' ? rawArgs.targetPath.trim() : ''
  const includeUnchanged = rawArgs.includeUnchanged === true

  if (!basePath || !targetPath) {
    throw new Error('basePath and targetPath are required and must be non-empty strings')
  }

  if (
    !isProgressArtifactPathAllowedWithMultiRoot('review', basePath, deps) ||
    !isProgressArtifactPathAllowedWithMultiRoot('review', targetPath, deps)
  ) {
    throw new Error(buildPathReceivedError('review', REVIEW_PATH_SCOPE_LABEL, `${basePath}, ${targetPath}`))
  }

  const baseTarget = await resolveTarget(deps, basePath)
  const target = await resolveTarget(deps, targetPath)
  const [baseContent, targetContent] = await Promise.all([
    readTargetText(deps, baseTarget),
    readTargetText(deps, target),
  ])

  const baseValidation = validateReviewDocument(normalizeLineEndingsToLF(baseContent))
  const targetValidation = validateReviewDocument(normalizeLineEndingsToLF(targetContent))
  const baseSnapshot = baseValidation.reviewSnapshot
  const targetSnapshot = targetValidation.reviewSnapshot

  if (!baseSnapshot || !targetSnapshot) {
    throw new Error('Both review documents must be parseable as recognized review formats before comparison.')
  }

  const baseFindings = baseSnapshot.findings.map((item) => ({
    key: hashFindingKey(item),
    id: item.id,
    title: item.title,
    severity: item.severity,
    category: item.category,
    trackingStatus: item.trackingStatus,
    descriptionMarkdown: item.descriptionMarkdown,
    recommendationMarkdown: item.recommendationMarkdown,
    relatedMilestoneIds: [...item.relatedMilestoneIds],
    evidence: [...item.evidence],
  }))
  const targetFindings = targetSnapshot.findings.map((item) => ({
    key: hashFindingKey(item),
    id: item.id,
    title: item.title,
    severity: item.severity,
    category: item.category,
    trackingStatus: item.trackingStatus,
    descriptionMarkdown: item.descriptionMarkdown,
    recommendationMarkdown: item.recommendationMarkdown,
    relatedMilestoneIds: [...item.relatedMilestoneIds],
    evidence: [...item.evidence],
  }))
  const baseMap = new Map(baseFindings.map((item) => [item.key, item]))
  const targetMap = new Map(targetFindings.map((item) => [item.key, item]))

  const added: typeof targetFindings = []
  const removed: typeof baseFindings = []
  const persisted: Array<{ key: string; base: typeof baseFindings[number]; target: typeof targetFindings[number]; changes: string[] }> = []

  for (const targetItem of targetFindings) {
    const baseItem = baseMap.get(targetItem.key)
    if (!baseItem) {
      added.push(targetItem)
      continue
    }

    const changes: string[] = []
    if (baseItem.severity !== targetItem.severity) changes.push('severity')
    if (baseItem.trackingStatus !== targetItem.trackingStatus) changes.push('trackingStatus')
    if (normalizeComparableText(baseItem.descriptionMarkdown) !== normalizeComparableText(targetItem.descriptionMarkdown)) changes.push('description')
    if (normalizeComparableText(baseItem.recommendationMarkdown) !== normalizeComparableText(targetItem.recommendationMarkdown)) changes.push('recommendation')

    const baseEvidence = sortUnique(baseItem.evidence.map((item) => normalizeEvidenceKey(item)))
    const targetEvidence = sortUnique(targetItem.evidence.map((item) => normalizeEvidenceKey(item)))
    if (baseEvidence.join('||') !== targetEvidence.join('||')) changes.push('evidence')

    const baseMilestones = sortUnique(baseItem.relatedMilestoneIds)
    const targetMilestones = sortUnique(targetItem.relatedMilestoneIds)
    if (baseMilestones.join('||') !== targetMilestones.join('||')) changes.push('relatedMilestoneIds')

    if (includeUnchanged || changes.length > 0) {
      persisted.push({ key: targetItem.key, base: baseItem, target: targetItem, changes })
    }
  }

  for (const baseItem of baseFindings) {
    if (!targetMap.has(baseItem.key)) {
      removed.push(baseItem)
    }
  }

  const allPersistedCount = targetFindings.filter((item) => baseMap.has(item.key)).length

  const statsDelta = {
    totalMilestones: { base: baseSnapshot.stats.totalMilestones, target: targetSnapshot.stats.totalMilestones },
    completedMilestones: { base: baseSnapshot.stats.completedMilestones, target: targetSnapshot.stats.completedMilestones },
    totalFindings: { base: baseSnapshot.stats.totalFindings, target: targetSnapshot.stats.totalFindings },
    severity: {
      high: { base: baseSnapshot.stats.severity.high, target: targetSnapshot.stats.severity.high },
      medium: { base: baseSnapshot.stats.severity.medium, target: targetSnapshot.stats.severity.medium },
      low: { base: baseSnapshot.stats.severity.low, target: targetSnapshot.stats.severity.low },
    },
  }

  return {
    base: {
      path: basePath,
      reviewRunId: baseSnapshot.reviewRunId,
      generatedAt: baseSnapshot.render.generatedAt,
      locale: baseSnapshot.render.locale,
      title: baseSnapshot.header.title,
      date: baseSnapshot.header.date,
      status: baseSnapshot.status,
      overallDecision: baseSnapshot.overallDecision,
    },
    target: {
      path: targetPath,
      reviewRunId: targetSnapshot.reviewRunId,
      generatedAt: targetSnapshot.render.generatedAt,
      locale: targetSnapshot.render.locale,
      title: targetSnapshot.header.title,
      date: targetSnapshot.header.date,
      status: targetSnapshot.status,
      overallDecision: targetSnapshot.overallDecision,
    },
    summary: {
      addedFindings: added.length,
      removedFindings: removed.length,
      persistedFindings: allPersistedCount,
      severityChanged: persisted.filter((item) => item.changes.includes('severity')).length,
      trackingChanged: persisted.filter((item) => item.changes.includes('trackingStatus')).length,
      evidenceChanged: persisted.filter((item) => item.changes.includes('evidence')).length,
      relatedMilestoneChanged: persisted.filter((item) => item.changes.includes('relatedMilestoneIds')).length,
    },
    findings: {
      added,
      removed,
      persisted,
    },
    statsDelta,
    baseValidation: buildReviewValidationSummaryFromResult(baseValidation),
    targetValidation: buildReviewValidationSummaryFromResult(targetValidation),
  }
}

export function createCreateReviewTool(fs: FileSystem) {
  return defineTool({
    name: 'create_review',
    description:
      'Create a review document (markdown) and write it under .graycode/review/**.md. This tool is for Review mode and must not modify business code.',
    parameters: {
      title: { type: 'string', description: 'Optional review title (used for default filename)' },
      overview: { type: 'string', description: 'Optional one-line review overview' },
      review: { type: 'string', required: true, description: 'Initial review content in markdown' },
      path: {
        type: 'string',
        description:
          'Optional output path. Must be under .graycode/review/**.md (or workspace/.graycode/review/**.md).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: renderToolResult,
    },
    async execute(args, exec) {
      return executeCreateReview(depsFromExec(fs, exec, exec.signal), args as Record<string, unknown>) as never
    },
  })
}

export function createRecordReviewMilestoneTool(fs: FileSystem) {
  return defineTool({
    name: 'record_review_milestone',
    description:
      'Append a milestone to an existing review document under .graycode/review/**.md and update the structured summary sections.',
    parameters: {
      path: { type: 'string', required: true, description: 'Target review document path under .graycode/review/**.md' },
      milestoneId: { type: 'string', description: 'Optional milestone identifier. If omitted, it is generated automatically.' },
      milestoneTitle: { type: 'string', required: true, description: 'Milestone title' },
      summary: { type: 'string', required: true, description: 'Milestone summary in markdown' },
      status: { type: 'string', enum: ['in_progress', 'completed'], description: 'Milestone status' },
      conclusion: { type: 'string', description: 'Optional latest conclusion for the summary section' },
      evidenceFiles: {
        type: 'array',
        description: 'Optional related evidence file paths. Use this for simple file-level evidence when line-level references are not available.',
        items: { type: 'string' },
      },
      evidence: {
        type: 'array',
        description: 'Optional structured evidence references with file path and optional line or symbol details.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            lineStart: { type: 'integer' },
            lineEnd: { type: 'integer' },
            symbol: { type: 'string' },
            excerptHash: { type: 'string' },
          },
        },
      },
      findings: {
        type: 'array',
        description: 'Optional legacy finding strings to merge into the review findings section',
        items: { type: 'string' },
      },
      structuredFindings: {
        type: 'array',
        description: 'Optional structured findings to merge into the review findings section. Keep title concise, and put detailed explanation into description.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Optional short stable finding identifier. Omit it if you do not already have a concise id.' },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            category: {
              type: 'string',
              enum: ['html', 'css', 'javascript', 'accessibility', 'performance', 'maintainability', 'docs', 'test', 'other'],
            },
            title: { type: 'string', required: true, description: 'Short finding title. Use a concise issue label, not a full sentence, file path, or recommendation.' },
            description: { type: 'string', description: 'Detailed explanation of the finding. Put reasoning, impact, and context here.' },
            evidenceFiles: { type: 'array', description: 'Optional simple evidence file paths for this finding.', items: { type: 'string' } },
            evidence: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  lineStart: { type: 'integer' },
                  lineEnd: { type: 'integer' },
                  symbol: { type: 'string' },
                  excerptHash: { type: 'string' },
                },
              },
            },
            relatedMilestoneIds: { type: 'array', description: 'Optional related milestone ids for cross-reference.', items: { type: 'string' } },
            recommendation: { type: 'string', description: 'Optional follow-up recommendation for fixing or handling the finding.' },
            trackingStatus: { type: 'string', enum: ['open', 'accepted_risk', 'fixed', 'wont_fix', 'duplicate'] },
          },
        },
      },
      reviewedModules: {
        type: 'array',
        description: 'Optional reviewed modules to merge into the review summary section',
        items: { type: 'string' },
      },
      recommendedNextAction: {
        type: 'string',
        description: 'Optional recommended next action for the review summary section',
      },
    },
    output: {
      schema: { type: 'json' },
      render: renderToolResult,
    },
    async execute(args, exec) {
      return executeRecordReviewMilestone(depsFromExec(fs, exec, exec.signal), args as Record<string, unknown>) as never
    },
  })
}

export function createFinalizeReviewTool(fs: FileSystem) {
  return defineTool({
    name: 'finalize_review',
    description:
      'Finalize an existing review document under .graycode/review/**.md, normalize its structure, and update the final review summary.',
    parameters: {
      path: { type: 'string', required: true, description: 'Target review document path under .graycode/review/**.md' },
      conclusion: { type: 'string', required: true, description: 'Final review conclusion' },
      overallDecision: {
        type: 'string',
        enum: ['accepted', 'conditionally_accepted', 'rejected', 'needs_follow_up'],
        description: 'Optional overall review decision',
      },
      recommendedNextAction: {
        type: 'string',
        description: 'Optional recommended next action for the summary section',
      },
      reviewedModules: {
        type: 'array',
        description: 'Optional reviewed modules to merge into the summary section',
        items: { type: 'string' },
      },
    },
    output: {
      schema: { type: 'json' },
      render: renderToolResult,
    },
    async execute(args, exec) {
      return executeFinalizeReview(depsFromExec(fs, exec, exec.signal), args as Record<string, unknown>) as never
    },
  })
}

export function createReopenReviewTool(fs: FileSystem) {
  return defineTool({
    name: 'reopen_review',
    description:
      'Reopen a finalized review document under .graycode/review/**.md so the same review run can continue recording milestones.',
    parameters: {
      path: { type: 'string', required: true, description: 'Target finalized review document path under .graycode/review/**.md' },
    },
    output: {
      schema: { type: 'json' },
      render: renderToolResult,
    },
    async execute(args, exec) {
      return executeReopenReview(depsFromExec(fs, exec, exec.signal), args as Record<string, unknown>) as never
    },
  })
}

export function createValidateReviewDocumentTool(fs: FileSystem) {
  return defineTool({
    name: 'validate_review_document',
    description:
      'Validate an existing review document under .graycode/review/**.md without modifying it. Reports format, metadata health, and invariant issues.',
    parameters: {
      path: { type: 'string', required: true, description: 'Target review document path under .graycode/review/**.md' },
    },
    output: {
      schema: { type: 'json' },
      render: renderToolResult,
    },
    async execute(args, exec) {
      return executeValidateReviewDocument(depsFromExec(fs, exec, exec.signal), args as Record<string, unknown>) as never
    },
  })
}

export function createCompareReviewDocumentsTool(fs: FileSystem) {
  return defineTool({
    name: 'compare_review_documents',
    description:
      'Compare two review documents under .graycode/review/**.md without modifying them. Returns finding deltas, tracking changes, and snapshot statistics differences.',
    parameters: {
      basePath: { type: 'string', required: true, description: 'Base review document path under .graycode/review/**.md' },
      targetPath: { type: 'string', required: true, description: 'Target review document path under .graycode/review/**.md' },
      includeUnchanged: { type: 'boolean', description: 'Whether to include unchanged persisted findings in the result' },
    },
    output: {
      schema: { type: 'json' },
      render: renderToolResult,
    },
    async execute(args, exec) {
      return executeCompareReviewDocuments(depsFromExec(fs, exec, exec.signal), args as Record<string, unknown>) as never
    },
  })
}
