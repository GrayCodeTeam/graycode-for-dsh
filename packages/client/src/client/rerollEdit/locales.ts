/**
 * Reroll / edit-turn (F1/F2) — locale fragment.
 *
 * Own namespace (`graycode.rerollEdit`) shared by the regenerate assistant
 * action and the edit-user-message turn-tail action.
 */
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary keys of the `graycode.rerollEdit` namespace. */
export type GrayCodeRerollEditLocaleKey =
  | 'reroll.label'
  | 'reroll.working'
  | 'reroll.failed'
  | 'edit.label'
  | 'edit.title'
  | 'edit.confirm'
  | 'edit.cancel'
  | 'edit.required'
  | 'edit.saving'
  | 'edit.failed'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GrayCode regenerate / edit-turn action copy. */
    'graycode.rerollEdit': GrayCodeRerollEditLocaleKey
  }
}

/** Locale namespace owned by this fragment. */
export const GRAYCODE_REROLL_NS = 'graycode.rerollEdit'

/**
 * Balanced zh/en dictionaries for the `graycode.rerollEdit` namespace.
 */
export const graycodeRerollEditDictionaries: Record<LocaleId, LocaleDictOf<'graycode.rerollEdit'>> = {
  zh: {
    'reroll.label': '重新生成',
    'reroll.working': '重新生成中…',
    'reroll.failed': '重新生成失败',
    'edit.label': '编辑',
    'edit.title': '编辑用户消息',
    'edit.confirm': '确认',
    'edit.cancel': '取消',
    'edit.required': '消息内容不能为空',
    'edit.saving': '提交中…',
    'edit.failed': '编辑失败',
  },
  en: {
    'reroll.label': 'Regenerate',
    'reroll.working': 'Regenerating…',
    'reroll.failed': 'Regeneration failed',
    'edit.label': 'Edit',
    'edit.title': 'Edit user message',
    'edit.confirm': 'Confirm',
    'edit.cancel': 'Cancel',
    'edit.required': 'Message text is required',
    'edit.saving': 'Submitting…',
    'edit.failed': 'Edit failed',
  },
}

/** Japanese placeholder dictionary (GAP-1, mirrors every other surface). */
export const graycodeRerollEditJaPlaceholder: LocaleDict = {
  'reroll.label': '再生成',
  'reroll.working': '再生成中…',
  'reroll.failed': '再生成に失敗しました',
  'edit.label': '編集',
  'edit.title': 'ユーザーメッセージを編集',
  'edit.confirm': '確定',
  'edit.cancel': 'キャンセル',
  'edit.required': 'メッセージ内容を入力してください',
  'edit.saving': '送信中…',
  'edit.failed': '編集に失敗しました',
}
