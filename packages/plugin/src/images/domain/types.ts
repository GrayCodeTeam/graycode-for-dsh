/**
 * GrayCode - images 域类型与常量（generate_image / 图像编辑）。
 *
 * 域契约（参考老版 Gray generate_image 工具 + DSH 变体）：
 * - 生成与编辑共用同一个工具 `generate_image`：编辑 = 在参数中携带
 *   `reference_images`（base64 数据，模型直接透传，不读磁盘）；
 * - 请求直连 Gemini REST 面（dsh-llm rc.6 无公开图像 API，见 media README）：
 *   POST {url}/models/{model}:generateContent?key={apiKey}；
 * - 响应 `candidates[0].content.parts[]` 中的 text 与 inlineData 分离返回。
 */

/** 默认 API 基址（与老版 settings 默认值一致）。 */
export const DEFAULT_IMAGE_API_URL = 'https://generativelanguage.googleapis.com/v1beta'

/** 默认生成模型（与老版 settings 默认值一致）。 */
export const DEFAULT_IMAGE_MODEL = 'gemini-3-pro-image-preview'

/** Gemini 请求超时（毫秒）：网络挂起不会无限期等待。 */
export const IMAGE_API_TIMEOUT_MS = 120_000

/** 支持的宽高比（工具枚举；'auto' = 不传 aspectRatio）。 */
export const SUPPORTED_ASPECT_RATIOS = [
  'auto', '1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
] as const
export type AspectRatio = typeof SUPPORTED_ASPECT_RATIOS[number]

/** 支持的图片尺寸（工具枚举；'auto' = 不传 imageSize）。 */
export const SUPPORTED_IMAGE_SIZES = ['auto', '1K', '2K', '4K'] as const
export type ImageSize = typeof SUPPORTED_IMAGE_SIZES[number]

/** 单次调用最多参考图片数（与老版一致）。 */
export const MAX_REFERENCE_IMAGES = 14

/** 批量任务上限默认值（设置页默认；单任务工具下仅作契约保留）。 */
export const DEFAULT_MAX_BATCH_TASKS = 5

/** 单次调用保存的最大图片数默认值。 */
export const DEFAULT_MAX_IMAGES_PER_TASK = 1

/** 参考图片（base64 数据 + 嗅探出的 mime 类型）。 */
export interface ReferenceImage {
  data: string
  mimeType: string
}

/** Gemini Image 响应中的一张图片（inlineData）。 */
export interface GeneratedImage {
  data: string
  mimeType: string
}

/** 请求构建产物：URL + JSON body（execute 直接 fetch）。 */
export interface GenerateContentRequest {
  url: string
  body: Record<string, unknown>
}
