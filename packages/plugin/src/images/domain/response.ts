/**
 * GrayCode - images 响应解析（纯函数，零宿主依赖）。
 *
 * Gemini generateContent 响应：
 * - `candidates[0].content.parts[]`：text 与 inlineData{mimeType, data} 混合；
 * - 顶层 `error`（HTTP 层已拦截非 200，此处兜底校验响应体错误）。
 */

import type { GeneratedImage } from './types.ts'

export class ImagesResponseError extends Error {
  readonly code = 'GRAY_IMAGES_RESPONSE_INVALID'
}

export interface ParsedGenerateContent {
  texts: string[]
  images: GeneratedImage[]
}

/** 从 base64 嗅探扩展名（magic bytes；失败回退 mimeType 映射，再回退 png）。 */
export function sniffExtension(buffer: Uint8Array, mimeType?: string): string {
  if (isSupportedImageBytes(buffer)) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return '.jpg'
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png'
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return '.gif'
    if (
      buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
    ) {
      return '.webp'
    }
  }
  const mimeToExt: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/x-icon': '.ico',
    'image/heic': '.heic',
    'image/heif': '.heif',
  }
  return (mimeType ? mimeToExt[mimeType] : undefined) ?? '.png'
}

/**
 * 校验字节魔数是否为受支持的图片格式（PNG/JPEG/GIF/WebP）。
 * 与 sniffExtension 的魔数判定同源；不识别即 false（调用方应拒绝而非回退）。
 */
export function isSupportedImageBytes(buffer: Uint8Array): boolean {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return true
  if (buffer.length >= 6 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38 && (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61) return true
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return true
  }
  return false
}

/** 解析 Gemini generateContent 响应 JSON。 */
export function parseGenerateContentResponse(raw: unknown): ParsedGenerateContent {
  if (typeof raw !== 'object' || raw === null) {
    throw new ImagesResponseError('image API returned a non-object response')
  }
  const response = raw as Record<string, unknown>
  if (response.error !== undefined && typeof response.error === 'object' && response.error !== null) {
    const message = (response.error as Record<string, unknown>).message
    throw new ImagesResponseError(
      `image API error: ${typeof message === 'string' ? message : String(message ?? 'unknown error')}`,
    )
  }

  const texts: string[] = []
  const images: GeneratedImage[] = []
  const candidates = response.candidates
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      const content = (candidate as Record<string, unknown> | null)?.content as Record<string, unknown> | undefined
      const parts = Array.isArray(content?.parts) ? (content.parts as unknown[]) : []
      for (const part of parts) {
        const record = part as Record<string, unknown>
        if (typeof record?.text === 'string') {
          texts.push(record.text)
        }
        const inline = record?.inlineData as Record<string, unknown> | undefined
        if (typeof inline?.data === 'string' && typeof inline.mimeType === 'string') {
          images.push({ data: inline.data, mimeType: inline.mimeType })
        }
      }
    }
  }
  return { texts, images }
}
