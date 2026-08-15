/**
 * Gray settings manifest (P4-07) — the client-side config item catalogue.
 *
 * Model mirrors PLAN_V2 §5.5's classification, projected onto the DSH rc.6
 * settings surface:
 *
 * | §5.5 class            | DSH home              | Here                     |
 * | ---                   | ---                   | ---                      |
 * | 部署/组合参数          | bundle/profile patch  | `deployment` section     |
 * |                        | (cordis.yml)          | (read-only rows)         |
 * | 用户偏好               | `ctx.settings` ns     | `preferences` section    |
 * | 敏感值                 | credentials refs      | `secrets` section        |
 * | 会话瞬态值             | session events        | out of scope (P4-01..06) |
 *
 * This catalogue is the STATIC fallback the surface works from when no host
 * data is wired: it carries names, kinds, defaults, and the client-side
 * validation rules (see validate.ts). It is NOT a wire source of truth — the
 * host schema (Schemastery/`settings.describe`) is authoritative; the client
 * catalogue only renders and hints.
 */
import type { GraySettingsSectionKey, GraySettingsValue } from './types.ts'

/** Common fields of every catalogue item. */
interface GraySettingsItemBase {
  /** Stable key (dot path into the Gray settings section, e.g. `memory.autoRecall`). */
  readonly key: string
  /** §5.5 classification → which section card renders this item. */
  readonly section: GraySettingsSectionKey
  /** Locale key for the display label (`label.<key>`). */
  readonly labelKey: string
  /** Locale key for the description (`desc.<key>`). */
  readonly descriptionKey: string
  /**
   * Deployment/composition params are managed by the bundle profile
   * (cordis.yml) and shown read-only; only `preferences` items are editable.
   */
  readonly managedBy?: 'cordis.yml'
}

/** Boolean preference → switch row. */
export interface GrayBooleanItem extends GraySettingsItemBase {
  readonly kind: 'boolean'
  readonly default?: boolean
}

/** String preference → text input row. */
export interface GrayStringItem extends GraySettingsItemBase {
  readonly kind: 'string'
  readonly default?: string
  /** Client-side hint: non-empty after trim (host remains authoritative). */
  readonly required?: boolean
  readonly maxLength?: number
  /** Client-side hint: must be a safe relative path (no absolute, no `..`). */
  readonly pathLike?: boolean
}

/** Number preference → numeric input row. */
export interface GrayNumberItem extends GraySettingsItemBase {
  readonly kind: 'number'
  readonly default?: number
  /** Inclusive bounds for client-side range hints. */
  readonly min?: number
  readonly max?: number
}

/** Select preference → dropdown row (deployment section, read-only today). */
export interface GraySelectItem extends GraySettingsItemBase {
  readonly kind: 'select'
  readonly options: readonly string[]
  readonly default?: string
}

/**
 * Sensitive value → credential-reference row. The item's VALUE is a DSH
 * credentials reference name (`credentialRef`), never a secret plaintext; the
 * row renders reference + configured state only (see secrets.ts).
 */
export interface GraySecretItem extends GraySettingsItemBase {
  readonly kind: 'secret'
  /** DSH credentials reference (e.g. `deepseek.apiKey`); never a value. */
  readonly credentialRef: string
}

/** One catalogue item (discriminated union on `kind`). */
export type GraySettingsItem =
  | GrayBooleanItem
  | GrayStringItem
  | GrayNumberItem
  | GraySelectItem
  | GraySecretItem

/** The static Gray settings manifest (see module doc for provenance). */
export const GRAY_SETTINGS_ITEMS: readonly GraySettingsItem[] = [
  // ---- preferences (user preferences, `ctx.settings` namespace) ----
  {
    key: 'memory.autoRecall',
    section: 'preferences',
    kind: 'boolean',
    default: true,
    labelKey: 'label.memory.autoRecall',
    descriptionKey: 'desc.memory.autoRecall',
  },
  {
    key: 'memory.maxPromptTokens',
    section: 'preferences',
    kind: 'number',
    default: 16000,
    min: 0,
    max: 131072,
    labelKey: 'label.memory.maxPromptTokens',
    descriptionKey: 'desc.memory.maxPromptTokens',
  },
  {
    key: 'workflows.documentRoot',
    section: 'preferences',
    kind: 'string',
    default: '.graycode',
    required: true,
    pathLike: true,
    labelKey: 'label.workflows.documentRoot',
    descriptionKey: 'desc.workflows.documentRoot',
  },
  {
    key: 'checkpoints.retentionDays',
    section: 'preferences',
    kind: 'number',
    default: 30,
    min: 1,
    max: 3650,
    labelKey: 'label.checkpoints.retentionDays',
    descriptionKey: 'desc.checkpoints.retentionDays',
  },
  // ---- deployment (deployment/composition params, cordis.yml, read-only) ----
  {
    key: 'graycode.enabled',
    section: 'deployment',
    kind: 'boolean',
    managedBy: 'cordis.yml',
    labelKey: 'label.graycode.enabled',
    descriptionKey: 'desc.graycode.enabled',
  },
  {
    key: 'providers.primary',
    section: 'deployment',
    kind: 'select',
    managedBy: 'cordis.yml',
    // Route keys mirror the plugin provider matrix (docs/PROVIDER_MATRIX.md):
    // `deepseek-official` is the registered DeepSeek provider (not `deepseek`,
    // which is only the pi-ai catalog name) and Gemini registers as `google`.
    options: ['deepseek-official', 'anthropic', 'openai', 'google'],
    labelKey: 'label.providers.primary',
    descriptionKey: 'desc.providers.primary',
  },
  // ---- secrets (sensitive values → credentials references) ----
  {
    key: 'credentials.deepseekApiKey',
    section: 'secrets',
    kind: 'secret',
    credentialRef: 'deepseek.apiKey',
    labelKey: 'label.credentials.deepseekApiKey',
    descriptionKey: 'desc.credentials.deepseekApiKey',
  },
  {
    key: 'credentials.privateServiceToken',
    section: 'secrets',
    kind: 'secret',
    credentialRef: 'graycode.privateServiceToken',
    labelKey: 'label.credentials.privateServiceToken',
    descriptionKey: 'desc.credentials.privateServiceToken',
  },
] as const

/** Fixed section render order. */
export const GRAY_SETTINGS_SECTION_ORDER: readonly GraySettingsSectionKey[] = [
  'preferences',
  'deployment',
  'secrets',
]

/** O(1) key lookup table over the manifest. */
const GRAY_SETTINGS_INDEX: Readonly<Record<string, GraySettingsItem>> = Object.fromEntries(
  GRAY_SETTINGS_ITEMS.map((item) => [item.key, item]),
)

/** Look up a catalogue item by its stable key. */
export function graySettingsItem(key: string): GraySettingsItem | undefined {
  return GRAY_SETTINGS_INDEX[key]
}

/** Items of one section, in manifest order. */
export function graySettingsItemsOf(section: GraySettingsSectionKey): readonly GraySettingsItem[] {
  return GRAY_SETTINGS_ITEMS.filter((item) => item.section === section)
}

/** Narrow a catalogue item to a secret item (type guard over the union). */
export function isSecretItem(item: GraySettingsItem): item is GraySecretItem {
  return item.kind === 'secret'
}

/** Default value of a non-secret item (undefined when none declared). */
export function graySettingsDefaultValue(item: GraySettingsItem): GraySettingsValue | undefined {
  return item.kind === 'secret' ? undefined : item.default
}
