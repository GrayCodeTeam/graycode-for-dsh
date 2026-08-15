/**
 * images 请求构建纯函数测试（domain/request.ts）。
 */
import { describe, expect, it } from 'vitest'
import {
  assertSecureApiUrl,
  buildGenerateContentRequest,
  sniffMimeFromBase64,
  type GenerateImageConfig,
} from '../../src/images/domain/request.ts'

/** 1x1 PNG base64（fixture 与 tests/media 共用语义） */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='

function baseConfig(overrides: Partial<GenerateImageConfig> = {}): GenerateImageConfig {
  return {
    url: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'test-key',
    model: 'gemini-3-pro-image-preview',
    enableAspectRatio: false,
    enableImageSize: false,
    maxImagesPerTask: 1,
    ...overrides,
  }
}

describe('buildGenerateContentRequest', () => {
  it('builds the documented endpoint URL with key as a query parameter', () => {
    const { url } = buildGenerateContentRequest(baseConfig(), {
      prompt: 'a cat',
      referenceImages: [],
      aspectRatio: undefined,
      imageSize: undefined,
    })
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=test-key',
    )
  })

  it('sends text prompt + TEXT/IMAGE modalities, no imageConfig when disabled', () => {
    const { body } = buildGenerateContentRequest(baseConfig(), {
      prompt: 'a cat',
      referenceImages: [],
      aspectRatio: '16:9',
      imageSize: '2K',
    })
    expect(body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'a cat' }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    })
  })

  it('sends reference images as inline_data parts (mime sniffed from bytes) after the prompt', () => {
    const { body } = buildGenerateContentRequest(baseConfig(), {
      prompt: 'make it blue',
      referenceImages: [{ data: PNG_BASE64, mimeType: sniffMimeFromBase64(PNG_BASE64) }],
      aspectRatio: undefined,
      imageSize: undefined,
    })
    const parts = (body.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0]!.parts
    expect(parts).toEqual([
      { text: 'make it blue' },
      { inline_data: { mime_type: 'image/png', data: PNG_BASE64 } },
    ])
  })

  it('passes aspectRatio/imageSize only when the setting is enabled', () => {
    const disabled = buildGenerateContentRequest(baseConfig(), {
      prompt: 'p',
      referenceImages: [],
      aspectRatio: '16:9',
      imageSize: '4K',
    })
    expect(disabled.body).not.toHaveProperty(['generationConfig', 'imageConfig'])

    const enabled = buildGenerateContentRequest(baseConfig({ enableAspectRatio: true, enableImageSize: true }), {
      prompt: 'p',
      referenceImages: [],
      aspectRatio: '16:9',
      imageSize: '2K',
    })
    expect(enabled.body).toMatchObject({
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
      },
    })
  })

  it('drops a model-supplied "auto" value from the request even when enabled', () => {
    const { body } = buildGenerateContentRequest(baseConfig({ enableAspectRatio: true, enableImageSize: true }), {
      prompt: 'p',
      referenceImages: [],
      aspectRatio: 'auto',
      imageSize: 'auto',
    })
    expect(body).not.toHaveProperty(['generationConfig', 'imageConfig'])
  })

  it('throws when no API key is configured', () => {
    expect(() =>
      buildGenerateContentRequest(baseConfig({ apiKey: '' }), {
        prompt: 'p',
        referenceImages: [],
        aspectRatio: undefined,
        imageSize: undefined,
      }),
    ).toThrow(/API Key not configured/)
  })

  it('rejects non-http(s) and non-loopback plain-http API urls (L-3)', () => {
    const options = { prompt: 'p', referenceImages: [], aspectRatio: undefined, imageSize: undefined }
    // ftp:// 等其他 scheme 拒绝
    expect(() => buildGenerateContentRequest(baseConfig({ url: 'ftp://example.com/v1' }), options)).toThrow(
      /must use http\(s\)/,
    )
    // 非回环 http 明文拒绝（apiKey 以查询参数传输）
    expect(() => buildGenerateContentRequest(baseConfig({ url: 'http://example.com/v1' }), options)).toThrow(
      /must use https for non-loopback hosts/,
    )
  })

  it('allows plain http for loopback hosts (local proxies)', () => {
    const { url } = buildGenerateContentRequest(baseConfig({ url: 'http://127.0.0.1:8000/v1' }), {
      prompt: 'p',
      referenceImages: [],
      aspectRatio: undefined,
      imageSize: undefined,
    })
    expect(url).toContain('http://127.0.0.1:8000/v1/models/')
  })
})

describe('assertSecureApiUrl', () => {
  it('rejects malformed urls and non-http(s) schemes', () => {
    expect(() => assertSecureApiUrl('not a url')).toThrow(/invalid image API url/)
    expect(() => assertSecureApiUrl('javascript:alert(1)')).toThrow(/must use http\(s\)/)
  })

  it('accepts https and loopback http', () => {
    expect(() => assertSecureApiUrl('https://generativelanguage.googleapis.com/v1beta')).not.toThrow()
    expect(() => assertSecureApiUrl('http://localhost:8080/v1')).not.toThrow()
    expect(() => assertSecureApiUrl('http://[::1]:8080/v1')).not.toThrow()
    expect(() => assertSecureApiUrl('http://0.0.0.0:8080/v1')).not.toThrow()
  })
})

describe('sniffMimeFromBase64', () => {
  it('detects PNG and JPEG from magic bytes and falls back to png', () => {
    expect(sniffMimeFromBase64(PNG_BASE64)).toBe('image/png')
    expect(sniffMimeFromBase64(JPEG_BASE64)).toBe('image/jpeg')
    expect(sniffMimeFromBase64('AAAA')).toBe('image/png')
    expect(sniffMimeFromBase64('not-base64!')).toBe('image/png')
  })
})
