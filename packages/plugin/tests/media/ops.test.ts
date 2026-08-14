/**
 * media 图像运算纯函数测试（domain/ops.ts）
 *
 * 覆盖：归一化坐标 → 像素（clamp + round）、旋转包围盒估算、
 * 50MP 输出像素护栏、输出格式解析优先级（显式 format → 输出扩展名 → 原格式 → png）、
 * 宽高比分数。
 */
import { describe, expect, test } from 'vitest'
import {
  estimateRotatedSize,
  exceedsOutputPixelLimit,
  formatAspectRatio,
  normalizeCoord,
  resolveOutputFormat,
  toDimensions,
} from '../../src/media/domain/ops.ts'

describe('normalizeCoord', () => {
  test('0-1 归一化 → 像素（clamp 后 round）', () => {
    expect(normalizeCoord(0, 100)).toBe(0)
    expect(normalizeCoord(1, 100)).toBe(100)
    expect(normalizeCoord(0.5, 100)).toBe(50)
    expect(normalizeCoord(0.333, 100)).toBe(33)
  })

  test('越界坐标 clamp 到 [0, size]', () => {
    expect(normalizeCoord(-0.5, 100)).toBe(0)
    expect(normalizeCoord(1.5, 100)).toBe(100)
  })
})

describe('estimateRotatedSize', () => {
  test('90° 旋转交换宽高', () => {
    expect(estimateRotatedSize(100, 50, 90)).toEqual({ width: 50, height: 100 })
    expect(estimateRotatedSize(100, 50, 270)).toEqual({ width: 50, height: 100 })
  })

  test('180° 旋转尺寸不变', () => {
    expect(estimateRotatedSize(100, 50, 180)).toEqual({ width: 100, height: 50 })
  })

  test('0° 旋转尺寸不变', () => {
    expect(estimateRotatedSize(100, 50, 0)).toEqual({ width: 100, height: 50 })
  })
})

describe('exceedsOutputPixelLimit', () => {
  test('严格超过 50MP 才拒绝（恰好 50MP 允许，与老版 > 语义一致）', () => {
    expect(exceedsOutputPixelLimit(10000, 5000)).toBe(false) // 恰好 50MP：允许
    expect(exceedsOutputPixelLimit(10000, 5001)).toBe(true)
    expect(exceedsOutputPixelLimit(100, 100)).toBe(false)
    expect(exceedsOutputPixelLimit(9999, 5000)).toBe(false)
  })
})

describe('resolveOutputFormat', () => {
  test('优先级 1：显式 format（jpeg → jpg 扩展名）', () => {
    const result = resolveOutputFormat('jpeg', 'out.png', 'png')
    expect(result).toEqual({ ext: 'jpg', mime: 'image/jpeg' })
    const webp = resolveOutputFormat('webp', undefined, 'png')
    expect(webp).toEqual({ ext: 'webp', mime: 'image/webp' })
  })

  test('优先级 2：输出路径扩展名', () => {
    expect(resolveOutputFormat(undefined, 'out.jpg', 'png')).toEqual({ ext: 'jpg', mime: 'image/jpeg' })
    expect(resolveOutputFormat(undefined, 'out.jpeg', 'png')).toEqual({ ext: 'jpg', mime: 'image/jpeg' })
    expect(resolveOutputFormat(undefined, 'out.webp', 'png')).toEqual({ ext: 'webp', mime: 'image/webp' })
  })

  test('优先级 3：原图格式（sharp format，jpeg → jpg）', () => {
    expect(resolveOutputFormat(undefined, undefined, 'jpeg')).toEqual({ ext: 'jpg', mime: 'image/jpeg' })
    expect(resolveOutputFormat(undefined, undefined, 'webp')).toEqual({ ext: 'webp', mime: 'image/webp' })
  })

  test('优先级 4：兜底 png', () => {
    expect(resolveOutputFormat(undefined, undefined, undefined)).toEqual({ ext: 'png', mime: 'image/png' })
    expect(resolveOutputFormat(undefined, 'out.bmp', 'tiff')).toEqual({ ext: 'png', mime: 'image/png' })
  })
})

describe('formatAspectRatio / toDimensions', () => {
  test('宽高比化简为分数', () => {
    expect(formatAspectRatio(1920, 1080)).toBe('16:9')
    expect(formatAspectRatio(100, 100)).toBe('1:1')
    expect(formatAspectRatio(100, 50)).toBe('2:1')
  })

  test('toDimensions 组装完整对象', () => {
    expect(toDimensions(640, 480)).toEqual({ width: 640, height: 480, aspectRatio: '4:3' })
  })
})
