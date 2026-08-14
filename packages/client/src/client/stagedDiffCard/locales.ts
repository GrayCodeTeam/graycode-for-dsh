/**
 * Staged-diff card locale fragment (P4-06).
 *
 * Own namespace (`graycode.stagedDiffCard`) so the main session can register
 * it independently of the skeleton `graycode` namespace and the workflow
 * `graycode.workflow` namespace (index.ts/locales.ts are merged by the main
 * session; this file is the typed dictionary source).
 *
 * Key set is aligned with the card components (StagedDiffCard.tsx /
 * StagedDiffBatchList.tsx): every `StagedEntryStatus` has a `status.<x>`
 * key, every `StagedDiffErrorKind` an `error.<x>` key, every
 * `StagedDiffKind` a `summary.<x>` key.
 */
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { StagedDiffErrorKind } from './errors.ts'
import type { StagedStatusBadgeKey } from './status.ts'
import type { StagedDiffKind } from './summary.ts'

/** Dictionary keys of the `graycode.stagedDiffCard` namespace. */
export type GrayCodeStagedDiffCardLocaleKey =
  | StagedStatusBadgeKey
  | `summary.${StagedDiffKind}`
  | 'action.accept'
  | 'action.reject'
  | 'reapplyHint'
  | 'replayOnly'
  | 'empty.title'
  | 'empty.description'
  | 'batch.title'
  | 'batch.pending'
  | 'batch.reviewing'
  | 'updatedAt'
  | `error.${StagedDiffErrorKind}`

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GrayCode staged-diff card copy. */
    'graycode.stagedDiffCard': GrayCodeStagedDiffCardLocaleKey
  }
}

/** Locale namespace owned by this fragment. */
export const GRAYCODE_STAGED_DIFF_CARD_NS = 'graycode.stagedDiffCard'

/**
 * Balanced zh/en dictionaries for the `graycode.stagedDiffCard` namespace
 * (DSH rc.6 ships exactly `LocaleId = 'zh' | 'en'`; the typed form enforces
 * balance).
 */
export const graycodeStagedDiffCardDictionaries: Record<LocaleId, LocaleDictOf<'graycode.stagedDiffCard'>> = {
  zh: {
    'status.pending': '待审',
    'status.reviewing': '审阅中',
    'status.accepted': '已接受',
    'status.rejected': '已拒绝',
    'status.done': '已完成',
    'status.needsReapply': '需重放',
    'summary.create': '新建文件',
    'summary.delete': '删除文件',
    'summary.modify': '修改文件',
    'action.accept': '接受',
    'action.reject': '拒绝',
    reapplyHint: '该条目在崩溃前已被接受但未落盘，请确认后重新接受或拒绝',
    replayOnly: '回放视图，不可操作',
    'empty.title': '暂无待审文件',
    'empty.description': '当前没有待审阅的写入意图。Gray 写工具产生的 staged 条目会出现在这里。',
    'batch.title': '待审阅改动',
    'batch.pending': '待审',
    'batch.reviewing': '审阅中',
    updatedAt: '更新于',
    'error.revisionConflict': '条目已变化（版本冲突），请刷新后重试',
    'error.rejectConflict': '目标文件在暂存后被其他流程修改，请先解决冲突',
    'error.applyFailed': '落盘失败，条目保持已接受状态，可直接重试',
    'error.illegalTransition': '条目状态不允许该操作，请刷新列表',
    'error.conflict': '操作冲突，请刷新后重试',
    'error.notFound': '条目不存在（可能已被移除），请刷新列表',
    'error.endpointNotFound': 'stagedDiff 端点未接线，请检查插件装配',
    'error.approvalRequired': '该操作需要审批',
    'error.cancelled': '操作已取消',
    'error.storageCorrupt': '插件存储不可用',
    'error.invalidInput': '操作参数无效',
    'error.internal': '未预期的错误',
  },
  en: {
    'status.pending': 'Pending',
    'status.reviewing': 'Reviewing',
    'status.accepted': 'Accepted',
    'status.rejected': 'Rejected',
    'status.done': 'Done',
    'status.needsReapply': 'Needs re-apply',
    'summary.create': 'New file',
    'summary.delete': 'Deleted',
    'summary.modify': 'Modified',
    'action.accept': 'Accept',
    'action.reject': 'Reject',
    reapplyHint: 'This entry was accepted before a crash but never written; confirm before re-applying or rejecting',
    replayOnly: 'Not available in replay view',
    'empty.title': 'No staged files',
    'empty.description': 'No write intents are awaiting review. Staged entries produced by Gray write tools appear here.',
    'batch.title': 'Changes awaiting review',
    'batch.pending': 'pending',
    'batch.reviewing': 'reviewing',
    updatedAt: 'Updated at',
    'error.revisionConflict': 'Entry changed (revision conflict); refresh and retry',
    'error.rejectConflict': 'Target file was modified after staging; resolve the conflict first',
    'error.applyFailed': 'Write failed; the entry stays accepted and can be retried',
    'error.illegalTransition': 'The entry state does not allow this action; refresh the list',
    'error.conflict': 'Operation conflict; refresh and retry',
    'error.notFound': 'Entry not found (may have been removed); refresh the list',
    'error.endpointNotFound': 'stagedDiff endpoint is not wired; check the plugin assembly',
    'error.approvalRequired': 'This operation requires approval',
    'error.cancelled': 'Operation cancelled',
    'error.storageCorrupt': 'Plugin storage is unavailable',
    'error.invalidInput': 'Invalid operation parameters',
    'error.internal': 'Unexpected error',
  },
}

/**
 * Japanese placeholder dictionary (GAP-1, mirrors the skeleton `graycode`
 * namespace): DSH rc.6 has no selectable `ja` locale, so this registers
 * through the untyped single-locale overload and stays inert until DSH ships
 * one. The key set intentionally mirrors the zh/en dictionaries.
 */
export const graycodeStagedDiffCardJaPlaceholder: LocaleDict = {
  'status.pending': '未審査',
  'status.reviewing': '審査中',
  'status.accepted': '承認済み',
  'status.rejected': '却下済み',
  'status.done': '完了',
  'status.needsReapply': '再適用が必要',
  'summary.create': '新規ファイル',
  'summary.delete': '削除',
  'summary.modify': '変更',
  'action.accept': '承認',
  'action.reject': '却下',
  reapplyHint: 'このエントリはクラッシュ前に承認済みですが未書き込みです。再適用または却下を確認してください',
  replayOnly: 'リプレイ表示のため操作できません',
  'empty.title': '未審査のファイルはありません',
  'empty.description': '現在、審査待ちの書き込み意図はありません。Gray 書き込みツールが生成した staged エントリがここに表示されます。',
  'batch.title': '審査待ちの変更',
  'batch.pending': '未審査',
  'batch.reviewing': '審査中',
  updatedAt: '更新日時',
  'error.revisionConflict': 'エントリが変更されました（リビジョン競合）。更新して再試行してください',
  'error.rejectConflict': 'ステージング後にターゲットファイルが変更されました。先に競合を解決してください',
  'error.applyFailed': '書き込みに失敗しました。エントリは承認済みのままなので再試行できます',
  'error.illegalTransition': 'エントリの状態ではこの操作はできません。リストを更新してください',
  'error.conflict': '操作が競合しました。更新して再試行してください',
  'error.notFound': 'エントリが見つかりません（削除された可能性があります）。リストを更新してください',
  'error.endpointNotFound': 'stagedDiff エンドポイントが接続されていません。プラグインの構成を確認してください',
  'error.approvalRequired': 'この操作には承認が必要です',
  'error.cancelled': '操作がキャンセルされました',
  'error.storageCorrupt': 'プラグインのストレージを利用できません',
  'error.invalidInput': '操作パラメータが無効です',
  'error.internal': '予期しないエラーが発生しました',
}
