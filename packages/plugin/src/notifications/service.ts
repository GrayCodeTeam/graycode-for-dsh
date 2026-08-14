/**
 * GrayCode - notifications 域服务（编排层）。
 *
 * 职责：
 * - `notify(raw)`：参数校验（稳定错误码）→ 后端投递 → 收敛为 {@link NotifyResult}；
 * - 失败隔离：后端不可用/失败一律收敛为 delivery（skipped/failed），绝不 reject；
 *   参数非法抛 {@link NotificationError}（稳定码 GRAY_NOTIFY_INVALID_INPUT）；
 * - 投递完成后 best-effort 发射 cordis 事件 `graycode/notifications/notify`，
 *   观察者（其他域/未来 host→client 桥）异常被吞掉，不影响主流程。
 */

import type { ToastBackend } from './domain/toast.ts'
import { parseNotifyRequest } from './domain/validate.ts'
import {
  NotificationDeliveryCode,
  type NotifyDelivery,
  type NotifyRequest,
  type NotifyResult,
} from './domain/types.ts'

/** 投递完成后发射的 cordis 事件名（自定义事件，运行时按字符串发射）。 */
export const NOTIFY_EVENT = 'graycode/notifications/notify'

export interface NotificationServiceOptions {
  /** 投递后端（生产为 createToastBackend 结果；测试注入 fake）。 */
  readonly backend: ToastBackend
  /** 可选观察者：投递完成后回调（默认 noop；异常由本服务吞掉）。 */
  readonly emit?: (kind: string, payload: unknown) => void
}

export class NotificationService {
  private readonly backend: ToastBackend
  private readonly emit: (kind: string, payload: unknown) => void

  constructor(options: NotificationServiceOptions) {
    this.backend = options.backend
    this.emit = options.emit ?? (() => {})
  }

  /** 当前后端名（诊断/测试用）。 */
  get backendName(): string {
    return this.backend.name
  }

  /**
   * 触发一次系统通知（C4 host 侧入口）。
   * - 参数非法：抛 {@link NotificationError}（GRAY_NOTIFY_INVALID_INPUT）；
   * - 投递失败：绝不抛出，收敛为 `result.delivery.status === 'failed'`；
   * - 观察者异常：吞掉。
   */
  async notify(raw: unknown): Promise<NotifyResult> {
    const request: NotifyRequest = parseNotifyRequest(raw)
    const notifiedAt = Date.now()
    const delivery = await this.deliver(request)
    const result: NotifyResult = { request, delivery, notifiedAt }
    try {
      this.emit(NOTIFY_EVENT, result)
    } catch {
      // 观察者失败不影响通知主流程
    }
    return result
  }

  private async deliver(request: NotifyRequest): Promise<NotifyDelivery> {
    try {
      if (!this.backend.isAvailable()) {
        return {
          status: 'skipped',
          code: NotificationDeliveryCode.SKIPPED,
          message: 'no notification backend available on this host',
          backend: this.backend.name,
        }
      }
      const outcome = await this.backend.show(request)
      if (outcome.status === 'delivered') {
        return {
          status: 'delivered',
          code: NotificationDeliveryCode.DELIVERED,
          message: 'notification delivered',
          backend: this.backend.name,
        }
      }
      if (outcome.status === 'skipped') {
        return {
          status: 'skipped',
          code: NotificationDeliveryCode.SKIPPED,
          message: outcome.reason,
          backend: this.backend.name,
        }
      }
      return {
        status: 'failed',
        code: NotificationDeliveryCode.TOAST_FAILED,
        message: outcome.reason,
        backend: this.backend.name,
      }
    } catch (error) {
      // 后端任何未预期异常收敛为 failed 投递（失败隔离，绝不外溢）
      return {
        status: 'failed',
        code: NotificationDeliveryCode.TOAST_FAILED,
        message: error instanceof Error ? error.message : String(error),
        backend: this.backend.name,
      }
    }
  }
}
