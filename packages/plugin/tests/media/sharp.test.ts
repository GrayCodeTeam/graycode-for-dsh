/**
 * media sharp 集成测试（1x1 PNG fixture 真实处理）
 *
 * sharp 缺失/损坏时整体跳过（describe.skipIf）——保证 CI 无 sharp 也能通过
 * 其余测试；纯函数/工具层测试不依赖本文件。
 */
import { describe, expect, test } from 'vitest'
import { loadSharp, type SharpModule } from '../../src/media/adapters/sharpLoader.ts'
import { MediaErrorCode } from '../../src/media/domain/errors.ts'
import { png1x1Bytes } from './fixtures.ts'

let sharpAvailable = false
let sharpModule: SharpModule | undefined
try {
  sharpModule = await loadSharp()
  sharpAvailable = true
} catch {
  sharpAvailable = false
}

const describeSharp = describe.skipIf(!sharpAvailable)

describeSharp('sharp 集成（sharp 缺失时跳过）', () => {
  test('fixture 是有效 1x1 PNG', async () => {
    const metadata = await sharpModule!(png1x1Bytes()).metadata()
    expect(metadata.width).toBe(1)
    expect(metadata.height).toBe(1)
    expect(metadata.format).toBe('png')
  })

  test('crop：归一化坐标提取子区域', async () => {
    // 用 sharp 现场生成 100x80 渐变图（避免 fixture 只有 1px 无法裁切）
    const source = await sharpModule!({
      create: { width: 100, height: 80, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).png().toBuffer()
    const cropped = await sharpModule!(source)
      .extract({ left: 25, top: 20, width: 50, height: 40 })
      .png()
      .toBuffer()
    const meta = await sharpModule!(cropped).metadata()
    expect(meta.width).toBe(50)
    expect(meta.height).toBe(40)
  })

  test('resize：拉伸填充到目标尺寸', async () => {
    const resized = await sharpModule!(png1x1Bytes())
      .resize(64, 48, { fit: 'fill', kernel: 'lanczos3' })
      .png()
      .toBuffer()
    const meta = await sharpModule!(resized).metadata()
    expect(meta.width).toBe(64)
    expect(meta.height).toBe(48)
  })

  test('rotate：90° 顺时针交换宽高', async () => {
    const source = await sharpModule!({
      create: { width: 40, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer()
    const rotated = await sharpModule!(source).rotate(90).png().toBuffer()
    const meta = await sharpModule!(rotated).metadata()
    expect(meta.width).toBe(10)
    expect(meta.height).toBe(40)
  })

  test('rotate：180° 尺寸不变；format 转换 jpeg 生效', async () => {
    const rotated180 = await sharpModule!(png1x1Bytes()).rotate(180).jpeg({ quality: 90 }).toBuffer()
    const meta = await sharpModule!(rotated180).metadata()
    expect(meta.width).toBe(1)
    expect(meta.height).toBe(1)
    expect(meta.format).toBe('jpeg')
  })

  test('loadSharp 幂等（模块级缓存）', async () => {
    const first = await loadSharp()
    const second = await loadSharp()
    expect(first).toBe(second)
    expect(second!.versions.vips).toBeTruthy()
  })
})

/** sharp 缺失时仍可运行的错误码契约测试 */
describe('sharpLoader 错误码契约', () => {
  test('sharp 不可用时 loadSharp 抛 GRAY_MEDIA_SHARP_MISSING', async () => {
    if (sharpAvailable) {
      // 已安装：验证不抛错
      const sharp = await loadSharp()
      expect(sharp).toBeTruthy()
      return
    }
    try {
      await loadSharp()
      expect.unreachable('expected MediaError when sharp is missing')
    } catch (error) {
      expect((error as { code?: string }).code).toBe(MediaErrorCode.SHARP_MISSING)
    }
  })
})
