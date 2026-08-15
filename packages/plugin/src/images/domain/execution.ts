/**
 * GrayCode - images 执行编排（generate_image 单任务）。
 *
 * 纯逻辑层：参数校验 → 请求构建 → fetch（超时 + exec.signal）→ 响应解析 →
 * 图片落盘（节点 fs 端口）。宿主无关，fetch/fs/时间均以端口注入，便于测试。
 *
 * 路径安全：output_path 经 resolveOutputPath 做工作区包含性校验（.. 穿越/
 * 绝对路径逃逸/控制字符拒绝）；落盘前 fs 端口再做 realpath 权威校验
 * （符号链接目录逃逸工作区 → 拒绝，M-2，与 media 域 MediaFsPort 同构）。
 */

import * as path from 'node:path'
import type { AspectRatio, GeneratedImage, ImageSize } from './types.ts'
import { MAX_REFERENCE_IMAGES, DEFAULT_MAX_IMAGES_PER_TASK, IMAGE_API_TIMEOUT_MS } from './types.ts'
import {
  buildGenerateContentRequest,
  sniffMimeFromBase64,
  type GenerateImageConfig,
} from './request.ts'
import { isSupportedImageBytes, parseGenerateContentResponse, sniffExtension } from './response.ts'
import { applyExtensionCorrection, resolveOutputPath } from './paths.ts'

/** 文件能力端口（生产为 node fs 直写；测试注入内存/临时目录实现）。 */
export interface ImageFsPort {
  mkdir(directory: string): Promise<void>
  writeFile(filePath: string, bytes: Uint8Array): Promise<void>
  /**
   * 写前权威校验：目标文件（若已存在）与其最深已存在祖先目录 realpath 后
   * 必须位于 workspaceRoot 内（防符号链接把图片写到工作区外，M-2）。
   * 校验失败抛错（调用方投影为失败结果），不执行任何写入。
   */
  assertWriteInside(filePath: string, workspaceRoot: string): Promise<void>
}

export interface ImageExecutionDeps {
  /** HTTP 实现（默认全局 fetch；Node 18+）。 */
  fetchFn?: typeof fetch
  /** 文件实现（默认 node:fs/promises）。 */
  fs?: ImageFsPort
  /** 请求超时毫秒（默认 120s；测试注入小预算）。 */
  timeoutMs?: number
}

export interface GenerateImageArgs {
  prompt: string
  output_path: string
  reference_images?: string[]
  aspect_ratio?: string
  image_size?: string
}

export interface ImageTaskResult {
  success: boolean
  paths: string[]
  count: number
  texts: string[]
  error?: string
  cancelled?: boolean
}

export class ImagesExecutionError extends Error {
  readonly code = 'GRAY_IMAGES_EXECUTION_ERROR'
}

/** 校验参数合法性；失败抛 ImagesExecutionError（工具层投影为失败结果）。 */
export function validateArgs(args: GenerateImageArgs): void {
  if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
    throw new ImagesExecutionError('prompt is required')
  }
  if (typeof args.output_path !== 'string' || args.output_path.trim() === '') {
    throw new ImagesExecutionError('output_path is required')
  }
  const references = args.reference_images ?? []
  if (!Array.isArray(references)) {
    throw new ImagesExecutionError('reference_images must be an array of base64 strings')
  }
  if (references.length > MAX_REFERENCE_IMAGES) {
    throw new ImagesExecutionError(`Maximum ${MAX_REFERENCE_IMAGES} reference images allowed`)
  }
  for (const entry of references) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new ImagesExecutionError('reference_images entries must be non-empty base64 strings')
    }
    // L-2：无效/垃圾 base64 解码后魔数不可识别 → 拒绝（绝不把垃圾字节当图片透传）
    const bytes = Uint8Array.from(Buffer.from(entry, 'base64'))
    if (!isSupportedImageBytes(bytes)) {
      throw new ImagesExecutionError(
        'reference_images entries must decode to a supported image format (PNG/JPEG/GIF/WebP)',
      )
    }
  }
}

/** 参考图片 base64 → 内联 parts（mime 由 magic bytes 嗅探）。 */
function toReferenceImages(entries: readonly string[]): Array<{ data: string; mimeType: string }> {
  return entries.map(data => ({ data, mimeType: sniffMimeFromBase64(data) }))
}

/** 超时错误（内部标记；执行层映射为超时文案）。 */
class ImagesExecutionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`image API request timed out after ${timeoutMs / 1000}s`)
    this.name = 'ImagesExecutionTimeoutError'
  }
}

/** fetch 结果：2xx 携带解析出的 JSON；非 2xx 携带响应文本。 */
interface FetchOutcome {
  ok: boolean
  status: number
  text: string
  json: unknown
  jsonParseError?: string
}

/**
 * fetch + 超时 + 调用方 signal（AbortController 双源中止）。
 * L-1：计时器覆盖到 body 消费完成（response.text()/json() 也在超时预算内），
 * 慢 body 流不再无限期等待；finally 在 body 消费后才清计时器。
 */
async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<FetchOutcome> {
  const controller = new AbortController()
  let timedOut = false
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const detach = signal === undefined
    ? undefined
    : signal.aborted
      ? () => undefined
      : (() => {
          const onAbort = (): void => controller.abort()
          signal.addEventListener('abort', onAbort)
          return () => signal.removeEventListener('abort', onAbort)
        })()
  try {
    let response: Response
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (timedOut) throw new ImagesExecutionTimeoutError(timeoutMs)
      throw error
    }
    if (!response.ok) {
      let text = ''
      try {
        text = await response.text()
      } catch (error) {
        if (signal?.aborted) throw error
        // 读 body 失败按空文本处理（状态码已足够定位）
      }
      if (timedOut) throw new ImagesExecutionTimeoutError(timeoutMs)
      return { ok: false, status: response.status, text, json: undefined }
    }
    try {
      const json = await response.json()
      return { ok: true, status: response.status, text: '', json }
    } catch (error) {
      if (timedOut) throw new ImagesExecutionTimeoutError(timeoutMs)
      if (signal?.aborted) throw error
      return {
        ok: true,
        status: response.status,
        text: '',
        json: undefined,
        jsonParseError: error instanceof Error ? error.message : String(error),
      }
    }
  } finally {
    clearTimeout(timer)
    detach?.()
  }
}

/**
 * 执行一次图像生成/编辑任务。
 *
 * @param config 生效的域配置（url/apiKey/model/宽高比/尺寸开关与默认值）
 * @param args   defineTool 校验后的参数
 * @param cwd    会话工作区（exec.agent.session.header.cwd；undefined 时由调用方回退）
 * @param signal 调用方取消信号（exec.signal）
 * @param deps   端口（fetch/fs/时钟；测试注入）
 */
export async function executeGenerateImage(
  config: GenerateImageConfig,
  args: GenerateImageArgs,
  cwd: string,
  signal: AbortSignal | undefined,
  deps: ImageExecutionDeps = {},
): Promise<ImageTaskResult> {
  const fetchFn = deps.fetchFn ?? fetch
  const fsPort = deps.fs ?? nodeFsPort
  const timeoutMs = deps.timeoutMs ?? IMAGE_API_TIMEOUT_MS

  try {
    return await executeGenerateImageInner(config, args, cwd, signal, { fetchFn, fsPort, timeoutMs })
  } catch (error) {
    // 已知失败一律投影为失败结果，不向框架抛错（与其余工具域一致）。
    if (signal?.aborted) {
      return { success: false, paths: [], count: 0, texts: [], cancelled: true }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, paths: [], count: 0, texts: [], error: message }
  }
}

async function executeGenerateImageInner(
  config: GenerateImageConfig,
  args: GenerateImageArgs,
  cwd: string,
  signal: AbortSignal | undefined,
  deps: { fetchFn: typeof fetch; fsPort: ImageFsPort; timeoutMs: number },
): Promise<ImageTaskResult> {
  const { fetchFn, fsPort, timeoutMs } = deps

  if (signal?.aborted) {
    return { success: false, paths: [], count: 0, texts: [], cancelled: true }
  }

  validateArgs(args)

  // 输出路径先解析（.. 穿越/逃逸在发起网络请求前就拒绝）
  const baseTarget = resolveOutputPath(cwd, args.output_path)

  // 宽高比/尺寸：仅设置启用时生效；默认值优先，否则用模型传入值
  let aspectRatio: AspectRatio | undefined
  if (config.enableAspectRatio) {
    aspectRatio = (config.defaultAspectRatio || args.aspect_ratio || 'auto') as AspectRatio
  }
  let imageSize: ImageSize | undefined
  if (config.enableImageSize) {
    imageSize = (config.defaultImageSize || args.image_size || 'auto') as ImageSize
  }

  const request = buildGenerateContentRequest(config, {
    prompt: args.prompt,
    referenceImages: toReferenceImages(args.reference_images ?? []),
    aspectRatio,
    imageSize,
  })

  let fetched: FetchOutcome
  try {
    fetched = await fetchWithTimeout(fetchFn, request.url, request.body, signal, timeoutMs)
  } catch (error) {
    if (signal?.aborted) {
      return { success: false, paths: [], count: 0, texts: [], cancelled: true }
    }
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof ImagesExecutionTimeoutError) {
      return { success: false, paths: [], count: 0, texts: [], error: message }
    }
    return { success: false, paths: [], count: 0, texts: [], error: `image API request failed: ${message}` }
  }

  if (!fetched.ok) {
    return {
      success: false,
      paths: [],
      count: 0,
      texts: [],
      error: `image API request failed: ${fetched.status} ${fetched.text}`,
    }
  }

  if (fetched.jsonParseError !== undefined) {
    return {
      success: false,
      paths: [],
      count: 0,
      texts: [],
      error: `image API returned a non-JSON response: ${fetched.jsonParseError}`,
    }
  }
  const raw = fetched.json

  let parsed: { texts: string[]; images: GeneratedImage[] }
  try {
    parsed = parseGenerateContentResponse(raw)
  } catch (error) {
    return {
      success: false,
      paths: [],
      count: 0,
      texts: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }

  if (parsed.images.length === 0) {
    return {
      success: false,
      paths: [],
      count: 0,
      texts: parsed.texts,
      error: 'No images generated. Content may have been filtered or an error occurred.',
    }
  }

  if (signal?.aborted) {
    return { success: false, paths: [], count: 0, texts: [], cancelled: true }
  }

  const maxImages = config.maxImagesPerTask > 0 ? config.maxImagesPerTask : DEFAULT_MAX_IMAGES_PER_TASK
  const savedPaths: string[] = []
  const limited = parsed.images.slice(0, maxImages)
  for (let index = 0; index < limited.length; index += 1) {
    const image = limited[index]!
    const bytes = Uint8Array.from(Buffer.from(image.data, 'base64'))
    if (bytes.length === 0) continue
    // 内容校验（对齐 media 域 imageOutputMismatch）：魔数不可识别 → 拒绝落盘，
    // 绝不把任意字节写成 .png（H-17）。
    if (!isSupportedImageBytes(bytes)) {
      return {
        success: false,
        paths: savedPaths,
        count: savedPaths.length,
        texts: parsed.texts,
        error: 'image API returned bytes that are not a supported image format (PNG/JPEG/GIF/WebP)',
      }
    }
    const ext = sniffExtension(bytes, image.mimeType)

    let target: string
    if (index === 0) {
      target = applyExtensionCorrection(baseTarget, ext)
    } else {
      // 额外图片：`<stem>_<n>.<ext>`（与老版命名一致，避免覆盖第一张）
      const stem = baseTarget.replace(/\.[^./\\]+$/, '')
      target = applyExtensionCorrection(`${stem}_${index}`, ext)
    }

    try {
      // M-2：realpath 权威校验（符号链接逃逸拒绝）后 mkdir + 写盘
      await fsPort.assertWriteInside(target, cwd)
      await fsPort.mkdir(path.dirname(target))
      await fsPort.writeFile(target, bytes)
    } catch (error) {
      return {
        success: false,
        paths: savedPaths,
        count: savedPaths.length,
        texts: parsed.texts,
        error: `failed to write image ${target}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    savedPaths.push(target)
  }

  if (savedPaths.length === 0) {
    return {
      success: false,
      paths: [],
      count: 0,
      texts: parsed.texts,
      error: 'No images written (empty image data in the API response).',
    }
  }

  return { success: true, paths: savedPaths, count: savedPaths.length, texts: parsed.texts }
}

/** 生产默认 fs 端口：node:fs/promises（写盘直写 + realpath 包含性权威校验）。 */
const nodeFsPort: ImageFsPort = {
  async mkdir(directory) {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(directory, { recursive: true })
  },
  async writeFile(filePath, bytes) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(filePath, bytes)
  },
  async assertWriteInside(filePath, workspaceRoot) {
    const { realpath } = await import('node:fs/promises')
    const rootReal = await realpath(workspaceRoot)
    // 目标文件（若存在）或最深已存在祖先逐级 realpath：任一环节解析到
    // 工作区外即拒绝（符号链接目录逃逸，M-2；与 mediaFs.nodeResolveInside 同构）。
    let probe = filePath
    for (;;) {
      let real: string
      try {
        real = await realpath(probe)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          const parent = path.dirname(probe)
          if (parent === probe) {
            throw new ImagesExecutionError(`output path escapes the workspace root: ${filePath}`)
          }
          probe = parent
          continue
        }
        throw error
      }
      if (!isPathInside(rootReal, real)) {
        throw new ImagesExecutionError(
          `output path escapes the workspace root (symbolic link): ${filePath}`,
        )
      }
      return
    }
  },
}

/** realpath 后的包含性判定（目标等于根或为根的后代）。 */
function isPathInside(rootReal: string, targetReal: string): boolean {
  const relative = path.relative(rootReal, targetReal)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
