/**
 * Activity heatmap (C6) — monthly summary bars.
 *
 * One horizontal bar per month: width scales with totalMinutes against the
 * range maximum; active days and session count shown inline. Pure presentation
 * — no I/O.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActivityMonthlyBarView } from './viewModel.ts'

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  marginTop: '0.5rem',
}

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: '12px',
  fontWeight: 600,
}

const barRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '10px',
}

const barLabelStyle: CSSProperties = {
  minWidth: '3.5em',
  opacity: 0.8,
}

const barTrackStyle: CSSProperties = {
  flex: 1,
  height: '8px',
  borderRadius: '2px',
  background: 'var(--dsh-surface-color-alt, rgba(255,255,255,0.06))',
  overflow: 'hidden',
}

function barFillStyle(ratio: number): CSSProperties {
  return {
    height: '100%',
    width: `${Math.max(2, Math.min(100, Math.round(ratio * 100)))}%`,
    background: 'var(--dsh-accent-color, #4a9eff)',
    borderRadius: '2px',
  }
}

const barValueStyle: CSSProperties = {
  minWidth: '3.5em',
  textAlign: 'right',
  opacity: 0.9,
}

export interface ActivityMonthlyBarsProps {
  /** Framework-injected translate seat for the `graycode.activityHeatmap` namespace. */
  t: TranslateNS<'graycode.activityHeatmap'>
  /** Render-ready bars (newest first, host order). */
  bars: readonly ActivityMonthlyBarView[]
}

/** Monthly summary bars. */
export function ActivityMonthlyBars({ t, bars }: ActivityMonthlyBarsProps): ReactNode {
  const max = bars.reduce((current, bar) => Math.max(current, bar.totalMinutes), 0)
  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>{t('monthly.title')}</h3>
      {bars.map((bar) => (
        <div key={bar.month} style={barRowStyle}>
          <span style={barLabelStyle}>{bar.month}</span>
          <div style={barTrackStyle}>
            <div style={barFillStyle(max > 0 ? bar.totalMinutes / max : 0)} />
          </div>
          <span style={barValueStyle}>
            {bar.totalMinutes} {t('summary.minutes')}
          </span>
          <span style={{ opacity: 0.7, whiteSpace: 'nowrap' }}>
            {bar.activeDays} {t('summary.activeDays')} · {bar.sessionCount} {t('summary.sessions')}
          </span>
        </div>
      ))}
      {bars.length === 0 && <div style={{ fontSize: '11px', opacity: 0.8 }}>{t('monthly.empty')}</div>}
    </div>
  )
}
