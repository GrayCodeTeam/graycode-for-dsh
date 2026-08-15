/**
 * images 响应解析纯函数测试（domain/response.ts）。
 */
import { describe, expect, it } from 'vitest'
import { parseGenerateContentResponse, sniffExtension } from '../../src/images/domain/response.ts'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('parseGenerateContentResponse', () => {
  it('separates text parts and inlineData images from the first candidate', () => {
    const parsed = parseGenerateContentResponse({
      candidates: [
        {
          content: {
            parts: [
              { text: 'Here is your image:' },
              { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } },
              { inlineData: { mimeType: 'image/jpeg', data: 'jpeg-data' } },
            ],
          },
        },
      ],
    })
    expect(parsed.texts).toEqual(['Here is your image:'])
    expect(parsed.images).toEqual([
      { data: PNG_BASE64, mimeType: 'image/png' },
      { data: 'jpeg-data', mimeType: 'image/jpeg' },
    ])
  })

  it('collects across multiple candidates', () => {
    const parsed = parseGenerateContentResponse({
      candidates: [
        { content: { parts: [{ text: 'a' }, { inlineData: { mimeType: 'image/png', data: 'x' } }] } },
        { content: { parts: [{ inlineData: { mimeType: 'image/gif', data: 'y' } }] } },
      ],
    })
    expect(parsed.texts).toEqual(['a'])
    expect(parsed.images).toHaveLength(2)
  })

  it('returns empty collections for an empty response', () => {
    expect(parseGenerateContentResponse({})).toEqual({ texts: [], images: [] })
  })

  it('throws on a top-level API error object', () => {
    expect(() =>
      parseGenerateContentResponse({ error: { code: 400, message: 'bad request' } }),
    ).toThrow(/image API error: bad request/)
  })

  it('throws on non-object input', () => {
    expect(() => parseGenerateContentResponse(null)).toThrow()
    expect(() => parseGenerateContentResponse('nope')).toThrow()
  })
})

describe('sniffExtension', () => {
  it('detects JPEG/PNG/GIF/WebP from magic bytes', () => {
    expect(sniffExtension(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('.jpg')
    expect(sniffExtension(Uint8Array.from(Buffer.from(PNG_BASE64, 'base64')))).toBe('.png')
    expect(sniffExtension(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('.gif')
    const webp = new Uint8Array(14)
    webp.set([0x52, 0x49, 0x46, 0x46], 0)
    webp.set([0x57, 0x45, 0x42, 0x50], 8)
    expect(sniffExtension(webp)).toBe('.webp')
  })

  it('falls back to the mimeType map, then png', () => {
    expect(sniffExtension(Uint8Array.from([1, 2, 3, 4, 5]), 'image/jpeg')).toBe('.jpg')
    expect(sniffExtension(Uint8Array.from([1, 2, 3, 4, 5]), 'image/heic')).toBe('.heic')
    expect(sniffExtension(Uint8Array.from([1, 2, 3, 4, 5]), 'image/unknown')).toBe('.png')
    expect(sniffExtension(Uint8Array.from([1, 2, 3, 4, 5]))).toBe('.png')
  })
})
