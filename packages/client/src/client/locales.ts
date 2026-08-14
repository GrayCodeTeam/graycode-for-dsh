import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary keys of the `graycode` locale namespace (merged into LocaleNamespaceMap). */
export type GrayCodeLocaleKey = 'loaded' | 'description'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GrayCode client copy. */
    graycode: GrayCodeLocaleKey
  }
}

/** Locale namespace owned by this package. */
export const GRAYCODE_NS = 'graycode'

/**
 * Balanced zh/en dictionaries for the `graycode` namespace.
 *
 * DSH rc.6 ships exactly two selectable locales (`LocaleId = 'zh' | 'en'`,
 * see `LOCALE_IDS` in @deepseek-ai/dsh-client-locale), and the typed
 * registration form enforces balance: every shipped locale must be present.
 */
export const graycodeDictionaries: Record<LocaleId, LocaleDictOf<'graycode'>> = {
  zh: {
    loaded: 'Gray Code 已加载',
    description: 'Gray Code 客户端插件已注册到 DeepSeek Harness',
  },
  en: {
    loaded: 'Gray Code loaded',
    description: 'Gray Code client plugin registered with DeepSeek Harness',
  },
}

/**
 * Japanese placeholder dictionary.
 *
 * GAP-1: DSH rc.6 has no `ja` in `LocaleId` and no `ja` entry in its
 * language selector (`setLocale` throws for unknown ids), so this registers
 * through the untyped single-locale overload and stays inert until DSH ships
 * a selectable `ja` locale. The key set intentionally mirrors the zh/en
 * dictionaries so the namespace stays balanced for a future upgrade.
 */
export const graycodeJaPlaceholder: LocaleDict = {
  loaded: 'Gray Code 読み込み完了',
  description: 'Gray Code クライアントプラグインが DeepSeek Harness に登録されました',
}
