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
import { CheckpointService } from '../../src/checkpoints/service.ts'
import { computeForcedKeepIds } from '../../src/checkpoints/domain/CheckpointDeletionService.ts'
import { BlobStore, BLOB_HASH_PATTERN } from '../../src/checkpoints/domain/BlobStore.ts'
import * as fileHashing from '../../src/checkpoints/domain/fileHashing.ts'
import type { CheckpointRecord } from '../../src/checkpoints/domain/types.ts'
import { makeEnv, writeFile, createTempDir, cleanup } from './helpers.ts'

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
      expect(created!.excludedCount).toBeGreaterThanOrEqual(3) // node_modules/.git/logs
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

      // 无 token 拒绝
      const noToken = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, '')
      expect(noToken.success).toBe(false)
      expect(noToken.error).toContain('previewToken')

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
      expect(replay.error).toContain('previewToken')
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
      expect(denied.error).toContain('preview')
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
      expect(gcWhileReferenced.refsVerified).toBe(2)

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
  test('excess checkpoints are evicted oldest-first with chain protection', async () => {
    const { workspaceDir, service } = await makeEnv({ maxCheckpoints: 2 })
    try {
      await writeFile(workspaceDir, 'a.txt', 'v1')
      const first = await service.createCheckpoint(workspaceDir)
      await writeFile(workspaceDir, 'a.txt', 'v2')
      const second = await service.createCheckpoint(workspaceDir)
      await writeFile(workspaceDir, 'a.txt', 'v3')
      const third = await service.createCheckpoint(workspaceDir)

      // 第三个创建后触发清理：最旧 first 被驱逐（second 仍被 third 引用，受链保护）
      const listed = await service.listCheckpoints(workspaceDir)
      expect(listed.total).toBe(2)
      const ids = listed.items.map(item => item.id)
      expect(ids).not.toContain(first!.checkpointId)
      expect(ids).toContain(second!.checkpointId)
      expect(ids).toContain(third!.checkpointId)
      const wsId = service.conversationIdFor(workspaceDir)
      await expect(
        fs.access(path.join(service.checkpointsDir, wsId, 'manifests', `${first!.checkpointId}.json`)),
      ).rejects.toThrow()
      // 被驱逐的 blob 只减引用不物理删除（GC 负责）
      expect(await listBlobHashes(blobsDirOf(service, workspaceDir))).toHaveLength(3)
    } finally {
      service.dispose()
      await cleanup(workspaceDir)
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
