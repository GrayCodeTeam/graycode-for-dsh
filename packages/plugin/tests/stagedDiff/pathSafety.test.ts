/**
 * 路径规范化与防穿越测试（domain/pathSafety.ts）。
 */
import { describe, expect, it } from 'vitest'
import { assertSafeEntryPath, normalizeEntryPath } from '../../src/stagedDiff/domain/pathSafety.ts'
import { StagedDiffError, StagedDiffErrorCode } from '../../src/stagedDiff/domain/types.ts'

function expectInvalidPath(raw: string): void {
  try {
    normalizeEntryPath(raw)
    expect.unreachable(`expected path ${JSON.stringify(raw)} to be rejected`)
  } catch (error) {
    expect(error).toBeInstanceOf(StagedDiffError)
    expect((error as StagedDiffError).code).toBe(StagedDiffErrorCode.INVALID_PATH)
  }
}

describe('normalizeEntryPath', () => {
  it('规范化合法相对路径', () => {
    expect(normalizeEntryPath('a/b.md')).toBe('a/b.md')
    expect(normalizeEntryPath('./a/./b.md')).toBe('a/b.md')
    expect(normalizeEntryPath('a\\b.md')).toBe('a/b.md')
    expect(normalizeEntryPath('a/b/')).toBe('a/b')
    expect(normalizeEntryPath('a//b')).toBe('a/b')
    expect(normalizeEntryPath('.hidden/x')).toBe('.hidden/x')
    expect(normalizeEntryPath('a/b/c/d.md')).toBe('a/b/c/d.md')
    expect(normalizeEntryPath('dir with spaces/f.md')).toBe('dir with spaces/f.md')
  })

  it('拒绝绝对路径（POSIX / UNC / 盘符）', () => {
    expectInvalidPath('/abs/path')
    expectInvalidPath('//server/share')
    expectInvalidPath('C:/x')
    expectInvalidPath('C:\\x')
    expectInvalidPath('c:/windows/system32')
  })

  it('拒绝 .. 穿越（含夹在中间的形态）', () => {
    expectInvalidPath('..')
    expectInvalidPath('../x')
    expectInvalidPath('a/../b')
    expectInvalidPath('a/../../b')
    expectInvalidPath('..\\x')
  })

  it('拒绝空路径 / 仅 . / 空字节 / 控制字符', () => {
    expectInvalidPath('')
    expectInvalidPath('.')
    expectInvalidPath('./')
    expectInvalidPath('a/\0b')
    expectInvalidPath('a/b\x01c')
  })

  it('assertSafeEntryPath 为 normalizeEntryPath 的断言形式', () => {
    expect(assertSafeEntryPath('x/y.md')).toBe('x/y.md')
    try {
      assertSafeEntryPath('../x')
      expect.unreachable()
    } catch (error) {
      expect((error as StagedDiffError).code).toBe(StagedDiffErrorCode.INVALID_PATH)
    }
  })
})
