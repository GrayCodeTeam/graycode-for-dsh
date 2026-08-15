/**
 * Activity heatmap (C6) — daily activity bars.
 *
 * One horizontal bar per day: width scales with totalMinutes against the
 * range maximum. Pure presentation — no I/O.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActivityDailyBarView } from './viewModel.ts'

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
  minWidth: '4.5em',
  opacity: 0.8,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const barTrackStyle: CSSProperties = {
  flex: 1,
  height: '8px',
  borderRadius: '2px',
  background: 'var(--dsh-surface-color-alt, rgba(255,255,255,0.06))',
  overflow: 'hidden',
}

function barFillStyle(ratio: number): CSSProperties {
  // 零值渲染为空填充（4.1-L4）：ratio<=0 不画 2% 的“假活动”条，仅 >0 时给最小可见宽度。
  const width = ratio > 0 ? Math.max(2, Math.min(100, Math.round(ratio * 100))) : 0
  return {
    height: '100%',
    width: `${width}%`,
    background: 'var(--dsh-accent-color, #4a9eff)',
    borderRadius: '2px',
  }
}

const barValueStyle: CSSProperties = {
  minWidth: '3.5em',
  textAlign: 'right',
  opacity: 0.9,
}

export interface ActivityDailyBarsProps {
  /** Framework-injected translate seat for the `graycode.activityHeatmap` namespace. */
  t: TranslateNS<'graycode.activityHeatmap'>
  /** Render-ready bars (newest first, host order). */
  bars: readonly ActivityDailyBarView[]
}

/** Daily activity bars. */
export function ActivityDailyBars({ t, bars }: ActivityDailyBarsProps): ReactNode {
  const max = bars.reduce((current, bar) => Math.max(current, bar.totalMinutes), 0)
  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>{t('daily.title')}</h3>
      {bars.map((bar) => (
        <div key={bar.date} style={barRowStyle}>
          <span style={barLabelStyle}>{bar.date}</span>
          <div style={barTrackStyle}>
            <div style={barFillStyle(max > 0 ? bar.totalMinutes / max : 0)} />
          </div>
          <span style={barValueStyle}>
            {bar.totalMinutes} {t('summary.minutes')}
          </span>
        </div>
      ))}
      {bars.length === 0 && <div style={{ fontSize: '11px', opacity: 0.8 }}>{t('daily.empty')}</div>}
    </div>
  )
}
