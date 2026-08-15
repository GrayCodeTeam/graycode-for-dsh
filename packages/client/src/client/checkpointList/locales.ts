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
  | 'config.beforeModelMessage'
  | 'config.beforeModelMessage.description'
  | 'config.afterUserMessageUnavailable'
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
  | 'config.toolsGroup'
  | 'config.toolsGroup.description'
  | 'config.matrix.tool'
  | 'config.matrix.before'
  | 'config.matrix.after'
  | 'config.tools.selectAll'
  | 'config.tools.clear'
  | 'config.tools.reset'
  | 'config.tools.customGroup'
  | 'config.tools.customGroup.description'
  | 'config.tools.customPlaceholder'
  | 'config.tools.add'
  | 'config.tools.remove'
  | 'config.tools.duplicate'
  | 'config.toolGroup.write'
  | 'config.toolGroup.shell'
  | 'config.toolGroup.search'
  | 'config.toolGroup.image'
  | 'config.toolGroup.workflow'
  | 'config.tool.write.description'
  | 'config.tool.edit.description'
  | 'config.tool.str_replace_editor.description'
  | 'config.tool.delete_code.description'
  | 'config.tool.bash.description'
  | 'config.tool.pwsh.description'
  | 'config.tool.grep.description'
  | 'config.tool.glob.description'
  | 'config.tool.crop_image.description'
  | 'config.tool.resize_image.description'
  | 'config.tool.rotate_image.description'
  | 'config.tool.generate_image.description'
  | 'config.tool.remove_background.description'
  | 'config.tool.create_plan.description'
  | 'config.tool.update_plan.description'
  | 'config.tool.create_design.description'
  | 'config.tool.update_design.description'
  | 'config.tool.create_progress.description'
  | 'config.tool.update_progress.description'
  | 'config.tool.record_progress_milestone.description'
  | 'config.tool.create_review.description'
  | 'config.tool.record_review_milestone.description'
  | 'config.tool.finalize_review.description'
  | 'config.tool.reopen_review.description'
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
    'config.messageCheckpoint.description': '选择在哪些消息边界自动创建存档点（默认：用户消息前 + 模型消息前）。',
    'config.beforeUserMessage': '用户消息前',
    'config.beforeUserMessage.description': '新用户回合处理前创建存档点（agent/pre-step）。',
    'config.beforeModelMessage': '模型消息前',
    'config.beforeModelMessage.description': '每次模型调用发起前创建存档点（agent/request；同回合多次调用各存一次，无变更自动去重）。',
    'config.afterModelMessage': '模型消息后',
    'config.afterModelMessage.description': '模型回合关闭后创建存档点（agent/turn-stopping）。',
    'config.afterUserMessageUnavailable': '「用户消息后」在 DSH 宿主没有对应触发点，因此不提供该选项。',
    'config.beforeTools': '执行前存档',
    'config.beforeTools.description': '勾选的工具在调用前自动创建存档点。',
    'config.afterTools': '执行后存档',
    'config.afterTools.description': '勾选的工具在调用后自动创建存档点。',
    'config.toolPlaceholder': '例如 checkpoint_create、checkpoint_restore',
    'config.toolsInvalidChars': '工具名含非法字符',
    'config.toolsTooLong': '工具名过长',
    'config.toolsEmptyLine': '工具名不能为空',
    'config.toolsGroup': '工具触发存档',
    'config.toolsGroup.description': '勾选哪些工具在「执行前 / 执行后」自动创建存档点。默认只勾：执行命令前（bash/pwsh）、删除前（delete_code）、写入后（write）、应用差异后（edit / str_replace_editor）。',
    'config.matrix.tool': '工具',
    'config.matrix.before': '执行前',
    'config.matrix.after': '执行后',
    'config.tools.selectAll': '全选',
    'config.tools.clear': '全不选',
    'config.tools.reset': '恢复默认',
    'config.tools.customGroup': '自定义工具',
    'config.tools.customGroup.description': '列表中不属于已知工具的名称（来自旧配置或手写），仍会正常生效。',
    'config.tools.customPlaceholder': '输入工具名，例如 my_mcp_tool',
    'config.tools.add': '添加',
    'config.tools.remove': '移除',
    'config.tools.duplicate': '该工具已在列表中',
    'config.toolGroup.write': '文件写入',
    'config.toolGroup.shell': '终端执行',
    'config.toolGroup.search': '搜索',
    'config.toolGroup.image': '图像处理',
    'config.toolGroup.workflow': '工作流文档',
    'config.tool.write.description': '写入文件',
    'config.tool.edit.description': '编辑文件（旧版补丁格式）',
    'config.tool.str_replace_editor.description': '精确字符串替换编辑',
    'config.tool.delete_code.description': '删除代码片段',
    'config.tool.bash.description': '执行 Bash 命令',
    'config.tool.pwsh.description': '执行 PowerShell 命令',
    'config.tool.grep.description': '按正则搜索文件内容',
    'config.tool.glob.description': '按模式匹配文件名',
    'config.tool.crop_image.description': '裁剪图片',
    'config.tool.resize_image.description': '缩放图片',
    'config.tool.rotate_image.description': '旋转图片',
    'config.tool.generate_image.description': '生成或编辑图片',
    'config.tool.remove_background.description': '去除图片背景',
    'config.tool.create_plan.description': '创建计划文档',
    'config.tool.update_plan.description': '更新计划文档',
    'config.tool.create_design.description': '创建设计文档',
    'config.tool.update_design.description': '更新设计文档',
    'config.tool.create_progress.description': '创建进度文档',
    'config.tool.update_progress.description': '更新进度文档',
    'config.tool.record_progress_milestone.description': '记录进度里程碑',
    'config.tool.create_review.description': '创建评审文档',
    'config.tool.record_review_milestone.description': '记录评审里程碑',
    'config.tool.finalize_review.description': '完结评审',
    'config.tool.reopen_review.description': '重开评审',
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
    'config.messageCheckpoint.description': 'Choose which message boundaries create checkpoints automatically (default: before user messages + before model calls).',
    'config.beforeUserMessage': 'Before user messages',
    'config.beforeUserMessage.description': 'Checkpoint before each new user turn is processed (agent/pre-step).',
    'config.beforeModelMessage': 'Before model messages',
    'config.beforeModelMessage.description': 'Checkpoint before each model call (agent/request; one per call per turn, unchanged turns are deduped).',
    'config.afterModelMessage': 'After model messages',
    'config.afterModelMessage.description': 'Checkpoint after the model turn closes (agent/turn-stopping).',
    'config.afterUserMessageUnavailable': '“After user message” has no trigger point in the DSH host, so it is not offered.',
    'config.beforeTools': 'Checkpoint before',
    'config.beforeTools.description': 'Checked tools automatically create a checkpoint before they run.',
    'config.afterTools': 'Checkpoint after',
    'config.afterTools.description': 'Checked tools automatically create a checkpoint after they run.',
    'config.toolPlaceholder': 'e.g. checkpoint_create, checkpoint_restore',
    'config.toolsInvalidChars': 'Tool name contains invalid characters',
    'config.toolsTooLong': 'Tool name is too long',
    'config.toolsEmptyLine': 'Tool name cannot be empty',
    'config.toolsGroup': 'Tool-triggered checkpoints',
    'config.toolsGroup.description': 'Pick which tools checkpoint before/after execution. Defaults: before commands (bash/pwsh) and deletes (delete_code); after writes (write) and diffs (edit / str_replace_editor).',
    'config.matrix.tool': 'Tool',
    'config.matrix.before': 'Before',
    'config.matrix.after': 'After',
    'config.tools.selectAll': 'Select all',
    'config.tools.clear': 'Clear all',
    'config.tools.reset': 'Reset to default',
    'config.tools.customGroup': 'Custom tools',
    'config.tools.customGroup.description': 'Names outside the known tool surface (from older configs or hand-written); they still take effect.',
    'config.tools.customPlaceholder': 'Enter a tool name, e.g. my_mcp_tool',
    'config.tools.add': 'Add',
    'config.tools.remove': 'Remove',
    'config.tools.duplicate': 'This tool is already listed',
    'config.toolGroup.write': 'File writes',
    'config.toolGroup.shell': 'Shell execution',
    'config.toolGroup.search': 'Search',
    'config.toolGroup.image': 'Image processing',
    'config.toolGroup.workflow': 'Workflow documents',
    'config.tool.write.description': 'Write files',
    'config.tool.edit.description': 'Edit files (legacy patch format)',
    'config.tool.str_replace_editor.description': 'Exact string-replace editing',
    'config.tool.delete_code.description': 'Delete code snippets',
    'config.tool.bash.description': 'Run Bash commands',
    'config.tool.pwsh.description': 'Run PowerShell commands',
    'config.tool.grep.description': 'Regex content search',
    'config.tool.glob.description': 'File-name pattern matching',
    'config.tool.crop_image.description': 'Crop images',
    'config.tool.resize_image.description': 'Resize images',
    'config.tool.rotate_image.description': 'Rotate images',
    'config.tool.generate_image.description': 'Generate or edit images',
    'config.tool.remove_background.description': 'Remove image backgrounds',
    'config.tool.create_plan.description': 'Create plan documents',
    'config.tool.update_plan.description': 'Update plan documents',
    'config.tool.create_design.description': 'Create design documents',
    'config.tool.update_design.description': 'Update design documents',
    'config.tool.create_progress.description': 'Create progress documents',
    'config.tool.update_progress.description': 'Update progress documents',
    'config.tool.record_progress_milestone.description': 'Record progress milestones',
    'config.tool.create_review.description': 'Create review documents',
    'config.tool.record_review_milestone.description': 'Record review milestones',
    'config.tool.finalize_review.description': 'Finalize reviews',
    'config.tool.reopen_review.description': 'Reopen reviews',
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
  'config.beforeModelMessage': 'モデルメッセージの前',
  'config.beforeModelMessage.description': '各モデル呼び出しの前にチェックポイントを作成します（agent/request。同一ターンで複数回の都度作成、変更なしは自動的に重複排除）。',
  'config.afterUserMessageUnavailable': '「ユーザーメッセージの後」は DSH ホストに対応するトリガーが存在しないため、このオプションはありません。',
  'config.beforeTools': 'ツール呼び出しの前',
  'config.beforeTools.description': '1行に1つのツール名。これらのツール呼び出しの前にチェックポイントを作成します。',
  'config.afterTools': 'ツール呼び出しの後',
  'config.afterTools.description': '1行に1つのツール名。これらのツール呼び出しの後にチェックポイントを作成します。',
  'config.toolPlaceholder': '例: checkpoint_create、checkpoint_restore',
  'config.toolsInvalidChars': 'ツール名に不正な文字が含まれています',
  'config.toolsTooLong': 'ツール名が長すぎます',
  'config.toolsEmptyLine': 'ツール名を空にできません',
  'config.toolsGroup': 'ツール起点チェックポイント',
  'config.toolsGroup.description': 'どのツールの実行前/後にチェックポイントを作成するかを選択します。リセットで全既知ツールをオンに戻します。',
  'config.matrix.tool': 'ツール',
  'config.matrix.before': '実行前',
  'config.matrix.after': '実行後',
  'config.tools.selectAll': 'すべて選択',
  'config.tools.clear': 'すべて解除',
  'config.tools.reset': 'デフォルトに戻す',
  'config.tools.customGroup': 'カスタムツール',
  'config.tools.customGroup.description': '既知ツール以外の名前（旧設定や手入力）。引き続き有効です。',
  'config.tools.customPlaceholder': 'ツール名を入力、例: my_mcp_tool',
  'config.tools.add': '追加',
  'config.tools.remove': '削除',
  'config.tools.duplicate': 'このツールは既に登録されています',
  'config.toolGroup.write': 'ファイル書き込み',
  'config.toolGroup.shell': 'シェル実行',
  'config.toolGroup.search': '検索',
  'config.toolGroup.image': '画像処理',
  'config.toolGroup.workflow': 'ワークフロードキュメント',
  'config.tool.write.description': 'ファイルを書き込む',
  'config.tool.edit.description': 'ファイルを編集（旧パッチ形式）',
  'config.tool.str_replace_editor.description': '正確な文字列置換編集',
  'config.tool.delete_code.description': 'コード断片を削除',
  'config.tool.bash.description': 'Bash コマンドを実行',
  'config.tool.pwsh.description': 'PowerShell コマンドを実行',
  'config.tool.grep.description': '正規表現でファイル内容を検索',
  'config.tool.glob.description': 'ファイル名パターン照合',
  'config.tool.crop_image.description': '画像を切り抜き',
  'config.tool.resize_image.description': '画像をリサイズ',
  'config.tool.rotate_image.description': '画像を回転',
  'config.tool.generate_image.description': '画像を生成・編集',
  'config.tool.remove_background.description': '画像の背景を削除',
  'config.tool.create_plan.description': '計画ドキュメントを作成',
  'config.tool.update_plan.description': '計画ドキュメントを更新',
  'config.tool.create_design.description': '設計ドキュメントを作成',
  'config.tool.update_design.description': '設計ドキュメントを更新',
  'config.tool.create_progress.description': '進捗ドキュメントを作成',
  'config.tool.update_progress.description': '進捗ドキュメントを更新',
  'config.tool.record_progress_milestone.description': '進捗マイルストーンを記録',
  'config.tool.create_review.description': 'レビュードキュメントを作成',
  'config.tool.record_review_milestone.description': 'レビューマイルストーンを記録',
  'config.tool.finalize_review.description': 'レビューを確定',
  'config.tool.reopen_review.description': 'レビューを再開',
  'config.localOnly': '設定チャンネルに接続されていません。変更はローカルのみに保存されます',
  'config.saveError': '保存に失敗しました',
}
