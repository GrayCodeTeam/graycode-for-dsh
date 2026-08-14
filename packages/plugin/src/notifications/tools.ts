/**
 * GrayCode - notify 工具（C4 多平台系统通知的 host 触发面）。
 *
 * 参数与老 Gray 通知对齐：title（必填）、message（可选）、level、silent。
 * 语义要点：
 * - 参数校验在 dsh-tools schema 之外再显式校验一次（防御模型直传非法值），
 *   非法参数抛稳定错误码 NotificationErrorCode.INVALID_INPUT；
 * - 投递失败绝不抛出（失败隔离）：结果 `notification.delivered` +
 *   `notification.deliveryCode` 承载投递状态，模型/前端以稳定码路由；
 * - 工具结果附带 notify 调用事实（title/message/level/silent/delivery），
 *   client 侧经会话事件（tool/call + tool/result）自行观察，无需 host→client
 *   推送通道（rc.6 无该通道，见 notifications/README.md）。
 */

import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { NotificationService } from './service.ts'
import { NOTIFICATION_LEVELS, type NotifyResult } from './domain/types.ts'

/**
 * 丢弃值为 undefined 的键（工具输出跨 dsh-tools 边界为无损 JSON，可选字段
 * 必须省略而非携带 undefined）。
 */
function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) out[key] = v
  }
  return out as T
}

/** 渲染规范的 text 字段（模型可见文案）。 */
function renderText(value: { text: string }): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: value.text }]
}

/** 把投递结果渲染为一行人类可读摘要（稳定码才是契约）。 */
export function formatNotifyResult(result: NotifyResult): string {
  const level = result.request.level.toUpperCase()
  const target =
    result.delivery.status === 'delivered'
      ? 'delivered'
      : result.delivery.status === 'skipped'
        ? 'skipped'
        : 'delivery failed'
  const parts = [`Notification ${target} [${level}]: ${result.request.title}`]
  if (result.request.message !== null) {
    parts.push(result.request.message)
  }
  return parts.join('\n')
}

/** notify 工具集合（当前单个），闭包持有 NotificationService 实例。 */
export function createNotifyTools(service: NotificationService): ToolDefinition[] {
  const notify = defineTool({
    name: 'notify',
    description:
      'Trigger a system notification (C4 multi-platform): Windows native toast when the host ' +
      'supports it, otherwise the delivery is reported as skipped/failed (never a thrown error).\n' +
      'Parameters: title (required, 1-120 chars); message (optional body, <= 500 chars); ' +
      'level (info/success/warning/error, default info); silent (suppress the toast sound, default false).\n' +
      'Returns: notification { title, message?, level, silent, delivered, deliveryCode } — ' +
      'deliveryCode is the stable machine code (GRAY_NOTIFY_DELIVERED / GRAY_NOTIFY_SKIPPED / GRAY_NOTIFY_TOAST_FAILED).',
    parameters: {
      title: { type: 'string', required: true, description: 'Notification title (1-120 characters).' },
      message: { type: 'string', description: 'Optional notification body (<= 500 characters).' },
      level: { type: 'string', enum: [...NOTIFICATION_LEVELS], description: 'Severity level. Defaults to info.' },
      silent: { type: 'boolean', description: 'Suppress the notification sound. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          notification: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', required: true },
              message: { type: 'string' },
              level: { type: 'string', enum: [...NOTIFICATION_LEVELS], required: true },
              silent: { type: 'boolean', required: true },
              delivered: { type: 'boolean', required: true },
              deliveryCode: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec: ToolRunContext) {
      if (exec.signal.aborted) {
        throw new Error('notify aborted')
      }
      // 参数校验（schema 之外的防御校验）与投递：投递失败不抛出，收敛为 delivery 字段
      const result = await service.notify(args)
      if (exec.signal.aborted) {
        throw new Error('notify aborted')
      }
      return omitUndefined({
        text: formatNotifyResult(result),
        notification: {
          title: result.request.title,
          ...(result.request.message !== null ? { message: result.request.message } : {}),
          level: result.request.level,
          silent: result.request.silent,
          delivered: result.delivery.status === 'delivered',
          deliveryCode: result.delivery.code,
        },
      })
    },
  })

  return [notify]
}
