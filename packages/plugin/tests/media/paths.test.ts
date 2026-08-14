/**
 * media 路径安全纯函数测试（domain/paths.ts）
 *
 * 覆盖：工作区内相对/绝对路径解析、.. 穿越拒绝、绝对路径逃逸拒绝、
 * 空/控制字符拒绝、默认输出路径（media-output/<name>-<ts>.png）生成与消歧。
 * 注意：符号链接逃逸由适配层（ctx.fs.resolve + contains）权威校验，不在此层。
 */
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildDefaultOutputPath, resolveInsideWorkspace } from '../../src/media/domain/paths.ts'
import { MediaError, MediaErrorCode } from '../../src/media/domain/errors.ts'

/** 跨平台构造工作区绝对路径（Windows 盘符 / POSIX 根） */
function workspaceRoot(): string {
  return path.resolve(path.sep === '\\' ? 'C:\\ws\\project' : '/ws/project')
}

function expectPathError(fn: () => unknown, code: string): void {
  try {
    fn()
    expect.unreachable('expected MediaError to be thrown')
  } catch (error) {
    expect(error).toBeInstanceOf(MediaError)
    expect((error as MediaError).code).toBe(code)
  }
}

describe('resolveInsideWorkspace', () => {
  const root = workspaceRoot()

  test('相对路径以 cwd 为基解析到工作区内', () => {
    const resolved = resolveInsideWorkspace(root, 'images/a.png')
    expect(resolved).toBe(path.join(root, 'images', 'a.png'))
  })

  test('工作区内的绝对路径直接接受', () => {
    const absolute = path.join(root, 'a.png')
    expect(resolveInsideWorkspace(root, absolute)).toBe(absolute)
  })

  test('路径等于工作区根被接受（文件操作在适配层按语义拒绝目录）', () => {
    expect(resolveInsideWorkspace(root, root)).toBe(root)
  })

  test('拒绝 .. 穿越（含 a/../b 形态的越界）', () => {
    expectPathError(() => resolveInsideWorkspace(root, '../outside.png'), MediaErrorCode.PATH_OUTSIDE_WORKSPACE)
    expectPathError(() => resolveInsideWorkspace(root, 'images/../../outside.png'), MediaErrorCode.PATH_OUTSIDE_WORKSPACE)
    // a/../b 归一化后仍在工作区内（<root>/b），包含性校验通过——不抛错（见下方用例）
  })

  test('拒绝工作区外的绝对路径', () => {
    const outside = path.resolve(path.dirname(root), 'elsewhere.png')
    expectPathError(() => resolveInsideWorkspace(root, outside), MediaErrorCode.PATH_OUTSIDE_WORKSPACE)
  })

  test('拒绝空路径 / 空字节 / 控制字符', () => {
    expectPathError(() => resolveInsideWorkspace(root, ''), MediaErrorCode.PATH_OUTSIDE_WORKSPACE)
    expectPathError(() => resolveInsideWorkspace(root, 'a\u0000b.png'), MediaErrorCode.PATH_OUTSIDE_WORKSPACE)
    expectPathError(() => resolveInsideWorkspace(root, 'a\u0001b.png'), MediaErrorCode.PATH_OUTSIDE_WORKSPACE)
  })

  test('拒绝非字符串输入', () => {
    expectPathError(() => resolveInsideWorkspace(root, undefined as unknown as string), MediaErrorCode.PATH_OUTSIDE_WORKSPACE)
  })

  test('工作区内的 .. 不越界时按解析结果处理（如 a/../b → b）', () => {
    // a/../b 停留在工作区内：path.resolve 归一为 <root>/b，属于合法包含
    expect(resolveInsideWorkspace(root, 'a/../b.png')).toBe(path.join(root, 'b.png'))
  })
})

describe('buildDefaultOutputPath', () => {
  const root = workspaceRoot()

  test('生成 <workspace>/media-output/<stem>-<ts>.<ext>', () => {
    const out = buildDefaultOutputPath(root, 'photo.png', 'png', 1710000000000)
    expect(out).toBe(path.join(root, 'media-output', 'photo-1710000000000.png'))
  })

  test('同名批内任务用序号消歧', () => {
    const first = buildDefaultOutputPath(root, 'photo.png', 'png', 1710000000000, 0)
    const second = buildDefaultOutputPath(root, 'photo.png', 'png', 1710000000000, 1)
    expect(first).not.toBe(second)
    expect(second).toContain('-1710000000000-1.png')
  })

  test('无扩展名的输入文件名照常派生', () => {
    const out = buildDefaultOutputPath(root, 'photo', 'jpg', 1)
    expect(out).toBe(path.join(root, 'media-output', 'photo-1.jpg'))
  })

  test('清理文件名中的路径分隔符与控制字符（basename 语义：分隔符前为目录）', () => {
    // 'a/b\c:d.png' 的 basename 是 'c:d.png'（Windows 分隔符 \ 与 / 均识别），
    // ':' 被替换为 '_'；'a/b\' 属于目录前缀不进入文件名
    const out = buildDefaultOutputPath(root, 'a/b\\c:d.png', 'png', 1)
    expect(out).toBe(path.join(root, 'media-output', 'c_d-1.png'))
  })
})
