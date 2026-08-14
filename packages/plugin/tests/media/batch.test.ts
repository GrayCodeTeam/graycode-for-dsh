/**
 * media 批量拆分与批次校验纯函数测试（domain/batch.ts）
 *
 * 覆盖：单张模式 → 单任务数组、批量模式（images 数组）逐项校验、
 * 两种模式都缺失 → null、批量上限拒绝（GRAY_MEDIA_BATCH_LIMIT_EXCEEDED）、
 * 重复输出路径检测（GRAY_MEDIA_DUPLICATE_OUTPUT 判定依据）。
 */
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import { assertBatchLimit, findDuplicateOutput, toTasks } from '../../src/media/domain/batch.ts'
import { MediaError, MediaErrorCode } from '../../src/media/domain/errors.ts'
import type { CropTask, MediaBatchArgs, MediaTask, ResizeTask, RotateTask } from '../../src/media/domain/types.ts'

describe('toTasks（单张/批量拆分）', () => {
  test('单张模式：crop 顶层参数 → 单任务数组', () => {
    const args: MediaBatchArgs = { image_path: 'a.png', x1: 0, y1: 0, x2: 0.5, y2: 0.5 }
    const tasks = toTasks('crop_image', args)
    expect(tasks).not.toBeNull()
    expect(tasks).toHaveLength(1)
    const task = tasks![0] as CropTask
    expect(task.image_path).toBe('a.png')
    expect(task.x2).toBe(0.5)
  })

  test('单张模式：resize/rotate 各自专属参数', () => {
    const resize = toTasks('resize_image', { image_path: 'a.png', width: 100, height: 50 })
    expect((resize![0] as ResizeTask).width).toBe(100)
    const rotate = toTasks('rotate_image', { image_path: 'a.png', angle: 90 })
    expect((rotate![0] as RotateTask).angle).toBe(90)
  })

  test('批量模式：images 数组逐项校验', () => {
    const tasks = toTasks('crop_image', {
      images: [
        { image_path: 'a.png', x1: 0, y1: 0, x2: 0.5, y2: 0.5 },
        { image_path: 'b.png', x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 },
      ],
    })
    expect(tasks).toHaveLength(2)
  })

  test('批量模式：任一任务非法 → 整批拒绝（INVALID_ARGUMENTS）', () => {
    expect(() =>
      toTasks('crop_image', {
        images: [
          { image_path: 'a.png', x1: 0, y1: 0, x2: 0.5, y2: 0.5 },
          { image_path: 'b.png', x1: 0.9, y1: 0.1, x2: 0.5, y2: 0.9 }, // x1 > x2
        ],
      }),
    ).toThrowError(MediaError)
  })

  test('单张模式缺专属参数 → INVALID_ARGUMENTS（非 NO_TASKS）', () => {
    expect(() => toTasks('crop_image', { image_path: 'a.png' })).toThrowError(MediaError)
  })

  test('两种模式都缺失 → null（调用方投影 NO_TASKS）', () => {
    expect(toTasks('crop_image', {})).toBeNull()
    expect(toTasks('crop_image', { images: [] })).toBeNull()
    expect(toTasks('resize_image', { images: 'not-an-array' })).toBeNull()
  })

  test('空数组 images 视为未提供', () => {
    expect(toTasks('rotate_image', { images: [] })).toBeNull()
  })
})

describe('assertBatchLimit', () => {
  test('任务数 ≤ 上限通过', () => {
    const tasks: MediaTask[] = Array.from({ length: 10 }, (_, i) => ({ image_path: `${i}.png`, x1: 0, y1: 0, x2: 1, y2: 1 }))
    expect(() => assertBatchLimit(tasks, 10)).not.toThrow()
  })

  test('任务数 > 上限 → GRAY_MEDIA_BATCH_LIMIT_EXCEEDED', () => {
    const tasks: MediaTask[] = Array.from({ length: 11 }, (_, i) => ({ image_path: `${i}.png`, x1: 0, y1: 0, x2: 1, y2: 1 }))
    try {
      assertBatchLimit(tasks, 10)
      expect.unreachable('expected MediaError')
    } catch (error) {
      expect((error as MediaError).code).toBe(MediaErrorCode.BATCH_LIMIT_EXCEEDED)
    }
  })
})

describe('findDuplicateOutput', () => {
  const resolve = (p: string): string => path.resolve(p)

  test('无重复输出路径 → undefined', () => {
    const tasks: MediaTask[] = [
      { image_path: 'a.png', output_path: 'out1.png', x1: 0, y1: 0, x2: 1, y2: 1 },
      { image_path: 'b.png', output_path: 'out2.png', x1: 0, y1: 0, x2: 1, y2: 1 },
    ]
    expect(findDuplicateOutput(tasks, resolve)).toBeUndefined()
  })

  test('重复 output_path（含不同写法归一后相同）→ 返回重复值', () => {
    const tasks: MediaTask[] = [
      { image_path: 'a.png', output_path: 'out.png', x1: 0, y1: 0, x2: 1, y2: 1 },
      { image_path: 'b.png', output_path: 'sub/../out.png', x1: 0, y1: 0, x2: 1, y2: 1 },
    ]
    expect(findDuplicateOutput(tasks, resolve)).toBe('sub/../out.png')
  })

  test('省略 output_path 的任务不参与检测（默认输出按序号消歧）', () => {
    const tasks: MediaTask[] = [
      { image_path: 'a.png', x1: 0, y1: 0, x2: 1, y2: 1 },
      { image_path: 'b.png', x1: 0, y1: 0, x2: 1, y2: 1 },
    ]
    expect(findDuplicateOutput(tasks, resolve)).toBeUndefined()
  })
})
