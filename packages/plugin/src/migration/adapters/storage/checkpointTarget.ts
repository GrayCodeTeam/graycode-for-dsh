/**
 * GrayCode - migration checkpoint 写入侧适配
 *
 * 复用现有 checkpoints 的 BlobStore / CheckpointManifestRepository 公开方法
 * （内容寻址布局，V2 §7.6）：
 * - 每个 legacy 存档目录 → 一个 v3 manifest（单文件，原子写）+ 内容寻址 blob；
 * - 写入顺序（§7.6）：staging 复制并校验 size/hash → 原子提交 blobs/<hash>
 *   （同 hash 复用）→ 写 manifest → incrementRefs；
 * - 失败项移入 quarantine（不静默删除证据）；单文件失败不中断存档导入；
 * - 目录名/路径全程安全校验（isSafeCheckpointDirName / resolvePathInsideRoot）。
 *
 * 增量链跨目录回溯：files 条目带 backupSourceCheckpointId 时，物理文件可能不在
 * 本存档目录而在链上祖先（跨不同 cp_* 目录，F08：cp_aa3333 → cp_bb4444 →
 * cp_cc5555）——按 checkpointId 懒加载父 manifest 逐级回溯
 * （resolveIncrementalFileSource），从祖先目录复制并按子节点声明哈希校验；
 * 父缺失/损坏/越界/成环按损坏隔离跳过该文件，不中断存档导入。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'node:crypto'
import { BlobStore, isSafeBlobHash, type StageMismatchError } from '../../../checkpoints/domain/BlobStore.ts'
import {
  CheckpointManifestRepository,
  isSafeCheckpointDirName,
} from '../../../checkpoints/domain/CheckpointManifestRepository.ts'
import {
  createWorkspaceRootId,
  normalizeSafeCheckpointPath,
  resolvePathInsideRoot,
  type CheckpointWorkspaceRoot,
} from '../../../checkpoints/domain/CheckpointWorkspace.ts'
import type { CheckpointManifest, CheckpointManifestFileEntry, CheckpointExcludedEntry, CheckpointExcludeReason } from '../../../checkpoints/domain/types.ts'
import type { TargetWriterPort, WriteTargetInput, WriteTargetResult } from '../../application/ports.ts'
import {
  parseLegacyCheckpointManifest,
  resolveIncrementalFileSource,
  type LegacyCheckpointLookup,
  type ParsedLegacyCheckpoint,
} from '../legacy/checkpointManifestParser.ts'

const SHA256_RE = /^[a-f0-9]{64}$/

function defaultIgnoreSnapshot(): CheckpointManifest['ignoreSnapshot'] {
  return {
    version: 1,
    forcedRulesVersion: 1,
    defaultProfileVersion: 1,
    enabledProfiles: {},
    maxFileSizeBytes: 50 * 1024 * 1024,
    customPatterns: [],
  }
}

function toIgnoreSnapshot(value: Record<string, unknown> | undefined): CheckpointManifest['ignoreSnapshot'] {
  if (!value) return defaultIgnoreSnapshot()
  const enabledProfiles = value.enabledProfiles && typeof value.enabledProfiles === 'object'
    ? (value.enabledProfiles as Record<string, boolean>)
    : {}
  return {
    version: typeof value.version === 'number' ? value.version : 1,
    forcedRulesVersion: typeof value.forcedRulesVersion === 'number' ? value.forcedRulesVersion : 1,
    defaultProfileVersion: typeof value.defaultProfileVersion === 'number' ? value.defaultProfileVersion : 1,
    enabledProfiles,
    ...(value.profilePatterns && typeof value.profilePatterns === 'object'
      ? { profilePatterns: value.profilePatterns as Record<string, string[]> }
      : {}),
    maxFileSizeBytes: typeof value.maxFileSizeBytes === 'number' ? value.maxFileSizeBytes : 50 * 1024 * 1024,
    customPatterns: Array.isArray(value.customPatterns) ? value.customPatterns.filter((p): p is string => typeof p === 'string') : [],
  }
}

/** 内容签名：按 scopedPath 排序的 `path:hash` 摘要（与 checkpoints service 同构） */
function digestOfHashes(files: Record<string, CheckpointManifestFileEntry>): string {
  const builder = createHash('sha256')
  let first = true
  for (const scopedPath of Object.keys(files).sort()) {
    if (!first) builder.update('\n')
    first = false
    const entry = files[scopedPath]
    if (!entry) continue
    builder.update(`${scopedPath}\n${entry.hash}`)
  }
  return builder.digest('hex')
}

const EXCLUDE_REASON_MAP: Record<string, CheckpointExcludeReason> = {
  forced: 'forced',
  default: 'default',
  gitignore: 'gitignore',
  custom: 'custom',
  size: 'size',
  unsupported_file_type: 'unsupported_file_type',
  unreadable: 'unreadable',
}

function toExcludedEntries(
  excluded: ParsedLegacyCheckpoint['excluded'],
): CheckpointExcludedEntry[] {
  return excluded.map(e => ({
    path: e.path,
    reason: EXCLUDE_REASON_MAP[e.reason] ?? 'custom',
    ...(e.rule !== undefined ? { rule: e.rule } : {}),
    ...(e.source !== undefined ? { source: e.source } : {}),
  }))
}

/** legacy 工作区根 → 指纹（与 createWorkspaceSnapshot 同构，但不要求 fsPath） */
function fingerprintOfRoots(roots: CheckpointWorkspaceRoot[]): string {
  const builder = createHash('sha256')
  roots
    .map(root => `${root.id}\n${root.uri.replace(/\\/g, '/').replace(/\/+$/g, '')}`)
    .sort()
    .forEach((line, index) => {
      if (index > 0) builder.update('\n---\n')
      builder.update(line)
    })
  return builder.digest('hex')
}

/**
 * 读取链上父存档（manifest + files.json），供 backupSourceCheckpointId 跨目录回溯。
 * 目录名非法/缺失/损坏 → null（损坏隔离：调用方跳过该文件，不整体失败）。
 */
async function readLegacyCheckpointForChain(
  sourceDir: string,
  checkpointId: string,
): Promise<ParsedLegacyCheckpoint | null> {
  if (!isSafeCheckpointDirName(checkpointId)) return null
  const dir = path.join(sourceDir, 'checkpoints', checkpointId)
  let manifestRaw: string
  try {
    manifestRaw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8')
  } catch {
    return null
  }
  let filesJsonRaw: string | undefined
  try {
    filesJsonRaw = await fs.readFile(path.join(dir, 'files.json'), 'utf-8')
  } catch {
    filesJsonRaw = undefined
  }
  const parsed = parseLegacyCheckpointManifest(checkpointId, manifestRaw, { filesJsonRaw })
  return parsed.corrupt ? null : parsed
}

/**
 * resolvePathInsideRoot 的不跟随实现（H2）：逐段 lstat，拒绝任何符号链接。
 * 防止 manifest 声明的 scoped 路径经 symlink 读取源目录之外的文件/环链；
 * 路径越界（`..`/绝对路径）仍由 resolvePathInsideRoot 拒绝。
 * 语义与 checkpoints 域 resolveSafePathInsideRoot 等价，在 migration 内实现
 * （避免跨域实现细节耦合）。
 */
async function resolvePathInsideRootNoSymlink(rootPath: string, relativePath: string): Promise<string> {
  const normalized = normalizeSafeCheckpointPath(relativePath)
  const target = resolvePathInsideRoot(rootPath, normalized)
  let current = path.resolve(rootPath)
  for (const segment of normalized.split('/')) {
    current = path.join(current, segment)
    let st
    try {
      st = await fs.lstat(current)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // 段缺失：交由调用方 lstat 处理（备份文件缺失 / 增量链回溯）
        break
      }
      throw err
    }
    if (st.isSymbolicLink()) {
      throw new Error(`checkpoint 路径含符号链接，拒绝读取: ${relativePath}`)
    }
  }
  return target
}

export function createCheckpointTargetWriter(options: { dataRoot: string }): TargetWriterPort {
  return {
    kind: 'checkpoints',
    async write(input: WriteTargetInput): Promise<WriteTargetResult> {
      const parsed = input.object.data as ParsedLegacyCheckpoint | undefined
      if (!parsed) throw new Error(`checkpoint 负载缺失: ${input.object.legacyId}`)
      if (parsed.corrupt) throw new Error(`checkpoint 源损坏: ${parsed.errorCode ?? 'UNKNOWN'} ${parsed.errorMessage ?? ''}`)

      const backupDir = path.join(input.sourceDir, 'checkpoints', parsed.dirName)

      // 工作区根：legacy workspaceRoots → scoped 路径前缀 → 合成（legacy 未知根）
      let roots: CheckpointWorkspaceRoot[] = parsed.workspaceRoots.filter(
        r => typeof r.id === 'string' && r.id.length > 0 && typeof r.uri === 'string',
      )
      if (roots.length === 0) {
        const scopedRoots = new Set<string>()
        for (const key of Object.keys(parsed.files)) {
          const match = key.match(/^(ws_[a-f0-9]{16})\//)
          if (match?.[1]) scopedRoots.add(match[1])
        }
        roots = [...scopedRoots].sort().map(id => ({ id, name: id, uri: `legacy://unknown/${id}` }))
      }
      if (roots.length === 0) {
        roots = [{ id: createWorkspaceRootId(`legacy-checkpoint://${parsed.checkpointId}`), name: parsed.checkpointId, uri: `legacy-checkpoint://${parsed.checkpointId}` }]
      }
      const workspaceId = roots[0]?.id ?? ''
      if (!/^ws_[a-f0-9]{16}$/.test(workspaceId)) {
        throw new Error(`checkpoint workspace root id 非法: ${workspaceId}`)
      }
      const workspaceSnapshot = {
        workspaceRoots: roots.map(r => ({ id: r.id, name: r.name, uri: r.uri })),
        workspaceFingerprint: fingerprintOfRoots(roots),
      }

      const workspaceDir = path.join(options.dataRoot, 'checkpoints', workspaceId)
      const blobs = new BlobStore(workspaceDir)
      const manifests = new CheckpointManifestRepository(workspaceDir)
      await blobs.initialize()

      // 引用计数幂等（H1b）：manifest 已存在 ⟹ 此前某次 write 已完整执行
      // writeManifest → incrementRefs。ledger.put 失败后重跑时不再重复累加
      // blob 引用（blobRefs 以 manifests 为权威源，缺失可由 GC 调和自愈）。
      // 损坏 manifest 按不存在处理（writeManifest 原子写失败 ⇒ refs 未增）。
      let manifestAlreadyExists = false
      try {
        manifestAlreadyExists = (await manifests.loadManifest(parsed.checkpointId)) !== null
      } catch {
        manifestAlreadyExists = false
      }

      const opId = `migrate-${input.runId}`
      const files: Record<string, CheckpointManifestFileEntry> = {}
      const hashes: string[] = []
      const notes: string[] = []
      let skippedFiles = 0
      let chainResolvedFiles = 0

      // 增量链跨目录回溯：按 checkpointId 懒加载父存档（memoized；缺失/损坏 → null）
      const chainCache = new Map<string, ParsedLegacyCheckpoint | null>()
      const chainLookup: LegacyCheckpointLookup = {
        get: async (checkpointId: string) => {
          const cached = chainCache.get(checkpointId)
          if (cached !== undefined) return cached
          const value = await readLegacyCheckpointForChain(input.sourceDir, checkpointId)
          chainCache.set(checkpointId, value)
          return value
        },
      }

      for (const [scopedKey, entry] of Object.entries(parsed.files).sort(([a], [b]) => a.localeCompare(b))) {
        // 旧存档可能用扁平相对路径（无 ws_ 前缀）：统一 scoped 到 workspaceId 下
        const safeRelative = normalizeSafeCheckpointPath(scopedKey)
        const scopedPath = safeRelative.startsWith(`${workspaceId}/`) ? safeRelative : `${workspaceId}/${safeRelative}`
        let srcPath: string
        try {
          srcPath = await resolvePathInsideRootNoSymlink(backupDir, scopedPath)
        } catch (err) {
          skippedFiles += 1
          notes.push(`路径越界/符号链接跳过: ${scopedKey} — ${(err as Error).message}`)
          continue
        }
        let stat
        try {
          stat = await fs.lstat(srcPath)
        } catch {
          // 本目录无物理文件：若条目带 backupSourceCheckpointId，沿增量链跨目录回溯
          if (!entry.backupSourceCheckpointId) {
            skippedFiles += 1
            notes.push(`备份文件缺失: ${scopedKey}`)
            continue
          }
          const resolved = await resolveIncrementalFileSource(
            parsed.checkpointId,
            [scopedPath, scopedKey],
            entry,
            chainLookup,
          )
          if (!resolved.ok) {
            // 父缺失/损坏/越界/成环：损坏隔离——跳过该文件，不中断存档导入
            skippedFiles += 1
            notes.push(`增量链回溯失败（${resolved.reason}）: ${scopedKey} — ${resolved.message}`)
            continue
          }
          try {
            srcPath = await resolvePathInsideRootNoSymlink(
              path.join(input.sourceDir, 'checkpoints', resolved.sourceCheckpointId),
              resolved.sourceKey,
            )
          } catch (err) {
            skippedFiles += 1
            notes.push(`路径越界/符号链接跳过（增量链）: ${scopedKey} — ${(err as Error).message}`)
            continue
          }
          try {
            stat = await fs.lstat(srcPath)
          } catch {
            skippedFiles += 1
            notes.push(`增量链回溯失败（物理文件缺失）: ${scopedKey} @ ${resolved.sourceCheckpointId}`)
            continue
          }
          if (!resolved.hashConsistent) {
            notes.push(`增量链哈希不一致（仍按子节点声明哈希校验）: ${scopedKey}`)
          }
          chainResolvedFiles += 1
        }
        if (!stat.isFile()) {
          skippedFiles += 1
          notes.push(`非普通文件跳过: ${scopedKey}`)
          continue
        }        try {
          const expectedHash = SHA256_RE.test(entry.hash) ? entry.hash : undefined
          const result = await blobs.stageAndCommit(opId, srcPath, expectedHash, entry.size)
          files[scopedPath] = { hash: result.hash, size: result.size, mode: stat.mode }
          hashes.push(result.hash)
        } catch (err) {
          const stagedPath = (err as StageMismatchError).stagedPath
          if (stagedPath) {
            await blobs.quarantine(opId, scopedPath, `migration stage mismatch: ${(err as Error).message}`, stagedPath)
          }
          skippedFiles += 1
          notes.push(`文件提交失败（已 quarantine）: ${scopedKey} — ${(err as Error).message}`)
        }
      }
      await blobs.cleanupStaging(opId)

      const manifest: CheckpointManifest = {
        version: 3,
        checkpointId: parsed.checkpointId,
        workspaceRoots: workspaceSnapshot.workspaceRoots,
        workspaceFingerprint: workspaceSnapshot.workspaceFingerprint,
        createdAt: Date.now(),
        files,
        changes: parsed.changes,
        emptyDirs: parsed.emptyDirs,
        excluded: toExcludedEntries(parsed.excluded),
        ignoreSnapshot: toIgnoreSnapshot(parsed.ignoreSnapshot),
        excludeRuleVersion: typeof parsed.ignoreSnapshot?.version === 'number' ? parsed.ignoreSnapshot.version : 1,
        contentHash: digestOfHashes(files),
        ...(parsed.partial === true ? { partial: true } : {}),
      }
      await manifests.writeManifest(parsed.checkpointId, manifest)
      // H1b：首次写入才累加引用；重跑（manifest 已存在）不重复 incrementRefs
      if (!manifestAlreadyExists) {
        await blobs.incrementRefs(hashes)
      }

      notes.push(
        `blob 数: ${hashes.length}（复用由 BlobStore 判定）；备份文件缺失跳过: ${skippedFiles}；增量链回溯: ${chainResolvedFiles}`,
      )
      return { targetRef: `checkpoint://${workspaceId}/${parsed.checkpointId}`, notes }
    },
    async probe(targetRef: string): Promise<boolean> {
      const match = targetRef.match(/^checkpoint:\/\/(ws_[a-f0-9]{16})\/(.+)$/)
      if (!match?.[1] || !match[2]) return false
      const workspaceDir = path.join(options.dataRoot, 'checkpoints', match[1])
      const manifests = new CheckpointManifestRepository(workspaceDir)
      try {
        const manifest = await manifests.loadManifest(match[2])
        return manifest !== null
      } catch {
        return false
      }
    },
  }
}

export { isSafeBlobHash }
