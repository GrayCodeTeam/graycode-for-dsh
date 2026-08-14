/**
 * GrayCode - migration 工作区记忆 scope 映射（纯函数，D-1/D-4/D-5 决策）
 *
 * 旧 Gray 的 workspace-scope 记忆（memory-workspaces/<hash>/scope.json）在
 * DSH 侧按路径哈希重建工作区记忆目录。默认自动映射（用 scope.json 的
 * fsPath），但路径漂移（项目移动/大小写）会把记忆写进用户取不到的 scope。
 *
 * 本模块产出「映射建议表」（scan/apply 报告 + Remote 端点消费），并定义
 * 用户覆盖（scopeOverrides）的解析规则：
 * - 未覆盖：沿用 scope.json 的 fsPath（现状，自动映射）；
 * - `global`：该工作区记忆降级写入 DSH 全局记忆；
 * - 绝对路径：显式指定目标工作区路径（写进该路径哈希出的工作区记忆）。
 *
 * 解析结果直接驱动 memoryTarget 的目标选择；非法覆盖在写侧 fail-closed
 * （migration 错误码 MEMORY_SCOPE_INVALID）。
 *
 * D-4a / D-5b 决策也落在这里（报告事实派生）：
 * - conversation workspaceUri 无法派生 DSH cwd（远程/非 file:// URI）→
 *   接受降级（cwd 省略、原值随附 artifact），报告汇总不可派生清单；
 * - 会话侧 custom.checkpoints 存档记录 → 报告列出「会话历史存档点清单」
 *   （DSH 侧 checkpoint 与会话无外键，清单供用户检索）。
 */

import * as path from 'node:path'
import type { PlannedObject } from './types.ts'

/** 一条工作区记忆的映射建议（报告 / Remote 端点 / client 面板共用形状）。 */
export interface ScopeMapEntry {
  /** 旧工作区记忆 scope 哈希目录（= memory-workspace 的 legacyId）。 */
  hashDir: string
  /** scope.json 的 fsPath ?? cwd（可能缺失：远程工作区或损坏）。 */
  sourcePath?: string
  /** scope.json 的 uri（vscode-remote:// 等远程标识，可能缺失）。 */
  uri?: string
  /** auto = 可自动映射；unmapped = scope.json 缺失/损坏。 */
  status: 'auto' | 'unmapped'
  /** auto → sourcePath；unmapped → null。 */
  suggestedTarget: string | null
}

/** 用户覆盖表：hashDir → 'global' | 绝对路径。 */
export type ScopeOverrideMap = Readonly<Record<string, string>>

/** scopeOverrides 输入不满足稳定契约。 */
export class ScopeOverrideValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScopeOverrideValidationError'
  }
}

/**
 * 跨平台判断 scope 覆盖路径：迁移可能在与旧数据不同的宿主 OS 上运行，因此
 * 同时接受 POSIX、Windows 盘符与 UNC 绝对路径，而不依赖当前 process.platform。
 */
export function isAbsoluteScopeOverridePath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
}

/**
 * 把不可信输入收窄为 scope 覆盖表。值只允许 `global` 或跨平台绝对路径；
 * 返回 null-prototype 对象，避免 `__proto__` 等键影响原型链。
 */
export function parseScopeOverrideMap(value: unknown): ScopeOverrideMap | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScopeOverrideValidationError('scope 覆盖必须是 JSON 对象')
  }

  const normalized: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [hashDir, rawTarget] of Object.entries(value)) {
    if (hashDir.trim().length === 0) {
      throw new ScopeOverrideValidationError('scope 覆盖的 hashDir 不能为空')
    }
    if (typeof rawTarget !== 'string') {
      throw new ScopeOverrideValidationError(`scope 覆盖 ${hashDir} 的值必须是字符串`)
    }
    const target = rawTarget.trim()
    if (target === 'global') {
      normalized[hashDir] = target
      continue
    }
    if (!isAbsoluteScopeOverridePath(target)) {
      throw new ScopeOverrideValidationError(`scope 覆盖 ${hashDir} 必须是 global 或绝对路径`)
    }
    normalized[hashDir] = target
  }
  return normalized
}

/** 是否存在用户显式覆盖（只认 own property，不读取对象原型链）。 */
export function hasScopeOverride(overrides: ScopeOverrideMap | undefined, hashDir: string): boolean {
  return overrides !== undefined && Object.prototype.hasOwnProperty.call(overrides, hashDir)
}

/** 解析后的覆盖结果（memoryTarget 消费）。 */
export type ResolvedScopeOverride =
  | { kind: 'auto' } // 无覆盖 → 沿用 scope.json fsPath
  | { kind: 'global' } // 覆盖为 global → DSH 全局记忆
  | { kind: 'workspace'; cwd: string } // 覆盖为绝对路径 → 目标工作区

/**
 * 从 legacy workspaceUri（file:// 形式）派生 DSH header.cwd（绝对路径）。
 * 仅在派生结果是 POSIX 或 Windows 绝对路径时返回（DSH 校验绝对 cwd）；无法派生返回
 * undefined（调用方省略 cwd，避免单个坏 URI 使整个会话创建失败）。
 * 例：file:///c%3A/Users/demo/proj → c:/Users/demo/proj（与当前宿主无关）。
 */
export function deriveWorkspaceUriCwd(uri: string | undefined): string | undefined {
  if (!uri || !uri.startsWith('file://')) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(uri.slice('file://'.length))
  } catch {
    return undefined
  }
  if (!decoded) return undefined
  // file:///c%3A/... → /c:/... → c:/...（去掉盘符路径的前导斜杠）
  const drive = decoded.match(/^\/[A-Za-z]:\//)
  const candidate = drive ? decoded.slice(1) : decoded
  return isAbsoluteScopeOverridePath(candidate) ? candidate : undefined
}

/**
 * 从计划对象构建映射建议表（按 hashDir 稳定排序）。
 * 仅在计划对象 data 上读取（scopeValid / scopeMeta），不触碰源目录。
 */
export function buildScopeMap(objects: readonly PlannedObject[]): ScopeMapEntry[] {
  const entries: ScopeMapEntry[] = []
  for (const obj of objects) {
    if (obj.objectType !== 'memory-workspace') continue
    const data = obj.data as { scopeValid?: boolean; scopeMeta?: { fsPath?: string; cwd?: string; uri?: string } } | undefined
    const invalid = data?.scopeValid === false
    const sourcePath = data?.scopeMeta?.fsPath ?? data?.scopeMeta?.cwd
    entries.push({
      hashDir: obj.legacyId,
      ...(sourcePath !== undefined ? { sourcePath } : {}),
      ...(data?.scopeMeta?.uri !== undefined ? { uri: data.scopeMeta.uri } : {}),
      status: invalid || !sourcePath ? 'unmapped' : 'auto',
      suggestedTarget: invalid || !sourcePath ? null : (sourcePath ?? null),
    })
  }
  return entries.sort((a, b) => a.hashDir.localeCompare(b.hashDir))
}

/**
 * 解析某个 hashDir 的覆盖结果。
 *
 * @param overrides - 用户覆盖表（可为 undefined）。
 * @param hashDir - 旧工作区记忆 scope 哈希目录。
 * @returns 解析后的覆盖；无覆盖时返回 `{kind:'auto'}`。
 */
export function resolveScopeOverride(
  overrides: ScopeOverrideMap | undefined,
  hashDir: string,
): ResolvedScopeOverride {
  if (!hasScopeOverride(overrides, hashDir)) return { kind: 'auto' }
  const override = overrides![hashDir]!
  if (override === 'global') return { kind: 'global' }
  return { kind: 'workspace', cwd: override }
}

// ─── D-4a：conversation 工作区归属不可派生清单 ─────────────

/** 一条无法从 workspaceUri 派生 DSH cwd 的会话（远程/非 file:// URI，接受降级）。 */
export interface ConversationCwdIssue {
  legacyId: string
  workspaceUri: string
}

/**
 * 收集 workspaceUri 存在但 `deriveWorkspaceUriCwd` 无法派生的会话
 * （vscode-remote:// 等远程标识、损坏 URI）。这些会话迁移后无 header cwd，
 * 原 URI 只随附 artifact——报告透明化列出，供用户知晓归属缺失。
 */
export function buildConversationCwdIssues(objects: readonly PlannedObject[]): ConversationCwdIssue[] {
  const out: ConversationCwdIssue[] = []
  for (const obj of objects) {
    if (obj.objectType !== 'conversation') continue
    const data = obj.data as { workspaceUri?: unknown } | undefined
    const uri = data?.workspaceUri
    if (typeof uri !== 'string' || uri.length === 0) continue
    if (deriveWorkspaceUriCwd(uri) !== undefined) continue
    out.push({ legacyId: obj.legacyId, workspaceUri: uri })
  }
  return out.sort((a, b) => a.legacyId.localeCompare(b.legacyId))
}

// ─── D-5b：会话历史存档点清单 ─────────────────────────

/** 一个会话在旧数据中挂载的历史存档点（custom.checkpoints 的 id 列表）。 */
export interface ConversationCheckpointList {
  legacyId: string
  checkpointIds: string[]
}

/**
 * 读取会话侧 custom.checkpoints 记录（CheckpointRecord[]，字段表见
 * docs/legacy-format.md §2.3），导出存档点 id 清单。DSH 侧 checkpoint 与
 * 会话无外键关联（迁移为独立对象），清单供报告/用户检索。
 */
export function buildConversationCheckpointLists(objects: readonly PlannedObject[]): ConversationCheckpointList[] {
  const out: ConversationCheckpointList[] = []
  for (const obj of objects) {
    if (obj.objectType !== 'conversation') continue
    const data = obj.data as { custom?: { checkpoints?: unknown } } | undefined
    const checkpoints = data?.custom?.checkpoints
    if (!Array.isArray(checkpoints) || checkpoints.length === 0) continue
    const ids: string[] = []
    for (const record of checkpoints) {
      if (typeof record === 'string') {
        if (record.length > 0) ids.push(record)
        continue
      }
      if (typeof record === 'object' && record !== null && !Array.isArray(record)) {
        const id = (record as { id?: unknown }).id
        if (typeof id === 'string' && id.length > 0) ids.push(id)
      }
    }
    if (ids.length > 0) out.push({ legacyId: obj.legacyId, checkpointIds: ids })
  }
  return out.sort((a, b) => a.legacyId.localeCompare(b.legacyId))
}
