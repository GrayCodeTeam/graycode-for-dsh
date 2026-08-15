/**
 * GrayCode - images 路径安全（纯函数，零宿主依赖）。
 *
 * 双层防线（与 media/stagedDiff 同一思路）：
 * 1. 本文件（纯字符串层）：拒绝空路径、`..` 穿越、绝对路径逃逸工作区、
 *    空字节与控制字符；把模型传入的 output_path 解析为工作区内的绝对路径。
 * 2. 执行层兜底（domain/execution.ts）：写盘前 fs 端口对目标与其最深已存在
 *    祖先做 realpath 包含性校验（符号链接目录逃逸工作区 → 拒绝，M-2），
 *    再 mkdir 父目录（节点 fs）后写盘。
 */

import * as path from 'node:path'

export class ImagesPathError extends Error {
  readonly code = 'GRAY_IMAGES_PATH_OUTSIDE_WORKSPACE'
}

/** 控制字符（0x00-0x1F） */
const CONTROL_CHARS = /[\u0000-\u001f]/

/**
 * 把模型传入的 output_path 解析为工作区内的绝对路径。
 *
 * 规则（与 media domain/paths.ts 的 resolveInsideWorkspace 同源）：
 * - 相对路径以 `cwd` 为基解析（`generated_images/cat.png` → `<cwd>/generated_images/cat.png`）；
 * - 绝对路径（POSIX `/` 开头或 Windows 盘符）直接作为候选；
 * - 解析结果必须位于 `cwd` 内（等于 cwd 或为其后代），否则拒绝；
 * - `..` 段、空字节、控制字符、空路径一律拒绝。
 */
export function resolveOutputPath(cwd: string, rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new ImagesPathError(`invalid output path: path must be a non-empty string`)
  }
  if (rawPath.includes('\0')) {
    throw new ImagesPathError(`invalid output path: path contains a null byte`)
  }
  if (CONTROL_CHARS.test(rawPath)) {
    throw new ImagesPathError(`invalid output path: path contains control characters`)
  }

  const isAbsoluteInput = rawPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawPath)
  const candidate = isAbsoluteInput ? rawPath : path.resolve(cwd, rawPath)

  const relative = path.relative(cwd, candidate)
  if (relative === '') {
    return candidate
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ImagesPathError(`output path escapes the workspace root: ${rawPath}`)
  }
  return candidate
}

/**
 * 扩展名校正：output_path 自带扩展名与嗅探结果不同（且非同义后缀）时，
 * 把文件名中的扩展名替换为嗅探结果；无扩展名时直接追加。返回完整路径。
 */
export function applyExtensionCorrection(outputPath: string, ext: string): string {
  const currentExt = path.extname(outputPath).toLowerCase()
  const targetExt = ext.toLowerCase()
  const areSynonyms = (a: string, b: string): boolean =>
    ['.jpg', '.jpeg', '.jfif'].includes(a) && ['.jpg', '.jpeg', '.jfif'].includes(b)
  if (currentExt !== '' && currentExt !== targetExt && !areSynonyms(currentExt, targetExt)) {
    const dirName = path.dirname(outputPath)
    const baseName = path.basename(outputPath, currentExt)
    return dirName === '.' ? `${baseName}${targetExt}` : path.join(dirName, `${baseName}${targetExt}`)
  }
  if (currentExt === '') {
    return `${outputPath}${targetExt}`
  }
  return outputPath
}
