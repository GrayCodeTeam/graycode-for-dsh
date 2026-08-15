/**
 * Subagent back-to-main action (S1) — locale fragment.
 *
 * Own namespace (`graycode.subagentBack`) so the header action can register
 * it independently of the skeleton `graycode` namespace.
 */
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary keys of the `graycode.subagentBack` namespace. */
export type GrayCodeSubagentBackLocaleKey = 'label'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GrayCode subagent back-to-main action copy. */
    'graycode.subagentBack': GrayCodeSubagentBackLocaleKey
  }
}

/** Locale namespace owned by this fragment. */
export const GRAYCODE_SUBAGENT_BACK_NS = 'graycode.subagentBack'

/**
 * Balanced zh/en dictionaries for the `graycode.subagentBack` namespace.
 */
export const graycodeSubagentBackDictionaries: Record<LocaleId, LocaleDictOf<'graycode.subagentBack'>> = {
  zh: {
    label: '返回主会话',
  },
  en: {
    label: 'Back to main session',
  },
}

/** Japanese placeholder dictionary (GAP-1, mirrors every other surface). */
export const graycodeSubagentBackJaPlaceholder: LocaleDict = {
  label: 'メインセッションに戻る',
}
