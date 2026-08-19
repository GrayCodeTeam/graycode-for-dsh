import type { ReactNode } from 'react'
import { Switch, type GcTranslate } from './fields.tsx'
import {
  buttonRowStyle,
  buttonStyle,
  rowCopyStyle,
  rowDescriptionStyle,
  rowLabelStyle,
  rowStyle,
  sectionBodyStyle,
  sectionDescriptionStyle,
  sectionStyle,
  sectionTitleStyle,
} from './styles.ts'

export const CHECKPOINT_EXCLUSION_PROFILE_IDS = [
  'logs',
  'aiModels',
  'datasets',
  'caches',
  'pythonVenvs',
  'buildArtifacts',
  'largeMedia',
  'archives',
] as const

export type CheckpointExclusionProfileId = (typeof CHECKPOINT_EXCLUSION_PROFILE_IDS)[number]

export function exclusionProfileEnabled(values: Readonly<Record<string, boolean>>, id: CheckpointExclusionProfileId): boolean {
  return values[id] ?? true
}

/** Persist a complete record so an empty object never ambiguously means "all disabled". */
export function withExclusionProfile(
  values: Readonly<Record<string, boolean>>,
  id: CheckpointExclusionProfileId,
  enabled: boolean,
): Record<string, boolean> {
  return Object.fromEntries(CHECKPOINT_EXCLUSION_PROFILE_IDS.map(profileId => [
    profileId,
    profileId === id ? enabled : exclusionProfileEnabled(values, profileId),
  ]))
}

export function CheckpointExclusionProfilesSection({
  t,
  values,
  onChange,
}: {
  t: GcTranslate
  values: Readonly<Record<string, boolean>>
  onChange: (value: Record<string, boolean>) => void | Promise<void>
}): ReactNode {
  const setAll = (enabled: boolean): void => {
    void Promise.resolve(onChange(Object.fromEntries(CHECKPOINT_EXCLUSION_PROFILE_IDS.map(id => [id, enabled]))))
      .catch(() => undefined)
  }
  return (
    <section style={sectionStyle}>
      <h3 style={sectionTitleStyle}>{t('checkpoint.exclusions.title')}</h3>
      <p style={sectionDescriptionStyle}>{t('checkpoint.exclusions.description')}</p>
      <div style={{ ...buttonRowStyle, marginBottom: '8px' }}>
        <button type="button" style={buttonStyle} onClick={() => setAll(true)}>{t('checkpoint.exclusions.enableAll')}</button>
        <button type="button" style={buttonStyle} onClick={() => setAll(false)}>{t('checkpoint.exclusions.disableAll')}</button>
      </div>
      <div style={sectionBodyStyle}>
        {CHECKPOINT_EXCLUSION_PROFILE_IDS.map(id => (
          <label key={id} style={rowStyle}>
            <span style={rowCopyStyle}>
              <span style={rowLabelStyle}>{t(`checkpoint.exclusions.${id}`)}</span>
              <span style={rowDescriptionStyle}>{t(`checkpoint.exclusions.${id}.description`)}</span>
            </span>
            <Switch
              checked={exclusionProfileEnabled(values, id)}
              onChange={enabled => {
                void Promise.resolve(onChange(withExclusionProfile(values, id, enabled))).catch(() => undefined)
              }}
            />
          </label>
        ))}
      </div>
    </section>
  )
}
