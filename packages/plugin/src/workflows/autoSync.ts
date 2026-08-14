/**
 * Progress 自动联动辅助（审计项 W-M1 恢复；旧语义参考 A:/api/Gray-Code-main/
 * backend/tools/progress/autoSync.ts）
 *
 * 在 design / review 文档写入后，best-effort 同步 `.graycode/progress.md`：
 * - 创建/追加 `artifact_changed` 日志、更新 activeArtifacts、缺失时初始化进度文档
 *   （design → phase 'design'；review → phase 'review'）；
 * - 同步失败只返回 warning 字符串数组，绝不阻断主工具成功；
 * - 读改写整体进 per-path 写锁（withProgressWriteLock），并行子代理不会互相覆盖。
 *
 * DSH 差异：
 * - 依赖经 ToolDeps 注入（fs/cwd/sessionId），不再依赖 vscode workspace API；
 * - 落盘仍走 workspace.ts writeTargetText：staged-diff enabled 时同步写同样先变成
 *   staged 条目（与主文档一致，接受后才落盘），否则直接落盘。
 */

import type { ProgressDocumentMetadataV1 } from './domain/progress/schema.ts'
import { buildProgressDocument, validateProgressDocument } from './domain/progress/documentLayout.ts'
import { withProgressWriteLock } from './domain/progress/progressWriteLock.ts'
import { slugify } from './domain/shared/slugify.ts'
import { normalizeSingleLineText } from './domain/shared/textUtils.ts'
import {
  DEFAULT_PROGRESS_PATH,
  PROGRESS_PATH_SCOPE_LABEL,
  buildPathRejectedError,
  getWorkspaceDisplayName,
  isProgressModePathAllowedWithMultiRoot,
  readTargetText,
  resolveTarget,
  targetExists,
  writeTargetText,
  type ToolDeps,
} from './workspace.ts'

export interface SyncProgressFromDesignArtifactArgs {
  designPath: string
  title?: string
}

export interface SyncProgressFromReviewArtifactArgs {
  reviewPath: string
  title?: string
  latestConclusion?: string
  nextAction?: string
  eventMessage?: string
}

/** 由工件路径推导 progress 路径（保留 multi-root 前缀语义，与旧 autoSync 一致） */
function resolveProgressPathForArtifact(artifactPath: string): string {
  const normalized = (artifactPath || '').replace(/\\/g, '/')
  const slashIndex = normalized.indexOf('/')
  if (slashIndex > 0) {
    const workspacePrefix = normalized.slice(0, slashIndex)
    const rest = normalized.slice(slashIndex + 1)
    if (
      workspacePrefix !== '.' &&
      workspacePrefix !== '..' &&
      !workspacePrefix.includes(':') &&
      rest.startsWith('.graycode/')
    ) {
      return `${workspacePrefix}/.graycode/progress.md`
    }
  }
  return DEFAULT_PROGRESS_PATH
}

async function loadExistingProgress(
  deps: ToolDeps,
  progressPath: string
): Promise<{
  metadata?: ProgressDocumentMetadataV1
  missing: boolean
  error?: string
}> {
  const target = await resolveTarget(deps, progressPath)
  try {
    if (!(await targetExists(deps, target))) {
      return { missing: true }
    }
    const content = await readTargetText(deps, target)
    const validation = validateProgressDocument(content)
    if (!validation.success) {
      return { missing: false, error: 'error' in validation ? validation.error : 'Failed to validate progress document' }
    }
    return { metadata: validation.metadata, missing: false }
  } catch (error) {
    return { missing: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function writeProgress(
  deps: ToolDeps,
  progressPath: string,
  metadata: Partial<ProgressDocumentMetadataV1>,
  now: string
): Promise<void> {
  if (!isProgressModePathAllowedWithMultiRoot(progressPath, deps)) {
    throw new Error(buildPathRejectedError('progress', PROGRESS_PATH_SCOPE_LABEL, progressPath))
  }
  const target = await resolveTarget(deps, progressPath)
  const { content } = buildProgressDocument(metadata, { generatedAt: now })
  await writeTargetText(deps, target, content, progressPath)
}

function buildInitialProgressMetadata(
  deps: ToolDeps,
  now: string,
  progressPath: string
): Partial<ProgressDocumentMetadataV1> {
  const projectName = getWorkspaceDisplayName(deps)
  return {
    projectId: slugify(projectName || progressPath, 'project'),
    projectName,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    phase: 'design',
    activeArtifacts: {},
    todos: [],
    milestones: [],
    risks: [],
    log: [{
      at: now,
      type: 'created',
      message: '初始化项目进度',
    }],
  }
}

/** design 文档写入后的 best-effort 进度同步（失败返回 warning，不抛错） */
export async function syncProgressFromDesignArtifact(
  deps: ToolDeps,
  args: SyncProgressFromDesignArtifactArgs
): Promise<string[]> {
  const designPath = normalizeSingleLineText(args.designPath)
  if (!designPath) return []

  const progressPath = resolveProgressPathForArtifact(designPath)

  try {
    return await withProgressWriteLock(progressPath, async () => {
      const now = new Date().toISOString()
      const loaded = await loadExistingProgress(deps, progressPath)
      if (loaded.error) {
        return [`Failed to auto-sync progress after design write: ${loaded.error}`]
      }

      const base = loaded.missing || !loaded.metadata
        ? buildInitialProgressMetadata(deps, now, progressPath)
        : loaded.metadata

      const nextMetadata: Partial<ProgressDocumentMetadataV1> = {
        ...base,
        updatedAt: now,
        phase: loaded.missing ? 'design' : base.phase,
        currentFocus: loaded.missing && normalizeSingleLineText(args.title)
          ? normalizeSingleLineText(args.title)
          : base.currentFocus,
        activeArtifacts: {
          ...(base.activeArtifacts || {}),
          design: designPath,
        },
        log: [
          ...(base.log || []),
          {
            at: now,
            type: 'artifact_changed',
            refId: 'design',
            message: `同步设计文档：${designPath}`,
          },
        ],
      }

      await writeProgress(deps, progressPath, nextMetadata, now)
      return []
    })
  } catch (error) {
    return [`Failed to auto-sync progress after design write: ${error instanceof Error ? error.message : String(error)}`]
  }
}

/** review 文档写入后的 best-effort 进度同步（失败返回 warning，不抛错） */
export async function syncProgressFromReviewArtifact(
  deps: ToolDeps,
  args: SyncProgressFromReviewArtifactArgs
): Promise<string[]> {
  const reviewPath = normalizeSingleLineText(args.reviewPath)
  if (!reviewPath) return []

  const progressPath = resolveProgressPathForArtifact(reviewPath)

  try {
    return await withProgressWriteLock(progressPath, async () => {
      const now = new Date().toISOString()
      const loaded = await loadExistingProgress(deps, progressPath)
      if (loaded.error) {
        return [`Failed to auto-sync progress after review write: ${loaded.error}`]
      }

      const base = loaded.missing || !loaded.metadata
        ? {
          ...buildInitialProgressMetadata(deps, now, progressPath),
          phase: 'review' as const,
        }
        : loaded.metadata

      const nextMetadata: Partial<ProgressDocumentMetadataV1> = {
        ...base,
        updatedAt: now,
        phase: loaded.missing ? 'review' : base.phase,
        currentFocus: !base.currentFocus && normalizeSingleLineText(args.title)
          ? normalizeSingleLineText(args.title)
          : base.currentFocus,
        latestConclusion: normalizeSingleLineText(args.latestConclusion) || base.latestConclusion,
        nextAction: normalizeSingleLineText(args.nextAction) || base.nextAction,
        activeArtifacts: {
          ...(base.activeArtifacts || {}),
          review: reviewPath,
        },
        log: [
          ...(base.log || []),
          {
            at: now,
            type: 'artifact_changed',
            refId: 'review',
            message: args.eventMessage || `同步审查文档：${reviewPath}`,
          },
        ],
      }

      await writeProgress(deps, progressPath, nextMetadata, now)
      return []
    })
  } catch (error) {
    return [`Failed to auto-sync progress after review write: ${error instanceof Error ? error.message : String(error)}`]
  }
}
