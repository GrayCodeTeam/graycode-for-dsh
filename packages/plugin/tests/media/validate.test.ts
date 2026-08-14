/**
 * media 参数校验纯函数测试（domain/validate.ts）
 *
 * 覆盖：归一化坐标 0-1（含 NaN/Infinity 防御、x1<x2、y1<y2）、
 * resize 宽高限制（正数/有限/16K 上限）、rotate 角度枚举（0/90/180/270）、
 * format 归一（jpeg/jpg）、任务级校验（crop/resize/rotate）。
 */
import { describe, expect, test } from 'vitest'
import {
  validateCropTask,
  validateNormalizedCoords,
  validateOutputFormat,
  validateResizeTask,
  validateRotateAngle,
  validateRotateTask,
  validateTargetDimensions,
} from '../../src/media/domain/validate.ts'

describe('validateNormalizedCoords', () => {
  test('接受 0-1 范围内的合法坐标', () => {
    const result = validateNormalizedCoords(0.1, 0.2, 0.9, 0.8)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.8 })
    }
  })

  test('接受边界值 0 和 1', () => {
    expect(validateNormalizedCoords(0, 0, 1, 1).ok).toBe(true)
  })

  test('拒绝越界坐标（<0 或 >1）', () => {
    expect(validateNormalizedCoords(-0.01, 0, 1, 1).ok).toBe(false)
    expect(validateNormalizedCoords(0, 0, 1.01, 1).ok).toBe(false)
    expect(validateNormalizedCoords(0, 1.5, 1, 1).ok).toBe(false)
  })

  test('拒绝 NaN / Infinity（比较穿透防御）', () => {
    expect(validateNormalizedCoords(NaN, 0, 1, 1).ok).toBe(false)
    expect(validateNormalizedCoords(0, 0, Infinity, 1).ok).toBe(false)
    expect(validateNormalizedCoords(0, 0, -Infinity, 1).ok).toBe(false)
  })

  test('拒绝非数值', () => {
    expect(validateNormalizedCoords('0.1', 0, 1, 1).ok).toBe(false)
    expect(validateNormalizedCoords(undefined, 0, 1, 1).ok).toBe(false)
    expect(validateNormalizedCoords(null, 0, 1, 1).ok).toBe(false)
  })

  test('拒绝 x1>=x2 或 y1>=y2', () => {
    expect(validateNormalizedCoords(0.5, 0, 0.5, 1).ok).toBe(false)
    expect(validateNormalizedCoords(0.6, 0, 0.5, 1).ok).toBe(false)
    expect(validateNormalizedCoords(0, 0.5, 1, 0.5).ok).toBe(false)
  })
})

describe('validateTargetDimensions', () => {
  test('接受正整数宽高', () => {
    const result = validateTargetDimensions(640, 480)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ width: 640, height: 480 })
  })

  test('小数四舍五入为整数', () => {
    const result = validateTargetDimensions(640.4, 480.6)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ width: 640, height: 481 })
  })

  test('拒绝非正数 / 非有限数', () => {
    expect(validateTargetDimensions(0, 10).ok).toBe(false)
    expect(validateTargetDimensions(-5, 10).ok).toBe(false)
    expect(validateTargetDimensions(NaN, 10).ok).toBe(false)
    expect(validateTargetDimensions(Infinity, 10).ok).toBe(false)
    expect(validateTargetDimensions(10, '10').ok).toBe(false)
  })

  test('拒绝超过 16384 的单边', () => {
    expect(validateTargetDimensions(16384, 16384).ok).toBe(true)
    expect(validateTargetDimensions(16385, 10).ok).toBe(false)
    expect(validateTargetDimensions(10, 20000).ok).toBe(false)
  })
})

describe('validateRotateAngle', () => {
  test('接受枚举角度 0/90/180/270', () => {
    for (const angle of [0, 90, 180, 270]) {
      const result = validateRotateAngle(angle)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toBe(angle)
    }
  })

  test('拒绝非枚举角度', () => {
    for (const angle of [45, -90, 360, 180.5, NaN, Infinity, '90', undefined, null]) {
      expect(validateRotateAngle(angle).ok).toBe(false)
    }
  })
})

describe('validateOutputFormat', () => {
  test('undefined/null/空串 → undefined（未指定）', () => {
    expect(validateOutputFormat(undefined).ok).toBe(true)
    expect(validateOutputFormat(null).ok).toBe(true)
    expect(validateOutputFormat('').ok).toBe(true)
  })

  test('png/webp 原样通过', () => {
    const png = validateOutputFormat('png')
    expect(png.ok && png.value).toBe('png')
    const webp = validateOutputFormat('webp')
    expect(webp.ok && webp.value).toBe('webp')
  })

  test('jpeg/jpg 归一为 jpeg', () => {
    const jpeg = validateOutputFormat('jpeg')
    expect(jpeg.ok && jpeg.value).toBe('jpeg')
    const jpg = validateOutputFormat('jpg')
    expect(jpg.ok && jpg.value).toBe('jpeg')
    const upper = validateOutputFormat('JPG')
    expect(upper.ok && upper.value).toBe('jpeg')
  })

  test('拒绝未知格式', () => {
    expect(validateOutputFormat('bmp').ok).toBe(false)
    expect(validateOutputFormat('gif').ok).toBe(false)
    expect(validateOutputFormat(42).ok).toBe(false)
  })
})

describe('validateCropTask / validateResizeTask / validateRotateTask', () => {
  test('crop：合法任务通过，缺坐标拒绝', () => {
    const ok = validateCropTask({ image_path: 'a.png', x1: 0, y1: 0, x2: 0.5, y2: 0.5 })
    expect(ok.ok).toBe(true)
    expect(validateCropTask({ image_path: 'a.png', x1: 0, y1: 0, x2: 0.5 }).ok).toBe(false)
    expect(validateCropTask({ x1: 0, y1: 0, x2: 0.5, y2: 0.5 }).ok).toBe(false)
    expect(validateCropTask(null).ok).toBe(false)
  })

  test('crop：output_path 可选', () => {
    const withPath = validateCropTask({ image_path: 'a.png', output_path: 'out.png', x1: 0, y1: 0, x2: 1, y2: 1 })
    expect(withPath.ok).toBe(true)
    const emptyPath = validateCropTask({ image_path: 'a.png', output_path: '', x1: 0, y1: 0, x2: 1, y2: 1 })
    expect(emptyPath.ok).toBe(true)
  })

  test('resize：合法任务通过，宽高缺失/非法拒绝', () => {
    const ok = validateResizeTask({ image_path: 'a.png', width: 100, height: 200 })
    expect(ok.ok).toBe(true)
    expect(validateResizeTask({ image_path: 'a.png', width: 100 }).ok).toBe(false)
    expect(validateResizeTask({ image_path: 'a.png', width: 0, height: 200 }).ok).toBe(false)
  })

  test('rotate：合法任务通过，角度非法/格式非法拒绝', () => {
    const ok = validateRotateTask({ image_path: 'a.png', angle: 90, format: 'jpeg' })
    expect(ok.ok).toBe(true)
    expect(validateRotateTask({ image_path: 'a.png', angle: 45 }).ok).toBe(false)
    expect(validateRotateTask({ image_path: 'a.png', angle: 90, format: 'bmp' }).ok).toBe(false)
    const noFormat = validateRotateTask({ image_path: 'a.png', angle: 270 })
    expect(noFormat.ok).toBe(true)
    if (noFormat.ok) expect(noFormat.value.format).toBeUndefined()
  })
})
