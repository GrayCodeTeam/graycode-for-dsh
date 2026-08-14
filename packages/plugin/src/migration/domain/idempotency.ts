/**
 * GrayCode - migration 幂等键与计划令牌（纯函数）
 *
 * 幂等键（§7.2.5）：`sourceFingerprint + objectType + legacyId` 形成唯一键，
 * 重复运行不会生成副本。sourceFingerprint 由源目录清单（相对路径 + 字节数）
 * 的稳定哈希构成——同一目录重复扫描得到同一指纹；内容变化（同尺寸改写）由
 * 对象级 sourceHash 在冲突判定层兜底（§7.5 同 legacy id 不同 hash → GRAY_CONFLICT）。
 */

import { createHash } from 'node:crypto'
import type { ObjectType, PlannedObject } from './types.ts'

/** sha256 hex（纯计算，无 I/O） */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/** 幂等键：sourceFingerprint + objectType + legacyId（§7.2.5） */
export function buildIdempotencyKey(
  sourceFingerprint: string,
  objectType: ObjectType,
  legacyId: string,
): string {
  return `${sourceFingerprint}|${objectType}|${legacyId}`
}

/** 计划摘要（按对象排序的确定性文本，供 planToken 使用） */
export function planDigest(objects: readonly PlannedObject[]): string {
  return objects
    .map(o => `${o.objectType}|${o.legacyId}|${o.outcome}|${o.sourceHash}|${o.errorCode ?? ''}`)
    .sort()
    .join('\n')
}

/**
 * apply 二次确认令牌：绑定 sourceFingerprint 与计划内容。
 * 用户必须先 scan（dry-run）拿到 planToken，apply 时原样传回；
 * 源目录在 scan 与 apply 之间发生变化 → 指纹/计划变化 → 令牌不匹配 → 拒绝。
 */
export function computePlanToken(
  sourceFingerprint: string,
  objects: readonly PlannedObject[],
): string {
  return sha256Hex(`${sourceFingerprint}\n${planDigest(objects)}`)
}

/** 展示用短哈希（报告缩略） */
export function shortHash(hash: string, length = 12): string {
  return hash.length > length ? hash.slice(0, length) : hash
}
