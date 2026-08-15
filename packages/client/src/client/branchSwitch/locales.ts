/**
 * 分支候选切换器 — locale 片段。
 *
 * 独立命名空间（`graycode.branchSwitch`），被 turnTail 轮级切换器与
 * 会话头部切换器共用；文案对齐参考项目 BranchSwitcherBar 的
 * components.message.branch.*（zh-CN / en 词典）。
 */
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary keys of the `graycode.branchSwitch` namespace. */
export type GrayCodeBranchSwitchLocaleKey =
  | 'branch.previous'
  | 'branch.next'
  | 'branch.position'
  | 'branch.active'
  | 'branch.root'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GrayCode 分支候选切换器文案。 */
    'graycode.branchSwitch': GrayCodeBranchSwitchLocaleKey
  }
}

/** Locale namespace owned by this fragment. */
export const GRAYCODE_BRANCH_NS = 'graycode.branchSwitch'

/** Balanced zh/en dictionaries for the `graycode.branchSwitch` namespace. */
export const graycodeBranchSwitchDictionaries: Record<LocaleId, LocaleDictOf<'graycode.branchSwitch'>> = {
  zh: {
    'branch.previous': '上一个候选',
    'branch.next': '下一个候选',
    'branch.position': '候选分支 {index} / {total}',
    'branch.active': '当前',
    'branch.root': '主线',
  },
  en: {
    'branch.previous': 'Previous candidate',
    'branch.next': 'Next candidate',
    'branch.position': 'Branch candidate {index} / {total}',
    'branch.active': 'Active',
    'branch.root': 'Main',
  },
}

/** Japanese placeholder dictionary (GAP-1, mirrors every other surface). */
export const graycodeBranchSwitchJaPlaceholder: LocaleDict = {
  'branch.previous': '前の候補',
  'branch.next': '次の候補',
  'branch.position': '候補ブランチ {index} / {total}',
  'branch.active': '現在',
  'branch.root': 'メイン',
}
