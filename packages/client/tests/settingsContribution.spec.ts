/**
 * P4-07 settings contribution — pure-logic tests.
 *
 * Covers: the static catalogue (shape/uniqueness/helpers), the validator
 * (value → error key, client-hint semantics), the sensitive-value display
 * strategy (value-free states, redaction no-leak), the provider/surface
 * status mappings, and locale/catalogue key alignment (zh/en balance + ja
 * mirror + every catalogue key exists in the dictionaries).
 *
 * React is intentionally not imported: these are node-environment tests of
 * the pure logic (the components are not rendered here).
 */
import { describe, expect, it } from 'vitest'
import {
  GRAY_SETTINGS_ITEMS,
  GRAY_SETTINGS_SECTION_ORDER,
  graySettingsDefaultValue,
  graySettingsItem,
  graySettingsItemsOf,
  isSecretItem,
} from '../src/client/settingsContribution/catalog.ts'
import type { GrayNumberItem, GrayStringItem } from '../src/client/settingsContribution/catalog.ts'
import { validateGrayItemKey, validateGrayValue } from '../src/client/settingsContribution/validate.ts'
import {
  SECRET_PLACEHOLDER,
  describeSecretDisplay,
  isSecretConfigured,
  redactSecret,
} from '../src/client/settingsContribution/secrets.ts'
import {
  grayProviderHintKey,
  grayProviderStatus,
  graySurfaceHint,
} from '../src/client/settingsContribution/status.ts'
import {
  GRAYCODE_SETTINGS_CONTRIBUTION_NS,
  graycodeSettingsContributionDictionaries,
  graycodeSettingsContributionJaPlaceholder,
} from '../src/client/settingsContribution/locales.ts'
import type { CredentialViewLike, SettingsSnapshotLike } from '../src/client/settingsContribution/types.ts'

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

describe('catalogue', () => {
  it('has unique item keys', () => {
    const keys = GRAY_SETTINGS_ITEMS.map((item) => item.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('covers the three §5.5 sections with the expected item mix', () => {
    expect(GRAY_SETTINGS_SECTION_ORDER).toEqual(['preferences', 'deployment', 'secrets'])
    expect(graySettingsItemsOf('preferences')).toHaveLength(4)
    expect(graySettingsItemsOf('deployment')).toHaveLength(2)
    const secrets = graySettingsItemsOf('secrets')
    expect(secrets).toHaveLength(2)
    expect(secrets.every((item) => item.kind === 'secret')).toBe(true)
  })

  it('looks items up by key', () => {
    expect(graySettingsItem('memory.autoRecall')?.kind).toBe('boolean')
    expect(graySettingsItem('providers.primary')?.kind).toBe('select')
    expect(graySettingsItem('nope')).toBeUndefined()
  })

  it('narrows secret items and carries their credential reference', () => {
    const item = graySettingsItem('credentials.deepseekApiKey')
    expect(item).toBeDefined()
    expect(isSecretItem(item as NonNullable<typeof item>)).toBe(true)
    if (item !== undefined && isSecretItem(item)) {
      expect(item.credentialRef).toBe('deepseek.apiKey')
      expect(graySettingsDefaultValue(item)).toBeUndefined()
    }
  })

  it('reports declared defaults for non-secret items', () => {
    const autoRecall = graySettingsItem('memory.autoRecall')
    expect(graySettingsDefaultValue(autoRecall as NonNullable<typeof autoRecall>)).toBe(true)
    const documentRoot = graySettingsItem('workflows.documentRoot')
    expect(graySettingsDefaultValue(documentRoot as NonNullable<typeof documentRoot>)).toBe('.graycode')
  })

  it('keeps credential references unique (one ref per secret item)', () => {
    const refs = graySettingsItemsOf('secrets').map((item) => (item.kind === 'secret' ? item.credentialRef : null))
    expect(new Set(refs).size).toBe(refs.length)
  })
})

// ---------------------------------------------------------------------------
// Validator (client-side hints; undefined always passes)
// ---------------------------------------------------------------------------

describe('validateGrayValue', () => {
  it('passes absent values (host default applies) and secrets', () => {
    for (const item of GRAY_SETTINGS_ITEMS) {
      expect(validateGrayValue(item, undefined)).toEqual({ ok: true })
      if (item.kind === 'secret') {
        // Secrets are never validated client-side — even a hypothetical value
        // must pass here (the value never exists in the browser anyway).
        expect(validateGrayValue(item, 'anything')).toEqual({ ok: true })
      }
    }
  })

  it('flags non-boolean values for boolean items', () => {
    const item = graySettingsItem('memory.autoRecall')
    expect(validateGrayValue(item as NonNullable<typeof item>, true)).toEqual({ ok: true })
    expect(validateGrayValue(item as NonNullable<typeof item>, 'yes')).toEqual({ ok: false, error: 'error.type.boolean' })
  })

  it('enforces required and maxLength for string items', () => {
    const synthetic: GrayStringItem = {
      key: 'test.string',
      section: 'preferences',
      kind: 'string',
      required: true,
      maxLength: 4,
      labelKey: 'x',
      descriptionKey: 'x',
    }
    expect(validateGrayValue(synthetic, '')).toEqual({ ok: false, error: 'error.required' })
    expect(validateGrayValue(synthetic, '   ')).toEqual({ ok: false, error: 'error.required' })
    expect(validateGrayValue(synthetic, '12345')).toEqual({ ok: false, error: 'error.tooLong' })
    expect(validateGrayValue(synthetic, '1234')).toEqual({ ok: true })
    expect(validateGrayValue(synthetic, 42)).toEqual({ ok: false, error: 'error.type.string' })
  })

  it('enforces safe relative paths for pathLike items', () => {
    const item = graySettingsItem('workflows.documentRoot')
    const check = (value: unknown) => validateGrayValue(item as NonNullable<typeof item>, value)
    expect(check('/abs/path')).toEqual({ ok: false, error: 'error.path' })
    expect(check('C:\\abs\\path')).toEqual({ ok: false, error: 'error.path' })
    expect(check('a/../b')).toEqual({ ok: false, error: 'error.path' })
    expect(check('a*b')).toEqual({ ok: false, error: 'error.path' })
    expect(check('a/b')).toEqual({ ok: true })
    expect(check('.graycode')).toEqual({ ok: true })
  })

  it('enforces numeric type and inclusive range for number items', () => {
    const synthetic: GrayNumberItem = {
      key: 'test.number',
      section: 'preferences',
      kind: 'number',
      min: 1,
      max: 10,
      labelKey: 'x',
      descriptionKey: 'x',
    }
    expect(validateGrayValue(synthetic, Number.NaN)).toEqual({ ok: false, error: 'error.type.number' })
    expect(validateGrayValue(synthetic, '5')).toEqual({ ok: false, error: 'error.type.number' })
    expect(validateGrayValue(synthetic, 0)).toEqual({ ok: false, error: 'error.range' })
    expect(validateGrayValue(synthetic, 11)).toEqual({ ok: false, error: 'error.range' })
    expect(validateGrayValue(synthetic, 1)).toEqual({ ok: true })
    expect(validateGrayValue(synthetic, 10)).toEqual({ ok: true })
  })

  it('enforces option membership for select items', () => {
    const item = graySettingsItem('providers.primary')
    const check = (value: unknown) => validateGrayValue(item as NonNullable<typeof item>, value)
    // Options mirror the plugin provider matrix (docs/PROVIDER_MATRIX.md):
    // `deepseek-official` and `google` are the real route keys; `deepseek`
    // (pi-ai catalog name) and `gemini` are not valid host values.
    expect(check('deepseek-official')).toEqual({ ok: true })
    expect(check('anthropic')).toEqual({ ok: true })
    expect(check('openai')).toEqual({ ok: true })
    expect(check('google')).toEqual({ ok: true })
    expect(check('deepseek')).toEqual({ ok: false, error: 'error.enum' })
    expect(check('gemini')).toEqual({ ok: false, error: 'error.enum' })
    expect(check(42)).toEqual({ ok: false, error: 'error.type.string' })
  })

  it('passes unknown keys through validateGrayItemKey', () => {
    expect(validateGrayItemKey('unknown.key', 'anything')).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// Sensitive-value display strategy (value-free; never plaintext)
// ---------------------------------------------------------------------------

describe('describeSecretDisplay', () => {
  it('maps an absent view to unavailable', () => {
    expect(describeSecretDisplay(undefined)).toEqual({
      kind: 'unavailable',
      actionable: false,
      copyKey: 'secret.unavailable',
    })
  })

  it('maps a writable configured reference to configured', () => {
    const view: CredentialViewLike = { configured: true, writable: true, source: 'file' }
    expect(describeSecretDisplay(view)).toEqual({
      kind: 'configured',
      source: 'file',
      actionable: false,
      copyKey: 'secret.configured',
    })
  })

  it('maps a read-only configured reference to shadowed', () => {
    const view: CredentialViewLike = { configured: true, writable: false, source: 'env' }
    const display = describeSecretDisplay(view)
    expect(display.kind).toBe('shadowed')
    expect(display.source).toBe('env')
    expect(display.actionable).toBe(false)
    expect(display.copyKey).toBe('secret.shadowed')
  })

  it('maps an unconfigured reference to unconfigured with write affordance only when writable', () => {
    expect(describeSecretDisplay({ configured: false, writable: true })).toEqual({
      kind: 'unconfigured',
      actionable: true,
      copyKey: 'secret.unconfigured',
    })
    expect(describeSecretDisplay({ configured: false, writable: false })).toEqual({
      kind: 'unconfigured',
      actionable: false,
      copyKey: 'secret.unconfigured',
    })
  })

  it('never exposes a value: redaction is a guaranteed no-leak seam', () => {
    const secret = 'sk-super-secret-0123456789'
    expect(redactSecret(secret)).toBe(SECRET_PLACEHOLDER)
    expect(redactSecret(secret)).not.toContain(secret)
    expect(SECRET_PLACEHOLDER).not.toContain('secret')
  })

  it('isSecretConfigured reflects the value-free configured flag', () => {
    expect(isSecretConfigured(undefined)).toBe(false)
    expect(isSecretConfigured({ configured: true, writable: false })).toBe(true)
    expect(isSecretConfigured({ configured: false, writable: true })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Provider / surface status mappings
// ---------------------------------------------------------------------------

describe('grayProviderStatus', () => {
  it('derives status from the structural provider view', () => {
    expect(grayProviderStatus(undefined)).toBe('unavailable')
    expect(grayProviderStatus({ active: true })).toBe('enabled')
    expect(grayProviderStatus({ active: false })).toBe('disabled')
    // Absent `active` is "unknown" per the DSH contract — not "shipped".
    expect(grayProviderStatus({ provider: 'openai' })).toBe('unknown')
  })

  it('maps status to hint banner keys (enabled → no banner)', () => {
    expect(grayProviderHintKey('enabled')).toBeNull()
    expect(grayProviderHintKey('disabled')).toBe('provider.disabled')
    expect(grayProviderHintKey('unavailable')).toBe('provider.unavailable')
    expect(grayProviderHintKey('unknown')).toBe('provider.unknown')
  })
})

describe('graySurfaceHint', () => {
  const snapshot = (partial: Partial<SettingsSnapshotLike>): SettingsSnapshotLike => ({
    status: 'ready',
    writable: true,
    mode: 'host',
    ...partial,
  })

  it('degrades to unavailable when nothing is wired or the namespace is not exposed', () => {
    expect(graySurfaceHint(undefined)).toBe('banner.unavailable')
    expect(graySurfaceHint(snapshot({ status: 'unavailable' }))).toBe('banner.unavailable')
  })

  it('flags a read-only host document', () => {
    expect(graySurfaceHint(snapshot({ status: 'ready', writable: false }))).toBe('banner.readonly')
  })

  it('renders no banner while loading or when ready and writable', () => {
    expect(graySurfaceHint(snapshot({ status: 'loading' }))).toBeNull()
    expect(graySurfaceHint(snapshot({ status: 'ready', writable: true }))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Locale alignment (zh/en balance + ja mirror + catalogue ↔ dictionary)
// ---------------------------------------------------------------------------

describe('settingsContribution locales', () => {
  const zh = graycodeSettingsContributionDictionaries.zh
  const en = graycodeSettingsContributionDictionaries.en
  const ja = graycodeSettingsContributionJaPlaceholder

  it('owns a dedicated namespace', () => {
    expect(GRAYCODE_SETTINGS_CONTRIBUTION_NS).toBe('graycode.settingsContribution')
  })

  it('keeps zh/en dictionaries balanced', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('keeps the ja placeholder key-aligned with zh/en', () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(zh).sort())
  })

  it('provides every catalogue label/description/option key in all dictionaries', () => {
    const zhKeys = new Set(Object.keys(zh))
    const jaKeys = new Set(Object.keys(ja))
    for (const item of GRAY_SETTINGS_ITEMS) {
      for (const key of [item.labelKey, item.descriptionKey]) {
        expect(zhKeys.has(key), `zh missing ${key}`).toBe(true)
        expect(jaKeys.has(key), `ja missing ${key}`).toBe(true)
      }
      if (item.kind === 'select') {
        for (const option of item.options) {
          const optionKey = `option.${item.key}.${option}`
          expect(zhKeys.has(optionKey), `zh missing ${optionKey}`).toBe(true)
          expect(jaKeys.has(optionKey), `ja missing ${optionKey}`).toBe(true)
        }
      }
    }
  })

  it('provides every error/secret/status copy key the pure logic can emit', () => {
    const zhKeys = new Set(Object.keys(zh))
    const emittable = [
      // validate.ts GraySettingsErrorKey
      'error.required',
      'error.type.boolean',
      'error.type.number',
      'error.type.string',
      'error.range',
      'error.enum',
      'error.path',
      'error.tooLong',
      // secrets.ts GraySecretCopyKey
      'secret.configured',
      'secret.unconfigured',
      'secret.shadowed',
      'secret.unavailable',
      // status.ts GrayStatusHintKey
      'provider.disabled',
      'provider.unavailable',
      'provider.unknown',
      'banner.unavailable',
      'banner.readonly',
    ]
    for (const key of emittable) {
      expect(zhKeys.has(key), `zh missing ${key}`).toBe(true)
    }
  })
})
