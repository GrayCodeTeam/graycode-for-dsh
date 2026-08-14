/**
 * GrayCode Remote API — 入参校验小工具（零依赖，不引入 zod）。
 *
 * 所有校验失败抛 {@link GrayRemoteError}（GRAY_INVALID_INPUT），由
 * GrayRemoteService.invoke 统一转换为失败信封。
 */

import {
  GRAY_PAGE_LIMIT_DEFAULT,
  GRAY_PAGE_LIMIT_MAX,
  type GrayRemoteArgs,
} from './types.ts'
import { GrayRemoteError } from './errors.ts'

function invalid(field: string, expected: string): GrayRemoteError {
  return GrayRemoteError.invalidInput(`${field} must be ${expected}`, { field })
}

/** 必填字符串（非空）。 */
export function requireString(args: GrayRemoteArgs, field: string): string {
  const value = args[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(field, 'a non-empty string')
  }
  return value
}

/** 可选字符串（undefined/null 通过；空串返回 undefined）。 */
export function optionalString(args: GrayRemoteArgs, field: string): string | undefined {
  const value = args[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalid(field, 'a string')
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** 必填整数（安全整数）。 */
export function requireInt(args: GrayRemoteArgs, field: string): number {
  const value = args[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalid(field, 'an integer')
  }
  return value
}

/** 可选整数。 */
export function optionalInt(args: GrayRemoteArgs, field: string): number | undefined {
  const value = args[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalid(field, 'an integer')
  }
  return value
}

/** 必填布尔。 */
export function requireBoolean(args: GrayRemoteArgs, field: string): boolean {
  const value = args[field]
  if (typeof value !== 'boolean') throw invalid(field, 'a boolean')
  return value
}

/** 可选布尔。 */
export function optionalBoolean(args: GrayRemoteArgs, field: string): boolean | undefined {
  const value = args[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw invalid(field, 'a boolean')
  return value
}

/** 可选字符串数组（元素必须为非空字符串）。 */
export function optionalStringArray(args: GrayRemoteArgs, field: string): string[] | undefined {
  const value = args[field]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw invalid(field, 'an array of non-empty strings')
  }
  return value as string[]
}

/** 分页 limit 归一化（0/负/超限 → 默认/上限；非法类型 → GRAY_INVALID_INPUT）。 */
export function normalizeLimit(value: unknown, fallback = GRAY_PAGE_LIMIT_DEFAULT): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalid('limit', 'an integer')
  }
  if (value <= 0) return fallback
  return Math.min(value, GRAY_PAGE_LIMIT_MAX)
}

/** 校验 workspace 参数（可选）：存在时必须为绝对路径。 */
export function optionalWorkspace(args: GrayRemoteArgs, field = 'workspace'): string | undefined {
  const value = optionalString(args, field)
  if (value !== undefined && !isAbsolutePath(value)) {
    throw invalid(field, 'an absolute path')
  }
  return value
}

/** 跨平台绝对路径判定（Windows 盘符 / UNC / POSIX 根）。 */
export function isAbsolutePath(value: string): boolean {
  if (value.startsWith('/')) return true
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/** 分页切片辅助：按 cursor（项 id 字符串）取下一页。 */
export function slicePage<T extends { readonly id: string | number }>(
  items: readonly T[],
  cursor: string | number | undefined,
  limit: number
): { page: T[]; nextCursor?: string } {
  let start = 0
  if (cursor !== undefined && cursor !== null) {
    const index = items.findIndex(item => item.id === cursor)
    if (index >= 0) start = index + 1
  }
  const page = items.slice(start, start + limit)
  const nextCursor =
    start + limit < items.length && page.length > 0 ? String(page[page.length - 1]!.id) : undefined
  return { page, nextCursor }
}
