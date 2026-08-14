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
 *   不展开备份目录内容（文件哈希由目标侧逐文件校验）。
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
