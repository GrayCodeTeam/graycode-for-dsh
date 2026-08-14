/**
 * Restore preview locale fragment (P4-05).
 *
 * Own namespace (`graycode.restorePreview`) so the main session can register
 * it independently of the skeleton `graycode` namespace and the workflow
 * `graycode.workflow` namespace (index.ts/locales.ts are merged by the main
 * session; this file is the typed dictionary source).
 *
 * Key set is aligned with the components (RestorePreviewPanel.tsx /
 * RestorePreviewList.tsx / RestoreProgressView.tsx) and with the error hint
 * table (errors.ts): every `RestorePhase` has a `phase.<x>` key, every
 * `PreviewFileClass` a `class.<x>` key, every failure reason a
 * `failure.<x>` key, every mapped error code an `error.<x>` key.
 */
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary keys of the `graycode.restorePreview` namespace. */
export type GrayCodeRestorePreviewLocaleKey =
  | 'phase.idle'
  | 'phase.preview'
  | 'phase.confirm'
  | 'phase.running'
  | 'phase.done'
  | 'phase.failed'
  | 'class.restore'
  | 'class.delete'
  | 'class.untracked'
  | 'class.unbacked'
  | 'class.conflict'
  | 'failure.missing_in_chain'
  | 'failure.hash_mismatch'
  | 'failure.copy_failed'
  | 'failure.delete_failed'
  | 'failure.missing_backup_dir'
  | 'failure.unbacked'
  | 'error.approvalRequired'
  | 'error.conflict'
  | 'error.cancelled'
  | 'error.notFound'
  | 'error.storageCorrupt'
  | 'error.invalidInput'
  | 'error.endpointNotFound'
  | 'error.internal'
  | 'error.partial'
  | 'error.previewFailed'
  | 'error.malformed'
  | 'error.unknown'
  | 'title'
  | 'checkpointLabel'
  | 'previewButton'
  | 'previewing'
  | 'restoreButton'
  | 'confirmButton'
  | 'confirmCheckbox'
  | 'confirmWarning'
  | 'tokenLabel'
  | 'tokenShow'
  | 'tokenHide'
  | 'tokenPlaceholder'
  | 'tokenHint'
  | 'pasteTokenButton'
  | 'pasteTokenTitle'
  | 'progressLabel'
  | 'processedLabel'
  | 'restoredCountLabel'
  | 'deletedCountLabel'
  | 'skippedCountLabel'
  | 'failedCountLabel'
  | 'failuresTitle'
  | 'doneTitle'
  | 'failedTitle'
  | 'retryButton'
  | 'rePreviewButton'
  | 'resetButton'
  | 'conflictBlockedHint'
  | 'untrackedKeepHint'
  | 'unbackedProtectedHint'
  | 'legacyNote'
  | 'totalLabel'
  | 'moreLabel'
  | 'mockModeHint'
  | 'replayOnly'
  | 'stalePreviewHint'
  | 'emptyPreview'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GrayCode restore preview copy. */
    'graycode.restorePreview': GrayCodeRestorePreviewLocaleKey
  }
}

/** Locale namespace owned by this fragment. */
export const GRAYCODE_RESTORE_PREVIEW_NS = 'graycode.restorePreview'

/**
 * Balanced zh/en dictionaries for the `graycode.restorePreview` namespace
 * (DSH rc.6 ships exactly `LocaleId = 'zh' | 'en'`; the typed form enforces
 * balance).
 */
export const graycodeRestorePreviewDictionaries: Record<LocaleId, LocaleDictOf<'graycode.restorePreview'>> = {
  zh: {
    'phase.idle': '待机',
    'phase.preview': '预览',
    'phase.confirm': '确认',
    'phase.running': '恢复中',
    'phase.done': '完成',
    'phase.failed': '失败',
    'class.restore': '恢复',
    'class.delete': '删除',
    'class.untracked': '未跟踪',
    'class.unbacked': '未备份',
    'class.conflict': '冲突',
    'failure.missing_in_chain': '存档链中缺失',
    'failure.hash_mismatch': '内容哈希不匹配',
    'failure.copy_failed': '复制失败',
    'failure.delete_failed': '删除失败',
    'failure.missing_backup_dir': '备份目录缺失',
    'failure.unbacked': '快照时未备份',
    'error.approvalRequired': '审批 token 缺失或已过期：请重新预览以获取新的 token',
    'error.conflict': '预览后工作区已变化，恢复被拒绝：请重新预览后再恢复',
    'error.cancelled': '恢复已取消',
    'error.notFound': '存档不存在或已被删除',
    'error.storageCorrupt': '存档存储损坏或不可读',
    'error.invalidInput': '参数无效，请检查后重试',
    'error.endpointNotFound': 'host 未提供恢复端点（未接线）。当前为 mock 模式，不会写入任何文件',
    'error.internal': '恢复发生未预期错误，可重试',
    'error.partial': '恢复完成但部分文件失败，详见下方失败清单',
    'error.previewFailed': '恢复预览失败，无法确认恢复',
    'error.malformed': '端点返回无法解析的结果',
    'error.unknown': '未知错误',
    title: '存档恢复',
    checkpointLabel: '存档',
    previewButton: '预览恢复',
    previewing: '正在计算恢复预览…',
    restoreButton: '执行恢复',
    confirmButton: '确认并继续',
    confirmCheckbox: '我了解此操作会覆盖或删除工作区文件，且不可撤销',
    confirmWarning: '二次确认：恢复会立即写入工作区。请核对上方文件清单',
    tokenLabel: '审批 token',
    tokenShow: '显示',
    tokenHide: '隐藏',
    tokenPlaceholder: '粘贴 checkpoint_preview 返回的 previewToken',
    tokenHint: 'token 绑定存档、工作区与预览基线；缺失、过期或错配会被 host 拒绝（GRAY_APPROVAL_REQUIRED / GRAY_CONFLICT）',
    pasteTokenButton: '使用已有 token',
    pasteTokenTitle: '通过 token 确认恢复',
    progressLabel: '恢复进度',
    processedLabel: '已处理',
    restoredCountLabel: '已恢复',
    deletedCountLabel: '已删除',
    skippedCountLabel: '已跳过',
    failedCountLabel: '失败',
    failuresTitle: '逐项失败结果',
    doneTitle: '恢复完成',
    failedTitle: '恢复失败',
    retryButton: '重试恢复',
    rePreviewButton: '重新预览',
    resetButton: '返回',
    conflictBlockedHint: '存在阻塞性冲突，恢复已被禁用：请先处理冲突或重新预览',
    untrackedKeepHint: '这些文件在快照之后创建；未确认删除时默认保留',
    unbackedProtectedHint: '快照时未备份（受保护），恢复不会删除它们',
    legacyNote: '旧版存档：无法给出精确文件清单，以恢复执行结果为准',
    totalLabel: '影响文件',
    moreLabel: '另有 {n} 项',
    mockModeHint: 'mock 模式：host 端点未接线，界面使用本地模拟数据，不会写入任何文件',
    replayOnly: '回放视图，不可操作',
    stalePreviewHint: '预览可能已过期：token 绑定预览时的工作区基线，任何跟踪文件变化都会使其失效',
    emptyPreview: '无可恢复的变更（工作区与目标一致）',
  },
  en: {
    'phase.idle': 'Idle',
    'phase.preview': 'Preview',
    'phase.confirm': 'Confirm',
    'phase.running': 'Restoring',
    'phase.done': 'Done',
    'phase.failed': 'Failed',
    'class.restore': 'Restore',
    'class.delete': 'Delete',
    'class.untracked': 'Untracked',
    'class.unbacked': 'Unbacked',
    'class.conflict': 'Conflict',
    'failure.missing_in_chain': 'Missing in checkpoint chain',
    'failure.hash_mismatch': 'Content hash mismatch',
    'failure.copy_failed': 'Copy failed',
    'failure.delete_failed': 'Delete failed',
    'failure.missing_backup_dir': 'Missing backup directory',
    'failure.unbacked': 'Not backed up at snapshot time',
    'error.approvalRequired': 'Approval token missing or expired — re-run the preview to obtain a fresh token',
    'error.conflict': 'Workspace changed since preview — restore denied. Re-run the preview first',
    'error.cancelled': 'Restore cancelled',
    'error.notFound': 'Checkpoint not found or already deleted',
    'error.storageCorrupt': 'Checkpoint storage corrupt or unreadable',
    'error.invalidInput': 'Invalid parameters — check and retry',
    'error.endpointNotFound': 'Host restore endpoints unavailable (not wired). Running in mock mode — nothing will be written',
    'error.internal': 'Unexpected restore error — retry is allowed',
    'error.partial': 'Restore finished with per-file failures — see the list below',
    'error.previewFailed': 'Restore preview failed — restore cannot be confirmed',
    'error.malformed': 'Endpoint returned an unreadable result',
    'error.unknown': 'Unknown error',
    title: 'Checkpoint restore',
    checkpointLabel: 'Checkpoint',
    previewButton: 'Preview restore',
    previewing: 'Computing restore preview…',
    restoreButton: 'Restore now',
    confirmButton: 'Confirm and continue',
    confirmCheckbox: 'I understand this will overwrite or delete workspace files and cannot be undone',
    confirmWarning: 'Final confirmation: restore writes to the workspace immediately. Review the file list above',
    tokenLabel: 'Approval token',
    tokenShow: 'Show',
    tokenHide: 'Hide',
    tokenPlaceholder: 'Paste the previewToken returned by checkpoint_preview',
    tokenHint: 'The token binds checkpoint, workspace and preview baseline; missing, expired or mismatched tokens are denied by the host (GRAY_APPROVAL_REQUIRED / GRAY_CONFLICT)',
    pasteTokenButton: 'Use an existing token',
    pasteTokenTitle: 'Confirm restore with a token',
    progressLabel: 'Restore progress',
    processedLabel: 'Processed',
    restoredCountLabel: 'Restored',
    deletedCountLabel: 'Deleted',
    skippedCountLabel: 'Skipped',
    failedCountLabel: 'Failed',
    failuresTitle: 'Per-file failures',
    doneTitle: 'Restore complete',
    failedTitle: 'Restore failed',
    retryButton: 'Retry restore',
    rePreviewButton: 'Re-run preview',
    resetButton: 'Back',
    conflictBlockedHint: 'Blocking conflicts detected — restore is disabled. Resolve them or re-run the preview',
    untrackedKeepHint: 'Created after the snapshot; kept unless untracked deletion is confirmed',
    unbackedProtectedHint: 'Not backed up at snapshot time (protected) — never deleted by restore',
    legacyNote: 'Legacy checkpoint: exact file list unavailable — the restore result is authoritative',
    totalLabel: 'Affected files',
    moreLabel: '{n} more',
    mockModeHint: 'Mock mode: host endpoints are not wired; the panel uses local simulated data and writes nothing',
    replayOnly: 'Not available in replay view',
    stalePreviewHint: 'Preview may be stale: the token binds the baseline captured at preview time; any tracked-file change invalidates it',
    emptyPreview: 'Nothing to restore (workspace already matches)',
  },
}

/**
 * Japanese placeholder dictionary (GAP-1, mirrors the workflow node
 * fragment): DSH rc.6 has no selectable `ja` locale, so this registers
 * through the untyped single-locale overload and stays inert until DSH ships
 * one. The key set intentionally mirrors the zh/en dictionaries.
 */
export const graycodeRestorePreviewJaPlaceholder: LocaleDict = {
  'phase.idle': '待機',
  'phase.preview': 'プレビュー',
  'phase.confirm': '確認',
  'phase.running': '復元中',
  'phase.done': '完了',
  'phase.failed': '失敗',
  'class.restore': '復元',
  'class.delete': '削除',
  'class.untracked': '未追跡',
  'class.unbacked': '未バックアップ',
  'class.conflict': '競合',
  'failure.missing_in_chain': 'チェーン内で欠落',
  'failure.hash_mismatch': 'ハッシュ不一致',
  'failure.copy_failed': 'コピー失敗',
  'failure.delete_failed': '削除失敗',
  'failure.missing_backup_dir': 'バックアップディレクトリ欠落',
  'failure.unbacked': 'スナップショット時に未バックアップ',
  'error.approvalRequired': '承認トークンが無いか期限切れです。プレビューを再実行して新しいトークンを取得してください',
  'error.conflict': 'プレビュー後にワークスペースが変更されたため復元が拒否されました。先にプレビューを再実行してください',
  'error.cancelled': '復元はキャンセルされました',
  'error.notFound': 'チェックポイントが見つからないか削除されています',
  'error.storageCorrupt': 'チェックポイントのストレージが破損しているか読み取れません',
  'error.invalidInput': 'パラメータが無効です。確認して再試行してください',
  'error.endpointNotFound': 'ホストの復元エンドポイントが未接続です。現在はモックモードで動作し、ファイルは書き込まれません',
  'error.internal': '予期しない復元エラーです。再試行できます',
  'error.partial': '復元は完了しましたが一部のファイルが失敗しました。以下のリストを確認してください',
  'error.previewFailed': '復元プレビューに失敗したため、復元を確認できません',
  'error.malformed': 'エンドポイントが解析不能な結果を返しました',
  'error.unknown': '不明なエラー',
  title: 'チェックポイント復元',
  checkpointLabel: 'チェックポイント',
  previewButton: '復元をプレビュー',
  previewing: '復元プレビューを計算中…',
  restoreButton: '今すぐ復元',
  confirmButton: '確認して続行',
  confirmCheckbox: 'この操作でワークスペースのファイルが上書きまたは削除され、元に戻せないことを理解しています',
  confirmWarning: '最終確認：復元はすぐにワークスペースへ書き込みます。上のファイルリストを確認してください',
  tokenLabel: '承認トークン',
  tokenShow: '表示',
  tokenHide: '隠す',
  tokenPlaceholder: 'checkpoint_preview が返した previewToken を貼り付け',
  tokenHint: 'トークンはチェックポイント・ワークスペース・プレビュー基準に紐づきます。欠落・期限切れ・不一致はホストに拒否されます（GRAY_APPROVAL_REQUIRED / GRAY_CONFLICT）',
  pasteTokenButton: '既存のトークンを使用',
  pasteTokenTitle: 'トークンで復元を確認',
  progressLabel: '復元の進捗',
  processedLabel: '処理済み',
  restoredCountLabel: '復元済み',
  deletedCountLabel: '削除済み',
  skippedCountLabel: 'スキップ',
  failedCountLabel: '失敗',
  failuresTitle: 'ファイル別の失敗結果',
  doneTitle: '復元完了',
  failedTitle: '復元失敗',
  retryButton: '復元を再試行',
  rePreviewButton: 'プレビューを再実行',
  resetButton: '戻る',
  conflictBlockedHint: 'ブロックする競合があります。復元は無効化されています。競合を解決するかプレビューを再実行してください',
  untrackedKeepHint: 'スナップショット後に作成されたファイルです。削除を確認しない限り保持されます',
  unbackedProtectedHint: 'スナップショット時に未バックアップ（保護）。復元では削除されません',
  legacyNote: '旧バージョンのチェックポイント：正確なファイルリストは得られません。復元結果が正となります',
  totalLabel: '影響ファイル',
  moreLabel: '他 {n} 件',
  mockModeHint: 'モックモード：ホストのエンドポイントが未接続のため、ローカルの模擬データを使用します。ファイルは書き込まれません',
  replayOnly: 'リプレイ表示のため操作できません',
  stalePreviewHint: 'プレビューが古い可能性があります：トークンはプレビュー時の基準に紐づくため、追跡ファイルの変更で無効になります',
  emptyPreview: '復元する変更がありません（ワークスペースは既に一致）',
}
