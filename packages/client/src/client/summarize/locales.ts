/**
 * Manual conversation summary — locale fragment.
 *
 * Own namespace (`graycode.summarize`) so the header action can register it
 * independently of the skeleton `graycode` namespace (same pattern as
 * `graycode.subagentBack`).
 */
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary keys of the `graycode.summarize` namespace. */
export type GrayCodeSummarizeLocaleKey =
  | 'actions.summarize'
  | 'actions.summarizing'
  | 'failed'
  | 'title'
  | 'copy'
  | 'copied'
  | 'close'
  | 'empty'
  | 'timeout'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GrayCode manual conversation summary copy. */
    'graycode.summarize': GrayCodeSummarizeLocaleKey
  }
}

/** Locale namespace owned by this fragment. */
export const GRAYCODE_SUMMARIZE_NS = 'graycode.summarize'

/**
 * Balanced zh/en dictionaries for the `graycode.summarize` namespace.
 */
export const graycodeSummarizeDictionaries: Record<LocaleId, LocaleDictOf<'graycode.summarize'>> = {
  zh: {
    'actions.summarize': '总结对话',
    'actions.summarizing': '总结中…',
    failed: '总结失败',
    title: '对话总结',
    copy: '复制',
    copied: '已复制',
    close: '关闭',
    empty: '没有可总结的内容：最近的对话轮次仍保留在窗口中',
    timeout: '总结超时，请重试',
  },
  en: {
    'actions.summarize': 'Summarize',
    'actions.summarizing': 'Summarizing…',
    failed: 'Summarize failed',
    title: 'Conversation summary',
    copy: 'Copy',
    copied: 'Copied',
    close: 'Close',
    empty: 'Nothing to summarize: the recent conversation stays within the keep window',
    timeout: 'Summary timed out, please retry',
  },
}

/** Japanese placeholder dictionary (GAP-1, mirrors every other surface). */
export const graycodeSummarizeJaPlaceholder: LocaleDict = {
  'actions.summarize': '要約する',
  'actions.summarizing': '要約中…',
  failed: '要約に失敗しました',
  title: '会話の要約',
  copy: 'コピー',
  copied: 'コピー済み',
  close: '閉じる',
  empty: '要約する内容がありません：直近の会話は保持ウィンドウ内にあります',
  timeout: '要約がタイムアウトしました。もう一度お試しください',
}
