/**
 * GrayCode - images 请求构建（纯函数，零宿主依赖）。
 *
 * Gemini generateContent 请求契约（与老版 generate_image 逐字段一致）：
 * - URL：`POST {url}/models/{model}:generateContent?key={apiKey}`；
 * - body：`contents[0]`（role user）的 parts = [text, ...inline_data]；
 *   `generationConfig.responseModalities = ['TEXT', 'IMAGE']`；
 * - `imageConfig.aspectRatio / imageSize`：仅当设置启用且该参数有值时传入
 *   （禁用时不暴露，未设默认值时用模型传入值）。
 */

import type { AspectRatio, GenerateContentRequest, ImageSize, ReferenceImage } from './types.ts'
import { DEFAULT_IMAGE_API_URL } from './types.ts'

export class ImagesRequestError extends Error {
  readonly code = 'GRAY_IMAGES_MISSING_API_KEY'
}

export interface GenerateImageConfig {
  url: string
  apiKey: string
  model: string
  enableAspectRatio: boolean
  defaultAspectRatio?: string
  enableImageSize: boolean
  defaultImageSize?: string
  maxImagesPerTask: number
}

export interface GenerateContentOptions {
  prompt: string
  referenceImages: readonly ReferenceImage[]
  aspectRatio: AspectRatio | undefined
  imageSize: ImageSize | undefined
}

/** 从 base64 数据嗅探 mime 类型（magic bytes；失败回退 image/png）。 */
export function sniffMimeFromBase64(data: string): string {
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(Buffer.from(data, 'base64'))
  } catch {
    return 'image/png'
  }
  if (bytes.length < 4) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return 'image/png'
}

/**
 * 图片 API 基址安全校验（L-3）：
 * - 必须是 http(s) URL（拒绝其他 scheme）；
 * - http 明文仅允许回环地址（localhost / 127.0.0.1 / ::1 / 0.0.0.0）——
 *   apiKey 以查询参数传输，非回环明文会泄露密钥；本地代理（如 LiteLLM）
 *   不受影响。schemastery 无 .url() 校验器，此处在请求构建层（纯函数）
 *   强制，晚于配置解析但早于任何网络 IO。
 */
export function assertSecureApiUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ImagesRequestError(`invalid image API url: ${url}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ImagesRequestError(`image API url must use http(s): ${url}`)
  }
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.replace(/^\[|\]$/g, '')
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
    if (!isLoopback) {
      throw new ImagesRequestError(`image API url must use https for non-loopback hosts: ${url}`)
    }
  }
}

/** 工具传入的 aspectRatio/imageSize 生效值（'auto'/空 = 不传）。 */
function effectiveRatio(value: AspectRatio | ImageSize | undefined): string | undefined {
  if (value === undefined) return undefined
  const ratio = value === 'auto' ? undefined : value
  return ratio
}

/** 构建请求 URL + body。 */
export function buildGenerateContentRequest(
  config: GenerateImageConfig,
  options: GenerateContentOptions,
): GenerateContentRequest {
  const apiKey = config.apiKey
  if (!apiKey) {
    throw new ImagesRequestError(
      'API Key not configured. Please configure the GrayCode images settings (url/apiKey) and enable the generate_image tool.',
    )
  }
  assertSecureApiUrl(config.url || DEFAULT_IMAGE_API_URL)
  const model = config.model || 'gemini-3-pro-image-preview'
  const url = `${config.url || DEFAULT_IMAGE_API_URL}/models/${model}:generateContent?key=${apiKey}`

  const parts: Array<Record<string, unknown>> = [{ text: options.prompt }]
  for (const image of options.referenceImages) {
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } })
  }

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  }

  const imageConfig: Record<string, string> = {}
  if (config.enableAspectRatio) {
    const ratio = effectiveRatio(options.aspectRatio)
    if (ratio) imageConfig.aspectRatio = ratio
  }
  if (config.enableImageSize) {
    const size = effectiveRatio(options.imageSize)
    if (size) imageConfig.imageSize = size
  }
  if (Object.keys(imageConfig).length > 0) {
    ;(body.generationConfig as Record<string, unknown>).imageConfig = imageConfig
  }
  return { url, body }
}
