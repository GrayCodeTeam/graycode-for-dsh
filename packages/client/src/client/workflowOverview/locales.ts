/**
 * Workflow overview locale fragment (P4-02).
 *
 * Own namespace (`graycode.workflowOverview`) so the main session can register
 * it independently of the skeleton `graycode` namespace and the P4-01
 * `graycode.workflow` namespace (index.ts/locales.ts are merged by the main
 * session; this file is the typed dictionary source).
 *
 * Key set is aligned with the components and the pure logic:
 * - every `WorkflowRunKind` has a `kind.<x>` key,
 * - every progress status has a `runStatus.<x>` key,
 * - every progress phase has a `phase.<x>` key,
 * - every error hint has an `error.<x>` key (see errors.ts),
 * - every size unit has a `size.<x>` key (see viewModel.ts).
 * The typed `LocaleDictOf` form enforces zh/en balance; the spec file checks
 * the alignment against the logic tables at runtime.
 */
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary keys of the `graycode.workflowOverview` namespace. */
export type GrayCodeWorkflowOverviewLocaleKey =
  | 'title'
  | 'filter.workspace'
  | 'filter.workspacePlaceholder'
  | 'filter.session'
  | 'filter.sessionPlaceholder'
  | 'filter.sessionUnavailable'
  | 'filter.apply'
  | 'filter.reset'
  | 'list.total'
  | 'list.empty'
  | 'list.loadMore'
  | 'state.loading'
  | 'state.error'
  | 'state.errorRetry'
  | 'state.replayOnly'
  | 'run.updatedAt'
  | 'run.size'
  | 'run.workspace'
  | 'run.project'
  | 'run.status'
  | 'run.phase'
  | 'run.locateSession'
  | 'run.openDocument'
  | 'kind.progress'
  | 'kind.design'
  | 'kind.plan'
  | 'kind.review'
  | 'runStatus.active'
  | 'runStatus.blocked'
  | 'runStatus.completed'
  | 'runStatus.archived'
  | 'phase.design'
  | 'phase.plan'
  | 'phase.implementation'
  | 'phase.review'
  | 'phase.maintenance'
  | 'size.bytes'
  | 'size.kb'
  | 'size.mb'
  | 'size.gb'
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
    /** GrayCode workflow overview copy. */
    'graycode.workflowOverview': GrayCodeWorkflowOverviewLocaleKey
  }
}

/** Locale namespace owned by this fragment. */
export const GRAYCODE_WORKFLOW_OVERVIEW_NS = 'graycode.workflowOverview'

/**
 * Balanced zh/en dictionaries for the `graycode.workflowOverview` namespace
 * (DSH rc.6 ships exactly `LocaleId = 'zh' | 'en'`; the typed form enforces
 * balance).
 */
export const graycodeWorkflowOverviewDictionaries: Record<LocaleId, LocaleDictOf<'graycode.workflowOverview'>> = {
  zh: {
    title: '工作流总览',
    'filter.workspace': '工作区',
    'filter.workspacePlaceholder': '工作区根目录（绝对路径）',
    'filter.session': '会话',
    'filter.sessionPlaceholder': '会话 ID',
    'filter.sessionUnavailable': '当前版本不支持按会话过滤',
    'filter.apply': '应用',
    'filter.reset': '重置',
    'list.total': '个工作流',
    'list.empty': '没有找到 workflow run',
    'list.loadMore': '加载更多',
    'state.loading': '正在加载…',
    'state.error': '加载失败',
    'state.errorRetry': '重试',
    'state.replayOnly': '回放视图，此面板不可用',
    'run.updatedAt': '更新时间',
    'run.size': '大小',
    'run.workspace': '工作区',
    'run.project': '项目',
    'run.status': '状态',
    'run.phase': '阶段',
    'run.locateSession': '定位会话',
    'run.openDocument': '打开文档',
    'kind.progress': '进度',
    'kind.design': '设计',
    'kind.plan': '计划',
    'kind.review': '审查',
    'runStatus.active': '进行中',
    'runStatus.blocked': '受阻',
    'runStatus.completed': '已完成',
    'runStatus.archived': '已归档',
    'phase.design': '设计',
    'phase.plan': '计划',
    'phase.implementation': '实现',
    'phase.review': '审查',
    'phase.maintenance': '维护',
    'size.bytes': 'B',
    'size.kb': 'KB',
    'size.mb': 'MB',
    'size.gb': 'GB',
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
    title: 'Workflow overview',
    'filter.workspace': 'Workspace',
    'filter.workspacePlaceholder': 'Workspace root (absolute path)',
    'filter.session': 'Session',
    'filter.sessionPlaceholder': 'Session ID',
    'filter.sessionUnavailable': 'Session filtering is not supported in this version',
    'filter.apply': 'Apply',
    'filter.reset': 'Reset',
    'list.total': 'workflow runs',
    'list.empty': 'No workflow runs found',
    'list.loadMore': 'Load more',
    'state.loading': 'Loading…',
    'state.error': 'Failed to load',
    'state.errorRetry': 'Retry',
    'state.replayOnly': 'Not available in replay view',
    'run.updatedAt': 'Updated',
    'run.size': 'Size',
    'run.workspace': 'Workspace',
    'run.project': 'Project',
    'run.status': 'Status',
    'run.phase': 'Phase',
    'run.locateSession': 'Locate session',
    'run.openDocument': 'Open document',
    'kind.progress': 'Progress',
    'kind.design': 'Design',
    'kind.plan': 'Plan',
    'kind.review': 'Review',
    'runStatus.active': 'Active',
    'runStatus.blocked': 'Blocked',
    'runStatus.completed': 'Completed',
    'runStatus.archived': 'Archived',
    'phase.design': 'Design',
    'phase.plan': 'Plan',
    'phase.implementation': 'Implementation',
    'phase.review': 'Review',
    'phase.maintenance': 'Maintenance',
    'size.bytes': 'B',
    'size.kb': 'KB',
    'size.mb': 'MB',
    'size.gb': 'GB',
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
 * Japanese placeholder dictionary (GAP-1, mirrors the skeleton `graycode`
 * namespace and the P4-01 fragment): DSH rc.6 has no selectable `ja` locale,
 * so this registers through the untyped single-locale overload and stays
 * inert until DSH ships one. The key set intentionally mirrors the zh/en
 * dictionaries.
 */
export const graycodeWorkflowOverviewJaPlaceholder: LocaleDict = {
  title: 'ワークフロー概要',
  'filter.workspace': 'ワークスペース',
  'filter.workspacePlaceholder': 'ワークスペースルート（絶対パス）',
  'filter.session': 'セッション',
  'filter.sessionPlaceholder': 'セッション ID',
  'filter.sessionUnavailable': 'このバージョンではセッション絞り込みは利用できません',
  'filter.apply': '適用',
  'filter.reset': 'リセット',
  'list.total': '件のワークフロー',
  'list.empty': 'ワークフローが見つかりません',
  'list.loadMore': 'もっと読み込む',
  'state.loading': '読み込み中…',
  'state.error': '読み込みに失敗しました',
  'state.errorRetry': '再試行',
  'state.replayOnly': 'リプレイ表示のためこのパネルは利用できません',
  'run.updatedAt': '更新時刻',
  'run.size': 'サイズ',
  'run.workspace': 'ワークスペース',
  'run.project': 'プロジェクト',
  'run.status': '状態',
  'run.phase': 'フェーズ',
  'run.locateSession': 'セッションを探す',
  'run.openDocument': 'ドキュメントを開く',
  'kind.progress': '進捗',
  'kind.design': '設計',
  'kind.plan': '計画',
  'kind.review': 'レビュー',
  'runStatus.active': '進行中',
  'runStatus.blocked': 'ブロック中',
  'runStatus.completed': '完了',
  'runStatus.archived': 'アーカイブ済み',
  'phase.design': '設計',
  'phase.plan': '計画',
  'phase.implementation': '実装',
  'phase.review': 'レビュー',
  'phase.maintenance': '保守',
  'size.bytes': 'B',
  'size.kb': 'KB',
  'size.mb': 'MB',
  'size.gb': 'GB',
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
