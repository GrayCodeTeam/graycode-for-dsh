/**
 * GrayCode - notifications 域参数校验（纯领域层）。
 *
 * dsh-tools 的 schema 校验之外再显式校验一次（防御模型直传非法值），
 * 非法参数抛稳定错误码 NotificationErrorCode.INVALID_INPUT。
 * 语义：
 * - title 必填：非空字符串，trim 后 1..MAX_TITLE_LENGTH；
 * - message 可选：非空字符串，trim 后空串归一为 null，长度 ≤ MAX_MESSAGE_LENGTH；
 * - level 枚举 info/success/warning/error，默认 info；
 * - silent 布尔，默认 false。
 */

import {
  NOTIFICATION_LEVELS,
  NotificationError,
  NotificationErrorCode,
  type NotificationLevel,
  type NotifyRequest,
} from './types.ts'

/** title 长度上限（字符数）。 */
export const MAX_TITLE_LENGTH = 120

/** message 长度上限（字符数）。 */
export const MAX_MESSAGE_LENGTH = 500

function invalid(message: string): never {
  throw new NotificationError(NotificationErrorCode.INVALID_INPUT, message)
}

/**
 * 校验并规范化一次 notify 请求。非法输入抛 {@link NotificationError}（稳定码
 * GRAY_NOTIFY_INVALID_INPUT）；合法输入返回规范化请求。
 * @param raw - 模型/调用方传入的参数对象。
 */
export function parseNotifyRequest(raw: unknown): NotifyRequest {
  const record = (raw ?? {}) as Record<string, unknown>

  const title = record.title
  if (typeof title !== 'string') {
    invalid(`title must be a non-empty string, got ${JSON.stringify(title)}`)
  }
  const trimmedTitle = title.trim()
  if (trimmedTitle.length === 0) {
    invalid('title must be a non-empty string')
  }
  if (trimmedTitle.length > MAX_TITLE_LENGTH) {
    invalid(`title exceeds ${MAX_TITLE_LENGTH} characters`)
  }

  let message: string | null = null
  if (record.message !== undefined && record.message !== null) {
    if (typeof record.message !== 'string') {
      invalid(`message must be a string, got ${JSON.stringify(record.message)}`)
    }
    const trimmedMessage = record.message.trim()
    if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
      invalid(`message exceeds ${MAX_MESSAGE_LENGTH} characters`)
    }
    message = trimmedMessage.length > 0 ? trimmedMessage : null
  }

  let level: NotificationLevel = 'info'
  if (record.level !== undefined) {
    if (typeof record.level !== 'string' || !(NOTIFICATION_LEVELS as readonly string[]).includes(record.level)) {
      invalid(`invalid level ${JSON.stringify(record.level)}: expected one of ${NOTIFICATION_LEVELS.join(', ')}`)
    }
    level = record.level as NotificationLevel
  }

  let silent = false
  if (record.silent !== undefined) {
    if (typeof record.silent !== 'boolean') {
      invalid(`invalid silent ${JSON.stringify(record.silent)}: expected boolean`)
    }
    silent = record.silent
  }

  return { title: trimmedTitle, message, level, silent }
}
