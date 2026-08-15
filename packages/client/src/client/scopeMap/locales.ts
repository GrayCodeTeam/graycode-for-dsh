/**
 * Migration workspace memory mapping (D-1/D-2) — locale fragment.
 *
 * Own namespace (`graycode.scopeMap`) so the main session can register it
 * independently of the skeleton `graycode` namespace and other surfaces.
 *
 * Key set is aligned with the components and the pure logic:
 * - the panel title, loading / error / replay / empty states and the mock
 *   notice,
 * - table column headers, status labels, target radio options and the
 *   custom-path placeholder,
 * - the export block (title, usage line for the host `scopeOverridesFile`
 *   parameter, no-changes hint),
 * - every error hint has an `error.<x>` key (see errors.ts).
 * The typed `LocaleDictOf` form enforces zh/en balance; the spec file checks
 * the alignment against the logic tables at runtime.
 */
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary keys of the `graycode.scopeMap` namespace. */
export type GrayCodeScopeMapLocaleKey =
  | 'title'
  | 'state.loading'
  | 'state.error'
  | 'state.errorRetry'
  | 'state.replayOnly'
  | 'state.empty'
  | 'state.mock'
  | 'column.hashDir'
  | 'column.source'
  | 'column.status'
  | 'column.target'
  | 'status.auto'
  | 'status.unmapped'
  | 'target.default'
  | 'target.global'
  | 'target.custom'
  | 'target.noSuggestion'
  | 'custom.placeholder'
  | 'export.title'
  | 'export.usage'
  | 'export.none'
  | 'error.invalidInput'
  | 'error.conflict'
  | 'error.approvalRequired'
  | 'error.cancelled'
  | 'error.storageCorrupt'
  | 'error.notFound'
  | 'error.endpointNotFound'
  | 'error.internal'
  | 'error.unknown'
  | 'error.sourceDirMissing'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GrayCode migration workspace memory mapping copy. */
    'graycode.scopeMap': GrayCodeScopeMapLocaleKey
  }
}

/** Locale namespace owned by this fragment. */
export const GRAYCODE_SCOPE_MAP_NS = 'graycode.scopeMap'

/**
 * Balanced zh/en dictionaries for the `graycode.scopeMap` namespace
 * (DSH rc.6 ships exactly `LocaleId = 'zh' | 'en'`; the typed form enforces
 * balance).
 */
export const graycodeScopeMapDictionaries: Record<LocaleId, LocaleDictOf<'graycode.scopeMap'>> = {
  zh: {
    title: '迁移工作区记忆映射',
    'state.loading': '正在加载…',
    'state.error': '加载失败',
    'state.errorRetry': '重试',
    'state.replayOnly': '回放视图，此面板不可用',
    'state.empty': '无工作区记忆',
    'state.mock': '使用内置示例数据',
    'column.hashDir': '哈希目录',
    'column.source': '来源',
    'column.status': '状态',
    'column.target': '目标',
    'status.auto': '可自动映射',
    'status.unmapped': '未映射',
    'target.default': '默认建议',
    'target.global': '全局记忆',
    'target.custom': '自定义路径',
    'target.noSuggestion': '无建议',
    'custom.placeholder': '输入绝对路径…',
    'export.title': '导出 overrides JSON',
    'export.usage': '将上方 JSON 保存为文件，并在 migration_apply 的 scopeOverridesFile 参数中引用它。',
    'export.none': '没有手动修改的行，无需导出',
    'error.invalidInput': '输入无效',
    'error.conflict': '状态冲突',
    'error.approvalRequired': '需要人工确认',
    'error.cancelled': '已取消',
    'error.storageCorrupt': '存储数据损坏',
    'error.notFound': '未找到该记录',
    'error.endpointNotFound': 'DSH 服务未接入',
    'error.internal': '内部错误',
    'error.unknown': '未知错误',
    'error.sourceDirMissing': '未配置 sourceDir（源目录）',
  },
  en: {
    title: 'Migration workspace memory mapping',
    'state.loading': 'Loading…',
    'state.error': 'Failed to load',
    'state.errorRetry': 'Retry',
    'state.replayOnly': 'Not available in replay view',
    'state.empty': 'No workspace memory',
    'state.mock': 'Using built-in sample data',
    'column.hashDir': 'Hash dir',
    'column.source': 'Source',
    'column.status': 'Status',
    'column.target': 'Target',
    'status.auto': 'Auto-mappable',
    'status.unmapped': 'Unmapped',
    'target.default': 'Suggested (default)',
    'target.global': 'Global memory',
    'target.custom': 'Custom path',
    'target.noSuggestion': 'No suggestion',
    'custom.placeholder': 'Enter absolute path…',
    'export.title': 'Exported overrides JSON',
    'export.usage': 'Save the JSON above to a file and pass it to the scopeOverridesFile parameter of migration_apply.',
    'export.none': 'No manual changes to export',
    'error.invalidInput': 'Invalid input',
    'error.conflict': 'State conflict',
    'error.approvalRequired': 'Approval required',
    'error.cancelled': 'Cancelled',
    'error.storageCorrupt': 'Storage corrupted',
    'error.notFound': 'Not found',
    'error.endpointNotFound': 'DSH service not connected',
    'error.internal': 'Internal error',
    'error.unknown': 'Unknown error',
    'error.sourceDirMissing': 'Missing sourceDir (source directory)',
  },
}

/**
 * Japanese placeholder dictionary (GAP-1, mirrors every other surface): DSH
 * rc.6 has no selectable `ja` locale, so this registers through the untyped
 * single-locale overload and stays inert until DSH ships one. The key set
 * intentionally mirrors the zh/en dictionaries.
 */
export const graycodeScopeMapJaPlaceholder: LocaleDict = {
  title: 'ワークスペースメモリ移行マッピング',
  'state.loading': '読み込み中…',
  'state.error': '読み込みに失敗しました',
  'state.errorRetry': '再試行',
  'state.replayOnly': 'リプレイ表示のためこのパネルは利用できません',
  'state.empty': 'ワークスペースメモリがありません',
  'state.mock': '組み込みサンプルデータを使用中',
  'column.hashDir': 'ハッシュディレクトリ',
  'column.source': 'ソース',
  'column.status': 'ステータス',
  'column.target': 'ターゲット',
  'status.auto': '自動マッピング可能',
  'status.unmapped': '未マッピング',
  'target.default': '推奨（デフォルト）',
  'target.global': 'グローバルメモリ',
  'target.custom': 'カスタムパス',
  'target.noSuggestion': '推奨なし',
  'custom.placeholder': '絶対パスを入力…',
  'export.title': 'overrides JSON をエクスポート',
  'export.usage': '上記の JSON をファイルに保存し、migration_apply の scopeOverridesFile パラメータで参照してください。',
  'export.none': '手動で変更した行はありません',
  'error.invalidInput': '入力が無効です',
  'error.conflict': '状態の競合',
  'error.approvalRequired': '承認が必要です',
  'error.cancelled': 'キャンセル済み',
  'error.storageCorrupt': 'ストレージデータが破損しています',
  'error.notFound': 'レコードが見つかりません',
  'error.endpointNotFound': 'DSH サービスが未接続です',
  'error.internal': '内部エラー',
  'error.unknown': '不明なエラー',
  'error.sourceDirMissing': 'sourceDir（ソースディレクトリ）が設定されていません',
}
