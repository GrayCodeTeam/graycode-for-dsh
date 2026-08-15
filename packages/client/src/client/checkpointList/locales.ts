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
  | 'origin.auto'
  | 'origin.manual'
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
    'origin.auto': '自动',
    'origin.manual': '手动',
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
    'origin.auto': 'Auto',
    'origin.manual': 'Manual',
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
  'origin.auto': '自動',
  'origin.manual': '手動',
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

// ==================== checkpoint config namespace ====================
//
// Copy for the checkpoint configuration section (P4-06). It lives in this
// fragment (not in `settings.graycode`, which the settings half owns) so the
// settings page can bind it independently; CheckpointManager falls back to the
// zh dictionary when the main session has not injected a bound seat yet.

/** Dictionary keys of the `graycode.checkpointConfig` namespace. */
export type GrayCodeCheckpointConfigLocaleKey =
  | 'config.title'
  | 'config.description'
  | 'config.enabled'
  | 'config.enabled.description'
  | 'config.autoCheckpoint'
  | 'config.autoCheckpoint.description'
  | 'config.modelToolsEnabled'
  | 'config.modelToolsEnabled.description'
  | 'config.messageCheckpoint'
  | 'config.messageCheckpoint.description'
  | 'config.beforeUserMessage'
  | 'config.beforeUserMessage.description'
  | 'config.afterModelMessage'
  | 'config.afterModelMessage.description'
  | 'config.beforeTools'
  | 'config.beforeTools.description'
  | 'config.afterTools'
  | 'config.afterTools.description'
  | 'config.toolPlaceholder'
  | 'config.toolsInvalidChars'
  | 'config.toolsTooLong'
  | 'config.toolsEmptyLine'
  | 'config.localOnly'
  | 'config.saveError'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GrayCode checkpoint config copy. */
    'graycode.checkpointConfig': GrayCodeCheckpointConfigLocaleKey
  }
}

/** Locale namespace owned by the checkpoint config section. */
export const GRAYCODE_CHECKPOINT_CONFIG_NS = 'graycode.checkpointConfig'

/** Balanced zh/en dictionaries for the `graycode.checkpointConfig` namespace. */
export const graycodeCheckpointConfigDictionaries: Record<LocaleId, LocaleDictOf<'graycode.checkpointConfig'>> = {
  zh: {
    'config.title': '存档设置',
    'config.description': '自动存档与模型工具行为配置。',
    'config.enabled': '启用存档点',
    'config.enabled.description': '总开关；关闭后不再创建任何存档点。',
    'config.autoCheckpoint': '自动存档',
    'config.autoCheckpoint.description': '在消息与工具触发点上自动创建存档点。',
    'config.modelToolsEnabled': '模型工具开关',
    'config.modelToolsEnabled.description': '关闭后模型无法调用 checkpoint_create 等 7 个存档工具；自动存档不受影响。',
    'config.messageCheckpoint': '消息触发存档',
    'config.messageCheckpoint.description': '选择在哪些消息位置自动创建存档点。',
    'config.beforeUserMessage': '用户消息前存档',
    'config.beforeUserMessage.description': '开 = beforeMessages 包含 user；用户消息前创建存档点。',
    'config.afterModelMessage': '模型回复后存档',
    'config.afterModelMessage.description': '开 = afterMessages 包含 model；模型回复后创建存档点。',
    'config.beforeTools': '工具调用前存档',
    'config.beforeTools.description': '每行一个工具名；这些工具调用前创建存档点。',
    'config.afterTools': '工具调用后存档',
    'config.afterTools.description': '每行一个工具名；这些工具调用后创建存档点。',
    'config.toolPlaceholder': '例如 checkpoint_create、checkpoint_restore',
    'config.toolsInvalidChars': '工具名含非法字符',
    'config.toolsTooLong': '工具名过长',
    'config.toolsEmptyLine': '工具名不能为空',
    'config.localOnly': '未连接配置通道，更改仅保存在本地',
    'config.saveError': '保存失败',
  },
  en: {
    'config.title': 'Checkpoint settings',
    'config.description': 'Behaviour of automatic checkpoints and model tools.',
    'config.enabled': 'Enable checkpoints',
    'config.enabled.description': 'Master switch; no checkpoints are created while off.',
    'config.autoCheckpoint': 'Auto checkpoint',
    'config.autoCheckpoint.description': 'Automatically create checkpoints at message and tool trigger points.',
    'config.modelToolsEnabled': 'Model tools',
    'config.modelToolsEnabled.description': 'While off, the model cannot call the 7 checkpoint tools (e.g. checkpoint_create); auto checkpointing is unaffected.',
    'config.messageCheckpoint': 'Message-triggered checkpoints',
    'config.messageCheckpoint.description': 'Choose which message positions create checkpoints automatically.',
    'config.beforeUserMessage': 'Before user messages',
    'config.beforeUserMessage.description': 'On = beforeMessages includes user; checkpoint before each user message.',
    'config.afterModelMessage': 'After model replies',
    'config.afterModelMessage.description': 'On = afterMessages includes model; checkpoint after each model reply.',
    'config.beforeTools': 'Before tool calls',
    'config.beforeTools.description': 'One tool name per line; checkpoints are created before these tool calls.',
    'config.afterTools': 'After tool calls',
    'config.afterTools.description': 'One tool name per line; checkpoints are created after these tool calls.',
    'config.toolPlaceholder': 'e.g. checkpoint_create, checkpoint_restore',
    'config.toolsInvalidChars': 'Tool name contains invalid characters',
    'config.toolsTooLong': 'Tool name is too long',
    'config.toolsEmptyLine': 'Tool name cannot be empty',
    'config.localOnly': 'Not connected to the config channel; changes stay local',
    'config.saveError': 'Save failed',
  },
}

/**
 * Japanese placeholder dictionary (GAP-1, mirrors the checkpointList fragment).
 * Inert until DSH ships a selectable `ja` locale.
 */
export const graycodeCheckpointConfigJaPlaceholder: LocaleDict = {
  'config.title': 'チェックポイント設定',
  'config.description': '自動チェックポイントとモデルツールの動作設定。',
  'config.enabled': 'チェックポイントを有効化',
  'config.enabled.description': 'マスタースイッチ。オフの間はチェックポイントは作成されません。',
  'config.autoCheckpoint': '自動チェックポイント',
  'config.autoCheckpoint.description': 'メッセージ・ツールのトリガー地点で自動的にチェックポイントを作成します。',
  'config.modelToolsEnabled': 'モデルツール',
  'config.modelToolsEnabled.description': 'オフの間、モデルは checkpoint_create など 7 つのチェックポイントツールを呼び出せません。自動チェックポイントには影響しません。',
  'config.messageCheckpoint': 'メッセージ起点チェックポイント',
  'config.messageCheckpoint.description': 'チェックポイントを自動作成するメッセージ位置を選択します。',
  'config.beforeUserMessage': 'ユーザーメッセージの前',
  'config.beforeUserMessage.description': 'オン = beforeMessages に user を含む。各ユーザーメッセージの前にチェックポイントを作成します。',
  'config.afterModelMessage': 'モデル応答の後',
  'config.afterModelMessage.description': 'オン = afterMessages に model を含む。各モデル応答の後にチェックポイントを作成します。',
  'config.beforeTools': 'ツール呼び出しの前',
  'config.beforeTools.description': '1行に1つのツール名。これらのツール呼び出しの前にチェックポイントを作成します。',
  'config.afterTools': 'ツール呼び出しの後',
  'config.afterTools.description': '1行に1つのツール名。これらのツール呼び出しの後にチェックポイントを作成します。',
  'config.toolPlaceholder': '例: checkpoint_create、checkpoint_restore',
  'config.toolsInvalidChars': 'ツール名に不正な文字が含まれています',
  'config.toolsTooLong': 'ツール名が長すぎます',
  'config.toolsEmptyLine': 'ツール名を空にできません',
  'config.localOnly': '設定チャンネルに接続されていません。変更はローカルのみに保存されます',
  'config.saveError': '保存に失敗しました',
}
