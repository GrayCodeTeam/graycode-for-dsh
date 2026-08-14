/**
 * GrayCode - notifications 子插件（C4 多平台系统通知；cordis 表面）
 *
 * 挂载方式（由主会话在收尾时统一接入根 index.ts，本文件自带可独立挂载的 apply）：
 * ```ts
 * ctx.plugin(notifications, { enabled: true, agentScope: 'roots', windowsToast: true })
 * ```
 *
 * Config：
 * - enabled 默认 true：false 时不注册工具、不提供服务；
 * - agentScope：复用 agentScope.ts 的 createScopedToolRegistrar（roots/all/disabled）；
 * - windowsToast 默认 true：win32 上启用 PowerShell 原生 toast 后端；非 win32 或
 *   关闭时退化为 noop（投递 skipped，fail-closed）。
 *
 * 跨域服务：apply 时经 cordis 公开 API `ctx.provide('graycode.notifications', handle)`
 * 共享 {@link NotificationService}（参照 stagedDiff 的 `graycode.stagedDiff` 模式）；
 * 消费者用 `ctx.inject`/`ctx.get` 消费。投递完成后经 `ctx.emit` 发射
 * `graycode/notifications/notify` 事件（best-effort，观察者异常不外溢）。
 *
 * 与 client 的关系（通道结论，详见 README）：rc.6 无 host→client 推送通道；
 * client 侧自行经会话事件（tool/call + tool/result）观察 `notify` 调用并展示。
 * 因此本域不需要向 grayRemote 注册查询端点（通知是 fire-and-forget 推送语义）。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'
import { NotificationService } from './service.ts'
import { createNotifyTools } from './tools.ts'
import { createToastBackend } from './domain/toast.ts'
import type { NotifyResult } from './domain/types.ts'

export const name = 'graycode-notifications'

export const inject = ['agents'] as const

/**
 * Notifications domain (C4): `notify` tool + multi-platform delivery backends
 * (Windows native toast via child_process → powershell; noop fallback elsewhere).
 * Delivery failures never throw — they fold into the result's delivery field.
 */
export interface Config {
  /** Master switch: false skips tool registration and service provision entirely. Default true. */
  enabled: boolean
  /** Tool install scope: roots (default), all agents, or disabled (no registration). */
  agentScope: AgentScopeMode
  /** Enable the Windows native toast backend on win32 (default true). */
  windowsToast: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  agentScope: agentScopeSchema,
  windowsToast: z.boolean().default(true),
})

/** cordis service 名：notifications 子插件向其他域共享 NotificationService。 */
export const NOTIFICATIONS_SERVICE_KEY = 'graycode.notifications'

/** 跨域共享句柄（消费者只依赖本契约；domain/service 不感知 cordis）。 */
export interface NotificationsServiceHandle {
  readonly service: NotificationService
  /** 触发一次系统通知（参数非法抛稳定码错误；投递失败收敛为 delivery 字段）。 */
  notify(raw: unknown): Promise<NotifyResult>
}

/** 构造跨域共享句柄（引用同一 service 实例）。 */
export function createNotificationsServiceHandle(
  service: NotificationService,
): NotificationsServiceHandle {
  return { service, notify: (raw) => service.notify(raw) }
}

export function apply(ctx: Context, config: Config): () => void {
  if (!config.enabled) {
    return () => {}
  }

  const backend = createToastBackend({ windowsToast: config.windowsToast })
  const service = new NotificationService({
    backend,
    emit: (kind, payload) => {
      try {
        // 自定义事件名不在 cordis Events 声明内：运行时按字符串发射
        ;(ctx.emit as (event: string, ...args: unknown[]) => void)(kind, payload)
      } catch {
        // 观察者异常不影响通知主流程
      }
    },
  })

  // 跨域共享：service 出现时其他域的 ctx.inject 回调被唤醒；
  // 本 fiber 卸载时 disposeService 使消费者侧注入纤维回收。
  const handle = createNotificationsServiceHandle(service)
  const disposeService = ctx.provide(NOTIFICATIONS_SERVICE_KEY, handle)

  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  registrar.register(createNotifyTools(service))

  return () => {
    disposeService()
    registrar.dispose()
  }
}
