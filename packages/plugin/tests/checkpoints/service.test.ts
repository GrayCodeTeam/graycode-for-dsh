/**
 * CheckpointService 端到端用例（真实文件 + 临时 dataRoot，内容寻址布局 V2 §7.6）。
 *
 * 覆盖：
 * - 创建 → 列表 → 校验 round-trip（新布局：blobs/ + manifests/ + staging 清理）
 * - blob 同 hash 复用（内容寻址：未变更内容不重复写盘）
 * - 增量父链：第二份 checkpoint 的 base 字段 + changes；沿父链恢复完整文件集
 * - restore 门闸：preview → token → restore；无 token / 错 token / 一次性
 * - preview 基线绑定：目标变化后旧 preview 失效（apply 前重新比对拒绝）
 * - 删除链保护（computeForcedKeepIds 祖先闭包）
 * - 删除只减引用 + GC dry-run/refcount/grace period 语义
 * - staging 失败进 quarantine（不静默删除证据）
 * - manifest v3 单文件布局、保留策略、工作区隔离
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { CheckpointService, type CheckpointServiceConfig, type CreateCheckpointResult } from '../../src/checkpoints/service.ts'
import { createDshFsRestoreWorkspaceWriter, createNodeFsRestoreWorkspaceWriter, type RestoreWorkspaceWriter } from '../../src/checkpoints/domain/RestoreWorkspaceWriter.ts'
import { computeForcedKeepIds, type CheckpointWorkspaceStorage } from '../../src/checkpoints/domain/CheckpointDeletionService.ts'
import { BlobStore, BLOB_HASH_PATTERN } from '../../src/checkpoints/domain/BlobStore.ts'
import * as fileHashing from '../../src/checkpoints/domain/fileHashing.ts'
import type { CheckpointRecord } from '../../src/checkpoints/domain/types.ts'
import { makeEnv, makeService, writeFile, createTempDir, cleanup } from './helpers.ts'

/**
 * 默认行为 = 真实实现；staging 失败注入用例临时替换实现（见下方 quarantine describe）。
 * mock 在文件级生效，因此注入必须 try/finally 恢复，避免污染其他用例。
 */
vi.mock('../../src/checkpoints/domain/fileHashing.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/checkpoints/domain/fileHashing.ts')>()
  return {
    ...actual,
    hashFileStreaming: vi.fn(actual.hashFileStreaming),
  }
})

/**
 * 4.19-L1 故障注入：把 rename 包成 vi.fn（默认转发真实实现），
 * 使测试能按目标路径注入失败。src 用 'fs/promises'、测试用
 * 'node:fs/promises'，两个 specifier 都 mock 以命中同一模块实例。
 */
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(actual.rename),
  }
})
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(actual.rename),
  }
})

/** 工作区 blob 池目录（dataRoot/checkpoints/<wsId>/blobs） */
function blobsDirOf(service: CheckpointService, workspaceDir: string): string {
  const wsId = service.conversationIdFor(workspaceDir)
  return path.join(service.checkpointsDir, wsId, 'blobs')
}

/** 列出 blob 池中的内容哈希（按文件名） */
async function listBlobHashes(blobsDir: string): Promise<string[]> {
  return (await fs.readdir(blobsDir).catch(() => [])).filter(name => BLOB_HASH_PATTERN.test(name)).sort()
}

describe('CheckpointService round-trip (content-addressed layout)', () => {
  test('create -> list -> verify: new layout, node_modules/.git excluded', async () => {
    const { workspaceDir, dataRoot, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      await writeFile(workspaceDir, 'sub/b.ts', 'beta')
      await writeFile(workspaceDir, 'node_modules/pkg/index.js', 'nope')
      await writeFile(workspaceDir, '.git/config', '[core]')
      await writeFile(workspaceDir, 'logs/app.log', 'ignored by profile')

      const created = await service.createCheckpoint(workspaceDir, { title: 'first' })
      expect(created).not.toBeNull()
      expect(created!.checkpointId).toMatch(/^cp_[0-9a-f]{32}$/)
      expect(created!.type).toBe('full')
      expect(created!.fileCount).toBe(2) // a.txt + sub/b.ts
      // 排除面精确断言：node_modules + .git + logs/app.log 恰好 3 条排除
      // （目录被忽略时整棵子树不遍历，只计目录本身 1 条）
      expect(created!.excludedCount).toBe(3)
      expect(created!.sizeBytes).toBeGreaterThan(0)

      // V2 §7.6 布局：<checkpoints>/<wsId>/{blobs,manifests,staging,quarantine}
      const wsId = service.conversationIdFor(workspaceDir)
      const wsDir = path.join(dataRoot, 'checkpoints', wsId)
      const blobsDir = path.join(wsDir, 'blobs')
      const blobs = await listBlobHashes(blobsDir)
      expect(blobs).toHaveLength(2) // alpha + beta 两个内容 blob
      await expect(fs.access(path.join(wsDir, 'manifests', `${created!.checkpointId}.json`))).resolves.toBeUndefined()

      // manifest 内容：完整文件清单 path→blobHash + size/mode，无 mtime 易变字段
      const manifest = JSON.parse(
        await fs.readFile(path.join(wsDir, 'manifests', `${created!.checkpointId}.json`), 'utf-8'),
      )
      expect(manifest.version).toBe(3)
      expect(manifest.checkpointId).toBe(created!.checkpointId)
      expect(Object.keys(manifest.files)).toHaveLength(2)
      const aEntry = manifest.files[`${wsId}/a.txt`]
      expect(aEntry).toBeTruthy()
      expect(BLOB_HASH_PATTERN.test(aEntry.hash)).toBe(true)
      expect(aEntry.size).toBe(5) // 'alpha'
      expect(typeof aEntry.mode).toBe('number')
      expect(aEntry.mtimeMs).toBeUndefined() // 易变字段不再随内容寻址存储
      // 变更清单：全量快照 → 全部 added
      expect(manifest.changes.every((c: { type: string }) => c.type === 'added')).toBe(true)
      expect(manifest.parentCheckpointId).toBeUndefined()

      // staging 已清理（无残留）
      expect(await fs.readdir(path.join(wsDir, 'staging'))).toEqual([])

      // 记录存储：records.json 简单 JSON 数组（domain 记录含引用计数相关字段）
      const recordsRaw = JSON.parse(await fs.readFile(path.join(dataRoot, 'checkpoints', 'records.json'), 'utf-8'))
      expect(Array.isArray(recordsRaw)).toBe(true)
      expect(recordsRaw).toHaveLength(1)
      expect(recordsRaw[0]).toMatchObject({
        id: created!.checkpointId,
        type: 'full',
        fileCount: 2,
        status: 'active',
        manifestVersion: 3,
      })
      expect(recordsRaw[0].lastEvent).toMatch(/^checkpoint-created:/)

      // 列表
      const listed = await service.listCheckpoints(workspaceDir)
      expect(listed.total).toBe(1)
      expect(listed.items[0]).toMatchObject({ id: created!.checkpointId, fileCount: 2 })
      expect(listed.nextCursor).toBeUndefined()

      // 校验（只读）：blob 内容哈希与寻址键一致
      const verified = await service.verifyCheckpoint(created!.checkpointId)
      expect(verified.ok).toBe(true)
      expect(verified.checkedFiles).toBe(2)
      expect(verified.chainLength).toBe(1)
      expect(verified.filesRevisionPaired).toBe(true)
      expect(verified.issues).toEqual([])
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })

  test('blob reuse: unchanged content is not rewritten (content addressing)', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'v1')
      await writeFile(workspaceDir, 'b.txt', 'keep')
      const first = await service.createCheckpoint(workspaceDir)
      expect(first).not.toBeNull()

      const blobsDir = blobsDirOf(service, workspaceDir)
      const afterFirst = await listBlobHashes(blobsDir)
      expect(afterFirst).toHaveLength(2)

      await writeFile(workspaceDir, 'a.txt', 'v2')
      const second = await service.createCheckpoint(workspaceDir)
      expect(second).not.toBeNull()

      // 只有新内容（a.txt v2）新增 blob；b.txt 与 a.txt v1 复用
      const afterSecond = await listBlobHashes(blobsDir)
      expect(afterSecond).toHaveLength(3)
      // 未变更文件复用 = 第二份不新增字节
      expect(second!.sizeBytes).toBe('v2'.length)
      expect(second!.type).toBe('incremental')
      expect(second!.baseCheckpointId).toBe(first!.checkpointId)

      // 引用计数：b.txt 的 blob 被两个 manifest 引用（count=2），a.txt 两版各 count=1
      const wsId = service.conversationIdFor(workspaceDir)
      const refs = JSON.parse(
        await fs.readFile(path.join(service.checkpointsDir, wsId, 'blobRefs.json'), 'utf-8'),
      )
      const counts = Object.values(refs.counts as Record<string, { count: number }>)
      expect(counts.some(entry => entry.count === 2)).toBe(true) // b.txt 的 blob
      expect(counts.some(entry => entry.count === 1)).toBe(true) // a.txt v1 / v2
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })

  test('incremental semantics: second checkpoint keeps base field, changes, and full state restore', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'v1')
      await writeFile(workspaceDir, 'b.txt', 'keep')
      const first = await service.createCheckpoint(workspaceDir)
      expect(first).not.toBeNull()

      await writeFile(workspaceDir, 'a.txt', 'v2')
      await writeFile(workspaceDir, 'c.txt', 'new file')
      const second = await service.createCheckpoint(workspaceDir)
      expect(second).not.toBeNull()

      expect(second!.type).toBe('incremental')
      expect(second!.baseCheckpointId).toBe(first!.checkpointId)
      expect(second!.fileCount).toBe(3) // 完整文件集

      const listed = await service.listCheckpoints(workspaceDir)
      expect(listed.total).toBe(2)
      const [newest, oldest] = listed.items
      expect(newest!.baseCheckpointId).toBe(oldest!.id)

      // 校验第二个存档时增量链完整（chainLength = 2）
      const verified = await service.verifyCheckpoint(second!.checkpointId)
      expect(verified.ok).toBe(true)
      expect(verified.chainLength).toBe(2)

      // 改动工作区后沿父链恢复到第二份状态（完整文件集）
      await writeFile(workspaceDir, 'a.txt', 'changed')
      await writeFile(workspaceDir, 'b.txt', 'changed too')
      await fs.rm(path.join(workspaceDir, 'c.txt'), { force: true })

      const preview = await service.previewRestore(workspaceDir, second!.checkpointId)
      expect(preview.preview.success).toBe(true)
      expect(preview.preview.restored).toBe(3)
      expect(preview.previewToken).toBeTruthy()

      const restored = await service.restoreCheckpoint(workspaceDir, second!.checkpointId, preview.previewToken!)
      expect(restored.success).toBe(true)
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('v2')
      expect(await fs.readFile(path.join(workspaceDir, 'b.txt'), 'utf-8')).toBe('keep')
      expect(await fs.readFile(path.join(workspaceDir, 'c.txt'), 'utf-8')).toBe('new file')
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})

describe('CheckpointService restore gate (preview -> token -> restore)', () => {
  test('modify -> preview (conflicts) -> restore with token -> content restored; token one-time', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'original')
      await writeFile(workspaceDir, 'keep.txt', 'untracked-data')
      const created = await service.createCheckpoint(workspaceDir)
      expect(created).not.toBeNull()

      // 修改快照内文件 + 新增未跟踪文件
      await writeFile(workspaceDir, 'a.txt', 'modified')
      await writeFile(workspaceDir, 'new.txt', 'created after snapshot')

      // 预览：不确认删除 untracked
      const preview1 = await service.previewRestore(workspaceDir, created!.checkpointId)
      expect(preview1.preview.success).toBe(true)
      expect(preview1.preview.restored).toBe(1) // a.txt
      expect(preview1.preview.deletedIfUnconfirmed).toBe(0)
      expect(preview1.preview.untrackedPaths).toContain('new.txt')
      expect(preview1.previewToken).toBeTruthy()
      expect(preview1.baselineDigest).toMatch(/^[a-f0-9]{64}$/)

      // 无 token 拒绝：结构化失败 + 稳定错误前缀（F-10：错误码/结构化字段优先，文案仅作补充）
      const noToken = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, '')
      expect(noToken.success).toBe(false)
      expect(noToken.restored).toBe(0)
      expect(noToken.error).toMatch(/^Restore denied:/)
      expect(noToken.error).toContain('previewToken') // 补充：指明缺失的字段

      // 错 token 拒绝
      const wrongToken = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, 'x'.repeat(32))
      expect(wrongToken.success).toBe(false)

      // 带 token 恢复
      const restored = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview1.previewToken!)
      expect(restored.success).toBe(true)
      expect(restored.restored).toBe(1)
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('original')
      // deleteUntrackedFiles=false：未跟踪文件保留
      await expect(fs.access(path.join(workspaceDir, 'new.txt'))).resolves.toBeUndefined()
      expect(await fs.readFile(path.join(workspaceDir, 'new.txt'), 'utf-8')).toBe('created after snapshot')

      // token 一次性：成功恢复后作废
      const replay = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview1.previewToken!)
      expect(replay.success).toBe(false)
      expect(replay.error).toMatch(/^Restore denied:/)
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })

  test('preview invalidated when the target workspace changes after preview (baseline binding)', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'snapshot')
      await writeFile(workspaceDir, 'b.txt', 'tracked')
      const created = await service.createCheckpoint(workspaceDir)
      expect(created).not.toBeNull()

      // preview：基线 = 当前工作区摘要
      const preview = await service.previewRestore(workspaceDir, created!.checkpointId)
      expect(preview.preview.success).toBe(true)
      expect(preview.previewToken).toBeTruthy()
      expect(preview.baselineDigest).toBeTruthy()

      // 目标变化（快照内文件被改写）→ 旧 preview 失效：apply 前重新比对拒绝
      await writeFile(workspaceDir, 'a.txt', 'changed after preview')
      const denied = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview.previewToken!)
      expect(denied.success).toBe(false)
      expect(denied.error).toMatch(/^Restore denied:/)
      // 工作区未被改写
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('changed after preview')

      // 目标再次变化（新增文件也算变化）→ 仍然拒绝
      const preview2 = await service.previewRestore(workspaceDir, created!.checkpointId)
      await writeFile(workspaceDir, 'extra.txt', 'new untracked file')
      const denied2 = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview2.previewToken!)
      expect(denied2.success).toBe(false)

      // 重新 preview 后恢复成功
      const preview3 = await service.previewRestore(workspaceDir, created!.checkpointId)
      const restored = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview3.previewToken!)
      expect(restored.success).toBe(true)
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('snapshot')
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })

  test('deleteUntrackedFiles confirmed via preview deletes files created after snapshot', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'snapshot')
      const created = await service.createCheckpoint(workspaceDir)
      await writeFile(workspaceDir, 'a.txt', 'changed')
      await writeFile(workspaceDir, 'new.txt', 'untracked')

      const preview = await service.previewRestore(workspaceDir, created!.checkpointId, { deleteUntrackedFiles: true })
      expect(preview.preview.success).toBe(true)
      expect(preview.preview.deleted).toBe(1) // untracked new.txt（快照未记录）
      expect(preview.preview.untrackedPaths).toContain('new.txt')

      const restored = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview.previewToken!, {
        deleteUntrackedFiles: true,
      })
      expect(restored.success).toBe(true)
      expect(restored.deleted).toBe(1)
      await expect(fs.access(path.join(workspaceDir, 'new.txt'))).rejects.toThrow()
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('snapshot')
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })

  test('preview does not write any workspace file', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'snapshot')
      const created = await service.createCheckpoint(workspaceDir)
      await writeFile(workspaceDir, 'a.txt', 'changed')

      const preview = await service.previewRestore(workspaceDir, created!.checkpointId)
      expect(preview.preview.success).toBe(true)
      // 预览纯计算：工作区未被改写
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('changed')
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})

describe('CheckpointService delete chain protection', () => {
  test('delete rejects base referenced by a successor (computeForcedKeepIds closure)', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'v1')
      const first = await service.createCheckpoint(workspaceDir)
      await writeFile(workspaceDir, 'a.txt', 'v2')
      const second = await service.createCheckpoint(workspaceDir)
      expect(second!.baseCheckpointId).toBe(first!.checkpointId)

      // 默认：被后继引用为 base → 拒绝删除
      const rejected = await service.deleteCheckpoint(workspaceDir, first!.checkpointId)
      expect(rejected.success).toBe(false)
      expect(rejected.rejected).toContain('chain protection')
      expect(rejected.deleted).toBe(false)

      // manifest 仍在
      const wsId = service.conversationIdFor(workspaceDir)
      await expect(
        fs.access(path.join(service.checkpointsDir, wsId, 'manifests', `${first!.checkpointId}.json`)),
      ).resolves.toBeUndefined()

      // 后继本身可删（只减引用，blob 仍在池中）
      const deletedSuccessor = await service.deleteCheckpoint(workspaceDir, second!.checkpointId)
      expect(deletedSuccessor.success).toBe(true)
      expect(deletedSuccessor.deleted).toBe(true)
      await expect(
        fs.access(path.join(service.checkpointsDir, wsId, 'manifests', `${second!.checkpointId}.json`)),
      ).rejects.toThrow()

      // base 不再被引用后可删；force 显式跳过链保护
      await writeFile(workspaceDir, 'a.txt', 'v3')
      const third = await service.createCheckpoint(workspaceDir)
      const forced = await service.deleteCheckpoint(workspaceDir, first!.checkpointId, { force: true })
      expect(forced.success).toBe(true)
      expect(forced.deleted).toBe(true)
      await expect(
        fs.access(path.join(service.checkpointsDir, wsId, 'manifests', `${first!.checkpointId}.json`)),
      ).rejects.toThrow()
      void third
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })

  test('computeForcedKeepIds ancestor closure protects transitive bases', () => {
    // 链 A → B → C（C.base=B，B.base=A）
    const records: CheckpointRecord[] = [
      { id: 'A', conversationId: 'c', messageIndex: 0, toolName: 't', phase: 'before', timestamp: 1, backupDir: 'A', fileCount: 0, contentHash: 'h', type: 'full' },
      { id: 'B', conversationId: 'c', messageIndex: 1, toolName: 't', phase: 'before', timestamp: 2, backupDir: 'B', fileCount: 0, contentHash: 'h', type: 'incremental', baseCheckpointId: 'A' },
      { id: 'C', conversationId: 'c', messageIndex: 2, toolName: 't', phase: 'before', timestamp: 3, backupDir: 'C', fileCount: 0, contentHash: 'h', type: 'incremental', baseCheckpointId: 'B' },
    ]
    // 只保留 C → 闭包必须保护 C 的全部祖先 A、B
    const forcedKeep = computeForcedKeepIds(records, new Set(['C']))
    expect(forcedKeep.has('C')).toBe(true)
    expect(forcedKeep.has('B')).toBe(true)
    expect(forcedKeep.has('A')).toBe(true)
    // 保留 A 时不会向上误保护（A 无祖先）
    const forcedKeepA = computeForcedKeepIds(records, new Set(['A']))
    expect(forcedKeepA.has('B')).toBe(false)
  })
})

describe('CheckpointService blob GC (dry-run, refcount, grace period)', () => {
  test('delete only decrements refs; GC dry-run lists orphans; GC removes refcount-0 blobs', async () => {
    const { workspaceDir, service } = await makeEnv({ blobGracePeriodDays: 0 })
    try {
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      await writeFile(workspaceDir, 'b.txt', 'beta')
      const created = await service.createCheckpoint(workspaceDir)
      const blobsDir = blobsDirOf(service, workspaceDir)
      const hashes = await listBlobHashes(blobsDir)
      expect(hashes).toHaveLength(2)

      // 被引用：GC dry-run 不应列出任何 blob
      const gcWhileReferenced = await service.collectGarbage(workspaceDir)
      expect(gcWhileReferenced.dryRun).toBe(true)
      expect(gcWhileReferenced.removedBlobs).toEqual([])
      expect(gcWhileReferenced.pendingBlobs).toEqual([])
      // 4.12-L3：refsVerified 改名 blobsScanned（实为 blob 池文件数，名实相符）
      expect(gcWhileReferenced.blobsScanned).toBe(2)

      // 删除：只减引用（blob 物理仍在）
      const deleted = await service.deleteCheckpoint(workspaceDir, created!.checkpointId)
      expect(deleted.success).toBe(true)
      expect(await listBlobHashes(blobsDir)).toHaveLength(2)

      // 引用归零：dry-run 列出待删 blob，不删除
      const dryRun = await service.collectGarbage(workspaceDir)
      expect(dryRun.dryRun).toBe(true)
      expect(dryRun.removedBlobs.sort()).toEqual(hashes)
      expect(dryRun.removedBytes).toBe(0)
      expect(dryRun.pendingBlobs).toEqual([])
      expect(await listBlobHashes(blobsDir)).toHaveLength(2)

      // 真实 GC（grace=0）：物理回收
      const collected = await service.collectGarbage(workspaceDir, { dryRun: false })
      expect(collected.removedBlobs.sort()).toEqual(hashes)
      expect(collected.removedBytes).toBeGreaterThan(0)
      expect(await listBlobHashes(blobsDir)).toEqual([])

      // 幂等：再次 GC 无内容
      const again = await service.collectGarbage(workspaceDir, { dryRun: false })
      expect(again.removedBlobs).toEqual([])
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })

  test('GC respects grace period: orphans inside grace stay pending', async () => {
    const { workspaceDir, service } = await makeEnv({ blobGracePeriodDays: 365 })
    try {
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      const created = await service.createCheckpoint(workspaceDir)
      const blobsDir = blobsDirOf(service, workspaceDir)
      const hashes = await listBlobHashes(blobsDir)
      expect(hashes).toHaveLength(1)

      await service.deleteCheckpoint(workspaceDir, created!.checkpointId)

      // grace=365 天：孤儿仍在 grace 内 → pending，不删除
      const dryRun = await service.collectGarbage(workspaceDir)
      expect(dryRun.removedBlobs).toEqual([])
      expect(dryRun.pendingBlobs).toHaveLength(1)
      expect(dryRun.pendingBlobs[0]!.hash).toBe(hashes[0])
      expect(dryRun.pendingBlobs[0]!.orphanedSince).toBeGreaterThan(0)

      // 真实 GC 同样受 grace 约束
      const collected = await service.collectGarbage(workspaceDir, { dryRun: false })
      expect(collected.removedBlobs).toEqual([])
      expect(collected.pendingBlobs).toHaveLength(1)
      expect(await listBlobHashes(blobsDir)).toHaveLength(1)
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })

  test('shared blobs survive deletion of one referencing checkpoint', async () => {
    const { workspaceDir, service } = await makeEnv({ blobGracePeriodDays: 0 })
    try {
      await writeFile(workspaceDir, 'shared.txt', 'same content')
      const first = await service.createCheckpoint(workspaceDir)
      const second = await service.createCheckpoint(workspaceDir) // 内容未变 → 全复用
      expect(second!.sizeBytes).toBe(0)
      const blobsDir = blobsDirOf(service, workspaceDir)
      expect(await listBlobHashes(blobsDir)).toHaveLength(1)

      // 删除第一份：blob 仍被第二份引用 → GC 不回收
      await service.deleteCheckpoint(workspaceDir, first!.checkpointId)
      const gc = await service.collectGarbage(workspaceDir)
      expect(gc.removedBlobs).toEqual([])
      expect(gc.pendingBlobs).toEqual([])
      expect(await listBlobHashes(blobsDir)).toHaveLength(1)
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })

  test('GC removes orphan manifests (not referenced by any record) and reclaims their blobs (M3)', async () => {
    const { workspaceDir, service } = await makeEnv({ blobGracePeriodDays: 0 })
    try {
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      const created = await service.createCheckpoint(workspaceDir)
      const wsId = service.conversationIdFor(workspaceDir)
      const blobsDir = blobsDirOf(service, workspaceDir)
      const hashes = await listBlobHashes(blobsDir)
      expect(hashes).toHaveLength(1)

      // 模拟记录丢失：直接从 records.json 移除该记录（manifest 残留为孤儿，blob 引用永不归零）
      const recordsFile = path.join(service.checkpointsDir, 'records.json')
      const records = JSON.parse(await fs.readFile(recordsFile, 'utf-8'))
      await fs.writeFile(
        recordsFile,
        JSON.stringify(records.filter((r: { id: string }) => r.id !== created!.checkpointId), null, 2),
        'utf-8',
      )
      const manifestPath = path.join(service.checkpointsDir, wsId, 'manifests', `${created!.checkpointId}.json`)

      // dry-run：报告孤儿 manifest（issue），不删除任何文件
      const dryRun = await service.collectGarbage(workspaceDir)
      expect(dryRun.dryRun).toBe(true)
      expect(dryRun.issue).toContain('orphan manifests')
      await expect(fs.access(manifestPath)).resolves.toBeUndefined()

      // 真实 GC：孤儿 manifest 被删除 + 其 blob 可回收（引用归零）
      const collected = await service.collectGarbage(workspaceDir, { dryRun: false })
      expect(collected.removedBlobs.sort()).toEqual(hashes)
      await expect(fs.access(manifestPath)).rejects.toThrow()

      // 幂等：再次 GC 无内容
      const again = await service.collectGarbage(workspaceDir, { dryRun: false })
      expect(again.removedBlobs).toEqual([])
      expect(again.issue).toBeUndefined()
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})

describe('CheckpointService staging quarantine (failure evidence preserved)', () => {
  test('staged content mismatch moves evidence into quarantine, never silently deleted', async () => {
    // BlobStore 单元级：stageAndCommit 校验失败（CP-TOCTOU-1）→ 证据进 quarantine + 条目记录
    const rootDir = await createTempDir('dsh-checkpoint-blobstore-')
    try {
      const store = new BlobStore(rootDir)
      await store.initialize()
      const srcPath = path.join(rootDir, 'src.txt')
      await fs.writeFile(srcPath, 'real content', 'utf-8')
      const opId = 'op_test_1'

      // 期望 hash 与实际不符 → StageMismatchError，staged 副本留在 staging
      let stagedPath: string | undefined
      try {
        await store.stageAndCommit(opId, srcPath, 'f'.repeat(64))
        expect.unreachable('stageAndCommit should have thrown')
      } catch (err) {
        expect((err as Error).message).toMatch(/hash mismatch/)
        stagedPath = (err as { stagedPath?: string }).stagedPath
      }
      expect(stagedPath).toBeTruthy()

      // 失败项移入 quarantine：证据文件 + entries.json 记录（不静默删除）
      await store.quarantine(opId, 'ws_test/src.txt', 'staged content hash mismatch', stagedPath)
      const stagingLeftovers = await fs.readdir(store.stagingDir(opId)).catch(() => [])
      expect(stagingLeftovers).toEqual([]) // 证据已移走
      const quarantineEntries = await fs.readdir(store.quarantineRootDir)
      expect(quarantineEntries).toContain(opId)
      const evidence = await fs.readdir(path.join(store.quarantineRootDir, opId))
      expect(evidence.some(name => name.endsWith('.part'))).toBe(true) // 原始证据保留
      const entries = await store.readQuarantineEntries(opId)
      expect(entries.some(entry => entry.path === 'ws_test/src.txt' && entry.reason.includes('hash mismatch'))).toBe(true)

      // cleanupStaging 不触碰 quarantine（证据仍在）
      await store.cleanupStaging(opId)
      expect(await fs.readdir(path.join(store.quarantineRootDir, opId))).toHaveLength(evidence.length)
      expect(await store.readQuarantineEntries(opId)).toHaveLength(1)
    } finally {
      await cleanup(rootDir)
    }
  })

  test('create with a staging failure quarantines evidence and keeps the file protected', async () => {
    // service 级：staged 文件哈希被注入为与扫描期不一致（CP-TOCTOU-1 模拟）
    // → markUnbacked + 证据进 quarantine + 恢复时该文件受保护
    const mocked = vi.mocked(fileHashing.hashFileStreaming)
    const real = mocked.getMockImplementation()!
    mocked.mockImplementation(async filePath => {
      if (/[\\/]staging[\\/]/.test(filePath)) {
        return 'f'.repeat(64) // 伪造 staged 哈希 → 与扫描期不一致
      }
      return real(filePath)
    })
    const { workspaceDir, dataRoot, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'payload')
      const created = await service.createCheckpoint(workspaceDir)
      expect(created).not.toBeNull()
      // a.txt 备份失败：unbackedPaths 记录（恢复时受保护）
      expect(created!.fileCount).toBe(0)

      // 证据在 quarantine/<opId>/：entries.json + staged .part 文件
      const wsId = service.conversationIdFor(workspaceDir)
      const quarantineRoot = path.join(service.checkpointsDir, wsId, 'quarantine')
      const opDirs = await fs.readdir(quarantineRoot)
      expect(opDirs.length).toBeGreaterThan(0)
      const entries = await fs.readFile(path.join(quarantineRoot, opDirs[0]!, 'entries.json'), 'utf-8')
      expect(entries).toContain('a.txt')

      // staging 已清理
      const staging = await fs.readdir(path.join(service.checkpointsDir, wsId, 'staging'))
      expect(staging).toEqual([])

      // 恢复不删除未备份文件（受保护）
      await writeFile(workspaceDir, 'a.txt', 'changed after failed snapshot')
      const preview = await service.previewRestore(workspaceDir, created!.checkpointId)
      expect(preview.preview.success).toBe(true)
      const restored = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview.previewToken!)
      expect(restored.success).toBe(true)
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('changed after failed snapshot')
    } finally {
      mocked.mockImplementation(real)
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })
})

describe('CheckpointService verify integrity', () => {
  test('verify reports blob missing / hash mismatch issues', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      await writeFile(workspaceDir, 'b.txt', 'beta')
      const created = await service.createCheckpoint(workspaceDir)
      const blobsDir = blobsDirOf(service, workspaceDir)
      const hashes = await listBlobHashes(blobsDir)
      expect(hashes).toHaveLength(2)

      // 删除一个 blob → verify 报 missing
      await fs.rm(path.join(blobsDir, hashes[0]!), { force: true })
      const verified = await service.verifyCheckpoint(created!.checkpointId)
      expect(verified.ok).toBe(false)
      expect(verified.checkedFiles).toBe(1)
      expect(verified.issues.some(issue => issue.includes('blob missing'))).toBe(true)
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})

describe('CheckpointService retention', () => {
  test('eviction skips checkpoints referenced as base (H1): every remaining checkpoint previews and restores', async () => {
    const { workspaceDir, service } = await makeEnv({ maxCheckpoints: 2 })
    try {
      await writeFile(workspaceDir, 'a.txt', 'v1')
      const first = await service.createCheckpoint(workspaceDir)
      await writeFile(workspaceDir, 'a.txt', 'v2')
      const second = await service.createCheckpoint(workspaceDir)
      await writeFile(workspaceDir, 'a.txt', 'v3')
      const third = await service.createCheckpoint(workspaceDir)

      // 第三个创建后触发保留策略清理。链 A→B→C 中 A、B 均被后继引用为 base——
      // 驱逐会破坏增量链（resolveChainState overlay/files 交叉校验 fail-closed），
      // 必须跳过（H1：链完整性优先于数量上限，保留策略退化为尽力而为）。
      const listed = await service.listCheckpoints(workspaceDir)
      const ids = listed.items.map(item => item.id)
      expect(ids).toContain(first!.checkpointId)
      expect(ids).toContain(second!.checkpointId)
      expect(ids).toContain(third!.checkpointId)

      // 剩余节点（全部）都可 preview + restore（回归：驱逐前 second/third 全部 fail-closed）
      for (const item of listed.items) {
        const preview = await service.previewRestore(workspaceDir, item.id)
        expect(preview.preview.success).toBe(true)
        const restored = await service.restoreCheckpoint(workspaceDir, item.id, preview.previewToken!)
        expect(restored.success).toBe(true)
      }
      // 恢复顺序 = 列表序（新→旧）：最后恢复的是最旧节点 → 工作区 = 第一份状态（v1）
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('v1')

      // manifest 未被误删；blob 仍在池中（未被驱逐路径减引用）
      const wsId = service.conversationIdFor(workspaceDir)
      await expect(
        fs.access(path.join(service.checkpointsDir, wsId, 'manifests', `${first!.checkpointId}.json`)),
      ).resolves.toBeUndefined()
      expect(await listBlobHashes(blobsDirOf(service, workspaceDir))).toHaveLength(3)
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })

  test('eviction still reclaims childless checkpoints (corrupt predecessor) without breaking the chain', async () => {
    const { workspaceDir, dataRoot, service } = await makeEnv({ maxCheckpoints: 1 })
    try {
      await writeFile(workspaceDir, 'a.txt', 'v1')
      const first = await service.createCheckpoint(workspaceDir)

      // 破坏 first 的 manifest（等价断链）——换新服务实例（无内存缓存）重新解析
      const wsId = service.conversationIdFor(workspaceDir)
      service.dispose()
      await fs.rm(path.join(service.checkpointsDir, wsId, 'manifests', `${first!.checkpointId}.json`), { force: true })
      const service2 = makeService(dataRoot, { maxCheckpoints: 1 })
      await service2.initialize()
      try {
        await writeFile(workspaceDir, 'a.txt', 'v2')
        const second = await service2.createCheckpoint(workspaceDir)
        expect(second).not.toBeNull()
        expect(second!.type).toBe('full') // 父链损坏 → 从完整备份开始

        // 驱逐触发：first 无后继（second 是 full，不引用它）→ 被驱逐；链完整
        const listed = await service2.listCheckpoints(workspaceDir)
        expect(listed.total).toBe(1)
        expect(listed.items[0]!.id).toBe(second!.checkpointId)
        await expect(
          fs.access(path.join(service2.checkpointsDir, wsId, 'manifests', `${first!.checkpointId}.json`)),
        ).rejects.toThrow()

        // 剩余节点可 preview/restore
        const preview = await service2.previewRestore(workspaceDir, second!.checkpointId)
        expect(preview.preview.success).toBe(true)
        const restored = await service2.restoreCheckpoint(workspaceDir, second!.checkpointId, preview.previewToken!)
        expect(restored.success).toBe(true)
        expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('v2')
      } finally {
        service2.dispose()
      }
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })
})

describe('CheckpointService failed create (ghost record prevention, H2)', () => {
  test('incrementRefs failure after manifest write leaves no ghost record in records.json', async () => {
    // H2：记录提交前 incrementRefs 失败 → catch 回滚 manifest；记录从未提交 → 无幽灵记录
    const spy = vi
      .spyOn(BlobStore.prototype, 'incrementRefs')
      .mockRejectedValue(new Error('injected incrementRefs failure'))
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'payload')
      const result = await service.createCheckpoint(workspaceDir)
      expect(result).toBeNull()

      // records.json 无残留（无指向已删 manifest 的幽灵记录；文件不存在 = 从未提交，更强）
      const recordsRaw = JSON.parse(await fs.readFile(path.join(service.checkpointsDir, 'records.json'), 'utf-8').catch(() => '[]'))
      expect(recordsRaw).toEqual([])
      // manifest 已回滚（不可见）
      const wsId = service.conversationIdFor(workspaceDir)
      expect(await fs.readdir(path.join(service.checkpointsDir, wsId, 'manifests')).catch(() => [])).toEqual([])
    } finally {
      spy.mockRestore()
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})

describe('CheckpointService create cancellation mapping (L4)', () => {
  test('createCheckpoint maps cancelled lock wait to the canonical cancellation error', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      const controller = new AbortController()
      controller.abort()
      // 参照 restore/delete/gc：取消归一为 CHECKPOINT_LOCK_CANCELLED_MESSAGE（不记 error 日志）
      await expect(service.createCheckpoint(workspaceDir, { signal: controller.signal })).rejects.toThrow(
        'Checkpoint operation was cancelled',
      )
      // 无残留记录/manifest（records.json 不存在 = 从未提交）
      const recordsRaw = JSON.parse(await fs.readFile(path.join(service.checkpointsDir, 'records.json'), 'utf-8').catch(() => '[]'))
      expect(recordsRaw).toEqual([])
      const wsId = service.conversationIdFor(workspaceDir)
      expect(await fs.readdir(path.join(service.checkpointsDir, wsId, 'manifests')).catch(() => [])).toEqual([])
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})

describe('CheckpointService records.json corruption (L6)', () => {
  test('corrupt records.json is preserved as .corrupt-<ts> evidence and treated as empty', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      const recordsFile = path.join(service.checkpointsDir, 'records.json')
      const corrupt = '{"not":"an array"'
      await fs.writeFile(recordsFile, corrupt, 'utf-8')

      // 损坏读取：返回空列表（不抛错）
      const listed = await service.listCheckpoints(workspaceDir)
      expect(listed.total).toBe(0)

      // 证据保留：原内容被改名 .corrupt-<ts>（不静默丢弃可能含全部记录的文件）
      const names = await fs.readdir(service.checkpointsDir)
      const evidence = names.filter(name => name.startsWith('records.json.corrupt-'))
      expect(evidence.length).toBeGreaterThan(0)
      expect(await fs.readFile(path.join(service.checkpointsDir, evidence[0]!), 'utf-8')).toBe(corrupt)

      // 之后可正常创建（写入全新 records.json）
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      const created = await service.createCheckpoint(workspaceDir)
      expect(created).not.toBeNull()
      expect((await service.listCheckpoints(workspaceDir)).total).toBe(1)
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})

describe('CheckpointService restore idempotent deletion (M2)', () => {
  test('unlink ENOENT is treated as success (idempotent delete), not delete_failed', async () => {
    const workspaceDir = await createTempDir('dsh-checkpoint-ws-')
    const dataRoot = await createTempDir('dsh-checkpoint-data-')
    // 自定义 writer：unlink 恒抛 ENOENT（模拟删除目标在恢复前已被移除）
    const nodeWriter = createNodeFsRestoreWorkspaceWriter()
    const writer: RestoreWorkspaceWriter = {
      ...nodeWriter,
      async unlink() {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      },
    }
    const service = new CheckpointService(
      {
        dataRoot,
        maxCheckpoints: -1,
        excludeProfiles: {},
        excludePatterns: [],
        maxFileSizeBytes: 50 * 1024 * 1024,
        blobGracePeriodDays: 7,
        restoreProtectionPoint: false,
      },
      writer,
    )
    await service.initialize()
    try {
      await writeFile(workspaceDir, 'a.txt', 'snapshot')
      const created = await service.createCheckpoint(workspaceDir)
      expect(created).not.toBeNull()
      // 快照后新建文件：恢复时确认删除（unlink 目标已不存在 → ENOENT）
      await writeFile(workspaceDir, 'extra.txt', 'untracked')
      const preview = await service.previewRestore(workspaceDir, created!.checkpointId, { deleteUntrackedFiles: true })
      expect(preview.preview.success).toBe(true)
      const restored = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview.previewToken!, {
        deleteUntrackedFiles: true,
      })
      // ENOENT 幂等成功，不整次失败（修复前：delete_failed → success=false）
      expect(restored.success).toBe(true)
      expect(restored.deleted).toBe(1)
      expect(restored.failures).toBeUndefined()
      // 快照文件仍正常恢复
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('snapshot')
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })
})

describe('CheckpointService isolation across workspaces', () => {
  test('records and blob pools are keyed by workspace root id (cwd)', async () => {
    const wsA = await createTempDir('dsh-checkpoint-wsA-')
    const wsB = await createTempDir('dsh-checkpoint-wsB-')
    const { service } = await makeEnv()
    try {
      await writeFile(wsA, 'a.txt', 'A')
      await writeFile(wsB, 'b.txt', 'B')
      const cpA = await service.createCheckpoint(wsA)
      const cpB = await service.createCheckpoint(wsB)

      expect(cpA!.checkpointId).not.toBe(cpB!.checkpointId)
      expect(service.conversationIdFor(wsA)).not.toBe(service.conversationIdFor(wsB))

      const listA = await service.listCheckpoints(wsA)
      const listB = await service.listCheckpoints(wsB)
      expect(listA.total).toBe(1)
      expect(listB.total).toBe(1)
      expect(listA.items[0]!.id).toBe(cpA!.checkpointId)
      expect(listB.items[0]!.id).toBe(cpB!.checkpointId)

      // blob 池独立
      expect(await listBlobHashes(blobsDirOf(service, wsA))).toHaveLength(1)
      expect(await listBlobHashes(blobsDirOf(service, wsB))).toHaveLength(1)
    } finally {
      service.dispose()
      await cleanup(wsA, wsB)
    }
  })
})

describe('CheckpointService restore writes via DSH fs (P0-08)', () => {
  test('restoreCheckpoint writes workspace files through ctx.fs.writeText (real LocalFileSystem)', async () => {
    const workspaceDir = await createTempDir('dsh-checkpoint-ws-')
    const dataRoot = await createTempDir('dsh-checkpoint-data-')
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalFileSystem, { cwd: workspaceDir })
    try {
      const config: CheckpointServiceConfig = {
        dataRoot,
        maxCheckpoints: -1,
        excludeProfiles: {},
        excludePatterns: [],
        maxFileSizeBytes: 50 * 1024 * 1024,
        blobGracePeriodDays: 7,
      }
      // 生产接线方式（index.ts）：服务注入基于 ctx.fs 的 DSH workspace writer
      const service = new CheckpointService(config, createDshFsRestoreWorkspaceWriter(ctx.fs))
      await service.initialize()

      await writeFile(workspaceDir, 'a.txt', 'original')
      await writeFile(workspaceDir, 'keep.txt', 'untracked')
      const created = await service.createCheckpoint(workspaceDir)
      expect(created).not.toBeNull()

      await writeFile(workspaceDir, 'a.txt', 'modified')
      const preview = await service.previewRestore(workspaceDir, created!.checkpointId)
      expect(preview.previewToken).toBeTruthy()

      const spy = vi.spyOn(ctx.fs, 'writeText')
      const restored = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview.previewToken!)
      expect(restored.success).toBe(true)
      expect(restored.restored).toBe(1)

      // 恢复写盘经过 DSH fs：writeText 收到目标/内容/sandboxPolicy
      expect(spy).toHaveBeenCalledTimes(1)
      const call = spy.mock.calls[0]!
      expect(call[0]).toMatchObject({ displayPath: path.join(workspaceDir, 'a.txt') })
      expect(call[1]).toBe('original')
      expect(call[4]).toEqual({ mode: 'workspace-write', workspaceRoot: workspaceDir })
      // 落盘结果正确；门闸/删除语义不变（未跟踪文件保留）
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('original')
      await expect(fs.access(path.join(workspaceDir, 'keep.txt'))).resolves.toBeUndefined()

      service.dispose()
    } finally {
      await fiber.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })
})

describe('CheckpointService restore protection point (PLAN_V2 §7.6)', () => {
  test('restore creates a recoverable protection point by default and restore still succeeds', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'snapshot')
      const created = await service.createCheckpoint(workspaceDir)
      expect(created).not.toBeNull()
      await writeFile(workspaceDir, 'a.txt', 'changed after snapshot')

      const preview = await service.previewRestore(workspaceDir, created!.checkpointId)
      expect(preview.preview.success).toBe(true)
      const restored = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview.previewToken!)
      expect(restored.success).toBe(true)
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('snapshot')

      // 保护点：恢复前自动创建的新 checkpoint（最新一条；描述在 domain 记录中）
      const records = await service.listCheckpoints(workspaceDir)
      expect(records.total).toBe(2)
      const protection = records.items[0]!
      expect(protection.id).not.toBe(created!.checkpointId)
      const recordsRaw = JSON.parse(await fs.readFile(path.join(service.checkpointsDir, 'records.json'), 'utf-8'))
      const protectionRecord = recordsRaw.find((r: { id: string }) => r.id === protection.id) as { description?: string }
      expect(protectionRecord.description).toContain('恢复前自动保护点')

      // 保护点可恢复：恢复它 = 回到恢复前状态（a.txt = changed after snapshot）
      const preview2 = await service.previewRestore(workspaceDir, protection.id)
      expect(preview2.preview.success).toBe(true)
      const restored2 = await service.restoreCheckpoint(workspaceDir, protection.id, preview2.previewToken!)
      expect(restored2.success).toBe(true)
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('changed after snapshot')
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })

  test('restoreProtectionPoint=false skips the automatic protection point', async () => {
    const { workspaceDir, service } = await makeEnv({ restoreProtectionPoint: false })
    try {
      await writeFile(workspaceDir, 'a.txt', 'snapshot')
      const created = await service.createCheckpoint(workspaceDir)
      expect(created).not.toBeNull()
      await writeFile(workspaceDir, 'a.txt', 'changed')

      const preview = await service.previewRestore(workspaceDir, created!.checkpointId)
      const restored = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview.previewToken!)
      expect(restored.success).toBe(true)
      // 未新增保护点：记录数不变
      const records = await service.listCheckpoints(workspaceDir)
      expect(records.total).toBe(1)
      expect(records.items[0]!.id).toBe(created!.checkpointId)
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })

  test('protection point creation failure does not block restore (warn + continue)', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'snapshot')
      const created = await service.createCheckpoint(workspaceDir)
      expect(created).not.toBeNull()
      await writeFile(workspaceDir, 'a.txt', 'changed')

      // 注入：恢复前保护点创建失败（executeBackup 返回 null = 失败）——恢复必须继续
      const spy = vi
        .spyOn(
          service as unknown as { executeBackup: (...args: never[]) => Promise<CreateCheckpointResult | null> },
          'executeBackup',
        )
        .mockResolvedValue(null)

      const preview = await service.previewRestore(workspaceDir, created!.checkpointId)
      const restored = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview.previewToken!)
      expect(restored.success).toBe(true)
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('snapshot')
      spy.mockRestore()

      // 保护点创建失败 → 未新增记录
      const records = await service.listCheckpoints(workspaceDir)
      expect(records.total).toBe(1)
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})

describe('CheckpointService stat-level hash reuse (CP-HASH-REUSE)', () => {
  test('stat reuse provides candidate hash; blob reuse re-verifies source content (H-11b)', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'v1')
      await writeFile(workspaceDir, 'b.txt', 'keep')
      const first = await service.createCheckpoint(workspaceDir)
      expect(first).not.toBeNull()

      // 记录持久化 fileStats（含 mode），供下一次快照 stat 级复用
      const recordsRaw = JSON.parse(await fs.readFile(path.join(service.checkpointsDir, 'records.json'), 'utf-8'))
      const firstRecord = recordsRaw[0] as { fileStats?: Record<string, { size?: number; mtimeNs?: string; mode?: number }> }
      expect(firstRecord.fileStats).toBeTruthy()
      const wsId = service.conversationIdFor(workspaceDir)
      expect(firstRecord.fileStats![`${wsId}/a.txt`]).toMatchObject({ size: 2 })
      expect(typeof firstRecord.fileStats![`${wsId}/b.txt`]!.mode).toBe('number')

      // 只改 a.txt：快照构建对 b.txt 做 stat 级复用——H-11b 修复后 stat 命中仍重哈希
      // 确认内容（builder 侧 1 次），blob 已存在时 service 复用前再哈希比对（service 侧
      // 1 次），共 2 次；结果一致仍复用（不新增 blob）。a.txt 变化 → builder 重算 1 次，
      // 新 blob 不存在 → 无 service 侧复用校验。
      await writeFile(workspaceDir, 'a.txt', 'v2')
      const hashing = vi.mocked(fileHashing.hashFileStreaming)
      hashing.mockClear()
      const second = await service.createCheckpoint(workspaceDir)
      expect(second).not.toBeNull()
      expect(second!.type).toBe('incremental')

      const bPath = path.join(workspaceDir, 'b.txt')
      const aPath = path.join(workspaceDir, 'a.txt')
      expect(hashing.mock.calls.filter(call => call[0] === bPath)).toHaveLength(2) // stat 复用重哈希 + blob 复用前校验
      expect(hashing.mock.calls.filter(call => call[0] === aPath)).toHaveLength(1) // 变化 → 重算

      // 复用结果正确：b.txt hash 与第一份一致；a.txt hash 变化；changes 只含 a.txt
      const wsDir = path.join(service.checkpointsDir, wsId)
      const m1 = JSON.parse(await fs.readFile(path.join(wsDir, 'manifests', `${first!.checkpointId}.json`), 'utf-8'))
      const m2 = JSON.parse(await fs.readFile(path.join(wsDir, 'manifests', `${second!.checkpointId}.json`), 'utf-8'))
      expect(m2.files[`${wsId}/b.txt`].hash).toBe(m1.files[`${wsId}/b.txt`].hash)
      expect(m2.files[`${wsId}/a.txt`].hash).not.toBe(m1.files[`${wsId}/a.txt`].hash)
      expect(m2.changes).toHaveLength(1)
      expect(m2.changes[0]).toMatchObject({ path: `${wsId}/a.txt`, type: 'modified' })
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})

describe('CheckpointService lossless JSON tool returns (H-1)', () => {
  test('create/list/preview/restore results contain no undefined-valued keys', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      const created = await service.createCheckpoint(workspaceDir)
      expect(created).not.toBeNull()

      // create：full 类型 → baseCheckpointId/description 未定义 → 键省略（lossless JSON）
      expect('baseCheckpointId' in created!).toBe(false)
      expect('description' in created!).toBe(false)
      expect(JSON.parse(JSON.stringify(created))).toEqual(created)

      // list：摘要可选字段（messageNodeId/baseCheckpointId）与 nextCursor 省略
      const listed = await service.listCheckpoints(workspaceDir)
      const item = listed.items[0]!
      expect('messageNodeId' in item).toBe(false)
      expect('baseCheckpointId' in item).toBe(false)
      expect('nextCursor' in listed).toBe(false)
      expect(JSON.parse(JSON.stringify(listed))).toEqual(listed)

      // preview：成功路径无 undefined 值键（unbackedPaths/excludedNote 省略）
      const preview = await service.previewRestore(workspaceDir, created!.checkpointId)
      expect(preview.preview.success).toBe(true)
      expect('unbackedPaths' in preview.preview).toBe(false)
      expect('excludedNote' in preview.preview).toBe(false)
      expect(JSON.parse(JSON.stringify(preview))).toEqual(preview)

      // restore 成功路径：failures/error/unbackedPaths/excludedNote 省略
      const restored = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview.previewToken!)
      expect(restored.success).toBe(true)
      expect('failures' in restored).toBe(false)
      expect('error' in restored).toBe(false)
      expect('unbackedPaths' in restored).toBe(false)
      expect('excludedNote' in restored).toBe(false)
      expect(JSON.parse(JSON.stringify(restored))).toEqual(restored)
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})

describe('CheckpointService blob reuse re-verification (H-11b)', () => {
  test('stale candidate hash (blob exists for old content) is corrected to current content', async () => {
    const mocked = vi.mocked(fileHashing.hashFileStreaming)
    const real = mocked.getMockImplementation()!
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'AAAA')
      const first = await service.createCheckpoint(workspaceDir)
      expect(first).not.toBeNull()
      const blobsDir = blobsDirOf(service, workspaceDir)
      expect(await listBlobHashes(blobsDir)).toHaveLength(1)

      // 同 size 改写内容：stat 变化会触发快照构建重哈希——注入 builder 返回旧 hash，
      // 模拟「stat 级复用/陈旧候选 hash」场景（blob 池中该 hash 已存在 → 走复用分支）。
      const aPath = path.join(workspaceDir, 'a.txt')
      const oldHash = await real(aPath) // 'AAAA' 的真实内容哈希
      await fs.writeFile(aPath, 'BBBB', 'utf-8')
      let workspaceHashCalls = 0
      mocked.mockImplementation(async filePath => {
        if (/[\\/]staging[\\/]/.test(filePath)) {
          return real(filePath)
        }
        workspaceHashCalls += 1
        // 第 1 次（快照构建）返回陈旧候选 hash；之后（H-11b 复用前校验）返回真实 hash
        return workspaceHashCalls === 1 ? oldHash : real(filePath)
      })
      const second = await service.createCheckpoint(workspaceDir)
      expect(second).not.toBeNull()
      // H-11b：复用前重哈希发现内容已变 → 写入新 blob（内容寻址，hash 不同）
      expect(await listBlobHashes(blobsDir)).toHaveLength(2)

      // 恢复第二份 → 内容为最新 'BBBB'（修复前：复用旧 blob，恢复出陈旧 'AAAA'）
      await fs.writeFile(aPath, 'XXXX', 'utf-8')
      const preview = await service.previewRestore(workspaceDir, second!.checkpointId)
      expect(preview.preview.success).toBe(true)
      const restored = await service.restoreCheckpoint(workspaceDir, second!.checkpointId, preview.previewToken!)
      expect(restored.success).toBe(true)
      expect(await fs.readFile(aPath, 'utf-8')).toBe('BBBB')
    } finally {
      mocked.mockImplementation(real)
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})

describe('CheckpointService deleteUntrackedFiles binding (H-16)', () => {
  test('restore denied when deleteUntrackedFiles differs from the value confirmed at preview', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'snapshot')
      const created = await service.createCheckpoint(workspaceDir)
      await writeFile(workspaceDir, 'new.txt', 'untracked')

      // 预览未确认删除 untracked（默认 false）→ restore 带 true 必须拒绝
      const preview = await service.previewRestore(workspaceDir, created!.checkpointId)
      expect(preview.preview.success).toBe(true)
      const denied = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview.previewToken!, {
        deleteUntrackedFiles: true,
      })
      expect(denied.success).toBe(false)
      expect(denied.error).toMatch(/^Restore denied:/)
      expect(denied.error).toContain('deleteUntrackedFiles')
      // 工作区未被改写
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('snapshot')
      await expect(fs.access(path.join(workspaceDir, 'new.txt'))).resolves.toBeUndefined()

      // 重新预览（确认删除）后 restore 带 true → 成功且 untracked 被删
      const preview2 = await service.previewRestore(workspaceDir, created!.checkpointId, { deleteUntrackedFiles: true })
      const restored = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview2.previewToken!, {
        deleteUntrackedFiles: true,
      })
      expect(restored.success).toBe(true)
      await expect(fs.access(path.join(workspaceDir, 'new.txt'))).rejects.toThrow()
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})

describe('CheckpointService create cancellation propagation (M2)', () => {
  test('create aborted mid-backup rejects with the canonical cancellation error, not a generic create failure', async () => {
    const mocked = vi.mocked(fileHashing.hashFileStreaming)
    const real = mocked.getMockImplementation()!
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      const controller = new AbortController()
      let aborted = false
      mocked.mockImplementation(async filePath => {
        if (!aborted && !/[\\/]staging[\\/]/.test(filePath)) {
          aborted = true
          controller.abort()
        }
        return real(filePath)
      })
      await expect(service.createCheckpoint(workspaceDir, { signal: controller.signal })).rejects.toThrow(
        'Checkpoint operation was cancelled',
      )
      // 无残留记录/manifest（取消路径同样清理）
      const recordsRaw = JSON.parse(await fs.readFile(path.join(service.checkpointsDir, 'records.json'), 'utf-8').catch(() => '[]'))
      expect(recordsRaw).toEqual([])
    } finally {
      mocked.mockImplementation(real)
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})

describe('CheckpointService list empty cursor (M3)', () => {
  test('empty cursor string is treated as no cursor (first page, not empty page)', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      await service.createCheckpoint(workspaceDir)
      const noCursor = await service.listCheckpoints(workspaceDir)
      expect(noCursor.total).toBe(1)
      expect(noCursor.items).toHaveLength(1)

      const emptyCursor = await service.listCheckpoints(workspaceDir, { cursor: '' })
      expect(emptyCursor.total).toBe(1)
      expect(emptyCursor.items).toHaveLength(1)
      expect(emptyCursor.items[0]!.id).toBe(noCursor.items[0]!.id)
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})

describe('CheckpointService delete failure reason (M4)', () => {
  test('metadata write failure during delete is reported as a storage error, not chain protection', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      const created = await service.createCheckpoint(workspaceDir)
      expect(created).not.toBeNull()

      // 注入：记录写回失败（元数据 IO 错误）→ deleteCheckpointInternal 内部吞掉返回 false
      const store = (service as unknown as { store: { writeAllRecords: () => Promise<void> } }).store
      const spy = vi.spyOn(store, 'writeAllRecords').mockRejectedValue(new Error('injected metadata write failure'))
      const outcome = await service.deleteCheckpoint(workspaceDir, created!.checkpointId)
      expect(outcome.success).toBe(false)
      expect(outcome.deleted).toBe(false)
      // 修复前：误报为链保护拒绝（rejected 字段）；修复后：区分出存储/IO 错误
      expect(outcome.rejected).toBeUndefined()
      expect(outcome.reason).toBe('Failed to delete checkpoint (metadata write failed)')
      spy.mockRestore()

      // 记录未被删除
      const recordsRaw = JSON.parse(await fs.readFile(path.join(service.checkpointsDir, 'records.json'), 'utf-8'))
      expect(recordsRaw).toHaveLength(1)
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})

describe('CheckpointService verify unsafe conversationId (M5)', () => {
  test('verifyCheckpoint records an unsafe conversationId as an issue instead of throwing', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      const created = await service.createCheckpoint(workspaceDir)
      expect(created).not.toBeNull()

      // 模拟损坏记录：conversationId 改为不安全目录名（越界拼接）
      const recordsFile = path.join(service.checkpointsDir, 'records.json')
      const records = JSON.parse(await fs.readFile(recordsFile, 'utf-8'))
      const corrupted = records.map((r: { id: string }) =>
        r.id === created!.checkpointId ? { ...r, conversationId: '../../escape' } : r,
      )
      await fs.writeFile(recordsFile, JSON.stringify(corrupted, null, 2), 'utf-8')

      // 修复前：workspaceStorageFor 抛 'Unsafe workspace id' → verify 直接 reject
      // 修复后：catch → 记入 issues，verify 正常返回
      const verified = await service.verifyCheckpoint(created!.checkpointId)
      expect(verified.ok).toBe(false)
      expect(verified.issues.some(issue => issue.includes('Unsafe workspace id'))).toBe(true)
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})
describe('CheckpointService post-commit create failure does not evict old checkpoints (M8)', () => {
  test('staging cleanup failure after record commit rolls back only the new record; eviction is deferred and skipped', async () => {
    // maxCheckpoints=1：若创建成功，新存档会触发旧存档驱逐。注入记录提交之后的
    // staging 清理失败（修复前该步骤在驱逐之后——旧存档已被驱逐、新记录又被回滚，
    // 创建报告失败但数据已变更）。修复后 staging 清理先于驱逐，失败路径不含驱逐。
    const { workspaceDir, dataRoot, service } = await makeEnv({ maxCheckpoints: 1 })
    // 注入：记录提交后的 staging 清理失败（仅第一次调用；catch 内重试走真实实现）。
    // let + try 外声明：try 块作用域不向 finally 泄漏，finally 才能安全恢复。
    let spy: ReturnType<typeof vi.spyOn> | undefined
    try {
      await writeFile(workspaceDir, 'a.txt', 'v1')
      const first = await service.createCheckpoint(workspaceDir)
      expect(first).not.toBeNull()

      // 破坏 first 的 manifest：下一次创建 resolveChainState 失败 → 从完整备份开始
      // （新存档不引用 first，驱逐才有机会命中 first，链保护不会拦下驱逐）。
      const wsId = service.conversationIdFor(workspaceDir)
      await fs.rm(path.join(service.checkpointsDir, wsId, 'manifests', `${first!.checkpointId}.json`), { force: true })

      // 仅在 second 创建前装 mock（first 的 staging 清理走真实实现）
      spy = vi
        .spyOn(service as unknown as { quarantineStagingLeftovers: () => Promise<void> }, 'quarantineStagingLeftovers')
        .mockRejectedValueOnce(new Error('injected staging cleanup failure'))

      await writeFile(workspaceDir, 'a.txt', 'v2')
      const second = await service.createCheckpoint(workspaceDir)
      expect(second).toBeNull() // 创建失败（后期清理失败 → 回滚新记录）

      // 旧存档未被驱逐：records.json 仍只有 first（second 的记录已回滚）
      const records = await service.listCheckpoints(workspaceDir)
      expect(records.total).toBe(1)
      expect(records.items[0]!.id).toBe(first!.checkpointId)
      // 新存档的 manifest 已回滚
      const manifestsDir = path.join(service.checkpointsDir, wsId, 'manifests')
      expect(await fs.readdir(manifestsDir).catch(() => [])).toEqual([])
    } finally {
      spy?.mockRestore()
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })
})

describe('CheckpointService fault injection coverage (4.19-L1)', () => {
  test('blob commit rename failure quarantines evidence and keeps the file unbacked', async () => {
    // BlobStore.commitStaged 的 rename 失败分支（非 EEXIST/ENOTEMPTY/EPERM 复用路径）：
    // rename 抛错 → stageAndCommit 上抛 → create 路径 quarantine + markUnbacked，
    // 创建仍成功但该文件记录为未备份（恢复时受保护）。
    // 注：ESM 命名空间不可 spyOn，rename 已由文件级 vi.mock 包装为 vi.fn。
    const realRename = vi.mocked(fs.rename).getMockImplementation()!
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      const target = typeof to === 'string' ? to : String(to)
      if (/[\\/]blobs[\\/][a-f0-9]{64}$/.test(target)) {
        throw new Error('injected blob commit rename failure')
      }
      return realRename(from, to)
    })
    const { workspaceDir, dataRoot, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'payload')
      const created = await service.createCheckpoint(workspaceDir)
      expect(created).not.toBeNull()
      // rename 失败 → blob 未提交 → 文件记入 unbackedPaths（恢复时受保护）
      expect(created!.fileCount).toBe(0)
      const wsId = service.conversationIdFor(workspaceDir)
      const recordsRaw = JSON.parse(await fs.readFile(path.join(service.checkpointsDir, 'records.json'), 'utf-8'))
      const record = recordsRaw.find((r: { id: string }) => r.id === created!.checkpointId) as { unbackedPaths?: string[] }
      expect(record.unbackedPaths).toContain(`${wsId}/a.txt`)

      // 证据进 quarantine（entries.json 记录）
      const quarantineRoot = path.join(service.checkpointsDir, wsId, 'quarantine')
      const opDirs = await fs.readdir(quarantineRoot)
      expect(opDirs.length).toBeGreaterThan(0)
      const entries = await fs.readFile(path.join(quarantineRoot, opDirs[0]!, 'entries.json'), 'utf-8')
      expect(entries).toContain('a.txt')

      // 恢复不删除未备份文件（受保护）
      await writeFile(workspaceDir, 'a.txt', 'changed after failed snapshot')
      const preview = await service.previewRestore(workspaceDir, created!.checkpointId)
      expect(preview.preview.success).toBe(true)
      const restored = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview.previewToken!)
      expect(restored.success).toBe(true)
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('changed after failed snapshot')
    } finally {
      vi.mocked(fs.rename).mockReset()
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })

  test('workspace writer writeFile failure is reported as copy_failed; restore reports failure and leaves files untouched', async () => {
    const workspaceDir = await createTempDir('dsh-checkpoint-ws-')
    const dataRoot = await createTempDir('dsh-checkpoint-data-')
    const nodeWriter = createNodeFsRestoreWorkspaceWriter()
    const writer: RestoreWorkspaceWriter = {
      ...nodeWriter,
      async writeFile() {
        throw new Error('injected restore write failure')
      },
    }
    const service = new CheckpointService(
      {
        dataRoot,
        maxCheckpoints: -1,
        excludeProfiles: {},
        excludePatterns: [],
        maxFileSizeBytes: 50 * 1024 * 1024,
        blobGracePeriodDays: 7,
        restoreProtectionPoint: false,
      },
      writer,
    )
    await service.initialize()
    try {
      await writeFile(workspaceDir, 'a.txt', 'snapshot')
      const created = await service.createCheckpoint(workspaceDir)
      expect(created).not.toBeNull()
      await writeFile(workspaceDir, 'a.txt', 'changed')

      const preview = await service.previewRestore(workspaceDir, created!.checkpointId)
      expect(preview.preview.success).toBe(true)
      const restored = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview.previewToken!)
      // 写失败 → copy_failed 失败清单，success=false；目标文件保持当前内容（未被破坏）
      expect(restored.success).toBe(false)
      expect(restored.restored).toBe(0)
      expect(restored.failures).toHaveLength(1)
      expect(restored.failures![0]!.reason).toBe('copy_failed')
      expect(restored.failures![0]!.path).toBe('a.txt')
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('changed')
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })
})

describe('CheckpointService cross-workspace chain isolation (4.12-L2)', () => {
  test('getChainRecords ignores records from other workspaces when walking base ids (verify path)', async () => {
    const wsA = await createTempDir('dsh-checkpoint-wsA-')
    const wsB = await createTempDir('dsh-checkpoint-wsB-')
    const { service } = await makeEnv()
    try {
      await writeFile(wsA, 'a.txt', 'A')
      await writeFile(wsB, 'b.txt', 'B')
      const cpA = await service.createCheckpoint(wsA)
      const cpB = await service.createCheckpoint(wsB)
      expect(cpA).not.toBeNull()
      expect(cpB).not.toBeNull()

      // 损坏记录：cpA（本为 full）改成 incremental 且 base 指向另一工作区的 cpB——
      // 修复前 byId 图跨工作区捕获 cpB → 跨工作区混链（链上 manifest 从 cpB 的工作区
      // 加载、工作区校验错位）；修复后按 conversationId 过滤 → cpB 不可达 → broken，
      // verify 报「链断裂」而非误判通过。
      const recordsFile = path.join(service.checkpointsDir, 'records.json')
      const records = JSON.parse(await fs.readFile(recordsFile, 'utf-8'))
      const corrupted = records.map((r: { id: string }) =>
        r.id === cpA!.checkpointId ? { ...r, type: 'incremental', baseCheckpointId: cpB!.checkpointId } : r,
      )
      await fs.writeFile(recordsFile, JSON.stringify(corrupted, null, 2), 'utf-8')

      const verified = await service.verifyCheckpoint(cpA!.checkpointId)
      expect(verified.ok).toBe(false)
      expect(verified.issues.some(issue => issue.includes('Incremental chain is broken'))).toBe(true)
      // 链不跨工作区：损坏 base 找不到同工作区记录 → 只含目标自身，cpB 不计入
      expect(verified.chainLength).toBe(1)
    } finally {
      service.dispose()
      await cleanup(wsA, wsB)
    }
  })
})

describe('CheckpointService storage cache LRU (4.12-L5)', () => {
  test('workspace storage cache is capped and evicts least-recently-used entries', async () => {
    const { service } = await makeEnv()
    try {
      const svc = service as unknown as {
        workspaceStorageFor: (id: string) => CheckpointWorkspaceStorage
        storages: Map<string, CheckpointWorkspaceStorage>
      }
      const first = svc.workspaceStorageFor('ws_000')
      // 访问 110 个不同工作区：超过上限（100）后驱逐最久未用（ws_000 最早访问且未被再访问）
      for (let i = 1; i < 110; i += 1) {
        svc.workspaceStorageFor(`ws_${String(i).padStart(3, '0')}`)
      }
      expect(svc.storages.size).toBe(100)
      expect(svc.storages.has('ws_000')).toBe(false)
      expect(svc.storages.has('ws_109')).toBe(true)
      // LRU 命中刷新：重访 ws_109（当前最新）不触发驱逐、不重建
      const fresh109 = svc.workspaceStorageFor('ws_109')
      expect(fresh109).toBe(svc.storages.get('ws_109'))
      expect(svc.storages.size).toBe(100)
      // 重访被驱逐条目 → 按需重建（新实例），并驱逐下一个最久未用（ws_010）
      const recreated = svc.workspaceStorageFor('ws_000')
      expect(recreated).not.toBe(first)
      expect(svc.storages.size).toBe(100)
      expect(svc.storages.has('ws_010')).toBe(false)
    } finally {
      service.dispose()
    }
  })
})

describe('CheckpointService batch/byNodeIds deletion lock wiring (3.11-M5)', () => {
  test('deletion service uses the service lockManager and holds workspace-root key ∪ shell key', async () => {
    const { workspaceDir, service } = await makeEnv()
    try {
      const conversationId = service.conversationIdFor(workspaceDir)
      const svc = service as unknown as {
        lockManager: unknown
        deletionService: {
          lock: unknown
          deletionLockIds: (conversationId: string) => string[]
        }
      }
      // 壳层已注入 this.lockManager：批删/按节点删与创建/恢复/单删/GC 共用同一跨进程锁
      // 命名空间（同一 .locks 目录）——修复前缺省为进程级单例（系统临时目录命名空间），
      // 即便锁键一致也不互斥（blob 引用竞态防线失效）。
      expect(svc.deletionService.lock).toBe(svc.lockManager)
      // 锁键 = 壳层键（checkpoint-global-storage）∪ 工作区根键（conversationId = 工作区根
      // id，由 CheckpointDeletionService.deletionLockIds 追加）——与单删/创建/恢复/GC 的
      // 工作区根键互斥。
      const lockIds = svc.deletionService.deletionLockIds(conversationId)
      expect(lockIds).toContain('checkpoint-global-storage')
      expect(lockIds).toContain(conversationId)
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
    }
  })
})
