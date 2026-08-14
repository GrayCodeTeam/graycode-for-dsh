/**
 * C4 多平台系统通知 — locale 片段。
 *
 * 独立命名空间（`graycode.notifications`），与骨架 `graycode` 及其他 surface
 * 解耦。key 集与组件/纯逻辑对齐（title / 空态 / 回放态 / 级别徽标）。
 * 类型化 `LocaleDictOf` 强制 zh/en 平衡；ja 占位（GAP-1）镜像同 key 集。
 */
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary keys of the `graycode.notifications` namespace. */
export type GrayCodeNotificationsLocaleKey =
  | 'title'
  | 'state.empty'
  | 'state.replayOnly'
  | 'level.info'
  | 'level.success'
  | 'level.warning'
  | 'level.error'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GrayCode notifications copy. */
    'graycode.notifications': GrayCodeNotificationsLocaleKey
  }
}

/** Locale namespace owned by this fragment. */
export const GRAYCODE_NOTIFICATIONS_NS = 'graycode.notifications'

/**
 * Balanced zh/en dictionaries for the `graycode.notifications` namespace
 * (DSH rc.6 ships exactly `LocaleId = 'zh' | 'en'`; the typed form enforces
 * balance).
 */
export const graycodeNotificationsDictionaries: Record<
  LocaleId,
  LocaleDictOf<'graycode.notifications'>
> = {
  zh: {
    title: '系统通知',
    'state.empty': '暂无通知',
    'state.replayOnly': '回放视图，通知中心不可用',
    'level.info': '信息',
    'level.success': '成功',
    'level.warning': '警告',
    'level.error': '错误',
  },
  en: {
    title: 'Notifications',
    'state.empty': 'No notifications',
    'state.replayOnly': 'Not available in replay view',
    'level.info': 'Info',
    'level.success': 'Success',
    'level.warning': 'Warning',
    'level.error': 'Error',
  },
}

/**
 * Japanese placeholder dictionary (GAP-1, mirrors every other surface): DSH
 * rc.6 has no selectable `ja` locale, so this registers through the untyped
 * single-locale overload and stays inert until DSH ships one. The key set
 * intentionally mirrors the zh/en dictionaries.
 */
export const graycodeNotificationsJaPlaceholder: LocaleDict = {
  title: 'システム通知',
  'state.empty': '通知はありません',
  'state.replayOnly': 'リプレイ表示のため通知センターは利用できません',
  'level.info': '情報',
  'level.success': '成功',
  'level.warning': '警告',
  'level.error': 'エラー',
}
