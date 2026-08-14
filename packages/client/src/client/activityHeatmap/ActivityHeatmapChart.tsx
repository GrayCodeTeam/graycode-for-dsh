/**
 * Activity heatmap (C6) — 7×24 heatmap chart.
 *
 * Renders one row per day: 24 cells (one per local hour) whose fill level
 * follows the 0-4 intensity bucket from the view model. Pure presentation —
 * no I/O; all copy arrives as locale keys through `t`.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActivityHeatmapRowView } from './viewModel.ts'

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

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
}

const dateLabelStyle: CSSProperties = {
  fontSize: '10px',
  opacity: 0.8,
  minWidth: '4.5em',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const hourLabelsStyle: CSSProperties = {
  fontSize: '9px',
  opacity: 0.5,
  minWidth: '4.5em',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
}

/** Cell fill level by intensity bucket (CSS opacity; color via theme vars). */
const CELL_OPACITY: readonly number[] = [0.08, 0.25, 0.5, 0.75, 1]

function cellStyle(intensity: number): CSSProperties {
  return {
    width: '10px',
    height: '10px',
    borderRadius: '2px',
    background: 'var(--dsh-accent-color, #4a9eff)',
    opacity: CELL_OPACITY[intensity] ?? 0.08,
    flexShrink: 0,
  }
}

export interface ActivityHeatmapChartProps {
  /** Framework-injected translate seat for the `graycode.activityHeatmap` namespace. */
  t: TranslateNS<'graycode.activityHeatmap'>
  /** Render-ready rows (date ascending, clamped by the view model). */
  rows: readonly ActivityHeatmapRowView[]
}

/** 7×24 heatmap chart. */
export function ActivityHeatmapChart({ t, rows }: ActivityHeatmapChartProps): ReactNode {
  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>{t('heatmap.title')}</h3>
      <div style={rowStyle}>
        <span style={hourLabelsStyle}>{t('heatmap.hourLabels')}</span>
      </div>
      {rows.map((row) => (
        <div key={row.date} style={rowStyle}>
          <span style={dateLabelStyle}>{row.date}</span>
          {row.cells.map((cell) => (
            <span
              key={cell.hour}
              style={cellStyle(cell.intensity)}
              title={`${row.date} ${cell.hour}:00 — ${cell.minutes} min`}
            />
          ))}
        </div>
      ))}
      {rows.length === 0 && <div style={{ fontSize: '11px', opacity: 0.8 }}>{t('state.empty')}</div>}
    </div>
  )
}
