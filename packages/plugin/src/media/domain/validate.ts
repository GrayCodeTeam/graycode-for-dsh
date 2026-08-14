/**
 * GrayCode - media 参数校验纯函数（零依赖，可独立测试）
 *
 * 每个校验器返回判别联合：`{ ok: true; value }` 或 `{ ok: false; error }`。
 * 工具层把失败投影为任务级 { code: GRAY_MEDIA_INVALID_ARGUMENTS, error }。
 *
 * 校验规则（与老版一致 + 任务要求收紧）：
 * - crop：x1/y1/x2/y2 必须是有穷数，范围 0-1（归一化），且 x1 < x2、y1 < y2；
 * - resize：width/height 为正有穷数，单边 ≤ 16384（16K）；
 * - rotate：angle 必须是枚举 0/90/180/270；format 可选，jpeg/jpg 归一为 jpeg。
 * 所有校验显式拒绝 NaN/Infinity（它们会穿透 < 0 / > max 比较，老版同款防御）。
 */
import {
  MAX_IMAGE_DIMENSION,
  NORMALIZED_MAX,
  OUTPUT_FORMATS,
  ROTATE_ANGLES,
  type CropTask,
  type OutputFormat,
  type ResizeTask,
  type RotateAngle,
  type RotateTask,
} from './types.ts'

/** 校验结果判别联合 */
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string }

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value }
}

function fail(error: string): ValidationResult<never> {
  return { ok: false, error }
}

/** 有穷数检查（NaN/Infinity 一律拒绝） */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 校验归一化坐标（0-1、有穷、x1<x2、y1<y2）。
 * 老版范围是 0-1000，DSH 版按任务要求改为 0-1。
 */
export function validateNormalizedCoords(
  x1: unknown,
  y1: unknown,
  x2: unknown,
  y2: unknown,
): ValidationResult<{ x1: number; y1: number; x2: number; y2: number }> {
  if (
    !isFiniteNumber(x1) || !isFiniteNumber(y1) ||
    !isFiniteNumber(x2) || !isFiniteNumber(y2)
  ) {
    return fail(`coordinates must be finite numbers in range 0-${NORMALIZED_MAX}`)
  }
  const coords = { x1, y1, x2, y2 }
  for (const [name, value] of Object.entries(coords)) {
    if (value < 0 || value > NORMALIZED_MAX) {
      return fail(`${name} must be in range 0-${NORMALIZED_MAX}`)
    }
  }
  if (x1 >= x2) {
    return fail('x1 must be less than x2')
  }
  if (y1 >= y2) {
    return fail('y1 must be less than y2')
  }
  return ok({ x1, y1, x2, y2 })
}

/**
 * 校验 resize 目标尺寸：正有穷数、整数、单边 ≤ 16384（老版 MAX_DIMENSION）。
 */
export function validateTargetDimensions(
  width: unknown,
  height: unknown,
): ValidationResult<{ width: number; height: number }> {
  if (!isFiniteNumber(width) || width <= 0) {
    return fail('width must be a positive finite number')
  }
  if (!isFiniteNumber(height) || height <= 0) {
    return fail('height must be a positive finite number')
  }
  const w = Math.round(width)
  const h = Math.round(height)
  if (w <= 0 || h <= 0) {
    return fail('width and height must round to positive integers')
  }
  if (w > MAX_IMAGE_DIMENSION || h > MAX_IMAGE_DIMENSION) {
    return fail(`target dimensions cannot exceed ${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION}`)
  }
  return ok({ width: w, height: h })
}

/**
 * 校验 rotate 角度：必须为枚举 0/90/180/270（任务要求，较老版任意角度收紧）。
 */
export function validateRotateAngle(angle: unknown): ValidationResult<RotateAngle> {
  if (!isFiniteNumber(angle)) {
    return fail(`angle must be a finite number, one of: ${ROTATE_ANGLES.join('/')}`)
  }
  const candidate = angle as RotateAngle
  if (!ROTATE_ANGLES.includes(candidate)) {
    return fail(`angle must be one of: ${ROTATE_ANGLES.join('/')} (received ${angle})`)
  }
  return ok(candidate)
}

/**
 * 校验输出格式（rotate format 参数）：可选；jpeg/jpg 归一为 jpeg；
 * 其余（png/webp）原样通过；未知格式拒绝。
 */
export function validateOutputFormat(format: unknown): ValidationResult<OutputFormat | undefined> {
  if (format === undefined || format === null || format === '') {
    return ok(undefined)
  }
  if (typeof format !== 'string') {
    return fail(`format must be a string, one of: ${OUTPUT_FORMATS.join('/')}`)
  }
  const normalized = format.toLowerCase() === 'jpg' ? 'jpeg' : format.toLowerCase()
  if (!(OUTPUT_FORMATS as readonly string[]).includes(normalized)) {
    return fail(`format must be one of: ${OUTPUT_FORMATS.join('/')} (received ${format})`)
  }
  return ok(normalized as OutputFormat)
}

/** 输入路径校验：非空字符串 */
export function validateImagePath(imagePath: unknown): ValidationResult<string> {
  if (typeof imagePath !== 'string' || imagePath.trim() === '') {
    return fail('image_path is required')
  }
  return ok(imagePath)
}

/** 输出路径校验：可选，非空字符串 */
export function validateOutputPath(outputPath: unknown): ValidationResult<string | undefined> {
  if (outputPath === undefined || outputPath === null || outputPath === '') {
    return ok(undefined)
  }
  if (typeof outputPath !== 'string') {
    return fail('output_path must be a string')
  }
  return ok(outputPath)
}

/** 校验并规范化 crop 任务（坐标 0-1 归一化模式，无像素模式——任务要求收紧） */
export function validateCropTask(raw: unknown): ValidationResult<CropTask> {
  if (typeof raw !== 'object' || raw === null) {
    return fail('each crop task must be an object')
  }
  const task = raw as Record<string, unknown>
  const imagePath = validateImagePath(task.image_path)
  if (!imagePath.ok) return fail(imagePath.error)
  const outputPath = validateOutputPath(task.output_path)
  if (!outputPath.ok) return fail(outputPath.error)
  const coords = validateNormalizedCoords(task.x1, task.y1, task.x2, task.y2)
  if (!coords.ok) return fail(coords.error)
  return ok({
    image_path: imagePath.value,
    output_path: outputPath.value,
    ...coords.value,
  })
}

/** 校验并规范化 resize 任务 */
export function validateResizeTask(raw: unknown): ValidationResult<ResizeTask> {
  if (typeof raw !== 'object' || raw === null) {
    return fail('each resize task must be an object')
  }
  const task = raw as Record<string, unknown>
  const imagePath = validateImagePath(task.image_path)
  if (!imagePath.ok) return fail(imagePath.error)
  const outputPath = validateOutputPath(task.output_path)
  if (!outputPath.ok) return fail(outputPath.error)
  const dimensions = validateTargetDimensions(task.width, task.height)
  if (!dimensions.ok) return fail(dimensions.error)
  return ok({
    image_path: imagePath.value,
    output_path: outputPath.value,
    width: dimensions.value.width,
    height: dimensions.value.height,
  })
}

/** 校验并规范化 rotate 任务 */
export function validateRotateTask(raw: unknown): ValidationResult<RotateTask> {
  if (typeof raw !== 'object' || raw === null) {
    return fail('each rotate task must be an object')
  }
  const task = raw as Record<string, unknown>
  const imagePath = validateImagePath(task.image_path)
  if (!imagePath.ok) return fail(imagePath.error)
  const outputPath = validateOutputPath(task.output_path)
  if (!outputPath.ok) return fail(outputPath.error)
  const angle = validateRotateAngle(task.angle)
  if (!angle.ok) return fail(angle.error)
  const format = validateOutputFormat(task.format)
  if (!format.ok) return fail(format.error)
  return ok({
    image_path: imagePath.value,
    output_path: outputPath.value,
    angle: angle.value,
    format: format.value,
  })
}
