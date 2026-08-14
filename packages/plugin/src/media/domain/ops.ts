/**
 * GrayCode - media 图像运算纯函数（零依赖，可独立测试）
 *
 * 归一化坐标 → 像素、输出格式解析（显式 format / 输出扩展名 / 原图格式）、
 * 旋转包围盒估算、宽高比分数。全部为纯字符串/数值运算，sharp 无关。
 */
import { MAX_OUTPUT_PIXELS, NORMALIZED_MAX, type Dimensions, type OutputFormat } from './types.ts'
import { extFromSharpFormat, extOf, mimeFromExt } from './mime.ts'

/**
 * 归一化坐标（0-1）转实际像素：clamp 到 [0, max] 后 round。
 * 老版 normalizeCoord 同款（老版范围 0-1000，DSH 版 0-1）。
 */
export function normalizeCoord(normalized: number, actualSize: number): number {
  const clamped = Math.max(0, Math.min(NORMALIZED_MAX, normalized))
  return Math.round((clamped / NORMALIZED_MAX) * actualSize)
}

/**
 * 计算旋转后最小包围矩形尺寸（w' = |w·cosθ| + |h·sinθ|，
 * h' = |w·sinθ| + |h·cosθ|），与 sharp 自动扩边行为一致。
 * 角度取绝对值后 cos/sin 周期性天然覆盖任意角度与正负号。
 *
 * 浮点修正：90/180/270° 时 cos/sin 会产生 ~1e-17 的残差（如 cos(90°)），
 * ceil 后会多 1px；对接近整数的三角值取整，保证 90° 交换宽高、180° 尺寸
 * 不变等精确角度与 sharp 实测一致（护栏预检不误报）。
 */
export function estimateRotatedSize(
  width: number,
  height: number,
  angleDeg: number,
): { width: number; height: number } {
  const angleRad = (angleDeg * Math.PI) / 180
  const clean = (value: number): number =>
    Math.abs(value - Math.round(value)) < 1e-9 ? Math.round(value) : value
  const cos = clean(Math.abs(Math.cos(angleRad)))
  const sin = clean(Math.abs(Math.sin(angleRad)))
  return {
    width: Math.ceil(width * cos + height * sin),
    height: Math.ceil(width * sin + height * cos),
  }
}

/** 旋转输出像素护栏判定（估算或实测尺寸超 50MP → 拒绝） */
export function exceedsOutputPixelLimit(width: number, height: number): boolean {
  return width * height > MAX_OUTPUT_PIXELS
}

/** 输出格式三元组（扩展名 + MIME + JPEG 背景色语义在 tools 层处理） */
export interface ResolvedOutputFormat {
  /** 输出扩展名（小写、无点；jpeg 归一为 jpg，与老版输出命名一致） */
  ext: string
  /** 输出 MIME */
  mime: string
}

/**
 * 解析输出格式，优先级（与老版一致）：
 * 1. 显式 format（rotate 的 format 参数；jpeg/jpg → jpg 扩展名）；
 * 2. 输出路径扩展名（png/jpg/jpeg/webp → 对应格式）；
 * 3. 原图格式（sharp metadata.format → 扩展名）；
 * 4. 兜底 png。
 */
export function resolveOutputFormat(
  specifiedFormat: OutputFormat | undefined,
  outputPath: string | undefined,
  sourceFormat: string | undefined,
): ResolvedOutputFormat {
  if (specifiedFormat) {
    return {
      ext: specifiedFormat === 'jpeg' ? 'jpg' : specifiedFormat,
      mime: mimeFromExt(specifiedFormat) ?? 'image/png',
    }
  }
  if (outputPath) {
    const outputExt = extOf(outputPath)
    if (outputExt === 'png' || outputExt === 'jpg' || outputExt === 'jpeg' || outputExt === 'webp') {
      const ext = outputExt === 'jpeg' ? 'jpg' : outputExt
      return { ext, mime: mimeFromExt(ext) ?? 'image/png' }
    }
  }
  const sourceExt = extFromSharpFormat(sourceFormat)
  if (sourceExt === 'png' || sourceExt === 'jpg' || sourceExt === 'webp') {
    return { ext: sourceExt, mime: mimeFromExt(sourceExt) ?? 'image/png' }
  }
  return { ext: 'png', mime: 'image/png' }
}

/** 最大公约数（宽高比分数化简用） */
function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y > 0) {
    const t = x % y
    x = y
    y = t
  }
  return x || 1
}

/** 宽高比分数形式 "W:H"（老版 calculateAspectRatio 同构） */
export function formatAspectRatio(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return `${width}:${height}`
  }
  const g = gcd(width, height)
  return `${width / g}:${height / g}`
}

/** 构造 Dimensions 对象（工具结果用） */
export function toDimensions(width: number, height: number): Dimensions {
  return { width, height, aspectRatio: formatAspectRatio(width, height) }
}
