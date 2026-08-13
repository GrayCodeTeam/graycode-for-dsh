/**
 * workflows 工具共享层：workspace 解析、文档路径策略、fs 读写辅助。
 *
 * DSH 单工作区模型：workspace = 执行会话的 `exec.agent.session.header.cwd`
 * （可为 undefined，回退 process.cwd()）。文档根 = `<workspace>/.graycode/`。
 * 路径白名单语义与 GrayCode 一致（modeToolsPolicy），并保留 multi-root 形式的
 * `workspaceName/.graycode/...` 前缀支持（首段与 workspace 目录名一致时剥离后判定）。
 */

import * as fs from 'node:fs/promises'
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

/**
 * 递归创建父目录。工作区路径在沙箱内，仅此用途；
 * ctx.fs.writeText 的 createIfAbsent 是否自动建目录不确定，写前统一显式 mkdir。
 */
export async function ensureParentDir(processPath: string): Promise<void> {
  const dir = path.dirname(processPath)
  await fs.mkdir(dir, { recursive: true })
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

/** 写入目标文本：先 mkdir 父目录，内容归一化 LF 后写入 */
export async function writeTargetText(deps: ToolDeps, target: FsTarget, content: string): Promise<void> {
  const processPath = deps.fs.processPath(target)
  await ensureParentDir(processPath)
  await deps.fs.writeText(target, normalizeLineEndingsToLF(content), undefined, deps.signal)
}
