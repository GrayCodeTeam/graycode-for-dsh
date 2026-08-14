/**
 * workflows 工具共享层：workspace 解析、文档路径策略、fs 读写辅助。
 *
 * DSH 单工作区模型：workspace = 执行会话的 `exec.agent.session.header.cwd`
 * （可为 undefined，回退 process.cwd()）。文档根 = `<workspace>/.graycode/`。
 * 路径白名单语义与 GrayCode 一致（modeToolsPolicy），并保留 multi-root 形式的
 * `workspaceName/.graycode/...` 前缀支持（首段与 workspace 目录名一致时剥离后判定）。
 */

import * as path from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import {
  isDesignPathAllowed,
  isPlanPathAllowed,
  isProgressPathAllowed,
  isReviewPathAllowed,
} from './domain/modeToolsPolicy.ts'
import type { ProgressArtifactRef } from './domain/progress/schema.ts'
import { normalizeLineEndingsToLF } from './domain/shared/textUtils.ts'
import { getStagedWriteHook } from './stagedWriteHook.ts'

/** 各文档域的路径白名单 scope 文案（错误消息使用，与源逐字一致） */
export const DESIGN_PATH_SCOPE_LABEL = '.graycode/design/**.md'
export const PLAN_PATH_SCOPE_LABEL = '.graycode/plans/**.md'
export const REVIEW_PATH_SCOPE_LABEL = '.graycode/review/**.md'
export const PROGRESS_PATH_SCOPE_LABEL = '.graycode/progress.md'

export const DEFAULT_PROGRESS_PATH = '.graycode/progress.md'

/** 构建路径拒绝错误文案（"Rejected path" 变体，与源逐字一致） */
export function buildPathRejectedError(kind: string, scopeLabel: string, rejectedPath: string): string {
  return `Invalid ${kind} path. Only "${scopeLabel}" is allowed. Rejected path: ${rejectedPath}`
}

/** 构建路径错误文案（"Received" 变体，compare_review_documents 使用，与源逐字一致） */
export function buildPathReceivedError(kind: string, scopeLabel: string, received: string): string {
  return `Invalid ${kind} path. Only "${scopeLabel}" is allowed. Received: ${received}`
}

/** 工具共享依赖：fs 实现 + 工作区 cwd + 会话 id（review 会话门闸用） */
export interface ToolDeps {
  fs: FileSystem
  /** 工作区绝对路径（session cwd，回退 process.cwd()） */
  cwd: string
  /** 当前会话 id（exec.agent.session.header.id）；无 agent 时 undefined */
  sessionId?: string
  /** 取消信号 */
  signal?: AbortSignal
}

/** 从执行会话构造工具依赖 */
export function depsFromExec(fsService: FileSystem, exec: { agent?: { session?: { header?: { cwd?: string; id?: { toString(): string } } } } } | undefined, signal?: AbortSignal): ToolDeps {
  const header = exec?.agent?.session?.header
  return {
    fs: fsService,
    cwd: header?.cwd || process.cwd(),
    sessionId: header?.id ? String(header.id) : undefined,
    signal,
  }
}

/** 获取工作区显示名（progress create 默认 projectName，等价于源 getAllWorkspaces()[0].name） */
export function getWorkspaceDisplayName(deps: ToolDeps): string | undefined {
  const name = path.basename(deps.cwd)
  return name && name.trim() ? name.trim() : undefined
}

/**
 * 多工作区（multi-root）形式路径白名单校验（DSH 单工作区变体）。
 * 与源 isScopedPathAllowedWithMultiRoot 语义一致：先直接交给 validator；
 * 首段为 workspace 目录名时剥离后再次判定（等价于单工作区下显式工作区前缀）。
 */
function isScopedPathAllowedWithMultiRoot(
  pathStr: string,
  validator: (path: string) => boolean,
  deps: ToolDeps
): boolean {
  if (validator(pathStr)) return true

  const normalized = (pathStr || '').replace(/\\/g, '/')
  const slashIndex = normalized.indexOf('/')
  if (slashIndex <= 0) return false

  const workspacePrefix = normalized.slice(0, slashIndex)
  if (workspacePrefix === '.' || workspacePrefix === '..') return false
  if (workspacePrefix.includes(':')) return false
  if (workspacePrefix !== path.basename(deps.cwd)) return false

  return validator(normalized.slice(slashIndex + 1))
}

export function isDesignModePathAllowedWithMultiRoot(pathStr: string, deps: ToolDeps): boolean {
  return isScopedPathAllowedWithMultiRoot(pathStr, isDesignPathAllowed, deps)
}

export function isProgressModePathAllowedWithMultiRoot(pathStr: string, deps: ToolDeps): boolean {
  return isScopedPathAllowedWithMultiRoot(pathStr, isProgressPathAllowed, deps)
}

export const PROGRESS_ARTIFACT_KEYS = ['design', 'plan', 'review'] as const
export type ProgressArtifactKey = typeof PROGRESS_ARTIFACT_KEYS[number]

function getArtifactPathValidator(kind: ProgressArtifactKey): (path: string) => boolean {
  if (kind === 'design') return isDesignPathAllowed
  if (kind === 'plan') return isPlanPathAllowed
  return isReviewPathAllowed
}

function getArtifactScopeLabel(kind: ProgressArtifactKey): string {
  if (kind === 'design') return DESIGN_PATH_SCOPE_LABEL
  if (kind === 'plan') return PLAN_PATH_SCOPE_LABEL
  return REVIEW_PATH_SCOPE_LABEL
}

export function isProgressArtifactPathAllowedWithMultiRoot(
  kind: ProgressArtifactKey,
  pathStr: string,
  deps: ToolDeps
): boolean {
  return isScopedPathAllowedWithMultiRoot(pathStr, getArtifactPathValidator(kind), deps)
}

export function validateProgressArtifactRefInput(
  value: unknown,
  options: {
    fieldName?: string
    allowEmptyString?: boolean
  } = {},
  deps: ToolDeps
): string | null {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return `${options.fieldName || 'artifactRef'} must be an object`
  }

  const allowEmptyString = options.allowEmptyString ?? true
  for (const key of PROGRESS_ARTIFACT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue

    const rawValue = (value as Record<string, unknown>)[key]
    if (typeof rawValue !== 'string') {
      return `${options.fieldName || 'artifactRef'}.${key} must be a string`
    }

    const normalized = rawValue.trim()
    if (!normalized) {
      if (allowEmptyString) continue
      return `${options.fieldName || 'artifactRef'}.${key} must be a non-empty string`
    }

    if (!isProgressArtifactPathAllowedWithMultiRoot(key, normalized, deps)) {
      return `${options.fieldName || 'artifactRef'}.${key} must point to ${getArtifactScopeLabel(key)}`
    }
  }

  return null
}

export function normalizeProgressArtifactRef(value: unknown): ProgressArtifactRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const next: ProgressArtifactRef = {}
  for (const key of PROGRESS_ARTIFACT_KEYS) {
    const rawValue = (value as Record<string, unknown>)[key]
    if (typeof rawValue !== 'string') continue
    const normalized = rawValue.trim()
    if (!normalized) continue
    next[key] = normalized
  }

  return next
}

export function applyProgressArtifactPatch(
  current: ProgressArtifactRef,
  patch: unknown
): ProgressArtifactRef {
  const next: ProgressArtifactRef = { ...current }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return next
  }

  for (const key of PROGRESS_ARTIFACT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue

    const rawValue = (patch as Record<string, unknown>)[key]
    const normalized = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (!normalized) {
      delete next[key]
      continue
    }

    next[key] = normalized
  }

  return next
}

/** 解析工作区内相对路径为 FsTarget（相对 cwd） */
export function resolveTarget(deps: ToolDeps, relPath: string): Promise<FsTarget> {
  return deps.fs.resolve(relPath, { cwd: deps.cwd, signal: deps.signal })
}

/** 目标是否存在（stat 返回 undefined = 不存在；不要用 ENOENT 判断） */
export async function targetExists(deps: ToolDeps, target: FsTarget): Promise<boolean> {
  const info = await deps.fs.stat(target, deps.signal)
  return info !== undefined
}

/** 读取目标文本（文件不存在或 IO 失败时抛错） */
export async function readTargetText(deps: ToolDeps, target: FsTarget): Promise<string> {
  return deps.fs.readText(target, deps.signal)
}

/**
 * 读取目标当前文本（best-effort）：目标不存在或 IO 失败返回 null（不抛错）。
 * 供 staged 条目的 `before` 快照使用（FsWriteOutcome.before 语义）。
 */
export async function readTargetTextOrNull(deps: ToolDeps, target: FsTarget): Promise<string | null> {
  try {
    const info = await deps.fs.stat(target, deps.signal)
    if (info === undefined) return null
    return await deps.fs.readText(target, deps.signal)
  } catch {
    return null
  }
}

/** 一次文档写入的结果 */
export interface WriteTargetOutcome {
  /** true = 写入意图已变成 staged 条目（未落盘，待接受）；false = 已直接落盘 */
  staged: boolean
  /** staged 时：条目 id（供 staged_diff_accept / staged_diff_reject 使用） */
  stagedEntryId?: string
  /** 非阻断性警告（如 staging 失败回退直接落盘） */
  warnings?: string[]
}

/**
 * 写入目标文本：内容归一化 LF 后写入。
 *
 * staged-diff 适配（ADR-0003 §6 后续动作 2）：当写前钩子已安装且 enabled 时，把
 * 写入意图先变成 staged 条目（绝不提前写 workspace），用户接受后才落盘；否则直接
 * 经 ctx.fs 落盘（默认行为，与现状完全一致）。relPath 为 workspace 相对路径
 * （staged 条目的 path 字段），缺省时即使钩子存在也不接管（回退直接落盘）。
 *
 * staging 失败（存储/校验等）不阻断主流程：回退直接落盘并在结果中以 warnings 上报。
 *
 * 不在此处用 node:fs 直接 mkdir 父目录：dsh-fs-local 的 writeFileAtomic 内置
 * recursive mkdir（自动建父目录），且 node:fs 直写会绕过 fs 后端的权限/审批/沙箱层
 * （PLAN_V2 §6.2：文件写入经 ctx.fs）。父目录自动创建由 fs 后端保证。
 */
export async function writeTargetText(
  deps: ToolDeps,
  target: FsTarget,
  content: string,
  relPath?: string
): Promise<WriteTargetOutcome> {
  const normalized = normalizeLineEndingsToLF(content)
  const hook = getStagedWriteHook()
  if (hook && hook.enabled && relPath) {
    try {
      const before = await readTargetTextOrNull(deps, target)
      const { entryId } = await hook.stageWrite({
        relPath,
        content: normalized,
        before,
        cwd: deps.cwd,
        sessionId: deps.sessionId,
      })
      return { staged: true, stagedEntryId: entryId }
    } catch (error) {
      // best-effort：staging 失败不阻断主文档流程，回退直接落盘并上报 warning
      await deps.fs.writeText(target, normalized, undefined, deps.signal)
      return {
        staged: false,
        warnings: [
          `Failed to stage write for ${relPath}; wrote directly instead: ${error instanceof Error ? error.message : String(error)}`,
        ],
      }
    }
  }
  await deps.fs.writeText(target, normalized, undefined, deps.signal)
  return { staged: false }
}
