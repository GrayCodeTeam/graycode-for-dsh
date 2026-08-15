/**
 * Memory management locale fragment (P4-03).
 *
 * Own namespace (`graycode.memoryManage`) so the main session can register it
 * independently of the skeleton `graycode` namespace and of
 * `graycode.workflow` (index.ts/locales.ts are merged by the main session;
 * this file is the typed dictionary source).
 *
 * Key set is aligned with the components (MemoryManagePanel.tsx,
 * MemoryEntryList.tsx, MemoryEditOverlay.tsx, ForgetConfirm.tsx) and with the
 * error-code mapping (logic.ts `MemoryErrorLocaleKey`): every mapped code has
 * an `error.<x>` key.
 */
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary keys of the `graycode.memoryManage` namespace. */
export type GrayCodeMemoryManageLocaleKey =
  | 'title'
  | 'searchPlaceholder'
  | 'scope.global'
  | 'scope.workspace'
  | 'add.placeholder'
  | 'add.button'
  | 'add.busy'
  | 'add.success'
  | 'list.empty'
  | 'list.emptyHint'
  | 'list.total'
  | 'list.end'
  | 'loading'
  | 'loadMore'
  | 'retry'
  | 'degraded'
  | 'replayOnly'
  | 'entry.date'
  | 'entry.source'
  | 'entry.edit'
  | 'entry.forget'
  | 'edit.title'
  | 'edit.required'
  | 'edit.save'
  | 'edit.cancel'
  | 'edit.saveHint'
  | 'edit.unchanged'
  | 'edit.diff.added'
  | 'edit.diff.removed'
  | 'forget.title'
  | 'forget.warning'
  | 'forget.confirm'
  | 'forget.cancel'
  | 'forget.submitting'
  | 'forget.done'
  | 'error.title'
  | 'error.invalidInput'
  | 'error.conflict'
  | 'error.approvalRequired'
  | 'error.cancelled'
  | 'error.storageCorrupt'
  | 'error.notFound'
  | 'error.endpointNotFound'
  | 'error.internal'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GrayCode memory management copy. */
    'graycode.memoryManage': GrayCodeMemoryManageLocaleKey
  }
}

/** Locale namespace owned by this fragment. */
export const GRAYCODE_MEMORY_MANAGE_NS = 'graycode.memoryManage'

/**
 * Balanced zh/en dictionaries for the `graycode.memoryManage` namespace (DSH
 * rc.6 ships exactly `LocaleId = 'zh' | 'en'`; the typed form enforces
 * balance).
 */
export const graycodeMemoryManageDictionaries: Record<LocaleId, LocaleDictOf<'graycode.memoryManage'>> = {
  zh: {
    title: '记忆管理',
    searchPlaceholder: '搜索记忆…',
    'scope.global': '全局',
    'scope.workspace': '工作区',
    'add.placeholder': '写入一条新的记忆…（Ctrl/Cmd + Enter 提交）',
    'add.button': '新增',
    'add.busy': '写入中…',
    'add.success': '记忆已写入',
    'list.empty': '没有匹配的记忆',
    'list.emptyHint': '换个关键词，或切换作用域后再试',
    'list.total': '共',
    'list.end': '没有更多了',
    loading: '加载中…',
    loadMore: '加载更多',
    retry: '重试',
    degraded: '演示数据（host 端点未接线）',
    replayOnly: '回放视图，不可操作',
    'entry.date': '日期',
    'entry.source': '来源',
    'entry.edit': '编辑',
    'entry.forget': '删除',
    'edit.title': '编辑记忆',
    'edit.required': '内容不能为空',
    'edit.save': '保存',
    'edit.cancel': '取消',
    'edit.saveHint': '保存将覆盖原始记忆（保留 id 与日期）',
    'edit.unchanged': '没有更改',
    'edit.diff.added': '新增',
    'edit.diff.removed': '删除',
    'forget.title': '删除记忆',
    'forget.warning': '此操作不可撤销，将永久删除该条记忆。',
    'forget.confirm': '确认删除',
    'forget.cancel': '取消',
    'forget.submitting': '删除中…',
    'forget.done': '已删除 1 条记忆',
    'error.title': '出错了',
    'error.invalidInput': '请求参数无效',
    'error.conflict': '并发冲突，请刷新后重试',
    'error.approvalRequired': '需要二次确认',
    'error.cancelled': '操作已取消',
    'error.storageCorrupt': '记忆存储损坏，无法读写',
    'error.notFound': '条目不存在（可能已被删除）',
    'error.endpointNotFound': 'host 未提供记忆端点，当前为只读演示',
    'error.internal': '内部错误，请重试',
  },
  en: {
    title: 'Memory management',
    searchPlaceholder: 'Search memories…',
    'scope.global': 'Global',
    'scope.workspace': 'Workspace',
    'add.placeholder': 'Write a new memory… (Ctrl/Cmd + Enter to submit)',
    'add.button': 'Add',
    'add.busy': 'Saving…',
    'add.success': 'Memory saved',
    'list.empty': 'No matching memories',
    'list.emptyHint': 'Try a different keyword or switch scope',
    'list.total': 'Total',
    'list.end': 'No more',
    loading: 'Loading…',
    loadMore: 'Load more',
    retry: 'Retry',
    degraded: 'Demo data (host endpoints not wired)',
    replayOnly: 'Not available in replay view',
    'entry.date': 'Date',
    'entry.source': 'Source',
    'entry.edit': 'Edit',
    'entry.forget': 'Forget',
    'edit.title': 'Edit memory',
    'edit.required': 'Content is required',
    'edit.save': 'Save',
    'edit.cancel': 'Cancel',
    'edit.saveHint': 'Saving overwrites the original memory (keeps id and date)',
    'edit.unchanged': 'No changes',
    'edit.diff.added': 'added',
    'edit.diff.removed': 'removed',
    'forget.title': 'Forget memory',
    'forget.warning': 'This cannot be undone — the memory will be permanently deleted.',
    'forget.confirm': 'Confirm forget',
    'forget.cancel': 'Cancel',
    'forget.submitting': 'Forgetting…',
    'forget.done': '1 memory forgotten',
    'error.title': 'Something went wrong',
    'error.invalidInput': 'Invalid request parameters',
    'error.conflict': 'Concurrent change — refresh and retry',
    'error.approvalRequired': 'Confirmation required',
    'error.cancelled': 'Operation cancelled',
    'error.storageCorrupt': 'Memory storage corrupted — cannot read or write',
    'error.notFound': 'Entry not found (may have been deleted)',
    'error.endpointNotFound': 'Memory endpoints unavailable on host — read-only demo',
    'error.internal': 'Internal error, please retry',
  },
}

/**
 * Japanese placeholder dictionary (GAP-1, mirrors the workflowNode fragment):
 * DSH rc.6 has no selectable `ja` locale, so this registers through the
 * untyped single-locale overload and stays inert until DSH ships one. The key
 * set intentionally mirrors the zh/en dictionaries.
 */
export const graycodeMemoryManageJaPlaceholder: LocaleDict = {
  title: 'メモリ管理',
  searchPlaceholder: 'メモリを検索…',
  'scope.global': 'グローバル',
  'scope.workspace': 'ワークスペース',
  'add.placeholder': '新しいメモリを入力…（Ctrl/Cmd + Enter で送信）',
  'add.button': '追加',
  'add.busy': '保存中…',
  'add.success': 'メモリを保存しました',
  'list.empty': '一致するメモリがありません',
  'list.emptyHint': '別のキーワードまたはスコープをお試しください',
  'list.total': '合計',
  'list.end': 'これ以上ありません',
  loading: '読み込み中…',
  loadMore: 'さらに読み込む',
  retry: '再試行',
  degraded: 'デモデータ（ホストエンドポイント未接続）',
  replayOnly: 'リプレイ表示のため操作できません',
  'entry.date': '日付',
  'entry.source': '出所',
  'entry.edit': '編集',
  'entry.forget': '削除',
  'edit.title': 'メモリを編集',
  'edit.required': '内容は必須です',
  'edit.save': '保存',
  'edit.cancel': 'キャンセル',
  'edit.saveHint': '保存すると元のメモリを上書きします（id と日付は保持）',
  'edit.unchanged': '変更なし',
  'edit.diff.added': '追加',
  'edit.diff.removed': '削除',
  'forget.title': 'メモリを削除',
  'forget.warning': 'この操作は元に戻せません。メモリは完全に削除されます。',
  'forget.confirm': '削除を確定',
  'forget.cancel': 'キャンセル',
  'forget.submitting': '削除中…',
  'forget.done': '1 件のメモリを削除しました',
  'error.title': 'エラーが発生しました',
  'error.invalidInput': 'リクエストパラメータが無効です',
  'error.conflict': '競合が発生しました。更新して再試行してください',
  'error.approvalRequired': '確認が必要です',
  'error.cancelled': '操作はキャンセルされました',
  'error.storageCorrupt': 'メモリストレージが破損しています',
  'error.notFound': 'エントリが見つかりません（削除された可能性があります）',
  'error.endpointNotFound': 'ホストにメモリエンドポイントがありません。読み取り専用デモです',
  'error.internal': '内部エラーです。再試行してください',
}
