/**
 * C4 多平台系统通知 — 浏览器 Notification API 展示器。
 *
 * - {@link BrowserNotificationPresenter} 把一条 {@link NotificationIntent} 映射为
 *   Notification API 调用（title/body/tag/silent），处理权限生命周期
 *   （default → request；granted → show；denied → 降级为应用内列表）；
 * - 环境不支持（端口 permission() 返回 undefined）→ `unsupported`；
 * - 任何异常收敛为 `failed`，presenter 绝不 reject；
 * - 参数映射（`notificationShowOptions`）为纯函数，node 环境可测。
 */

import type {
  NotificationApiPort,
  NotificationIntent,
  NotificationPermissionState,
  NotificationPresentation,
  NotificationShowOptions,
} from './types.ts'

/** 展示 tag 前缀：同一 intent 的重复展示按 id 去重/替换（浏览器 Notification 语义）。 */
export const NOTIFICATION_TAG_PREFIX = 'graycode-notify'

/** 只有 completed 的意图才展示（active 未定论 / failed / cancelled 不弹）。 */
export function shouldPresent(intent: NotificationIntent): boolean {
  return intent.status === 'completed'
}

/** 稳定展示 tag（`graycode-notify:call:<callId>`）。 */
export function notificationTag(intent: NotificationIntent): string {
  return `${NOTIFICATION_TAG_PREFIX}:${intent.id}`
}

/**
 * 纯参数映射：意图 → Notification init（body 仅在非空时携带；silent 透传；
 * tag 恒携带以便替换）。node 环境可直接断言。
 */
export function notificationShowOptions(intent: NotificationIntent): NotificationShowOptions {
  return {
    tag: notificationTag(intent),
    silent: intent.silent,
    ...(intent.body !== null ? { body: intent.body } : {}),
  }
}

/** 浏览器通知展示器（端口注入；测试用 fake port，不依赖 jsdom）。 */
export class BrowserNotificationPresenter {
  constructor(private readonly port: NotificationApiPort) {}

  /**
   * 展示一条通知。绝不 reject：
   * - 非 completed → `failed`（不展示）；
   * - 端口不支持（permission() undefined）→ `unsupported`；
   * - denied → `denied`（调用方降级到应用内列表）；
   * - default → 先请求权限再决定；
   * - show 抛错 / 返回 false → `failed`。
   */
  async present(intent: NotificationIntent): Promise<NotificationPresentation> {
    if (!shouldPresent(intent)) {
      return { status: 'failed', intentId: intent.id }
    }

    let permission = this.port.permission()
    if (permission === undefined) {
      return { status: 'unsupported', intentId: intent.id }
    }
    if (permission === 'default') {
      try {
        permission = await this.port.requestPermission()
      } catch {
        return { status: 'failed', intentId: intent.id }
      }
    }
    if (permission === 'denied' || permission === 'default') {
      // denied：降级到应用内列表；default（用户忽略权限弹窗）同样不展示
      return { status: 'denied', intentId: intent.id }
    }

    try {
      const shown = this.port.show(intent.title, notificationShowOptions(intent))
      return shown
        ? { status: 'shown', intentId: intent.id }
        : { status: 'failed', intentId: intent.id }
    } catch {
      return { status: 'failed', intentId: intent.id }
    }
  }
}

/**
 * 浏览器环境适配端口：把全局 `Notification`（DOM lib 类型；node 测试中运行时
 * 为 undefined → permission() 返回 undefined = unsupported）适配为
 * {@link NotificationApiPort}。禁止在 node 环境直接调用（返回 unsupported/false）。
 */
export function createBrowserNotificationPort(): NotificationApiPort {
  return {
    permission(): NotificationPermissionState | undefined {
      if (typeof Notification === 'undefined') return undefined
      return Notification.permission
    },
    async requestPermission(): Promise<NotificationPermissionState> {
      if (typeof Notification === 'undefined') return 'denied'
      if (typeof Notification.requestPermission !== 'function') {
        return Notification.permission
      }
      return Notification.requestPermission()
    },
    show(title, options): boolean {
      if (typeof Notification === 'undefined') return false
      new Notification(title, options)
      return true
    },
  }
}
