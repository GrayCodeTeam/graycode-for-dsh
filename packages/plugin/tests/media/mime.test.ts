/**
 * media MIME/格式判定纯函数测试（domain/mime.ts）
 */
import { describe, expect, test } from 'vitest'
import { extFromSharpFormat, extOf, isSupportedImageExt, mimeFromExt } from '../../src/media/domain/mime.ts'

describe('mimeFromExt', () => {
  test('扩展名 → MIME（老版 imageUtils 同款映射）', () => {
    expect(mimeFromExt('png')).toBe('image/png')
    expect(mimeFromExt('jpg')).toBe('image/jpeg')
    expect(mimeFromExt('jpeg')).toBe('image/jpeg')
    expect(mimeFromExt('webp')).toBe('image/webp')
    expect(mimeFromExt('gif')).toBe('image/gif')
  })

  test('容忍前导点与大小写', () => {
    expect(mimeFromExt('.PNG')).toBe('image/png')
    expect(mimeFromExt('.Jpg')).toBe('image/jpeg')
  })

  test('未知格式返回 undefined', () => {
    expect(mimeFromExt('bmp')).toBeUndefined()
    expect(mimeFromExt('svg')).toBeUndefined()
    expect(mimeFromExt('')).toBeUndefined()
  })
})

describe('extOf', () => {
  test('提取小写扩展名（无前导点）', () => {
    expect(extOf('a/b/photo.PNG')).toBe('png')
    expect(extOf('photo.jpeg')).toBe('jpeg')
  })

  test('无扩展名 / 尾部点返回空串', () => {
    expect(extOf('photo')).toBe('')
    expect(extOf('photo.')).toBe('')
  })
})

describe('isSupportedImageExt', () => {
  test('png/jpg/jpeg/webp/gif 受支持', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif', '.PNG']) {
      expect(isSupportedImageExt(ext)).toBe(true)
    }
  })

  test('其他格式不受支持', () => {
    expect(isSupportedImageExt('bmp')).toBe(false)
    expect(isSupportedImageExt('svg')).toBe(false)
    expect(isSupportedImageExt('')).toBe(false)
  })
})

describe('extFromSharpFormat', () => {
  test('sharp format → 输出扩展名（jpeg 归一为 jpg）', () => {
    expect(extFromSharpFormat('jpeg')).toBe('jpg')
    expect(extFromSharpFormat('png')).toBe('png')
    expect(extFromSharpFormat('webp')).toBe('webp')
    expect(extFromSharpFormat('gif')).toBe('gif')
  })

  test('未知/缺失返回 undefined', () => {
    expect(extFromSharpFormat('tiff')).toBeUndefined()
    expect(extFromSharpFormat(undefined)).toBeUndefined()
    expect(extFromSharpFormat('')).toBeUndefined()
  })
})
