/**
 * CheckpointSnapshotBuilder 单元测试（CP-PARTIAL-1 部分快照分支，H3）。
 *
 * H3：部分快照分支必须用 lstat（不跟随符号链接）——符号链接/特殊文件按
 * unsupported_file_type 计入 excluded（与全量分支 collectEntries 同口径，参考
 * CheckpointIgnoreResolver），绝不把工作区外目标内容哈希进 blob（恢复侧同样拒绝符号链接段）。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildWorkspaceSnapshot } from '../../src/checkpoints/domain/CheckpointSnapshotBuilder.ts'
import { createRuntimeWorkspaceRoots, type RuntimeWorkspaceRoot } from '../../src/checkpoints/domain/CheckpointWorkspace.ts'
import { createTempDir, writeFile, cleanup } from './helpers.ts'

function rootsOf(workspaceDir: string): RuntimeWorkspaceRoot[] {
  return createRuntimeWorkspaceRoots([
    { name: 'ws', uri: `file:///${workspaceDir.replace(/\\/g, '/')}`, fsPath: workspaceDir },
  ])
}

describe('CheckpointSnapshotBuilder partial snapshot (affectedPaths)', () => {
  test('H3: symlink in affected paths is excluded as unsupported_file_type and never archived', async () => {
    const workspaceDir = await createTempDir('dsh-checkpoint-snap-')
    const outsideDir = await createTempDir('dsh-checkpoint-outside-')
    try {
      await writeFile(workspaceDir, 'real.txt', 'real content')
      const outsideFile = path.join(outsideDir, 'secret.txt')
      await fs.writeFile(outsideFile, 'outside secret', 'utf-8')
      const linkPath = path.join(workspaceDir, 'link.txt')
      let linkCreated = true
      try {
        await fs.symlink(outsideFile, linkPath)
      } catch {
        // Windows 无开发者模式/权限：符号链接创建失败 → 跳过（本机无法复现场景）
        linkCreated = false
      }
      if (!linkCreated) {
        return
      }

      const roots = rootsOf(workspaceDir)
      const wsId = roots[0]!.id
      const result = await buildWorkspaceSnapshot({
        roots,
        affectedPaths: [path.join(workspaceDir, 'real.txt'), linkPath],
      })

      // 普通文件正常归档
      expect(result.fileHashes[`${wsId}/real.txt`]).toBeTruthy()
      // 符号链接不归档、不哈希
      expect(result.fileHashes[`${wsId}/link.txt`]).toBeUndefined()
      // 按 unsupported_file_type 计入 excluded（与全量分支 collectEntries 同口径）
      const excludedLink = result.excluded.find(entry => entry.path === `${wsId}/link.txt`)
      expect(excludedLink).toBeTruthy()
      expect(excludedLink!.reason).toBe('unsupported_file_type')
      // 不是 unreadable / size 排除（有明确原因分类）
      expect(result.unreadable.some(entry => entry.scopedPath === `${wsId}/link.txt`)).toBe(false)
      expect(result.sizeExcluded.some(entry => entry.scopedPath === `${wsId}/link.txt`)).toBe(false)
    } finally {
      await cleanup(workspaceDir, outsideDir)
    }
  })

  test('H3: regular files in affected paths are still hashed (no regression)', async () => {
    const workspaceDir = await createTempDir('dsh-checkpoint-snap-')
    try {
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      await writeFile(workspaceDir, 'sub/b.txt', 'beta')
      const roots = rootsOf(workspaceDir)
      const wsId = roots[0]!.id
      const result = await buildWorkspaceSnapshot({
        roots,
        affectedPaths: [path.join(workspaceDir, 'a.txt'), path.join(workspaceDir, 'sub', 'b.txt')],
      })
      expect(result.fileHashes[`${wsId}/a.txt`]).toBeTruthy()
      expect(result.fileHashes[`${wsId}/sub/b.txt`]).toBeTruthy()
      expect(result.excluded).toEqual([])
      expect(result.unreadable).toEqual([])
    } finally {
      await cleanup(workspaceDir)
    }
  })
})
