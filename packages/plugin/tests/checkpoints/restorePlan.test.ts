/**
 * 改自源仓库 gray-code-plugin/backend/__tests__/checkpoint/CheckpointRestoreEngine.test.ts
 * （恢复计划 / 引擎执行语义零改动，DSH 下用 vitest + os.tmpdir 临时目录；
 * 内容寻址布局适配：哈希算法为 sha256，新增 blobsDir/blobHashes 读取路径）。
 *
 * 覆盖：
 * - 完整备份恢复（文件 + 空目录）
 * - #29：快照后新建文件默认保留，确认后（deleteUntrackedFiles）才删除
 * - M-3：目录级排除条目按前缀保护其子树（protectedScopedPaths）
 * - missing_in_chain / hash_mismatch 失败清单
 * - 内容寻址布局：从 blobs/<hash> 恢复；缺失 blob → missing_in_chain
 */
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  computeRestorePlan,
  restoreWorkspaceSnapshot,
  type RestoreChainEntry,
  type RestoreTargetState,
} from '../../src/checkpoints/domain/CheckpointRestoreEngine.ts'
import {
  createRuntimeWorkspaceRoots,
  createWorkspaceScopedPath,
  type RuntimeWorkspaceRoot,
} from '../../src/checkpoints/domain/CheckpointWorkspace.ts'
import { createTempDir, writeFile, cleanup } from './helpers.ts'

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

interface TestContext {
  workspaceDir: string
  checkpointsDir: string
  /** 内容寻址 blob 池目录（V2 §7.6 布局） */
  blobsDir: string
  roots: RuntimeWorkspaceRoot[]
}

async function setupContext(): Promise<TestContext> {
  const workspaceDir = await createTempDir('dsh-checkpoint-engine-ws-')
  const storeRoot = await createTempDir('dsh-checkpoint-engine-store-')
  const checkpointsDir = path.join(storeRoot, 'checkpoints')
  const blobsDir = path.join(checkpointsDir, 'ws_pool', 'blobs')
  await fs.mkdir(blobsDir, { recursive: true })
  const roots = createRuntimeWorkspaceRoots([
    { name: 'ws', uri: `file:///${workspaceDir.replace(/\\/g, '/')}`, fsPath: workspaceDir },
  ])
  return { workspaceDir, checkpointsDir, blobsDir, roots }
}

/**
 * 创建完整备份节点（内容寻址布局）：blob 写入 blobsDir/<hash>，
 * 节点携带 fileHashes/blobHashes/modes（三表同源）。
 */
async function createFullBlobBackup(
  ctx: TestContext,
  id: string,
  files: Record<string, string>,
): Promise<RestoreChainEntry> {
  const fileHashes: Record<string, string> = {}
  const blobHashes: Record<string, string> = {}
  const modes: Record<string, number> = {}
  for (const [relativePath, content] of Object.entries(files)) {
    const scoped = createWorkspaceScopedPath(ctx.roots[0]!.id, relativePath)
    const hash = sha256(content)
    fileHashes[scoped] = hash
    blobHashes[scoped] = hash
    modes[scoped] = 0o644
    await writeFile(ctx.blobsDir, hash, content)
  }
  return { checkpointId: id, backupDir: id, fileHashes, blobHashes, modes }
}

function scoped(ctx: TestContext, relativePath: string): string {
  return createWorkspaceScopedPath(ctx.roots[0]!.id, relativePath)
}

async function readWorkspaceFile(ctx: TestContext, relativePath: string): Promise<string> {
  return fs.readFile(path.join(ctx.workspaceDir, relativePath), 'utf-8')
}

async function collectCurrentState(
  ctx: TestContext,
): Promise<{ hashes: Record<string, string>; emptyDirs: string[] }> {
  const hashes: Record<string, string> = {}
  const emptyDirs: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    let isEmpty = true
    for (const entry of entries) {
      isEmpty = false
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(ctx.workspaceDir, fullPath).replace(/\\/g, '/')
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else {
        hashes[scoped(ctx, relativePath)] = sha256(await fs.readFile(fullPath, 'utf-8'))
      }
    }
    if (isEmpty && dir !== ctx.workspaceDir) {
      emptyDirs.push(scoped(ctx, path.relative(ctx.workspaceDir, dir).replace(/\\/g, '/')))
    }
  }
  await walk(ctx.workspaceDir)
  return { hashes, emptyDirs }
}

describe('restore plan (adapted from CheckpointRestoreEngine.test.ts)', () => {
  test('restores files and empty dirs from a full blob backup', async () => {
    const ctx = await setupContext()
    try {
      await writeFile(ctx.workspaceDir, 'src/main.ts', 'changed')
      await writeFile(ctx.workspaceDir, 'extra.txt', 'should be deleted')

      const chain = [await createFullBlobBackup(ctx, 'cp_full', {
        'src/main.ts': 'original',
        'src/lib.ts': 'lib',
      })]

      const target: RestoreTargetState = {
        fileHashes: {
          [scoped(ctx, 'src/main.ts')]: sha256('original'),
          [scoped(ctx, 'src/lib.ts')]: sha256('lib'),
        },
        emptyDirs: [scoped(ctx, 'docs')],
      }

      const current = await collectCurrentState(ctx)
      const result = await restoreWorkspaceSnapshot(
        { checkpointsDir: ctx.checkpointsDir, blobsDir: ctx.blobsDir, roots: ctx.roots },
        chain,
        target,
        current.hashes,
        current.emptyDirs,
      )

      expect(result.success).toBe(true)
      expect(result.restored).toBe(2)
      expect(result.deleted).toBe(1) // extra.txt（快照记录过？否——白名单缺省时除受保护外可删）
      expect(await readWorkspaceFile(ctx, 'src/main.ts')).toBe('original')
      await expect(fs.access(path.join(ctx.workspaceDir, 'extra.txt'))).rejects.toThrow()
      // 空目录重建（空目录无 blob，仅 manifest.emptyDirs）
      await expect(fs.access(path.join(ctx.workspaceDir, 'docs'))).resolves.toBeUndefined()
    } finally {
      await cleanup(ctx.workspaceDir, path.dirname(ctx.checkpointsDir))
    }
  })

  test('keeps untracked files by default and deletes them when confirmed (#29)', async () => {
    const ctx = await setupContext()
    try {
      await writeFile(ctx.workspaceDir, 'tracked.txt', 'snapshot')
      await writeFile(ctx.workspaceDir, 'untracked.txt', 'created later')

      const chain = [await createFullBlobBackup(ctx, 'cp_full', { 'tracked.txt': 'snapshot' })]
      const target: RestoreTargetState = {
        fileHashes: { [scoped(ctx, 'tracked.txt')]: sha256('snapshot') },
        emptyDirs: [],
      }
      const current = await collectCurrentState(ctx)

      // #29：快照后新建文件默认保留（删除白名单只含快照记录过的路径）
      const result = await restoreWorkspaceSnapshot(
        {
          checkpointsDir: ctx.checkpointsDir,
          blobsDir: ctx.blobsDir,
          roots: ctx.roots,
          deletableScopedPaths: new Set([scoped(ctx, 'tracked.txt')]),
        },
        chain,
        target,
        current.hashes,
        current.emptyDirs,
      )
      expect(result.success).toBe(true)
      expect(result.deleted).toBe(0)
      await expect(fs.access(path.join(ctx.workspaceDir, 'untracked.txt'))).resolves.toBeUndefined()

      // 确认删除 untracked 后：删除
      const resultConfirmed = await restoreWorkspaceSnapshot(
        {
          checkpointsDir: ctx.checkpointsDir,
          blobsDir: ctx.blobsDir,
          roots: ctx.roots,
          deletableScopedPaths: new Set([scoped(ctx, 'tracked.txt')]),
          deleteUntrackedFiles: true,
        },
        chain,
        target,
        current.hashes,
        current.emptyDirs,
      )
      expect(resultConfirmed.deleted).toBe(1)
      await expect(fs.access(path.join(ctx.workspaceDir, 'untracked.txt'))).rejects.toThrow()
    } finally {
      await cleanup(ctx.workspaceDir, path.dirname(ctx.checkpointsDir))
    }
  })

  test('directory-level excluded entry protects its subtree (M-3 prefix match)', async () => {
    const ctx = await setupContext()
    try {
      // 快照时整目录被排除（manifest.excluded 只记录目录自身 ws_x/dist）
      await writeFile(ctx.workspaceDir, 'dist/app.js', 'excluded at snapshot time')
      const chain = [await createFullBlobBackup(ctx, 'cp_full', { 'src/main.ts': 'main' })]
      const target: RestoreTargetState = {
        fileHashes: { [scoped(ctx, 'src/main.ts')]: sha256('main') },
        emptyDirs: [],
      }
      const current = await collectCurrentState(ctx)

      const protectedScopedPaths = new Set([scoped(ctx, 'dist')])
      const result = await restoreWorkspaceSnapshot(
        {
          checkpointsDir: ctx.checkpointsDir,
          blobsDir: ctx.blobsDir,
          roots: ctx.roots,
          protectedScopedPaths,
          deleteUntrackedFiles: true,
        },
        chain,
        target,
        current.hashes,
        current.emptyDirs,
      )
      expect(result.success).toBe(true)
      // 目录级保护覆盖其子树：dist/app.js 不被删除
      await expect(fs.access(path.join(ctx.workspaceDir, 'dist', 'app.js'))).resolves.toBeUndefined()
    } finally {
      await cleanup(ctx.workspaceDir, path.dirname(ctx.checkpointsDir))
    }
  })

  test('reports missing_in_chain and hash_mismatch failures (blob layout)', async () => {
    const ctx = await setupContext()
    try {
      await writeFile(ctx.workspaceDir, 'ghost.txt', 'whatever')
      await writeFile(ctx.workspaceDir, 'bad.txt', 'actual content')

      // 链上声明了 blob 池里不存在的 blob（missing_in_chain）
      const missingHash = sha256('expected but never stored')
      const missingChain: RestoreChainEntry[] = [{
        checkpointId: 'cp_missing',
        backupDir: 'cp_missing',
        fileHashes: { [scoped(ctx, 'ghost.txt')]: missingHash },
        blobHashes: { [scoped(ctx, 'ghost.txt')]: missingHash },
      }]
      // blob 存在但与 blobHashes 声称的哈希不一致（hash_mismatch）
      await writeFile(ctx.blobsDir, '0'.repeat(64), 'actual content')
      const badChain: RestoreChainEntry[] = [{
        checkpointId: 'cp_bad',
        backupDir: 'cp_bad',
        fileHashes: { [scoped(ctx, 'bad.txt')]: '0'.repeat(64) },
        blobHashes: { [scoped(ctx, 'bad.txt')]: '0'.repeat(64) },
      }]

      const target: RestoreTargetState = {
        fileHashes: {
          [scoped(ctx, 'ghost.txt')]: missingHash,
          [scoped(ctx, 'bad.txt')]: '0'.repeat(64),
        },
        emptyDirs: [],
      }
      const current = await collectCurrentState(ctx)

      const result = await restoreWorkspaceSnapshot(
        { checkpointsDir: ctx.checkpointsDir, blobsDir: ctx.blobsDir, roots: ctx.roots },
        [...missingChain, ...badChain],
        target,
        current.hashes,
        current.emptyDirs,
      )
      expect(result.success).toBe(false)
      expect(result.failures.some(f => f.reason === 'missing_in_chain')).toBe(true)
      expect(result.failures.some(f => f.reason === 'hash_mismatch')).toBe(true)
    } finally {
      await cleanup(ctx.workspaceDir, path.dirname(ctx.checkpointsDir))
    }
  })

  test('computeRestorePlan classifies added/modified/deleted/skipped', async () => {
    const ctx = await setupContext()
    try {
      const chain = [await createFullBlobBackup(ctx, 'cp_plan', { 'a.txt': '1', 'b.txt': '2' })]
      const target: RestoreTargetState = {
        fileHashes: {
          [scoped(ctx, 'a.txt')]: sha256('1'),
          [scoped(ctx, 'b.txt')]: sha256('changed'),
          [scoped(ctx, 'c.txt')]: sha256('new'),
        },
        emptyDirs: [],
      }
      const current: Record<string, string> = {
        [scoped(ctx, 'a.txt')]: sha256('1'), // 与目标一致 → skipped
        [scoped(ctx, 'b.txt')]: sha256('old'), // 与目标不同 → modified
        [scoped(ctx, 'd.txt')]: sha256('extra'), // 当前存在、目标无 → toDelete（白名单缺省）
      }
      const plan = computeRestorePlan(
        { checkpointsDir: ctx.checkpointsDir, blobsDir: ctx.blobsDir, roots: ctx.roots },
        chain,
        target,
        current,
        [],
      )
      expect(plan.added).toEqual([scoped(ctx, 'c.txt')])
      expect(plan.modified).toEqual([scoped(ctx, 'b.txt')])
      expect(plan.toDelete).toContain(scoped(ctx, 'd.txt'))
      expect(plan.skipped).toBe(1)
      expect(plan.added.length + plan.modified.length).toBe(2)
    } finally {
      await cleanup(ctx.workspaceDir, path.dirname(ctx.checkpointsDir))
    }
  })
})
