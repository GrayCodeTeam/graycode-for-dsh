/**
 * Checkpoint list locale fragment (P4-04).
 *
 * Own namespace (`graycode.checkpointList`) so the main session can register
 * it independently of the skeleton `graycode` namespace and the
 * `graycode.workflow` fragment (index.ts/locales.ts are merged by the main
 * session; this file is the typed dictionary source).
 *
 * Key set is aligned with the components (CheckpointList.tsx /
 * CheckpointListItem.tsx) and the logic modules: every error hint messageKey
 * (errors.ts), every type/phase label key (viewModel.ts) and every verify
 * state badge key is present here.
 */
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary keys of the `graycode.checkpointList` namespace. */
export type GrayCodeCheckpointListLocaleKey =
  | 'list.title'
  | 'list.workspace'
  | 'list.empty'
  | 'list.loading'
  | 'list.idle'
  | 'list.loadingMore'
  | 'list.loadMore'
  | 'list.total'
  | 'list.retry'
  | 'mock.notice'
  | 'type.full'
  | 'type.incremental'
  | 'phase.before'
  | 'phase.after'
  | 'verify.unknown'
  | 'verify.ok'
  | 'verify.failed'
  | 'verify.title'
  | 'verify.readonly'
  | 'verify.run'
  | 'verify.replayOnly'
  | 'item.createdAt'
  | 'item.size'
  | 'item.files'
  | 'item.parent'
  | 'item.parentNone'
  | 'item.chain'
  | 'item.chainMore'
  | 'item.phase'
  | 'item.conversation'
  | 'item.messageIndex'
  | 'item.tool'
  | 'item.excluded'
  | 'item.contentHash'
  | 'item.expand'
  | 'item.collapse'
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
    /** GrayCode checkpoint list copy. */
    'graycode.checkpointList': GrayCodeCheckpointListLocaleKey
  }
}

/** Locale namespace owned by this fragment. */
export const GRAYCODE_CHECKPOINT_LIST_NS = 'graycode.checkpointList'

/**
 * Balanced zh/en dictionaries for the `graycode.checkpointList` namespace
 * (DSH rc.6 ships exactly `LocaleId = 'zh' | 'en'`; the typed form enforces
 * balance).
 */
export const graycodeCheckpointListDictionaries: Record<LocaleId, LocaleDictOf<'graycode.checkpointList'>> = {
  zh: {
    'list.title': '存档点',
    'list.workspace': '工作区',
    'list.empty': '暂无存档点',
    'list.loading': '加载中…',
    'list.idle': '尚未加载',
    'list.loadingMore': '加载更多中…',
    'list.loadMore': '加载更多',
    'list.total': '总数',
    'list.retry': '重试',
    'mock.notice': '演示数据源（未接入）',
    'type.full': '全量',
    'type.incremental': '增量',
    'phase.before': '操作前',
    'phase.after': '操作后',
    'verify.unknown': '未校验',
    'verify.ok': '校验通过',
    'verify.failed': '校验失败',
    'verify.title': '完整性校验',
    'verify.readonly': '校验状态只读展示',
    'verify.run': '运行校验',
    'verify.replayOnly': '回放视图，不可操作',
    'item.createdAt': '创建时间',
    'item.size': '大小',
    'item.files': '文件数',
    'item.parent': '父存档',
    'item.parentNone': '无（全量根）',
    'item.chain': '父链',
    'item.chainMore': '更早祖先未加载',
    'item.phase': '阶段',
    'item.conversation': '对话',
    'item.messageIndex': '消息序号',
    'item.tool': '工具',
    'item.excluded': '排除数',
    'item.contentHash': '内容哈希',
    'item.expand': '展开',
    'item.collapse': '收起',
    'error.invalidInput': '请求参数无效',
    'error.conflict': '数据已变化，请重试',
    'error.approvalRequired': '操作需要审批',
    'error.cancelled': '已取消',
    'error.storageCorrupt': '存档存储损坏或不可读',
    'error.notFound': '存档点不存在',
    'error.endpointNotFound': '存档列表服务未接入',
    'error.internal': '发生未知错误',
    'error.unknown': '发生未知错误',
  },
  en: {
    'list.title': 'Checkpoints',
    'list.workspace': 'Workspace',
    'list.empty': 'No checkpoints yet',
    'list.loading': 'Loading…',
    'list.idle': 'Not loaded yet',
    'list.loadingMore': 'Loading more…',
    'list.loadMore': 'Load more',
    'list.total': 'Total',
    'list.retry': 'Retry',
    'mock.notice': 'Demo data source (not connected)',
    'type.full': 'Full',
    'type.incremental': 'Incremental',
    'phase.before': 'Before',
    'phase.after': 'After',
    'verify.unknown': 'Not verified',
    'verify.ok': 'Verified',
    'verify.failed': 'Verify failed',
    'verify.title': 'Integrity check',
    'verify.readonly': 'Verify status is read-only',
    'verify.run': 'Run verification',
    'verify.replayOnly': 'Not available in replay view',
    'item.createdAt': 'Created at',
    'item.size': 'Size',
    'item.files': 'Files',
    'item.parent': 'Parent',
    'item.parentNone': 'None (full root)',
    'item.chain': 'Chain',
    'item.chainMore': 'earlier ancestors not loaded',
    'item.phase': 'Phase',
    'item.conversation': 'Conversation',
    'item.messageIndex': 'Message index',
    'item.tool': 'Tool',
    'item.excluded': 'Excluded',
    'item.contentHash': 'Content hash',
    'item.expand': 'Expand',
    'item.collapse': 'Collapse',
    'error.invalidInput': 'Invalid request parameters',
    'error.conflict': 'Data changed; retry',
    'error.approvalRequired': 'Approval required',
    'error.cancelled': 'Cancelled',
    'error.storageCorrupt': 'Checkpoint storage is corrupt or unreadable',
    'error.notFound': 'Checkpoint not found',
    'error.endpointNotFound': 'Checkpoint list service is not connected',
    'error.internal': 'An unexpected error occurred',
    'error.unknown': 'An unexpected error occurred',
  },
}

/**
 * Japanese placeholder dictionary (GAP-1, mirrors the skeleton `graycode`
 * namespace): DSH rc.6 has no selectable `ja` locale, so this registers
 * through the untyped single-locale overload and stays inert until DSH ships
 * one. The key set intentionally mirrors the zh/en dictionaries.
 */
export const graycodeCheckpointListJaPlaceholder: LocaleDict = {
  'list.title': 'チェックポイント',
  'list.workspace': 'ワークスペース',
  'list.empty': 'チェックポイントはありません',
  'list.loading': '読み込み中…',
  'list.idle': '未読込',
  'list.loadingMore': 'さらに読み込み中…',
  'list.loadMore': 'さらに読み込む',
  'list.total': '合計',
  'list.retry': '再試行',
  'mock.notice': 'デモデータソース（未接続）',
  'type.full': 'フル',
  'type.incremental': '増分',
  'phase.before': '操作前',
  'phase.after': '操作後',
  'verify.unknown': '未検証',
  'verify.ok': '検証済み',
  'verify.failed': '検証失敗',
  'verify.title': '整合性検証',
  'verify.readonly': '検証状態は読み取り専用です',
  'verify.run': '検証を実行',
  'verify.replayOnly': 'リプレイ表示のため操作できません',
  'item.createdAt': '作成時刻',
  'item.size': 'サイズ',
  'item.files': 'ファイル数',
  'item.parent': '親チェックポイント',
  'item.parentNone': 'なし（フルルート）',
  'item.chain': '親チェーン',
  'item.chainMore': 'より古い祖先は未読込',
  'item.phase': 'フェーズ',
  'item.conversation': '会話',
  'item.messageIndex': 'メッセージ番号',
  'item.tool': 'ツール',
  'item.excluded': '除外数',
  'item.contentHash': 'コンテンツハッシュ',
  'item.expand': '展開',
  'item.collapse': '折りたたむ',
  'error.invalidInput': 'リクエストパラメータが無効です',
  'error.conflict': 'データが変更されました。再試行してください',
  'error.approvalRequired': '承認が必要です',
  'error.cancelled': 'キャンセル済み',
  'error.storageCorrupt': 'チェックポイントストレージが破損または読取不能です',
  'error.notFound': 'チェックポイントが見つかりません',
  'error.endpointNotFound': 'チェックポイント一覧サービスが接続されていません',
  'error.internal': '予期しないエラーが発生しました',
  'error.unknown': '予期しないエラーが発生しました',
}
