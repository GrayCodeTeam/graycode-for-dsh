/**
 * Gray settings section card (P4-07).
 *
 * One §5.5 classification group (preferences / deployment / secrets) rendered
 * as a titled card whose body stacks its item rows. Pure presentational shell:
 * no I/O, no data resolution — children arrive pre-resolved from the panel.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GraySettingsSectionKey } from './types.ts'
import type { GrayCodeSettingsContributionLocaleKey } from './locales.ts'

/** Section title keys (template over the catalogue section keys). */
export type GraySettingsSectionTitleKey = `section.${GraySettingsSectionKey}`

/** Composed props for the section card. */
export interface SettingsSectionCardProps {
  /** Framework-injected translate seat for the settings contribution namespace. */
  t: TranslateNS<'graycode.settingsContribution'>
  /** Section title key (`section.preferences` | `section.deployment` | `section.secrets`). */
  titleKey: GraySettingsSectionTitleKey
  /** Optional section description key. */
  descriptionKey?: GrayCodeSettingsContributionLocaleKey
  /** Renders the read-only tag (deployment section). */
  readOnly?: boolean
  /** Item rows of this section. */
  children?: ReactNode
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.625rem 0.75rem',
  borderRadius: '0.5rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'var(--dsh-text-color, #eee)',
  fontSize: '12px',
  lineHeight: '1.45',
  minWidth: '280px',
  maxWidth: '480px',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.5rem',
  flexWrap: 'wrap',
}

const titleStyle: CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
}

const tagStyle: CSSProperties = {
  padding: '0.0625rem 0.4375rem',
  borderRadius: '999px',
  border: '1px solid currentColor',
  fontSize: '10px',
  opacity: 0.7,
  whiteSpace: 'nowrap',
}

const descriptionStyle: CSSProperties = {
  opacity: 0.65,
  fontSize: '11px',
}

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
}

/** One settings group card. Mount rows as children (see SettingsContributionPanel). */
export function SettingsSectionCard({
  t,
  titleKey,
  descriptionKey,
  readOnly,
  children,
}: SettingsSectionCardProps): ReactNode {
  return (
    <section style={cardStyle} data-graycode-settings="section" data-section={titleKey}>
      <div style={headerStyle}>
        <span style={titleStyle}>{t(titleKey)}</span>
        {readOnly === true && (
          <span style={tagStyle} data-graycode-settings="readonly">
            {t('deployment.managedBy')}
          </span>
        )}
      </div>
      {descriptionKey !== undefined && <div style={descriptionStyle}>{t(descriptionKey)}</div>}
      <div style={bodyStyle}>{children}</div>
    </section>
  )
}
