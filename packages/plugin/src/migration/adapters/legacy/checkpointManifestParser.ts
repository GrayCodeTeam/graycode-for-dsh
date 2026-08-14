/**
 * GrayCode - migration legacy checkpoint manifest 只读解析器
 *
 * 存档规范见 docs/legacy-format.md §2：
 * - v1：`manifest.json` 内联 files（无 files.json、无 filesRevision）；
 * - v2：`manifest.json`（轻量）+ `files.json`（重量级文件映射）；
 *   ATOMIC-PAIR：两者 filesRevision 必须一致，混合配对拒绝
 *   （CHECKPOINT_FILES_REVISION_MISMATCH，F14f）；轻量元数据仍可用；
 * - `"files": []` 数组形状拒绝（防恢复误删语义，F14l）；
 * - 目录名越界（backupDir 等）→ CHECKPOINT_UNSAFE_DIR（F14g）；
 * - 大工作区 files 可达 10-20MB：本解析器只按需读取 manifest + files.json，
 *   不展开备份目录内容（文件哈希由目标侧逐文件校验）；
 * - 增量链（backupSourceCheckpointId）：物理文件可能在链上祖先存档目录
 *   （跨不同 cp_* 目录，F08），本模块提供纯函数 resolveIncrementalFileSource
 *   逐级回溯父链（调用方提供 lookup，缺失/损坏父节点按损坏隔离返回失败）。
 */

import {
  isSafeCheckpointDirName,
} from '../../../checkpoints/domain/CheckpointManifestRepository.ts'
import type { CheckpointWorkspaceRoot } from '../../../checkpoints/domain/CheckpointWorkspace.ts'
import { MIGRATION_ERROR_CODES } from '../../domain/types.ts'

export interface LegacyCheckpointFileEntry {
  hash: string
  size: number
  mtimeMs?: number
  mtimeNs?: string
  /** 增量链中该文件实际备份所在的前置节点（缺省 = 本节点） */
  backupSourceCheckpointId?: string
}

export interface ParsedLegacyCheckpoint {
  checkpointId: string
  dirName: string
  manifestVersion: 1 | 2 | 'unknown'
  manifestValid: boolean
  corrupt: boolean
  errorCode?: string
  errorMessage?: string
  /** v2 配对校验（files.json.filesRevision === manifest.filesRevision） */
  filesRevisionPaired: boolean
  workspaceRoots: CheckpointWorkspaceRoot[]
  files: Record<string, LegacyCheckpointFileEntry>
  emptyDirs: string[]
  changes: Array<{ path: string; type: 'added' | 'modified' | 'deleted'; hash?: string }>
  excluded: Array<{ path: string; reason: string; rule?: string; source?: string }>
  ignoreSnapshot?: Record<string, unknown>
  partial?: boolean
  fileCount: number
}

export interface CheckpointDirPayload {
  manifestRaw?: string
  filesJsonRaw?: string
  /** manifest.json 的 mtime（createdAt 回退值） */
  manifestMtimeMs: number
}

export interface CheckpointParseOptions {
  /** files.json 内容（v2）；缺失时为 undefined */
  filesJsonRaw?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 解析单个存档目录（manifest.json [+ files.json]）。
 * 损坏隔离：JSON 非法 → corrupt（CHECKPOINT_MANIFEST_CORRUPT），轻量信息仍返回；
 * v2 配对错乱 → filesRevisionPaired=false（完整数据不可信，F14f）。
 */
export function parseLegacyCheckpointManifest(
  checkpointId: string,
  manifestRaw: string,
  options: CheckpointParseOptions = {},
): ParsedLegacyCheckpoint {
  const base: ParsedLegacyCheckpoint = {
    checkpointId,
    dirName: checkpointId,
    manifestVersion: 'unknown',
    manifestValid: false,
    corrupt: false,
    filesRevisionPaired: true,
    workspaceRoots: [],
    files: {},
    emptyDirs: [],
    changes: [],
    excluded: [],
    fileCount: 0,
  }

  // 目录名安全校验（F14g：backupDir 越界拒绝）
  if (!isSafeCheckpointDirName(checkpointId)) {
    return {
      ...base,
      corrupt: true,
      errorCode: MIGRATION_ERROR_CODES.CHECKPOINT_UNSAFE_DIR,
      errorMessage: `Unsafe checkpoint dir name: ${checkpointId}`,
    }
  }

  let manifest: Record<string, unknown>
  try {
    const parsed = JSON.parse(manifestRaw) as unknown
    if (!isRecord(parsed)) throw new Error('not an object')
    manifest = parsed
  } catch {
    // F14e：manifest 损坏 → 存档跳过，记录仍在列表（轻量元数据 best-effort）
    return {
      ...base,
      corrupt: true,
      errorCode: MIGRATION_ERROR_CODES.CHECKPOINT_MANIFEST_CORRUPT,
      errorMessage: 'manifest.json 非法 JSON',
    }
  }

  const version = manifest.version
  const manifestVersion = version === 1 || version === 2 ? version : 'unknown'
  if (manifestVersion === 'unknown') {
    return {
      ...base,
      manifestVersion,
      corrupt: true,
      errorCode: MIGRATION_ERROR_CODES.CHECKPOINT_MANIFEST_CORRUPT,
      errorMessage: `未知 manifest 版本: ${String(version)}`,
    }
  }

  const workspaceRoots = Array.isArray(manifest.workspaceRoots)
    ? manifest.workspaceRoots.filter(isRecord).map(root => ({
        id: typeof root.id === 'string' ? root.id : '',
        name: typeof root.name === 'string' ? root.name : '',
        uri: typeof root.uri === 'string' ? root.uri : '',
      }))
    : []
  const emptyDirs = Array.isArray(manifest.emptyDirs)
    ? manifest.emptyDirs.filter((d): d is string => typeof d === 'string')
    : []
  const changes = Array.isArray(manifest.changes)
    ? manifest.changes
        .filter(isRecord)
        .filter(
          (c): c is Record<string, unknown> & { type: 'added' | 'modified' | 'deleted' } =>
            c.type === 'added' || c.type === 'modified' || c.type === 'deleted',
        )
        .map(c => ({
          path: typeof c.path === 'string' ? c.path : '',
          type: c.type,
          ...(typeof c.hash === 'string' ? { hash: c.hash } : {}),
        }))
        .filter(c => c.path.length > 0)
    : []
  const excluded = Array.isArray(manifest.excluded)
    ? manifest.excluded
        .filter(isRecord)
        .map(e => ({
          path: typeof e.path === 'string' ? e.path : '',
          reason: typeof e.reason === 'string' ? e.reason : 'unknown',
          ...(typeof e.rule === 'string' ? { rule: e.rule } : {}),
          ...(typeof e.source === 'string' ? { source: e.source } : {}),
        }))
        .filter(e => e.path.length > 0)
    : []

  // files 来源：v1 内联 vs v2 files.json
  let files: Record<string, LegacyCheckpointFileEntry> = {}
  let filesRevisionPaired = true
  let corrupt = false
  let errorCode: string | undefined
  let errorMessage: string | undefined

  const parseFilesMapping = (value: unknown): Record<string, LegacyCheckpointFileEntry> | null => {
    if (!isRecord(value)) return null
    const out: Record<string, LegacyCheckpointFileEntry> = {}
    for (const [scopedPath, entry] of Object.entries(value)) {
      if (!isRecord(entry)) continue
      const hash = typeof entry.hash === 'string' ? entry.hash : ''
      const size = typeof entry.size === 'number' ? entry.size : 0
      if (!hash) continue
      out[scopedPath] = {
        hash,
        size,
        ...(typeof entry.mtimeMs === 'number' ? { mtimeMs: entry.mtimeMs } : {}),
        ...(typeof entry.mtimeNs === 'string' ? { mtimeNs: entry.mtimeNs } : {}),
        ...(typeof entry.backupSourceCheckpointId === 'string'
          ? { backupSourceCheckpointId: entry.backupSourceCheckpointId }
          : {}),
      }
    }
    return out
  }

  if (manifestVersion === 1) {
    // v1：files 内联（legacy-format.md §2.2）
    const parsed = parseFilesMapping(manifest.files)
    if (parsed === null && manifest.files !== undefined) {
      // F14l 同源语义：数组形状拒绝
      corrupt = true
      errorCode = MIGRATION_ERROR_CODES.CHECKPOINT_FILES_ARRAY_SHAPE
      errorMessage = 'manifest.files 形状非法（数组/非对象被拒绝）'
    } else {
      files = parsed ?? {}
    }
  } else {
    // v2：files.json + filesRevision 配对（ATOMIC-PAIR）
    const manifestRevision = typeof manifest.filesRevision === 'string' ? manifest.filesRevision : undefined
    let filesJson: Record<string, unknown> | null = null
    if (options.filesJsonRaw !== undefined) {
      try {
        const parsed = JSON.parse(options.filesJsonRaw) as unknown
        if (!isRecord(parsed)) throw new Error('not an object')
        filesJson = parsed
      } catch {
        corrupt = true
        errorCode = MIGRATION_ERROR_CODES.CHECKPOINT_MANIFEST_CORRUPT
        errorMessage = 'files.json 非法 JSON'
      }
      if (!corrupt && filesJson) {
        const filesJsonRevision = typeof filesJson.filesRevision === 'string' ? filesJson.filesRevision : undefined
        if (manifestRevision && filesJsonRevision && manifestRevision !== filesJsonRevision) {
          // F14f：配对错乱 → 完整数据拒绝，轻量元数据仍可用
          filesRevisionPaired = false
          corrupt = true
          errorCode = MIGRATION_ERROR_CODES.CHECKPOINT_FILES_REVISION_MISMATCH
          errorMessage = `filesRevision 不配对: manifest=${manifestRevision} files.json=${filesJsonRevision}`
        } else {
          const parsed = parseFilesMapping(filesJson.files)
          if (parsed === null) {
            corrupt = true
            errorCode = MIGRATION_ERROR_CODES.CHECKPOINT_FILES_ARRAY_SHAPE
            errorMessage = 'files.json.files 形状非法（数组/非对象被拒绝）'
          } else {
            files = parsed
          }
        }
      }
    } else if (manifestRevision) {
      // files.json 缺失但 manifest 声明了 filesRevision：轻量元数据可用，完整数据不可信
      filesRevisionPaired = false
    }
  }

  return {
    checkpointId,
    dirName: checkpointId,
    manifestVersion,
    manifestValid: !corrupt,
    corrupt,
    ...(errorCode ? { errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    filesRevisionPaired,
    workspaceRoots,
    files,
    emptyDirs,
    changes,
    excluded,
    ...(isRecord(manifest.ignoreSnapshot) ? { ignoreSnapshot: manifest.ignoreSnapshot } : {}),
    ...(manifest.partial === true ? { partial: true } : {}),
    fileCount: Object.keys(files).length,
  }
}

// ─── 增量链（backupSourceCheckpointId）跨目录回溯 ─────────────────────
//
// legacy-format.md §2.3：增量存档的 files 条目可带 backupSourceCheckpointId，
// 指向「该文件实际备份所在的前置节点」——物理文件不在本存档目录，而在链上
// 祖先（可能跨不同 cp_* 目录，F08：cp_aa3333 → cp_bb4444 → cp_cc5555）。
// 本组函数为纯逻辑：给定 lookup（按 checkpointId 取已解析存档），逐级回溯
// backupSourceCheckpointId 链定位物理文件所在节点；父节点缺失/损坏/越界
// 目录名/自引用/成环/超深均按「损坏隔离」返回失败，由调用方跳过该文件
// （不整体失败）。调用方（checkpointTarget）负责提供带 memo 的磁盘 lookup。

export const CHECKPOINT_CHAIN_MAX_HOPS = 32

/** 按 checkpointId 提供已解析存档的查找器（缺失/损坏/目录名非法 → null） */
export interface LegacyCheckpointLookup {
  get(checkpointId: string): Promise<ParsedLegacyCheckpoint | null>
}

export type IncrementalChainFailureReason =
  | 'unsafe-dir'
  | 'missing-parent'
  | 'missing-entry'
  | 'self-ref'
  | 'cycle'
  | 'too-deep'

export type IncrementalFileResolution =
  | {
      ok: true
      /** 物理文件所在存档（= 本存档或链上祖先） */
      sourceCheckpointId: string
      /** sourceCheckpointId 存档 files 映射中命中的键（lookupKeys 之一） */
      sourceKey: string
      sourceEntry: LegacyCheckpointFileEntry
      /** 链上经过的节点（含起点） */
      hops: string[]
      /** 子节点声明哈希与解析节点声明哈希是否一致（任一缺失视为一致） */
      hashConsistent: boolean
    }
  | {
      ok: false
      reason: IncrementalChainFailureReason
      message: string
      hops: string[]
    }

/**
 * 逐级回溯 backupSourceCheckpointId 链，定位文件物理备份所在节点。
 *
 * 规则：
 * - 无 backupSourceCheckpointId → 本节点；
 * - 每级先校验目录名安全（F14g 同源），再查父节点 files（lookupKeys 逐个尝试，
 *   兼容子节点扁平键 → 父节点 scoped 键的归一化差异）；
 * - 父条目若仍带 backupSourceCheckpointId → 继续向上（多级链）；
 * - 父缺失/损坏（lookup 返回 null）、父无条目、越界目录名、自引用、成环、
 *   超深 → 失败（调用方按损坏隔离跳过该文件，不中断整体导入）。
 */
export async function resolveIncrementalFileSource(
  checkpointId: string,
  lookupKeys: readonly string[],
  entry: LegacyCheckpointFileEntry,
  lookup: LegacyCheckpointLookup,
): Promise<IncrementalFileResolution> {
  const start = entry.backupSourceCheckpointId
  if (!start) {
    return {
      ok: true,
      sourceCheckpointId: checkpointId,
      sourceKey: lookupKeys[0] ?? '',
      sourceEntry: entry,
      hops: [checkpointId],
      hashConsistent: true,
    }
  }

  const hops: string[] = [checkpointId]
  const visited = new Set<string>([checkpointId])
  let current = start

  for (let depth = 0; depth < CHECKPOINT_CHAIN_MAX_HOPS; depth += 1) {
    if (current === checkpointId) {
      return { ok: false, reason: 'self-ref', message: `增量链自引用: ${current}`, hops }
    }
    if (!isSafeCheckpointDirName(current)) {
      return { ok: false, reason: 'unsafe-dir', message: `父节点目录名非法: ${current}`, hops }
    }
    if (visited.has(current)) {
      return { ok: false, reason: 'cycle', message: `增量链成环: ${[...hops, current].join(' -> ')}`, hops }
    }
    visited.add(current)
    hops.push(current)

    const parent = await lookup.get(current)
    if (!parent) {
      return { ok: false, reason: 'missing-parent', message: `父节点缺失或损坏: ${current}`, hops }
    }

    let sourceKey: string | undefined
    let sourceEntry: LegacyCheckpointFileEntry | undefined
    for (const key of lookupKeys) {
      const found = parent.files[key]
      if (found) {
        sourceKey = key
        sourceEntry = found
        break
      }
    }
    if (sourceEntry === undefined || sourceKey === undefined) {
      return {
        ok: false,
        reason: 'missing-entry',
        message: `父节点 ${current} 无文件条目: ${lookupKeys.join(' / ')}`,
        hops,
      }
    }

    const next = sourceEntry.backupSourceCheckpointId
    if (next && next !== current) {
      current = next
      continue
    }
    if (next === current) {
      return { ok: false, reason: 'self-ref', message: `父节点 ${current} 自引用`, hops }
    }

    const hashConsistent = !entry.hash || !sourceEntry.hash || entry.hash === sourceEntry.hash
    return { ok: true, sourceCheckpointId: current, sourceKey, sourceEntry, hops, hashConsistent }
  }

  return {
    ok: false,
    reason: 'too-deep',
    message: `增量链过深（超过 ${CHECKPOINT_CHAIN_MAX_HOPS} 层）`,
    hops,
  }
}

export type CheckpointChainIssueCode = IncrementalChainFailureReason | 'hash-mismatch'

export interface CheckpointChainIssue {
  checkpointId: string
  scopedPath: string
  code: CheckpointChainIssueCode
  message: string
}

/**
 * 校验单个存档的全部 backupSourceCheckpointId 引用（引用一致性审计）：
 * 逐文件回溯，收集解析失败与「子/父声明哈希不一致」问题；不抛错、不修改任何状态。
 */
export async function validateCheckpointChainReferences(
  parsed: ParsedLegacyCheckpoint,
  lookup: LegacyCheckpointLookup,
): Promise<CheckpointChainIssue[]> {
  const issues: CheckpointChainIssue[] = []
  for (const [scopedPath, entry] of Object.entries(parsed.files)) {
    if (!entry.backupSourceCheckpointId) continue
    const resolved = await resolveIncrementalFileSource(parsed.checkpointId, [scopedPath], entry, lookup)
    if (!resolved.ok) {
      issues.push({
        checkpointId: parsed.checkpointId,
        scopedPath,
        code: resolved.reason,
        message: resolved.message,
      })
    } else if (!resolved.hashConsistent) {
      issues.push({
        checkpointId: parsed.checkpointId,
        scopedPath,
        code: 'hash-mismatch',
        message: `子/父声明哈希不一致: ${entry.hash} vs ${resolved.sourceEntry.hash}`,
      })
    }
  }
  return issues
}
