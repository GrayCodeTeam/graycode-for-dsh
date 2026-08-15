/**
 * CheckpointWorkspace 路径安全用例：
 * - `..` 穿越拒绝（normalizeSafeCheckpointPath / resolvePathInsideRoot）
 * - 符号链接拒绝（resolveSafePathInsideRoot，任一中间层是链接即拒绝）
 * - 绝对路径 / 盘符 / Windows 反斜杠归一化
 *
 * F-05：symlink 用例不再在无链接权限环境（CI / 未开开发者模式的 Windows）
 * 整体静默跳过——改为 beforeAll 探针 + test.skipIf 条件跳过（跳过在 vitest
 * 输出中可见），并在探针失败时输出可诊断说明。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  CheckpointPathError,
  normalizeSafeCheckpointPath,
  resolvePathInsideRoot,
  resolveSafePathInsideRoot,
} from '../../src/checkpoints/domain/CheckpointWorkspace.ts'
import { workspaceUriToFsPath } from '../../src/checkpoints/domain/affectedPaths.ts'
import { createTempDir, writeFile, cleanup } from './helpers.ts'

/** 环境是否支持创建符号链接（探针结果；false 时 symlink 用例被跳过） */
let symlinkSupported = true

beforeAll(async () => {
  const probe = await createTempDir('dsh-checkpoint-linkprobe-')
  try {
    const target = path.join(probe, 'target')
    await fs.mkdir(target)
    const linkPath = path.join(probe, 'link')
    if (process.platform === 'win32') {
      await fs.symlink(target, linkPath, 'junction')
    } else {
      await fs.symlink(target, linkPath, 'dir')
    }
  } catch (error) {
    symlinkSupported = false
    const detail = error instanceof Error ? error.message : String(error)
    // 可诊断输出：跳过原因可见，便于 CI 排查
    console.warn(
      `[workspacePath.test] symbolic links are unavailable in this environment (${detail}); ` +
        'the symlink-rejection assertions are SKIPPED. Run with link permission ' +
        '(Windows: NTFS junction usually works without admin) to cover them.',
    )
  } finally {
    await cleanup(probe)
  }
})

describe('CheckpointWorkspace path traversal defense', () => {
  test('normalizeSafeCheckpointPath rejects .. traversal and absolute paths', () => {
    expect(() => normalizeSafeCheckpointPath('../escape.txt')).toThrow(CheckpointPathError)
    expect(() => normalizeSafeCheckpointPath('a/../../b.txt')).toThrow(CheckpointPathError)
    expect(() => normalizeSafeCheckpointPath('/abs/path.txt')).toThrow(CheckpointPathError)
    expect(() => normalizeSafeCheckpointPath('C:/drive/path.txt')).toThrow(CheckpointPathError)
    expect(() => normalizeSafeCheckpointPath('')).toThrow(CheckpointPathError)
    // 合法路径与 Windows 反斜杠归一化
    expect(normalizeSafeCheckpointPath('a\\b\\c.txt')).toBe('a/b/c.txt')
    expect(normalizeSafeCheckpointPath('./a/./b.txt')).toBe('a/b.txt')
  })

  test('resolvePathInsideRoot rejects paths escaping the workspace root', async () => {
    const root = await createTempDir('dsh-checkpoint-root-')
    const outside = await createTempDir('dsh-checkpoint-outside-')
    try {
      await writeFile(root, 'inner/file.txt', 'x')
      await writeFile(outside, 'victim.txt', 'secret')

      const escaped = path.relative(root, outside)
      expect(() => resolvePathInsideRoot(root, `../${escaped}/victim.txt`)).toThrow(CheckpointPathError)
      expect(() => resolvePathInsideRoot(root, '../victim.txt')).toThrow(CheckpointPathError)
      // 根内合法路径正常解析
      expect(resolvePathInsideRoot(root, 'inner/file.txt')).toBe(path.join(root, 'inner', 'file.txt'))
    } finally {
      await cleanup(root, outside)
    }
  })

  test('resolveSafePathInsideRoot accepts ordinary in-root paths', async () => {
    const root = await createTempDir('dsh-checkpoint-root-')
    try {
      await writeFile(root, 'ok.txt', 'fine')
      await expect(resolveSafePathInsideRoot(root, 'ok.txt')).resolves.toBe(path.join(root, 'ok.txt'))
    } finally {
      await cleanup(root)
    }
  })

  test.skipIf(!symlinkSupported)(
    'resolveSafePathInsideRoot rejects symbolic links in the target path (skipped when links are unavailable)',
    async () => {
      const root = await createTempDir('dsh-checkpoint-root-')
      const outside = await createTempDir('dsh-checkpoint-outside-')
      try {
        await writeFile(outside, 'secret.txt', 'secret')
        // 探针已确认本环境支持链接：此处创建失败应使用例失败（不再静默跳过）
        const linkPath = path.join(root, 'linkdir')
        if (process.platform === 'win32') {
          await fs.symlink(outside, linkPath, 'junction')
        } else {
          await fs.symlink(outside, linkPath, 'dir')
        }
        // 链接路径（含中间层链接）一律拒绝
        await expect(resolveSafePathInsideRoot(root, 'linkdir/secret.txt')).rejects.toThrow(CheckpointPathError)
        await expect(resolveSafePathInsideRoot(root, 'linkdir')).rejects.toThrow(CheckpointPathError)
      } finally {
        await cleanup(root, outside)
      }
    },
  )
})

describe('workspaceUriToFsPath file://localhost handling (L2)', () => {
  test('file://localhost/... strips the localhost authority and resolves the path', () => {
    expect(workspaceUriToFsPath('file://localhost/home/user/project')).toBe(path.resolve('/home/user/project'))
  })

  test('file:///... (empty authority) keeps its previous behavior', () => {
    expect(workspaceUriToFsPath('file:///home/user/project')).toBe(path.resolve('/home/user/project'))
  })

  test('authority host matching is case-insensitive', () => {
    expect(workspaceUriToFsPath('file://LOCALHOST/home/user/x')).toBe(path.resolve('/home/user/x'))
  })

  test('file://localhost with encoded Windows drive still parses', () => {
    expect(workspaceUriToFsPath('file://localhost/C%3A/foo/bar.txt')).toBe(path.resolve('C:/foo/bar.txt'))
  })

  test('non-localhost authority returns null (remote host path cannot resolve locally)', () => {
    expect(workspaceUriToFsPath('file://otherhost/share/file.txt')).toBeNull()
  })
})
