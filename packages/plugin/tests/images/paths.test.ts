/**
 * images 路径安全纯函数测试（domain/paths.ts）。
 *
 * 覆盖：工作区内相对/绝对路径解析、.. 穿越拒绝、绝对路径逃逸拒绝、
 * 空/控制字符拒绝、默认输出路径（<cwd>/generated_images/gen-<ts>.png）、
 * 扩展名校正（嗅探结果纠正错误后缀、jpg/jpeg 同义保留、无扩展名追加）。
 */
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyExtensionCorrection,
  resolveOutputPath,
} from '../../src/images/domain/paths.ts'

/** 跨平台构造工作区绝对路径（Windows 盘符 / POSIX 根） */
function workspaceRoot(): string {
  return path.resolve(path.sep === '\\' ? 'C:\\ws\\project' : '/ws/project')
}

function expectPathError(fn: () => unknown): void {
  try {
    fn()
    expect.unreachable('expected ImagesPathError to be thrown')
  } catch (error) {
    expect((error as Error).name).toBe('Error')
    expect((error as { code?: string }).code).toBe('GRAY_IMAGES_PATH_OUTSIDE_WORKSPACE')
  }
}

describe('resolveOutputPath', () => {
  const root = workspaceRoot()

  it('resolves relative paths against the cwd', () => {
    expect(resolveOutputPath(root, 'generated_images/cat.png')).toBe(path.join(root, 'generated_images', 'cat.png'))
    expect(resolveOutputPath(root, 'cat.png')).toBe(path.join(root, 'cat.png'))
  })

  it('accepts absolute paths inside the workspace', () => {
    const absolute = path.join(root, 'generated_images', 'a.png')
    expect(resolveOutputPath(root, absolute)).toBe(absolute)
  })

  it('rejects .. traversal and escapes', () => {
    expectPathError(() => resolveOutputPath(root, '../outside.png'))
    expectPathError(() => resolveOutputPath(root, 'a/../../outside.png'))
  })

  it('rejects absolute paths outside the workspace', () => {
    const outside = path.resolve(path.dirname(root), 'elsewhere.png')
    expectPathError(() => resolveOutputPath(root, outside))
  })

  it('rejects empty paths, null bytes and control characters', () => {
    expectPathError(() => resolveOutputPath(root, ''))
    expectPathError(() => resolveOutputPath(root, 'a\u0000b.png'))
    expectPathError(() => resolveOutputPath(root, 'a\u0001b.png'))
  })

  it('rejects non-string input', () => {
    expectPathError(() => resolveOutputPath(root, undefined as unknown as string))
  })

  it('normalizes harmless interior .. segments', () => {
    expect(resolveOutputPath(root, 'a/../b.png')).toBe(path.join(root, 'b.png'))
  })
})

describe('applyExtensionCorrection', () => {
  it('replaces a mismatched extension with the sniffed one', () => {
    expect(applyExtensionCorrection('generated_images/cat.png', '.jpg')).toBe(path.join('generated_images', 'cat.jpg'))
    expect(applyExtensionCorrection('C:\\ws\\cat.webp', '.png')).toBe('C:\\ws\\cat.png')
  })

  it('keeps jpg/jpeg synonyms untouched', () => {
    expect(applyExtensionCorrection('generated_images/cat.jpg', '.jpeg')).toBe('generated_images/cat.jpg')
    expect(applyExtensionCorrection('generated_images/cat.jpeg', '.jpg')).toBe('generated_images/cat.jpeg')
  })

  it('appends the extension when the path has none', () => {
    expect(applyExtensionCorrection('generated_images/cat', '.png')).toBe('generated_images/cat.png')
  })

  it('keeps a matching extension untouched', () => {
    expect(applyExtensionCorrection('generated_images/cat.png', '.png')).toBe('generated_images/cat.png')
  })
})
