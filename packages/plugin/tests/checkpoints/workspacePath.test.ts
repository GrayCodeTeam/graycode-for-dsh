/**
 * CheckpointWorkspace 路径安全用例：
 * - `..` 穿越拒绝（normalizeSafeCheckpointPath / resolvePathInsideRoot）
 * - 符号链接拒绝（resolveSafePathInsideRoot，任一中间层是链接即拒绝）
 * - 绝对路径 / 盘符 / Windows 反斜杠归一化
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  CheckpointPathError,
  normalizeSafeCheckpointPath,
  resolvePathInsideRoot,
  resolveSafePathInsideRoot,
} from '../../src/checkpoints/domain/CheckpointWorkspace.ts'
import { createTempDir, writeFile, cleanup } from './helpers.ts'

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

  test('resolveSafePathInsideRoot rejects symbolic links in the target path', async () => {
    const root = await createTempDir('dsh-checkpoint-root-')
    const outside = await createTempDir('dsh-checkpoint-outside-')
    let linkCreated = false
    try {
      await writeFile(outside, 'secret.txt', 'secret')
      try {
        // Windows 下用 junction（无需管理员权限）；POSIX 用目录符号链接
        const linkPath = path.join(root, 'linkdir')
        if (process.platform === 'win32') {
          await fs.symlink(outside, linkPath, 'junction')
        } else {
          await fs.symlink(outside, linkPath, 'dir')
        }
        linkCreated = true
      } catch {
        // 无符号链接权限（CI 等）：跳过链接用例
      }
      if (linkCreated) {
        await expect(resolveSafePathInsideRoot(root, 'linkdir/secret.txt')).rejects.toThrow(CheckpointPathError)
        await expect(resolveSafePathInsideRoot(root, 'linkdir')).rejects.toThrow(CheckpointPathError)
      }
      // 根内普通路径不受影响
      await writeFile(root, 'ok.txt', 'fine')
      await expect(resolveSafePathInsideRoot(root, 'ok.txt')).resolves.toBe(path.join(root, 'ok.txt'))
    } finally {
      await cleanup(root, outside)
    }
  })
})
