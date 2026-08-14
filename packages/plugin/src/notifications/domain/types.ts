/**
 * GrayCode - notifications 域类型（C4 多平台系统通知）
 *
 * 通知是「fire-and-forget」语义：`notify` 工具触发后，投递状态（delivered /
 * skipped / failed）以稳定机器码（GRAY_NOTIFY_*）随结果返回，模型/前端不解析
 * 文案。错误码与 media/stagedDiff 域同一约定：execute 抛 {@link NotificationError}
 * 时工具层把它投影为 { code, message }；投递失败绝不抛出（失败隔离），
 * 收敛为 {@link NotifyDelivery} 的 status/failed。
 */

/** 通知级别（稳定枚举，模型/前端可路由）。 */
export const NOTIFICATION_LEVELS = ['info', 'success', 'warning', 'error'] as const

export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number]

/** notify 工具规范化请求（parseNotifyRequest 输出）。 */
export interface NotifyRequest {
  readonly title: string
  /** 可选正文；空字符串归一为 null。 */
  readonly message: string | null
  readonly level: NotificationLevel
  readonly silent: boolean
}

/** 投递状态码（稳定机器码；仅 status 字段的语义投影）。 */
export const NotificationDeliveryCode = {
  DELIVERED: 'GRAY_NOTIFY_DELIVERED',
  /** 未尝试投递：后端不可用 / 平台不支持 / 显式关闭。 */
  SKIPPED: 'GRAY_NOTIFY_SKIPPED',
  /** 后端尝试但失败（powershell 退出码非 0 / 超时 / 异常）。 */
  TOAST_FAILED: 'GRAY_NOTIFY_TOAST_FAILED',
} as const

export type NotificationDeliveryCodeValue =
  (typeof NotificationDeliveryCode)[keyof typeof NotificationDeliveryCode]

export type NotifyDeliveryStatus = 'delivered' | 'skipped' | 'failed'

/** 一次投递的结果（写入 NotifyResult.delivery；失败绝不外溢为异常）。 */
export interface NotifyDelivery {
  readonly status: NotifyDeliveryStatus
  /** 稳定机器码（GRAY_NOTIFY_*）。 */
  readonly code: NotificationDeliveryCodeValue
  /** 人类可读说明（投递细节；错误码才是契约）。 */
  readonly message: string
  /** 实际使用的后端名（noop / powershell-winrt / 注入的测试后端）。 */
  readonly backend: string
}

export interface NotifyResult {
  readonly request: NotifyRequest
  readonly delivery: NotifyDelivery
  readonly notifiedAt: number
}

/** notifications 域稳定错误码（GRAY_NOTIFY_*）。 */
export const NotificationErrorCode = {
  /** 参数校验失败（title 缺失/超长、message 非字符串/超长、level 非法、silent 非布尔）。 */
  INVALID_INPUT: 'GRAY_NOTIFY_INVALID_INPUT',
} as const

export type NotificationErrorCodeValue =
  (typeof NotificationErrorCode)[keyof typeof NotificationErrorCode]

/** notifications 域错误：稳定 code + 人类可读 message。 */
export class NotificationError extends Error {
  readonly code: NotificationErrorCodeValue

  constructor(code: NotificationErrorCodeValue, message: string) {
    super(message)
    this.name = 'NotificationError'
    this.code = code
  }
}
