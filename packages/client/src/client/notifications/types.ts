/**
 * C4 多平台系统通知 — client 侧类型与契约（浏览器通知展示）。
 *
 * CLIENT BOUNDARY RULES（PLAN_V2 §5.6）：本 surface 是「契约驱动消费点 +
 * 可挂接组件」（rc.6 无管理视图 slot、无 host→client 推送通道，见 README）。
 * 所有 wire 形状在 `fold.ts`/`types.ts` 防御性收窄，绝不信任事件载荷。
 */

/** 通知级别（与 host notifications 域稳定枚举对齐）。 */
export const NOTIFICATION_LEVELS = ['info', 'success', 'warning', 'error'] as const

export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number]

/** 一条通知在会话事件流中的生命周期状态。 */
export type NotificationIntentStatus = 'active' | 'completed' | 'failed' | 'cancelled'

/**
 * 一条通知意图（从 `notify` 工具调用派生；id 稳定 = `call:<callId>`）。
 * - active：tool/call 已见、tool/result 未到（窗口内）；
 * - completed：tool/result 成功（无错误）；
 * - failed：tool/result 带非取消错误（如 GRAY_NOTIFY_INVALID_INPUT）；
 * - cancelled：tool/result 带 GRAY_CANCELLED。
 */
export interface NotificationIntent {
  readonly id: string
  readonly title: string
  readonly body: string | null
  readonly level: NotificationLevel
  readonly silent: boolean
  /** `tool/call` 事件时间（Unix epoch ms）。 */
  readonly at: number
  readonly status: NotificationIntentStatus
}

export type NotificationPermissionState = 'default' | 'granted' | 'denied'

/** 浏览器 Notification init 的结构化子集（端口抽象，便于 node 环境测试）。 */
export interface NotificationShowOptions {
  readonly body?: string
  readonly tag?: string
  readonly silent?: boolean
}

/**
 * 浏览器通知 API 端口。`permission()` 返回 undefined 表示环境不支持
 * （如非浏览器/无 window.Notification）——presenter 以 `unsupported` 降级。
 */
export interface NotificationApiPort {
  permission(): NotificationPermissionState | undefined
  requestPermission(): Promise<NotificationPermissionState>
  /** 展示通知；返回是否已展示（实现不得抛出，异常由调用方收敛）。 */
  show(title: string, options: NotificationShowOptions): boolean
}

export type NotificationPresentationStatus = 'shown' | 'denied' | 'unsupported' | 'failed'

/** 一次展示的结果（presenter 绝不 reject）。 */
export interface NotificationPresentation {
  readonly status: NotificationPresentationStatus
  readonly intentId: string
}

/** 通知事件源：应用内通知中心 / 展示桥的消费点（subscribe 返回退订函数）。 */
export interface NotificationEventSource {
  subscribe(listener: (intent: NotificationIntent) => void): () => void
}
