/**
 * GrayCode - media 批量拆分与批次校验纯函数（零依赖）
 *
 * 与老版一致：每个工具支持「单张模式」（image_path/output_path/... 顶层参数）
 * 与「批量模式」（images 数组，每项含 image_path/output_path/...）。
 * 本模块负责：参数形态 → 任务数组、任务数上限校验、重复输出路径检测。
 */
import { MediaError, MediaErrorCode } from './errors.ts'
import { validateCropTask, validateResizeTask, validateRotateTask } from './validate.ts'
import type { CropTask, MediaBatchArgs, MediaTask, ResizeTask, RotateTask } from './types.ts'

export type MediaToolKind = 'crop_image' | 'resize_image' | 'rotate_image'

/**
 * 从工具参数提取任务数组：
 * - `images` 为非空数组 → 批量模式（逐项校验，任一非法 → 整批拒绝，
 *   与老版「参数错误直接返回」语义一致）；
 * - 否则尝试单张模式（image_path + 该工具的专属参数齐全才接受）。
 *
 * 返回 null 表示两种模式都不可用（由调用方投影为 GRAY_MEDIA_NO_TASKS）。
 */
export function toTasks(kind: MediaToolKind, args: MediaBatchArgs): MediaTask[] | null {
  if (Array.isArray(args.images) && args.images.length > 0) {
    return args.images.map((raw, index) => {
      const result = validateTask(kind, raw)
      if (!result.ok) {
        throw new MediaError(
          MediaErrorCode.INVALID_ARGUMENTS,
          `Task ${index + 1}: ${result.error}`,
        )
      }
      return result.value
    })
  }

  // 单张模式：需要 image_path 与至少一个该工具的专属参数
  if (typeof args.image_path !== 'string' || args.image_path.length === 0) {
    return null
  }
  const single = validateTask(kind, args)
  if (!single.ok) {
    throw new MediaError(MediaErrorCode.INVALID_ARGUMENTS, single.error)
  }
  return [single.value]
}

function validateTask(kind: MediaToolKind, raw: unknown): { ok: true; value: MediaTask } | { ok: false; error: string } {
  if (kind === 'crop_image') return validateCropTask(raw)
  if (kind === 'resize_image') return validateResizeTask(raw)
  return validateRotateTask(raw)
}

/** 任务数上限校验：超过 maxBatch → GRAY_MEDIA_BATCH_LIMIT_EXCEEDED（老版同款文案语义） */
export function assertBatchLimit(tasks: readonly MediaTask[], maxBatch: number): void {
  if (tasks.length > maxBatch) {
    throw new MediaError(
      MediaErrorCode.BATCH_LIMIT_EXCEEDED,
      `Maximum ${maxBatch} tasks per call (current: ${tasks.length})`,
    )
  }
}

/**
 * 重复输出路径检测：同批多个任务写同一 output_path 会互相覆盖（后写者胜出），
 * 老版在并发前拒绝；DSH 版顺序执行同样拒绝（默认输出路径按 index 消歧，
 * 不会撞名，仅显式 output_path 参与检测）。
 */
export function findDuplicateOutput(
  tasks: readonly MediaTask[],
  resolve: (outputPath: string) => string,
): string | undefined {
  const seen = new Set<string>()
  for (const task of tasks) {
    if (!task.output_path) continue
    const normalized = resolve(task.output_path)
    if (seen.has(normalized)) return task.output_path
    seen.add(normalized)
  }
  return undefined
}

/** 类型收窄辅助（tools.ts 用）：任务数组按工具类别分组 */
export function asCropTasks(tasks: MediaTask[]): CropTask[] {
  return tasks as CropTask[]
}

export function asResizeTasks(tasks: MediaTask[]): ResizeTask[] {
  return tasks as ResizeTask[]
}

export function asRotateTasks(tasks: MediaTask[]): RotateTask[] {
  return tasks as RotateTask[]
}
