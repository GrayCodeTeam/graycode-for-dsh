/**
 * GrayCode - media 工具定义（crop_image / resize_image / rotate_image /
 * remove_background）
 *
 * 与老版 Gray Code 参数/语义对齐（DSH 变体）：
 * - 批量模式 `images` 数组 + 单张模式（image_path/output_path/... 顶层参数）；
 * - crop 坐标归一化 0-1（任务要求，老版 0-1000）；
 * - resize width/height 为正整数像素（≤ 16K），拉伸填充（fit: 'fill'）；
 * - rotate angle 枚举 0/90/180/270（任务要求），format 可选 png/jpeg/webp；
 * - 输出格式优先级：显式 format → 输出路径扩展名 → 原图格式 → png；
 * - remove_background 依赖模型渠道（ChannelImagePort）：输入工作区内图片，
 *   输出写回工作区默认 media-output 目录；rc.6 无公开图像生成 API，未注入
 *   真实渠道时 fail-closed 报 GRAY_MEDIA_MODEL_CHANNEL_UNAVAILABLE
 *   （见 README「模型渠道」节）；generate_image 已迁出到 images 域
 *   （真实 REST 实现，src/images/）；
 * - 结构化结果：成功/失败列表（results[].code 稳定错误码）、输出路径、尺寸；
 * - 取消：顺序执行，每任务/每步检查 exec.signal，aborted 任务标记 cancelled；
 * - 批量上限 maxBatch（Config 可配，默认 10，与老插件一致）。
 *
 * 宿主分离：纯逻辑（校验/路径/批量/格式）在 domain/，文件能力在 adapters/
 * （MediaFsPort），本文件只做编排。execute 已知失败一律组装为结构化结果
 * （success:false + code），不向框架抛错，保证 output.schema 恒可校验。
 */
import { defineTool, type ObjectValueSchemaSpec, type ParameterPropertySpec, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { MediaFsPort } from './adapters/mediaFs.ts'
import { createUnavailableChannelImagePort } from './adapters/modelChannel.ts'
import { loadSharp, type SharpModule } from './adapters/sharpLoader.ts'
import { MediaError, MediaErrorCode } from './domain/errors.ts'
import { resolveInsideWorkspace, buildDefaultOutputPath, buildBackgroundRemovedOutputPath } from './domain/paths.ts'
import type { ChannelImagePort, ChannelImageResult } from './domain/modelChannel.ts'
import { assertBatchLimit, findDuplicateOutput, toTasks } from './domain/batch.ts'
import { extFromSharpFormat, isSupportedImageExt } from './domain/mime.ts'
import { normalizeCoord, resolveOutputFormat, toDimensions, exceedsOutputPixelLimit, estimateRotatedSize } from './domain/ops.ts'
import { validateRemoveBackgroundTask } from './domain/validate.ts'
import {
  DEFAULT_MAX_BATCH,
  MAX_MEDIA_MAX_BATCH,
  MAX_READ_BYTES,
  type CropTask,
  type MediaTask,
  type MediaTaskResult,
  type MediaToolResult,
  type RemoveBackgroundTask,
  type ResizeTask,
  type RotateTask,
} from './domain/types.ts'

/** 工具共享依赖（由 media/index.ts 注入） */
export interface MediaToolDeps {
  /** 文件能力端口（生产为 ctx.fs 适配；测试可注入 node 回退） */
  fs: MediaFsPort
  /** 单次调用任务数上限（默认 10，与老插件一致） */
  maxBatch: number
  /**
   * 模型渠道端口（remove_background）。缺省 fail-closed：未注入时用
   * createUnavailableChannelImagePort，调用报 GRAY_MEDIA_MODEL_CHANNEL_UNAVAILABLE
   * （rc.6 无公开图像 API；generate_image 已迁出到 images 域）。
   */
  channel?: Pick<ChannelImagePort, 'removeBackground'>
}

/** 从执行上下文解析工作区 cwd（undefined 回退 process.cwd()，与其他域一致） */
function resolveCwd(exec: ToolRunContext): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

/** 任务级失败结果投影（稳定 code + 文案） */
function failResult(
  index: number,
  task: { image_path: string },
  code: string,
  error: string,
  cancelled = false,
): MediaTaskResult {
  return { index, success: false, code, error, cancelled, inputPath: task.image_path }
}

/** 取消结果投影 */
function cancelledResult(index: number, task: { image_path: string }): MediaTaskResult {
  return failResult(index, task, MediaErrorCode.CANCELLED, 'user cancelled the operation', true)
}

/** 任务级失败结果投影（inputPath 显式指定；generate_image 无输入图用空串） */
function failResultFor(
  inputPath: string,
  index: number,
  code: string,
  error: string,
  cancelled = false,
): MediaTaskResult {
  return { index, success: false, code, error, cancelled, inputPath }
}

/** 取消结果投影（inputPath 显式指定） */
function cancelledResultFor(inputPath: string, index: number): MediaTaskResult {
  return failResultFor(inputPath, index, MediaErrorCode.CANCELLED, 'user cancelled the operation', true)
}

/**
 * 进程内单调时间戳（L4）：保证同一毫秒内多次调用生成的默认输出文件名互不覆盖。
 * 默认输出名嵌入 Date.now()，同毫秒的连续调用（如快速小图批量、紧邻的两次
 * generate_image）会生成相同文件名互相覆盖；本函数保证进程内严格递增。
 */
let lastOutputTimestamp = 0
function nextOutputTimestamp(): number {
  const now = Date.now()
  if (now > lastOutputTimestamp) {
    lastOutputTimestamp = now
  } else {
    lastOutputTimestamp += 1
  }
  return lastOutputTimestamp
}

/** 剔除值为 undefined 的键（lossless-JSON 契约：不序列化 undefined 值键） */
function omitUndefined<T extends object>(value: T): T {
  const out = Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Record<string, unknown>
  return out as T
}

/**
 * 图片 magic bytes 判定（PNG 89 50 4E 47 / JPEG FF D8 FF / WebP RIFF....WEBP /
 * GIF 47 49 46 38）。返回归一化格式名；无法识别返回 undefined。
 */
function detectImageFormat(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | 'gif' | undefined {
  if (bytes.byteLength < 4) return undefined
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    if (bytes.byteLength >= 12 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      return 'webp'
    }
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'gif'
  return undefined
}

/** 渠道声明 format/mime 归一化为格式名（未知值返回 undefined，不据此拒绝） */
function normalizeDeclaredFormat(value: string): string | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'png' || normalized === 'image/png' || normalized === 'image/x-png') return 'png'
  if (normalized === 'jpg' || normalized === 'jpeg' || normalized === 'image/jpeg') return 'jpeg'
  if (normalized === 'webp' || normalized === 'image/webp') return 'webp'
  if (normalized === 'gif' || normalized === 'image/gif') return 'gif'
  return undefined
}

/**
 * 模型渠道返回字节与期望输出格式的一致性校验（H-17）：
 * 1) magic bytes 必须识别为受支持图片格式；
 * 2) 必须与期望输出格式一致（jpeg 统一 .jpg 扩展名）；
 * 3) 渠道声明 format/mime 与 magic bytes 冲突时拒绝。
 * 返回错误文案；null = 通过。不一致必须明确拒绝，不静默落盘。
 */
function imageOutputMismatch(
  expectedExt: string,
  bytes: Uint8Array,
  declared: { format?: string; mime?: string },
): string | null {
  const detected = detectImageFormat(bytes)
  if (detected === undefined) {
    return `model channel returned bytes that are not a supported image format (expected ${expectedExt === 'jpg' ? 'jpeg' : expectedExt})`
  }
  const expected = expectedExt === 'jpg' ? 'jpeg' : expectedExt
  if (detected !== expected) {
    return `model channel returned ${detected} image bytes but the output format is ${expected} (extension .${expectedExt})`
  }
  for (const [kind, value] of [['format', declared.format], ['mime', declared.mime]] as const) {
    if (!value) continue
    const normalized = normalizeDeclaredFormat(value)
    if (normalized && normalized !== detected) {
      return `model channel declared ${kind} "${value}" but returned ${detected} image bytes`
    }
  }
  return null
}

/**
 * 模型渠道工具输出路径解析：显式 output_path（工作区内）或调用方按同一 ts
 * 生成的默认路径（generate：media-output/gen-<ts>.<ext>；remove-background：
 * media-output/<name>-bg-removed-<ts>.png）。路径安全与三件套同源
 * （domain/paths.ts 纯字符串层 + MediaFsPort 适配层权威校验）。
 */
function resolveModelOutput(
  cwd: string,
  outputPath: string | undefined,
  defaultPath: string,
  index: number,
): { ok: true; absolute: string; display: string } | { ok: false; result: MediaTaskResult } {
  try {
    const absolute = outputPath ? resolveInsideWorkspace(cwd, outputPath) : defaultPath
    return { ok: true, absolute, display: absolute }
  } catch (error) {
    const mediaError = error instanceof MediaError ? error : new MediaError(MediaErrorCode.INVALID_ARGUMENTS, String(error))
    return { ok: false, result: failResultFor('', index, mediaError.code, mediaError.message) }
  }
}

/** 解析任务输入路径（工作区内）；失败投影为任务级结果 */
function resolveInput(
  cwd: string,
  task: { image_path: string },
  index: number,
): { ok: true; absolute: string } | { ok: false; result: MediaTaskResult } {
  try {
    return { ok: true, absolute: resolveInsideWorkspace(cwd, task.image_path) }
  } catch (error) {
    const mediaError = error instanceof MediaError ? error : new MediaError(MediaErrorCode.INVALID_ARGUMENTS, String(error))
    return { ok: false, result: failResult(index, task, mediaError.code, mediaError.message) }
  }
}

/** 解析输出绝对路径：显式 output_path（工作区内）或默认 media-output/<name>-<ts>.<ext> */
function resolveOutput(
  cwd: string,
  outputPath: string | undefined,
  inputPath: string,
  ext: string,
  index: number,
): { ok: true; absolute: string; display: string } | { ok: false; result: MediaTaskResult } {
  const task = { image_path: inputPath }
  try {
    const ts = nextOutputTimestamp()
    const absolute = outputPath
      ? resolveInsideWorkspace(cwd, outputPath)
      : buildDefaultOutputPath(cwd, inputPath, ext, ts, index)
    return { ok: true, absolute, display: absolute }
  } catch (error) {
    const mediaError = error instanceof MediaError ? error : new MediaError(MediaErrorCode.INVALID_ARGUMENTS, String(error))
    return { ok: false, result: failResult(index, task, mediaError.code, mediaError.message) }
  }
}

/** 按目标扩展名编码（老版同款：jpeg/webp quality 90，png 默认） */
async function encodeTo(
  sharp: SharpModule,
  buffer: Uint8Array,
  ext: 'png' | 'jpg' | 'webp',
): Promise<Uint8Array> {
  if (ext === 'jpg') return sharp(buffer).jpeg({ quality: 90 }).toBuffer()
  if (ext === 'webp') return sharp(buffer).webp({ quality: 90 }).toBuffer()
  return sharp(buffer).png().toBuffer()
}

/** 读取 + 解码 + 元数据（共享前置管线） */
async function loadImage(
  deps: MediaToolDeps,
  cwd: string,
  signal: AbortSignal | undefined,
  task: { image_path: string },
  index: number,
): Promise<
  | { ok: true; sharp: SharpModule; bytes: Uint8Array; width: number; height: number; format?: string }
  | { ok: false; result: MediaTaskResult }
> {
  if (signal?.aborted) {
    return { ok: false, result: cancelledResult(index, task) }
  }
  const input = resolveInput(cwd, task, index)
  if (!input.ok) return input

  let sharp: SharpModule
  try {
    sharp = await loadSharp()
  } catch (error) {
    const mediaError = error instanceof MediaError ? error : new MediaError(MediaErrorCode.SHARP_MISSING, String(error))
    return { ok: false, result: failResult(index, task, mediaError.code, mediaError.message) }
  }

  let bytes: Uint8Array
  try {
    bytes = await deps.fs.readBytes(input.absolute, { signal, maxBytes: MAX_READ_BYTES, workspaceRoot: cwd })
  } catch (error) {
    const mediaError = error instanceof MediaError ? error : new MediaError(MediaErrorCode.READ_FAILED, String(error))
    return { ok: false, result: failResult(index, task, mediaError.code, mediaError.message) }
  }

  if (signal?.aborted) {
    return { ok: false, result: cancelledResult(index, task) }
  }

  let metadata: { width?: number; height?: number; format?: string }
  try {
    metadata = await sharp(bytes).metadata()
  } catch (error) {
    return {
      ok: false,
      result: failResult(
        index,
        task,
        MediaErrorCode.NOT_IMAGE,
        `cannot decode image ${task.image_path}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    }
  }
  if (!metadata.width || !metadata.height) {
    return {
      ok: false,
      result: failResult(index, task, MediaErrorCode.NOT_IMAGE, `cannot get image dimensions: ${task.image_path}`),
    }
  }
  const sourceExt = extFromSharpFormat(metadata.format)
  if (sourceExt && !isSupportedImageExt(sourceExt)) {
    return {
      ok: false,
      result: failResult(index, task, MediaErrorCode.NOT_IMAGE, `unsupported image format: ${metadata.format ?? 'unknown'}`),
    }
  }
  return { ok: true, sharp, bytes, width: metadata.width, height: metadata.height, format: metadata.format }
}

/** crop 单任务执行 */
async function executeCropTask(
  deps: MediaToolDeps,
  cwd: string,
  signal: AbortSignal | undefined,
  task: CropTask,
  index: number,
): Promise<MediaTaskResult> {
  const loaded = await loadImage(deps, cwd, signal, task, index)
  if (!loaded.ok) return loaded.result
  const { sharp, bytes, width: originalWidth, height: originalHeight, format } = loaded

  // 归一化坐标 → 像素（clamp 后 round）；与老版 normalizeCoord 一致（范围 0-1）
  const left = normalizeCoord(task.x1, originalWidth)
  const top = normalizeCoord(task.y1, originalHeight)
  const right = normalizeCoord(task.x2, originalWidth)
  const bottom = normalizeCoord(task.y2, originalHeight)
  const cropWidth = right - left
  const cropHeight = bottom - top
  if (cropWidth <= 0 || cropHeight <= 0) {
    return failResult(
      index,
      task,
      MediaErrorCode.INVALID_ARGUMENTS,
      `invalid crop region (width or height is 0): ${task.image_path}`,
    )
  }

  if (signal?.aborted) return cancelledResult(index, task)

  let cropped: Uint8Array
  try {
    cropped = await sharp(bytes)
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .toBuffer()
  } catch (error) {
    return failResult(
      index,
      task,
      MediaErrorCode.PROCESSING_FAILED,
      `crop failed for ${task.image_path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (signal?.aborted) return cancelledResult(index, task)

  const outputFormat = resolveOutputFormat(undefined, task.output_path, format)
  let finalBytes: Uint8Array
  try {
    finalBytes = await encodeTo(sharp, cropped, outputFormat.ext as 'png' | 'jpg' | 'webp')
  } catch (error) {
    return failResult(
      index,
      task,
      MediaErrorCode.PROCESSING_FAILED,
      `encoding failed for ${task.image_path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const output = resolveOutput(cwd, task.output_path, task.image_path, outputFormat.ext, index)
  if (!output.ok) return output.result

  try {
    await deps.fs.writeBytes(output.absolute, finalBytes, { signal, workspaceRoot: cwd })
  } catch (error) {
    const mediaError = error instanceof MediaError ? error : new MediaError(MediaErrorCode.WRITE_FAILED, String(error))
    return failResult(index, task, mediaError.code, mediaError.message)
  }

  return {
    index,
    success: true,
    inputPath: task.image_path,
    outputPath: output.display,
    originalDimensions: toDimensions(originalWidth, originalHeight),
    resultDimensions: toDimensions(cropWidth, cropHeight),
  }
}

/** resize 单任务执行 */
async function executeResizeTask(
  deps: MediaToolDeps,
  cwd: string,
  signal: AbortSignal | undefined,
  task: ResizeTask,
  index: number,
): Promise<MediaTaskResult> {
  const loaded = await loadImage(deps, cwd, signal, task, index)
  if (!loaded.ok) return loaded.result
  const { sharp, bytes, width: originalWidth, height: originalHeight, format } = loaded

  if (signal?.aborted) return cancelledResult(index, task)

  // 输出像素预检：目标尺寸超 50MP 直接拒绝（与 rotate 的 OUTPUT_TOO_LARGE 护栏同源，
  // 防止目标尺寸过大时 sharp 展开超大内存缓冲）
  if (exceedsOutputPixelLimit(task.width, task.height)) {
    return failResult(
      index,
      task,
      MediaErrorCode.OUTPUT_TOO_LARGE,
      `resized image would be too large (${task.width}x${task.height} = ${task.width * task.height} pixels, limit 50MP); choose a smaller target size`,
    )
  }

  let resized: Uint8Array
  try {
    // 老版同款：拉伸填充整个目标尺寸（不保持宽高比），Lanczos3 高质量
    resized = await sharp(bytes)
      .resize(task.width, task.height, { fit: 'fill', kernel: 'lanczos3' })
      .toBuffer()
  } catch (error) {
    return failResult(
      index,
      task,
      MediaErrorCode.PROCESSING_FAILED,
      `resize failed for ${task.image_path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (signal?.aborted) return cancelledResult(index, task)

  const outputFormat = resolveOutputFormat(undefined, task.output_path, format)
  let finalBytes: Uint8Array
  try {
    finalBytes = await encodeTo(sharp, resized, outputFormat.ext as 'png' | 'jpg' | 'webp')
  } catch (error) {
    return failResult(
      index,
      task,
      MediaErrorCode.PROCESSING_FAILED,
      `encoding failed for ${task.image_path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const output = resolveOutput(cwd, task.output_path, task.image_path, outputFormat.ext, index)
  if (!output.ok) return output.result

  try {
    await deps.fs.writeBytes(output.absolute, finalBytes, { signal, workspaceRoot: cwd })
  } catch (error) {
    const mediaError = error instanceof MediaError ? error : new MediaError(MediaErrorCode.WRITE_FAILED, String(error))
    return failResult(index, task, mediaError.code, mediaError.message)
  }

  return {
    index,
    success: true,
    inputPath: task.image_path,
    outputPath: output.display,
    originalDimensions: toDimensions(originalWidth, originalHeight),
    resultDimensions: toDimensions(task.width, task.height),
  }
}

/** rotate 单任务执行 */
async function executeRotateTask(
  deps: MediaToolDeps,
  cwd: string,
  signal: AbortSignal | undefined,
  task: RotateTask,
  index: number,
): Promise<MediaTaskResult> {
  const loaded = await loadImage(deps, cwd, signal, task, index)
  if (!loaded.ok) return loaded.result
  const { sharp, bytes, width: originalWidth, height: originalHeight, format } = loaded

  // 输出像素预检（rotate 前）：包围矩形估算，超 50MP 直接拒绝（老版同款护栏）
  const estimated = estimateRotatedSize(originalWidth, originalHeight, task.angle)
  if (exceedsOutputPixelLimit(estimated.width, estimated.height)) {
    return failResult(
      index,
      task,
      MediaErrorCode.OUTPUT_TOO_LARGE,
      `rotated image would be too large (estimated ${estimated.width}x${estimated.height} = ${estimated.width * estimated.height} pixels, limit 50MP); resize the image first`,
    )
  }

  if (signal?.aborted) return cancelledResult(index, task)

  let rotated: Uint8Array
  try {
    // sharp 的 rotate 是顺时针；自动计算最小包围矩形；透明背景由编码格式决定
    rotated = await sharp(bytes).rotate(task.angle).toBuffer()
  } catch (error) {
    return failResult(
      index,
      task,
      MediaErrorCode.PROCESSING_FAILED,
      `rotate failed for ${task.image_path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (signal?.aborted) return cancelledResult(index, task)

  // 旋转后实测尺寸复查（护栏兜底，老版同款）
  let rotatedWidth = estimated.width
  let rotatedHeight = estimated.height
  try {
    const rotatedMeta = await sharp(rotated).metadata()
    if (rotatedMeta.width && rotatedMeta.height) {
      rotatedWidth = rotatedMeta.width
      rotatedHeight = rotatedMeta.height
    }
  } catch {
    // 元数据读取失败不阻断（尺寸按估算值返回）
  }
  if (exceedsOutputPixelLimit(rotatedWidth, rotatedHeight)) {
    return failResult(
      index,
      task,
      MediaErrorCode.OUTPUT_TOO_LARGE,
      `rotated image would be too large (${rotatedWidth}x${rotatedHeight} = ${rotatedWidth * rotatedHeight} pixels, limit 50MP); resize the image first`,
    )
  }

  const outputFormat = resolveOutputFormat(task.format, task.output_path, format)
  let finalBytes: Uint8Array
  try {
    finalBytes = await encodeTo(sharp, rotated, outputFormat.ext as 'png' | 'jpg' | 'webp')
  } catch (error) {
    return failResult(
      index,
      task,
      MediaErrorCode.PROCESSING_FAILED,
      `encoding failed for ${task.image_path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const output = resolveOutput(cwd, task.output_path, task.image_path, outputFormat.ext, index)
  if (!output.ok) return output.result

  try {
    await deps.fs.writeBytes(output.absolute, finalBytes, { signal, workspaceRoot: cwd })
  } catch (error) {
    const mediaError = error instanceof MediaError ? error : new MediaError(MediaErrorCode.WRITE_FAILED, String(error))
    return failResult(index, task, mediaError.code, mediaError.message)
  }

  return {
    index,
    success: true,
    inputPath: task.image_path,
    outputPath: output.display,
    originalDimensions: toDimensions(originalWidth, originalHeight),
    resultDimensions: toDimensions(rotatedWidth, rotatedHeight),
  }
}

/**
 * remove_background 单任务执行：读取工作区内输入图片 → 调用模型渠道 →
 * 返回字节写盘（默认 <ws>/media-output/<name>-bg-removed-<ts>.png）。
 * 输入路径安全走 resolveInput（domain/paths.ts 纯字符串层）+
 * MediaFsPort.readBytes（适配层权威校验）；渠道未注入时 fail-closed。
 */
async function executeRemoveBackgroundTask(
  deps: MediaToolDeps,
  channel: Pick<ChannelImagePort, 'removeBackground'>,
  cwd: string,
  signal: AbortSignal | undefined,
  task: RemoveBackgroundTask,
  index: number,
): Promise<MediaTaskResult> {
  if (signal?.aborted) return cancelledResultFor(task.image_path, index)

  const input = resolveInput(cwd, task, index)
  if (!input.ok) return input.result

  let bytes: Uint8Array
  try {
    bytes = await deps.fs.readBytes(input.absolute, { signal, maxBytes: MAX_READ_BYTES, workspaceRoot: cwd })
  } catch (error) {
    const mediaError = error instanceof MediaError ? error : new MediaError(MediaErrorCode.READ_FAILED, String(error))
    return failResultFor(task.image_path, index, mediaError.code, mediaError.message)
  }

  if (signal?.aborted) return cancelledResultFor(task.image_path, index)

  const ts = nextOutputTimestamp()
  const defaultPath = buildBackgroundRemovedOutputPath(cwd, task.image_path, ts)
  const output = resolveModelOutput(cwd, task.output_path, defaultPath, index)
  if (!output.ok) return output.result

  if (signal?.aborted) return cancelledResultFor(task.image_path, index)

  let result: ChannelImageResult
  try {
    result = await channel.removeBackground({
      inputPath: input.absolute,
      inputBytes: bytes,
      signal,
    })
  } catch (error) {
    const mediaError = error instanceof MediaError ? error : new MediaError(MediaErrorCode.MODEL_CHANNEL_FAILED, String(error))
    return failResultFor(task.image_path, index, mediaError.code, mediaError.message)
  }

  if (signal?.aborted) return cancelledResultFor(task.image_path, index)
  if (!result.bytes || result.bytes.byteLength === 0) {
    return failResultFor(task.image_path, index, MediaErrorCode.MODEL_RESPONSE_INVALID, 'model channel returned an empty image response')
  }
  // H-17 同族：remove_background 契约输出透明背景 PNG，返回字节必须是真实 PNG
  const mismatch = imageOutputMismatch('png', result.bytes, {
    format: result.format,
    mime: result.mime,
  })
  if (mismatch !== null) {
    return failResultFor(task.image_path, index, MediaErrorCode.MODEL_RESPONSE_INVALID, mismatch)
  }

  try {
    await deps.fs.writeBytes(output.absolute, result.bytes, { signal, workspaceRoot: cwd })
  } catch (error) {
    const mediaError = error instanceof MediaError ? error : new MediaError(MediaErrorCode.WRITE_FAILED, String(error))
    return failResultFor(task.image_path, index, mediaError.code, mediaError.message)
  }

  return { index, success: true, inputPath: task.image_path, outputPath: output.display }
}

/** 工具类别（汇总消息文案用） */
type MediaOpKind = 'crop' | 'resize' | 'rotate' | 'remove-background'

const OP_LABELS: Record<MediaOpKind, string> = {
  crop: 'Crop',
  resize: 'Resize',
  rotate: 'Rotate',
  'remove-background': 'Remove Background',
}

const OP_PAST: Record<MediaOpKind, string> = {
  crop: 'Cropped',
  resize: 'Resized',
  rotate: 'Rotated',
  'remove-background': 'Removed background',
}

/** 汇总批量结果 → 工具级结构化结果（与老版 message 语义对齐） */
function summarize(
  kind: MediaOpKind,
  isBatch: boolean,
  tasksCount: number,
  results: MediaTaskResult[],
): MediaToolResult {
  const successResults = results.filter(r => r.success)
  const failedResults = results.filter(r => !r.success && !r.cancelled)
  const cancelledResults = results.filter(r => r.cancelled)
  const paths = successResults.map(r => r.outputPath ?? '').filter(Boolean)
  const opLabel = OP_LABELS[kind]

  if (cancelledResults.length === results.length && results.length > 0) {
    return {
      success: false,
      code: MediaErrorCode.CANCELLED,
      message: 'User cancelled the request. Please wait for the user\'s next instruction.',
      totalTasks: tasksCount,
      successCount: 0,
      failedCount: 0,
      cancelledCount: cancelledResults.length,
      results,
      paths,
    }
  }

  if (results.length === 0) {
    return {
      success: false,
      code: MediaErrorCode.NO_TASKS,
      message: 'No valid tasks. Use single mode (image_path + operation parameters) or batch mode (images array).',
      totalTasks: 0,
      successCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      results,
      paths,
    }
  }

  let message: string
  let success = true
  let code: string | undefined

  if (failedResults.length === 0) {
    // 全部成功
    if (isBatch) {
      message = `✅ Batch ${kind} completed: ${successResults.length}/${tasksCount} tasks succeeded\n\nSaved to:\n${paths.map(p => `• ${p}`).join('\n')}`
    } else if (kind === 'remove-background') {
      // 模型渠道工具无输入图/尺寸维度：只报输出路径
      message = `✅ ${OP_PAST[kind]} completed!\n\nOutput: ${paths[0] ?? ''}`
    } else {
      const r = successResults[0]!
      const op = OP_PAST[kind]
      message = `✅ ${opLabel} completed!\n\nOriginal: ${r.originalDimensions?.width}×${r.originalDimensions?.height} (${r.originalDimensions?.aspectRatio})\n${op}: ${r.resultDimensions?.width}×${r.resultDimensions?.height} (${r.resultDimensions?.aspectRatio})\n\nOutput: ${paths[0] ?? ''}`
    }
  } else if (successResults.length === 0) {
    // 全部失败
    success = false
    code = failedResults[0]?.code ?? MediaErrorCode.PROCESSING_FAILED
    const errors = failedResults.map(r => r.error).join('\n')
    message = isBatch
      ? `Batch ${kind} failed: All ${tasksCount} tasks failed\n\n${errors}`
      : (failedResults[0]?.error ?? `${opLabel} failed`)
  } else {
    // 部分成功
    const errors = failedResults.map(r => r.error).join('\n')
    message = `⚠️ Batch ${kind} partially completed: ${successResults.length}/${tasksCount} succeeded, ${failedResults.length} failed\n\n`
    message += `Saved to:\n${paths.map(p => `• ${p}`).join('\n')}\n\n`
    if (failedResults.length > 0) {
      message += `Failure reasons:\n${errors}`
    }
  }

  if (cancelledResults.length > 0) {
    message += `\n\n⚠️ Note: ${cancelledResults.length} tasks were cancelled by user`
  }

  return omitUndefined({
    success,
    code,
    message,
    totalTasks: tasksCount,
    successCount: successResults.length,
    failedCount: failedResults.length,
    cancelledCount: cancelledResults.length,
    results,
    paths,
  })
}

/** 批量执行主循环（顺序执行；每任务失败不中断，收集到 results；每步检查 signal）。
 * L2：取消信号触发后不再执行剩余任务（原来只是每个剩余任务被 executor 逐项判为
 * cancelled，浪费迭代）；剩余任务直接投影为 cancelled 结果，保持「全部取消 →
 * GRAY_CANCELLED」的汇总语义不变。 */
async function runBatch<T extends { image_path: string }>(
  deps: MediaToolDeps,
  cwd: string,
  signal: AbortSignal | undefined,
  kind: 'crop' | 'resize' | 'rotate',
  tasks: T[],
  executor: (task: T, index: number) => Promise<MediaTaskResult>,
): Promise<MediaToolResult> {
  const results: MediaTaskResult[] = []
  for (let index = 0; index < tasks.length; index += 1) {
    if (signal?.aborted) {
      results.push(cancelledResult(index, tasks[index]!))
      continue
    }
    results.push(await executor(tasks[index]!, index))
  }
  return summarize(kind, tasks.length > 1, tasks.length, results)
}

/** 工具级错误投影（批量上限/重复输出等整批拒绝） */
function batchRejected(code: string, message: string, taskCount: number): MediaToolResult {
  return {
    success: false,
    code,
    message,
    totalTasks: taskCount,
    successCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    results: [],
    paths: [],
  }
}

/** 解析任务数组：参数校验失败（toTasks throw）投影为整批拒绝结果，不向框架抛错 */
function parseTasks(
  kind: 'crop_image' | 'resize_image' | 'rotate_image',
  args: { images?: unknown; image_path?: unknown },
): { tasks: import('./domain/types.ts').MediaTask[] | null } | { rejected: MediaToolResult } {
  try {
    return { tasks: toTasks(kind, args) }
  } catch (error) {
    const mediaError = error instanceof MediaError ? error : new MediaError(MediaErrorCode.INVALID_ARGUMENTS, String(error))
    return { rejected: batchRejected(mediaError.code, mediaError.message, 0) }
  }
}

/**
 * 模型渠道工具参数解析（remove_background，单任务模式）：
 * 校验失败 → 整批拒绝结果（GRAY_MEDIA_INVALID_ARGUMENTS），不向框架抛错。
 */
function parseModelTask(
  kind: 'remove_background',
  args: Record<string, unknown>,
): { task: RemoveBackgroundTask } | { rejected: MediaToolResult } {
  try {
    const validated = validateRemoveBackgroundTask(args)
    if (!validated.ok) {
      throw new MediaError(MediaErrorCode.INVALID_ARGUMENTS, validated.error)
    }
    return { task: validated.value }
  } catch (error) {
    const mediaError = error instanceof MediaError ? error : new MediaError(MediaErrorCode.INVALID_ARGUMENTS, String(error))
    return { rejected: batchRejected(mediaError.code, mediaError.message, 0) }
  }
}

/** 输出 schema 共享片段 */
const dimensionsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    width: { type: 'integer' },
    height: { type: 'integer' },
    aspectRatio: { type: 'string' },
  },
} as const

const taskResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer' },
    success: { type: 'boolean' },
    inputPath: { type: 'string' },
    outputPath: { type: 'string' },
    code: { type: 'string' },
    error: { type: 'string' },
    cancelled: { type: 'boolean' },
    originalDimensions: dimensionsSchema,
    resultDimensions: dimensionsSchema,
  },
} as const

const toolResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    success: { type: 'boolean' },
    code: { type: 'string' },
    message: { type: 'string' },
    totalTasks: { type: 'integer' },
    successCount: { type: 'integer' },
    failedCount: { type: 'integer' },
    cancelledCount: { type: 'integer' },
    paths: { type: 'array', items: { type: 'string' } },
    results: { type: 'array', items: taskResultSchema },
  },
} as const

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** 批量模式任务项 schema（image_path/output_path 共用，附加工具专属参数） */
function batchItemSchema(extra: Record<string, ParameterPropertySpec>): ObjectValueSchemaSpec {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      image_path: { type: 'string', required: true, description: 'Input image path (workspace-relative or absolute within the workspace).' },
      output_path: { type: 'string', description: 'Optional output path; defaults to <workspace>/media-output/<name>-<ts>.<ext>.' },
      ...extra,
    },
  }
}

/** 创建 media 工具的 defineTool 定义（本地三件套 + remove_background） */
export function createMediaToolDefinitions(deps: MediaToolDeps): ToolDefinition[] {
  // L9：运行时同样钳制到硬顶（schema 在 settings 层已拦，此处兜底直传 Config/注入）
  const maxBatch = Math.min(deps.maxBatch > 0 ? deps.maxBatch : DEFAULT_MAX_BATCH, MAX_MEDIA_MAX_BATCH)
  // 模型渠道：未注入时 fail-closed（rc.6 无公开图像 API → GRAY_MEDIA_MODEL_CHANNEL_UNAVAILABLE）
  const channel = deps.channel ?? createUnavailableChannelImagePort()

  /** 整批拒绝检查（上限/重复输出），返回 null 表示通过（cwd 由 execute 注入；
   * function declaration hoisting 保证 crop_image 定义内可引用） */
  function rejectBatchChecked(
    tasks: readonly MediaTask[],
    cwd: string,
  ): MediaToolResult | null {
    try {
      assertBatchLimit(tasks, maxBatch)
    } catch (error) {
      return batchRejected((error as MediaError).code, (error as MediaError).message, tasks.length)
    }
    const duplicate = findDuplicateOutput(tasks, output => {
      try {
        return resolveInsideWorkspace(cwd, output)
      } catch {
        return output
      }
    })
    if (duplicate) {
      return batchRejected(
        MediaErrorCode.DUPLICATE_OUTPUT,
        `Duplicate output_path detected: ${duplicate}. Each task must write to a unique output path.`,
        tasks.length,
      )
    }
    return null
  }

  const crop_image = defineTool({
    name: 'crop_image',
    description:
      `Crop one or more images with normalized coordinates (0-1). ` +
      `Provide a single image (image_path + output_path? + x1/y1/x2/y2) or a batch (images array, up to ${maxBatch} tasks). ` +
      `Coordinates are normalized: 0 = left/top edge, 1 = right/bottom edge; x1 < x2 and y1 < y2 are required. ` +
      `Outputs are written to the workspace (output_path, or <workspace>/media-output/<name>-<ts>.<ext> by default). ` +
      `Returns per-task results with output paths and dimensions.`,
    parameters: {
      images: {
        type: 'array',
        description: `Batch mode: up to ${maxBatch} crop tasks.`,
        items: batchItemSchema({
          x1: { type: 'number', required: true, description: 'Normalized left edge (0-1).' },
          y1: { type: 'number', required: true, description: 'Normalized top edge (0-1).' },
          x2: { type: 'number', required: true, description: 'Normalized right edge (0-1).' },
          y2: { type: 'number', required: true, description: 'Normalized bottom edge (0-1).' },
        }),
      },
      image_path: { type: 'string', description: 'Single mode: input image path.' },
      output_path: { type: 'string', description: 'Single mode: optional output path.' },
      x1: { type: 'number', description: 'Single mode: normalized left edge (0-1).' },
      y1: { type: 'number', description: 'Single mode: normalized top edge (0-1).' },
      x2: { type: 'number', description: 'Single mode: normalized right edge (0-1).' },
      y2: { type: 'number', description: 'Single mode: normalized bottom edge (0-1).' },
    },
    output: { schema: toolResultSchema, render: renderJson },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = resolveCwd(exec)
      const signal = exec.signal
      const parsed = parseTasks('crop_image', args)
      if ('rejected' in parsed) return parsed.rejected
      const tasks = parsed.tasks
      if (!tasks) {
        return summarize('crop', false, 0, [])
      }
      const rejected = rejectBatchChecked(tasks, cwd)
      if (rejected) return rejected
      const cropTasks = tasks as CropTask[]
      return runBatch(deps, cwd, signal, 'crop', cropTasks, (task, index) =>
        executeCropTask(deps, cwd, signal, task, index))
    },
  })

  const resize_image = defineTool({
    name: 'resize_image',
    description:
      `Resize one or more images to exact target dimensions (stretch fill, no aspect-ratio preservation). ` +
      `Provide a single image (image_path + output_path? + width/height) or a batch (images array, up to ${maxBatch} tasks). ` +
      `width/height are positive integer pixels (each up to 16384). ` +
      `Outputs are written to the workspace (output_path, or <workspace>/media-output/<name>-<ts>.<ext> by default). ` +
      `Returns per-task results with output paths and dimensions.`,
    parameters: {
      images: {
        type: 'array',
        description: `Batch mode: up to ${maxBatch} resize tasks.`,
        items: batchItemSchema({
          width: { type: 'integer', required: true, description: 'Target width in pixels (1-16384).' },
          height: { type: 'integer', required: true, description: 'Target height in pixels (1-16384).' },
        }),
      },
      image_path: { type: 'string', description: 'Single mode: input image path.' },
      output_path: { type: 'string', description: 'Single mode: optional output path.' },
      width: { type: 'integer', description: 'Single mode: target width in pixels.' },
      height: { type: 'integer', description: 'Single mode: target height in pixels.' },
    },
    output: { schema: toolResultSchema, render: renderJson },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = resolveCwd(exec)
      const signal = exec.signal
      const parsed = parseTasks('resize_image', args)
      if ('rejected' in parsed) return parsed.rejected
      const tasks = parsed.tasks
      if (!tasks) {
        return summarize('resize', false, 0, [])
      }
      const rejected = rejectBatchChecked(tasks, cwd)
      if (rejected) return rejected
      const resizeTasks = tasks as ResizeTask[]
      return runBatch(deps, cwd, signal, 'resize', resizeTasks, (task, index) =>
        executeResizeTask(deps, cwd, signal, task, index))
    },
  })

  const rotate_image = defineTool({
    name: 'rotate_image',
    description:
      `Rotate one or more images clockwise by a fixed angle (0/90/180/270). ` +
      `Provide a single image (image_path + output_path? + angle + format?) or a batch (images array, up to ${maxBatch} tasks). ` +
      `angle must be one of 0, 90, 180, 270; format is optional (png/jpeg/webp) and defaults to the output extension or the source format. ` +
      `Outputs are written to the workspace (output_path, or <workspace>/media-output/<name>-<ts>.<ext> by default). ` +
      `Returns per-task results with output paths and dimensions.`,
    parameters: {
      images: {
        type: 'array',
        description: `Batch mode: up to ${maxBatch} rotate tasks.`,
        items: batchItemSchema({
          angle: { type: 'number', required: true, description: 'Rotation angle in degrees, one of: 0, 90, 180, 270.' },
          format: { type: 'string', description: 'Optional output format: png, jpeg or webp.' },
        }),
      },
      image_path: { type: 'string', description: 'Single mode: input image path.' },
      output_path: { type: 'string', description: 'Single mode: optional output path.' },
      angle: { type: 'number', description: 'Single mode: rotation angle, one of: 0, 90, 180, 270.' },
      format: { type: 'string', description: 'Single mode: optional output format: png, jpeg or webp.' },
    },
    output: { schema: toolResultSchema, render: renderJson },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = resolveCwd(exec)
      const signal = exec.signal
      const parsed = parseTasks('rotate_image', args)
      if ('rejected' in parsed) return parsed.rejected
      const tasks = parsed.tasks
      if (!tasks) {
        return summarize('rotate', false, 0, [])
      }
      const rejected = rejectBatchChecked(tasks, cwd)
      if (rejected) return rejected
      const rotateTasks = tasks as RotateTask[]
      return runBatch(deps, cwd, signal, 'rotate', rotateTasks, (task, index) =>
        executeRotateTask(deps, cwd, signal, task, index))
    },
  })

  const remove_background = defineTool({
    name: 'remove_background',
    description:
      `Remove the background of an image using the configured image model channel (segmentation). ` +
      `Provide the input image path (workspace-relative or absolute within the workspace) and an optional output_path. ` +
      `The result (transparent-background PNG) is written to output_path or <workspace>/media-output/<name>-bg-removed-<ts>.png by default. ` +
      `The image model channel is not connected in this build: calls return GRAY_MEDIA_MODEL_CHANNEL_UNAVAILABLE until a provider is wired (see media README).`,
    parameters: {
      image_path: { type: 'string', required: true, description: 'Input image path (workspace-relative or absolute within the workspace).' },
      output_path: { type: 'string', description: 'Optional output path; defaults to <workspace>/media-output/<name>-bg-removed-<ts>.png.' },
    },
    output: { schema: toolResultSchema, render: renderJson },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = resolveCwd(exec)
      const signal = exec.signal
      const parsed = parseModelTask('remove_background', args)
      if ('rejected' in parsed) return parsed.rejected
      const task = parsed.task as RemoveBackgroundTask
      return summarize('remove-background', false, 1, [
        await executeRemoveBackgroundTask(deps, channel, cwd, signal, task, 0),
      ])
    },
  })

  return [crop_image, resize_image, rotate_image, remove_background]
}
