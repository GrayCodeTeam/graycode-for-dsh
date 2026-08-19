/**
 * Workflow node locale fragment (P4-01).
 *
 * Own namespace (`graycode.workflow`) so the main session can register it
 * independently of the skeleton `graycode` namespace (index.ts/locales.ts are
 * merged by the main session; this file is the typed dictionary source).
 *
 * Key set is aligned with the card component (WorkflowNodeCard.tsx) and with
 * the tool registry (tools.ts): every `WorkflowToolStatus` has a
 * `status.<x>` key, every `WorkflowToolName` a `tool.<name>` key, every
 * `WorkflowFamily` a `family.<x>` key.
 */
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary keys of the `graycode.workflow` namespace. */
export type GrayCodeWorkflowLocaleKey =
  | 'status.draft'
  | 'status.active'
  | 'status.completed'
  | 'status.failed'
  | 'status.cancelled'
  | 'family.design'
  | 'family.plan'
  | 'family.progress'
  | 'family.review'
  | 'tool.create_design'
  | 'tool.update_design'
  | 'tool.create_plan'
  | 'tool.update_plan'
  | 'tool.create_progress'
  | 'tool.update_progress'
  | 'tool.record_progress_milestone'
  | 'tool.validate_progress_document'
  | 'tool.create_review'
  | 'tool.record_review_milestone'
  | 'tool.finalize_review'
  | 'tool.reopen_review'
  | 'tool.validate_review_document'
  | 'tool.compare_review_documents'
  | 'path'
  | 'summary'
  | 'calledAt'
  | 'completedAt'
  | 'error'
  | 'retry'
  | 'openDocument'
  | 'replayOnly'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GrayCode workflow node copy. */
    'graycode.workflow': GrayCodeWorkflowLocaleKey
  }
}

/** Locale namespace owned by this fragment. */
export const GRAYCODE_WORKFLOW_NS = 'graycode.workflow'

/**
 * Balanced zh/en dictionaries for the `graycode.workflow` namespace (DSH rc.6
 * ships exactly `LocaleId = 'zh' | 'en'`; the typed form enforces balance).
 */
export const graycodeWorkflowDictionaries: Record<LocaleId, LocaleDictOf<'graycode.workflow'>> = {
  zh: {
    'status.draft': '草稿',
    'status.active': '执行中',
    'status.completed': '已完成',
    'status.failed': '失败',
    'status.cancelled': '已取消',
    'family.design': '设计',
    'family.plan': '计划',
    'family.progress': '进度',
    'family.review': '审查',
    'tool.create_design': '创建设计文档',
    'tool.update_design': '更新设计文档',
    'tool.create_plan': '创建计划文档',
    'tool.update_plan': '更新计划文档',
    'tool.create_progress': '创建进度文档',
    'tool.update_progress': '更新进度文档',
    'tool.record_progress_milestone': '记录进度里程碑',
    'tool.validate_progress_document': '校验进度文档',
    'tool.create_review': '创建审查文档',
    'tool.record_review_milestone': '记录审查里程碑',
    'tool.finalize_review': '定稿审查',
    'tool.reopen_review': '重新打开审查',
    'tool.validate_review_document': '校验审查文档',
    'tool.compare_review_documents': '比较审查文档',
    path: '文档路径',
    summary: '摘要',
    calledAt: '发起时间',
    completedAt: '完成时间',
    error: '错误',
    retry: '重试',
    openDocument: '打开文档',
    replayOnly: '回放视图，不可操作',
  },
  en: {
    'status.draft': 'Draft',
    'status.active': 'Running',
    'status.completed': 'Completed',
    'status.failed': 'Failed',
    'status.cancelled': 'Cancelled',
    'family.design': 'Design',
    'family.plan': 'Plan',
    'family.progress': 'Progress',
    'family.review': 'Review',
    'tool.create_design': 'Create design document',
    'tool.update_design': 'Update design document',
    'tool.create_plan': 'Create plan document',
    'tool.update_plan': 'Update plan document',
    'tool.create_progress': 'Create progress document',
    'tool.update_progress': 'Update progress document',
    'tool.record_progress_milestone': 'Record progress milestone',
    'tool.validate_progress_document': 'Validate progress document',
    'tool.create_review': 'Create review document',
    'tool.record_review_milestone': 'Record review milestone',
    'tool.finalize_review': 'Finalize review',
    'tool.reopen_review': 'Reopen review',
    'tool.validate_review_document': 'Validate review document',
    'tool.compare_review_documents': 'Compare review documents',
    path: 'Document path',
    summary: 'Summary',
    calledAt: 'Called at',
    completedAt: 'Completed at',
    error: 'Error',
    retry: 'Retry',
    openDocument: 'Open document',
    replayOnly: 'Not available in replay view',
  },
}

/**
 * Japanese placeholder dictionary (GAP-1, mirrors the skeleton `graycode`
 * namespace): DSH rc.6 has no selectable `ja` locale, so this registers
 * through the untyped single-locale overload and stays inert until DSH ships
 * one. The key set intentionally mirrors the zh/en dictionaries.
 */
export const graycodeWorkflowJaPlaceholder: LocaleDict = {
  'status.draft': '下書き',
  'status.active': '実行中',
  'status.completed': '完了',
  'status.failed': '失敗',
  'status.cancelled': 'キャンセル済み',
  'family.design': '設計',
  'family.plan': '計画',
  'family.progress': '進捗',
  'family.review': 'レビュー',
  'tool.create_design': '設計ドキュメント作成',
  'tool.update_design': '設計ドキュメント更新',
  'tool.create_plan': '計画ドキュメント作成',
  'tool.update_plan': '計画ドキュメント更新',
  'tool.create_progress': '進捗ドキュメント作成',
  'tool.update_progress': '進捗ドキュメント更新',
  'tool.record_progress_milestone': '進捗マイルストーン記録',
  'tool.validate_progress_document': '進捗ドキュメント検証',
  'tool.create_review': 'レビュードキュメント作成',
  'tool.record_review_milestone': 'レビューマイルストーン記録',
  'tool.finalize_review': 'レビュー確定',
  'tool.reopen_review': 'レビュー再開',
  'tool.validate_review_document': 'レビュードキュメント検証',
  'tool.compare_review_documents': 'レビュードキュメント比較',
  path: 'ドキュメントパス',
  summary: '概要',
  calledAt: '開始時刻',
  completedAt: '完了時刻',
  error: 'エラー',
  retry: '再試行',
  openDocument: 'ドキュメントを開く',
  replayOnly: 'リプレイ表示のため操作できません',
}
