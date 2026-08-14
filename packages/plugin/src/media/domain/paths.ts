/**
 * GrayCode - media 路径安全（纯字符串/路径解析，零宿主依赖）
 *
 * 双层防线（与 stagedDiff pathSafety + fsApplier 同一思路）：
 * 1. 本文件（纯函数层）：拒绝空路径、`..` 穿越段、绝对路径逃逸工作区、
 *    空字节与控制字符；把用户路径解析为工作区内的绝对路径。
 * 2. 适配层（adapters/mediaFs.ts）权威校验：DSH 实现经 `ctx.fs.resolve`
 *    （跟随符号链接）后做 contains 包含性检查；node 回退实现做 realpath
 *    前缀检查。符号链接逃逸只能在 fs 语义层判定，故必须由适配层兜底。
 */
import * as path from 'node:path'
import { MediaError, MediaErrorCode } from './errors.ts'

/** 控制字符（0x00-0x1F）与路径分隔符、盘符分隔符校验用正则 */
const CONTROL_CHARS = /[\u0000-\u001f]/

function invalidPath(rawPath: string, reason: string): MediaError {
  return new MediaError(
    MediaErrorCode.PATH_OUTSIDE_WORKSPACE,
    `invalid media path ${JSON.stringify(rawPath)}: ${reason}`,
  )
}

/**
 * 把用户提供的路径解析为工作区内的绝对路径。
 *
 * 规则：
 * - 相对路径以 `cwd` 为基解析；
 * - 绝对路径（POSIX `/` 开头或 Windows 盘符）直接作为候选；
 * - 解析结果必须位于 `cwd` 内（等于 cwd 或为其后代），否则拒绝；
 * - `..` 段、空字节、控制字符、空路径一律拒绝。
 *
 * 注意：本函数做字符串级包含检查；符号链接逃逸由适配层
 * （ctx.fs.resolve + contains / realpath 前缀）做权威判定。
 */
export function resolveInsideWorkspace(cwd: string, rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw invalidPath(rawPath, 'path must be a non-empty string')
  }
  if (rawPath.includes('\0')) {
    throw invalidPath(rawPath, 'path contains a null byte')
  }
  if (CONTROL_CHARS.test(rawPath)) {
    throw invalidPath(rawPath, 'path contains control characters')
  }

  // 绝对路径判定：POSIX 根 / 或 Windows 盘符（C:\ 或 C:/）
  const isAbsoluteInput = rawPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawPath)
  const candidate = isAbsoluteInput ? rawPath : path.resolve(cwd, rawPath)

  // 规范化后包含性检查（path.relative 的 `..` 前缀判定，跨平台正确）
  const relative = path.relative(cwd, candidate)
  if (relative === '') {
    // 候选即工作区根本身：作为路径是允许的（文件操作在适配层按文件语义拒绝目录）
    return candidate
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw invalidPath(rawPath, 'path escapes the workspace root')
  }
  return candidate
}

/**
 * 从输入路径派生默认输出文件名：`<basename>-<ts>[-<n>].<ext>`
 * 例如 `photo.png` → `photo-1712345678901.png`（同批第 2 个 → `photo-1712345678901-1.png`）。
 *
 * 规则：basename 去掉扩展名并过滤路径分隔符/控制字符；ts 为毫秒时间戳；
 * 同批撞名由 n（从 0 起）消歧；输出固定落在 `<cwd>/media-output/`。
 */
export function buildDefaultOutputPath(
  cwd: string,
  inputPath: string,
  ext: string,
  ts: number,
  n = 0,
): string {
  const inputBase = path.basename(inputPath)
  const dotIndex = inputBase.lastIndexOf('.')
  const stem = dotIndex > 0 ? inputBase.slice(0, dotIndex) : inputBase
  // 清理不允许出现在文件名里的字符（保留常见多语言字符，仅替换分隔符/控制字符）
  const safeStem = stem.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'image'
  const suffix = n > 0 ? `-${n}` : ''
  return path.join(cwd, 'media-output', `${safeStem}-${ts}${suffix}.${ext}`)
}

/**
 * generate_image 默认输出路径：`<cwd>/media-output/gen-<ts>.<ext>`
 * （README 约定；ext 由输出格式解析决定，缺省 png）。
 */
export function buildGeneratedOutputPath(cwd: string, ext: string, ts: number, n = 0): string {
  const suffix = n > 0 ? `-${n}` : ''
  return path.join(cwd, 'media-output', `gen-${ts}${suffix}.${ext}`)
}

/**
 * remove_background 默认输出路径：`<cwd>/media-output/<name>-bg-removed-<ts>.png`
 * （透明背景 PNG；`<name>` 为输入文件名去扩展名，控制字符/分隔符按
 * buildDefaultOutputPath 同规则清理）。
 */
export function buildBackgroundRemovedOutputPath(cwd: string, inputPath: string, ts: number): string {
  const inputBase = path.basename(inputPath)
  const dotIndex = inputBase.lastIndexOf('.')
  const stem = dotIndex > 0 ? inputBase.slice(0, dotIndex) : inputBase
  const safeStem = stem.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'image'
  return path.join(cwd, 'media-output', `${safeStem}-bg-removed-${ts}.png`)
}
