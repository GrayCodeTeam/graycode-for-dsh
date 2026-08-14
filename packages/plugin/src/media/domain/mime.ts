/**
 * GrayCode - media MIME/格式判定纯函数（零依赖）
 *
 * 与老版 imageUtils 的 MIME 判定对齐：按扩展名判定输入 MIME；
 * 输出格式解析（显式 format / 输出路径扩展名 / 原图格式）在 ops.ts。
 * sharp 的 metadata.format 只用于默认扩展名兜底（format 属性与扩展名
 * 命名不同：jpeg 用 .jpg，svg 用 .svg 等）。
 */

/** 受支持的输入图片扩展名（sharp 可解码的子集，与老版一致） */
export const SUPPORTED_INPUT_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const

/** 输入扩展名 → MIME（老版 imageUtils.readImageFile 同款映射） */
export function mimeFromExt(ext: string): string | undefined {
  const normalized = ext.toLowerCase().replace(/^\./, '')
  if (normalized === 'png') return 'image/png'
  if (normalized === 'jpg' || normalized === 'jpeg') return 'image/jpeg'
  if (normalized === 'webp') return 'image/webp'
  if (normalized === 'gif') return 'image/gif'
  return undefined
}

/** 小写扩展名（去掉前导点）；无扩展名返回空串 */
export function extOf(filePath: string): string {
  const dotIndex = filePath.lastIndexOf('.')
  if (dotIndex < 0 || dotIndex === filePath.length - 1) return ''
  return filePath.slice(dotIndex + 1).toLowerCase()
}

/** 扩展名是否为受支持的输入图片格式 */
export function isSupportedImageExt(ext: string): boolean {
  return (SUPPORTED_INPUT_EXTS as readonly string[]).includes(ext.toLowerCase().replace(/^\./, ''))
}

/** sharp metadata.format → 默认输出扩展名（jpeg 归一为 jpg，与老版输出命名一致） */
export function extFromSharpFormat(format: string | undefined): string | undefined {
  if (!format) return undefined
  const normalized = format.toLowerCase()
  if (normalized === 'jpeg' || normalized === 'jpg') return 'jpg'
  if (normalized === 'png') return 'png'
  if (normalized === 'webp') return 'webp'
  if (normalized === 'gif') return 'gif'
  return undefined
}
