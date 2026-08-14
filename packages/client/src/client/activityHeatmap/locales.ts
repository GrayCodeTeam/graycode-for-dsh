/**
 * Activity heatmap locale fragment (C6).
 *
 * Own namespace (`graycode.activityHeatmap`) so the main session can register
 * it independently of the skeleton `graycode` namespace and other surfaces.
 *
 * Key set is aligned with the components and the pure logic:
 * - every range has a `range.<x>` key,
 * - every error hint has an `error.<x>` key (see errors.ts),
 * - the summary strip / heatmap / bars copy keys.
 * The typed `LocaleDictOf` form enforces zh/en balance; the spec file checks
 * the alignment against the logic tables at runtime.
 */
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary keys of the `graycode.activityHeatmap` namespace. */
export type GrayCodeActivityHeatmapLocaleKey =
  | 'title'
  | 'state.loading'
  | 'state.error'
  | 'state.errorRetry'
  | 'state.replayOnly'
  | 'state.empty'
  | 'summary.total'
  | 'summary.activeDays'
  | 'summary.sessions'
  | 'summary.today'
  | 'summary.currentActive'
  | 'summary.currentInactive'
  | 'summary.minutes'
  | 'heatmap.title'
  | 'heatmap.hourLabels'
  | 'daily.title'
  | 'daily.empty'
  | 'monthly.title'
  | 'monthly.empty'
  | 'range.today'
  | 'range.7d'
  | 'range.30d'
  | 'range.90d'
  | 'range.365d'
  | 'range.all'
  | 'toggle.hourly'
  | 'toggle.monthly'
  | 'error.invalidInput'
  | 'error.conflict'
  | 'error.approvalRequired'
  | 'error.cancelled'
  | 'error.storageCorrupt'
  | 'error.notFound'
  | 'error.endpointNotFound'
  | 'error.internal'
  | 'error.unknown'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GrayCode activity heatmap copy. */
    'graycode.activityHeatmap': GrayCodeActivityHeatmapLocaleKey
  }
}

/** Locale namespace owned by this fragment. */
export const GRAYCODE_ACTIVITY_HEATMAP_NS = 'graycode.activityHeatmap'

/**
 * Balanced zh/en dictionaries for the `graycode.activityHeatmap` namespace
 * (DSH rc.6 ships exactly `LocaleId = 'zh' | 'en'`; the typed form enforces
 * balance).
 */
export const graycodeActivityHeatmapDictionaries: Record<LocaleId, LocaleDictOf<'graycode.activityHeatmap'>> = {
  zh: {
    title: '作息统计',
    'state.loading': '正在加载…',
    'state.error': '加载失败',
    'state.errorRetry': '重试',
    'state.replayOnly': '回放视图，此面板不可用',
    'state.empty': '没有活动记录',
    'summary.total': '总计',
    'summary.activeDays': '活跃天数',
    'summary.sessions': '会话数',
    'summary.today': '今日',
    'summary.currentActive': '正在连续工作',
    'summary.currentInactive': '当前无进行中会话',
    'summary.minutes': '分钟',
    'heatmap.title': '7×24 作息热力图',
    'heatmap.hourLabels': '0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23',
    'daily.title': '每日活跃时长',
    'daily.empty': '所选范围内无每日数据',
    'monthly.title': '月度汇总',
    'monthly.empty': '所选范围内无月度数据',
    'range.today': '今日',
    'range.7d': '7 天',
    'range.30d': '30 天',
    'range.90d': '90 天',
    'range.365d': '365 天',
    'range.all': '全部',
    'toggle.hourly': '作息热力图',
    'toggle.monthly': '月度汇总',
    'error.invalidInput': '输入无效',
    'error.conflict': '状态冲突',
    'error.approvalRequired': '需要人工确认',
    'error.cancelled': '已取消',
    'error.storageCorrupt': '存储数据损坏',
    'error.notFound': '未找到该记录',
    'error.endpointNotFound': '主机服务未接线',
    'error.internal': '内部错误',
    'error.unknown': '未知错误',
  },
  en: {
    title: 'Activity',
    'state.loading': 'Loading…',
    'state.error': 'Failed to load',
    'state.errorRetry': 'Retry',
    'state.replayOnly': 'Not available in replay view',
    'state.empty': 'No activity recorded',
    'summary.total': 'Total',
    'summary.activeDays': 'Active days',
    'summary.sessions': 'Sessions',
    'summary.today': 'Today',
    'summary.currentActive': 'Working now',
    'summary.currentInactive': 'No session in progress',
    'summary.minutes': 'min',
    'heatmap.title': '7×24 heatmap',
    'heatmap.hourLabels': '0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23',
    'daily.title': 'Daily activity',
    'daily.empty': 'No daily data in range',
    'monthly.title': 'Monthly summary',
    'monthly.empty': 'No monthly data in range',
    'range.today': 'Today',
    'range.7d': '7 days',
    'range.30d': '30 days',
    'range.90d': '90 days',
    'range.365d': '365 days',
    'range.all': 'All',
    'toggle.hourly': 'Hourly heatmap',
    'toggle.monthly': 'Monthly summary',
    'error.invalidInput': 'Invalid input',
    'error.conflict': 'State conflict',
    'error.approvalRequired': 'Approval required',
    'error.cancelled': 'Cancelled',
    'error.storageCorrupt': 'Storage corrupted',
    'error.notFound': 'Not found',
    'error.endpointNotFound': 'Host service not wired',
    'error.internal': 'Internal error',
    'error.unknown': 'Unknown error',
  },
}

/**
 * Japanese placeholder dictionary (GAP-1, mirrors every other surface): DSH
 * rc.6 has no selectable `ja` locale, so this registers through the untyped
 * single-locale overload and stays inert until DSH ships one. The key set
 * intentionally mirrors the zh/en dictionaries.
 */
export const graycodeActivityHeatmapJaPlaceholder: LocaleDict = {
  title: 'アクティビティ',
  'state.loading': '読み込み中…',
  'state.error': '読み込みに失敗しました',
  'state.errorRetry': '再試行',
  'state.replayOnly': 'リプレイ表示のためこのパネルは利用できません',
  'state.empty': 'アクティビティ記録がありません',
  'summary.total': '合計',
  'summary.activeDays': 'アクティブ日数',
  'summary.sessions': 'セッション数',
  'summary.today': '今日',
  'summary.currentActive': '連続作業中',
  'summary.currentInactive': '進行中のセッションはありません',
  'summary.minutes': '分',
  'heatmap.title': '7×24 ヒートマップ',
  'heatmap.hourLabels': '0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23',
  'daily.title': '日別アクティビティ',
  'daily.empty': '範囲内に日別データがありません',
  'monthly.title': '月次サマリー',
  'monthly.empty': '範囲内に月次データがありません',
  'range.today': '今日',
  'range.7d': '7日',
  'range.30d': '30日',
  'range.90d': '90日',
  'range.365d': '365日',
  'range.all': 'すべて',
  'toggle.hourly': '時間別ヒートマップ',
  'toggle.monthly': '月次サマリー',
  'error.invalidInput': '入力が無効です',
  'error.conflict': '状態の競合',
  'error.approvalRequired': '承認が必要です',
  'error.cancelled': 'キャンセル済み',
  'error.storageCorrupt': 'ストレージデータが破損しています',
  'error.notFound': 'レコードが見つかりません',
  'error.endpointNotFound': 'ホストサービスが未接続です',
  'error.internal': '内部エラー',
  'error.unknown': '不明なエラー',
}
