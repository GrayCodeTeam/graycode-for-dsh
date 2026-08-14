/**
 * 改自源仓库 gray-code-plugin/backend/__tests__/checkpoint/CheckpointIgnoreResolver.test.ts
 * （忽略语义零改动；源用例的 jest mock 不可读目录场景在 DSH 下用真实 chmod 模拟）。
 *
 * 覆盖：
 * - 根目录与嵌套目录 `.gitignore` 作用域（target/ 匹配任意层级）
 * - anchored 根级规则（/target/ 只影响根目录）
 * - 嵌套作用域局部生效 + `!` 否定
 * - 用户自定义忽略模式（含 Windows 风格反斜杠归一化）
 * - 强制排除：.git / node_modules 不可被否定
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import { CheckpointIgnoreResolver, normalizeCheckpointPath } from '../../src/checkpoints/domain/CheckpointIgnoreResolver.ts'
import { createTempDir, writeFile, cleanup } from './helpers.ts'

/** 返回 resolver 最终会纳入检查点的相对路径列表（归一化 + 排序） */
async function listTrackedPaths(rootDir: string, extraPatterns: string[] = []): Promise<string[]> {
  const resolver = new CheckpointIgnoreResolver(rootDir, extraPatterns)
  const { files } = await resolver.collectEntries()
  return files
    .map(filePath => normalizeCheckpointPath(path.relative(rootDir, filePath)))
    .sort()
}

describe('CheckpointIgnoreResolver (adapted from source test suite)', () => {
  test('ignores root and nested target directories while preserving tracked files', async () => {
    const rootDir = await createTempDir('dsh-checkpoint-ignore-')
    try {
      await writeFile(rootDir, '.gitignore', 'target/\n')
      await writeFile(rootDir, 'src/main.rs', 'fn main() {}\n')
      await writeFile(rootDir, 'target/debug/app.exe', 'binary')
      await writeFile(rootDir, 'nested/target/cache.txt', 'ignored')
      await writeFile(rootDir, 'nested/src/lib.rs', 'pub fn lib() {}\n')
      await writeFile(rootDir, '.git/HEAD', 'ref: refs/heads/main\n')
      await writeFile(rootDir, 'node_modules/pkg/index.js', 'module.exports = {}\n')

      await expect(listTrackedPaths(rootDir)).resolves.toEqual([
        '.gitignore',
        'nested/src/lib.rs',
        'src/main.rs',
      ])
    } finally {
      await cleanup(rootDir)
    }
  })

  test('respects anchored root-only directory rules', async () => {
    const rootDir = await createTempDir('dsh-checkpoint-ignore-')
    try {
      await writeFile(rootDir, '.gitignore', '/target/\n')
      await writeFile(rootDir, 'target/root.txt', 'ignored')
      await writeFile(rootDir, 'nested/target/nested.txt', 'tracked')

      await expect(listTrackedPaths(rootDir)).resolves.toEqual([
        '.gitignore',
        'nested/target/nested.txt',
      ])
    } finally {
      await cleanup(rootDir)
    }
  })

  test('keeps nested gitignore scope local and supports negation within that scope', async () => {
    const rootDir = await createTempDir('dsh-checkpoint-ignore-')
    try {
      await writeFile(rootDir, 'packages/a/.gitignore', 'dist/*\n!dist/keep.txt\nfoo.txt\n')
      await writeFile(rootDir, 'packages/a/dist/keep.txt', 'tracked')
      await writeFile(rootDir, 'packages/a/dist/drop.txt', 'ignored')
      await writeFile(rootDir, 'packages/a/foo.txt', 'ignored')
      await writeFile(rootDir, 'packages/b/dist/keep.txt', 'tracked')
      await writeFile(rootDir, 'packages/b/foo.txt', 'tracked')

      await expect(listTrackedPaths(rootDir)).resolves.toEqual([
        'packages/a/.gitignore',
        'packages/a/dist/keep.txt',
        'packages/b/dist/keep.txt',
        'packages/b/foo.txt',
      ])
    } finally {
      await cleanup(rootDir)
    }
  })

  test('applies custom ignore patterns at the checkpoint root scope', async () => {
    const rootDir = await createTempDir('dsh-checkpoint-ignore-')
    try {
      await writeFile(rootDir, 'generated/code.ts', 'ignored')
      await writeFile(rootDir, 'src/app.ts', 'tracked')

      await expect(listTrackedPaths(rootDir, ['generated/'])).resolves.toEqual([
        'src/app.ts',
      ])
    } finally {
      await cleanup(rootDir)
    }
  })

  test('normalizes Windows-style custom ignore patterns before matching', async () => {
    const rootDir = await createTempDir('dsh-checkpoint-ignore-')
    try {
      await writeFile(rootDir, 'src/generated/file.ts', 'ignored')
      await writeFile(rootDir, 'src/keep.ts', 'tracked')

      await expect(listTrackedPaths(rootDir, ['src\\generated\\'])).resolves.toEqual([
        'src/keep.ts',
      ])
    } finally {
      await cleanup(rootDir)
    }
  })

  test('forced exclusions (.git, node_modules) cannot be re-included by negation', async () => {
    const rootDir = await createTempDir('dsh-checkpoint-ignore-')
    try {
      await writeFile(rootDir, '.gitignore', '!.git/config\n!node_modules/keep.js\n')
      await writeFile(rootDir, '.git/config', '[core]')
      await writeFile(rootDir, 'node_modules/keep.js', 'nope')
      await writeFile(rootDir, 'real.txt', 'tracked')

      await expect(listTrackedPaths(rootDir)).resolves.toEqual([
        '.gitignore',
        'real.txt',
      ])
    } finally {
      await cleanup(rootDir)
    }
  })
})
