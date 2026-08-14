/**
 * Gray settings contribution panel (P4-07) — the composed surface body.
 *
 * Renders, top to bottom:
 *   1. the surface degradation banner (no Gray Client / read-only document),
 *   2. the provider status banner (disabled provider hint),
 *   3. the three section cards (preferences / deployment / secrets) from the
 *      static catalogue (catalog.ts).
 *
 * DATA FLOW (all declarative — this component never performs I/O):
 * - `values`   — redacted Gray settings section (host `settings.describe` /
 *                `ctx.settingsScope` snapshot); keys are catalogue item keys.
 * - `credentials` — value-free `credentials.describe` views keyed by
 *                credentialRef (never values — structurally impossible here).
 * - `provider` — `llm.providers` entry for the primary provider route.
 * - `surface`  — structural `SettingsScopeSnapshot` (drives degradation).
 * - Edits / jumps are callbacks the host wiring injects. With no wiring the
 *   panel renders the full static catalogue in read-only degradation mode.
 *
 * This component is the content body of a `settings.section` contribution
 * (see README.md for the wiring the main session performs).
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { GRAY_SETTINGS_ITEMS, GRAY_SETTINGS_SECTION_ORDER, isSecretItem } from './catalog.ts'
import type { GraySecretItem, GraySettingsItem } from './catalog.ts'
import { graySurfaceHint } from './status.ts'
import { ConfigItemRow } from './ConfigItemRow.tsx'
import { SecretItemRow } from './SecretItemRow.tsx'
import { DisabledProviderBanner } from './DisabledProviderBanner.tsx'
import { SettingsSectionCard } from './SettingsSectionCard.tsx'
import type { GraySettingsSectionKey, GraySettingsValue, CredentialViewLike, ProviderViewLike, SettingsSnapshotLike } from './types.ts'

/** Composed props for the settings contribution panel. */
export interface SettingsContributionPanelProps {
  /** Framework-injected translate seat for the settings contribution namespace. */
  t: TranslateNS<'graycode.settingsContribution'>
  /**
   * Redacted Gray settings section value keyed by catalogue item key
   * (`settings.describe` value / `ctx.settingsScope` snapshot). Undefined =
   * nothing wired → rows render defaults + degradation banner.
   */
  values: Readonly<Record<string, GraySettingsValue | undefined>> | undefined
  /**
   * Value-free credential views keyed by credentialRef (`credentials.describe`
   * result). Undefined = credentials surface not wired → secret rows show the
   * unavailable state, never a value.
   */
  credentials: Readonly<Record<string, CredentialViewLike | undefined>> | undefined
  /** Primary provider route view (`llm.providers` entry) driving the banner. */
  provider?: ProviderViewLike
  /** Structural settings snapshot (drives read-only / unavailable degradation). */
  surface?: SettingsSnapshotLike | undefined
  /** Declarative edit entry (absent → every control renders disabled). */
  onChange?: (key: string, value: GraySettingsValue | undefined) => void
  /** Declarative jump to the DSH credentials surface for a reference. */
  onOpenCredentials?: (ref: string) => void
  /** Declarative jump into a provider's settings namespace. */
  onOpenProviderSettings?: (settingsNs: string) => void
  /** `settings.section` owner affordance (leave-settings flows); unused today. */
  onClose?: () => void
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.625rem',
  fontSize: '12px',
  lineHeight: '1.45',
}

const bannerStyle: CSSProperties = {
  padding: '0.5rem 0.75rem',
  borderRadius: '0.5rem',
  border: '1px solid var(--dsh-border-color, #444)',
  background: 'rgba(139, 148, 158, 0.08)',
  color: 'var(--dsh-text-color, #eee)',
  opacity: 0.85,
  fontSize: '12px',
  minWidth: '280px',
  maxWidth: '480px',
}

/** Render one non-secret item as a config row. */
function renderConfigRow(
  t: TranslateNS<'graycode.settingsContribution'>,
  item: GraySettingsItem,
  values: Readonly<Record<string, GraySettingsValue | undefined>> | undefined,
  readOnly: boolean,
  onChange: ((key: string, value: GraySettingsValue | undefined) => void) | undefined,
): ReactNode {
  return (
    <ConfigItemRow
      key={item.key}
      t={t}
      item={item}
      value={values?.[item.key]}
      onChange={onChange}
      readOnly={readOnly}
    />
  )
}

/** The composed settings surface body (mount inside a `settings.section`). */
export function SettingsContributionPanel({
  t,
  values,
  credentials,
  provider,
  surface,
  onChange,
  onOpenCredentials,
  onOpenProviderSettings,
}: SettingsContributionPanelProps): ReactNode {
  // Editable only when the host snapshot is ready AND writable AND a handler
  // exists — otherwise the whole panel degrades to a read-only hint surface.
  const canEdit = surface?.status === 'ready' && surface.writable === true && onChange !== undefined
  const surfaceHint = graySurfaceHint(surface)

  return (
    <div style={panelStyle} data-graycode-settings="panel">
      {surfaceHint !== null && (
        <div style={bannerStyle} data-graycode-settings="surface-banner" data-surface={surfaceHint}>
          {t(surfaceHint)}
        </div>
      )}

      <DisabledProviderBanner t={t} view={provider} onOpenSettings={onOpenProviderSettings} />

      {GRAY_SETTINGS_SECTION_ORDER.map((section: GraySettingsSectionKey) => {
        const items = GRAY_SETTINGS_ITEMS.filter((item) => item.section === section)
        const readOnly = section === 'deployment' || !canEdit
        return (
          <SettingsSectionCard
            key={section}
            t={t}
            titleKey={`section.${section}`}
            descriptionKey={`sectionDesc.${section}`}
            readOnly={section === 'deployment'}
          >
            {items.map((item) => {
              if (isSecretItem(item)) {
                return (
                  <SecretItemRow
                    key={item.key}
                    t={t}
                    item={item as GraySecretItem}
                    view={credentials?.[item.credentialRef]}
                    onOpenCredentials={onOpenCredentials}
                  />
                )
              }
              return renderConfigRow(t, item, values, readOnly, canEdit ? onChange : undefined)
            })}
          </SettingsSectionCard>
        )
      })}
    </div>
  )
}
