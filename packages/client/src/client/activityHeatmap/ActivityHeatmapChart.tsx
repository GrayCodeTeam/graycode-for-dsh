/**
 * Activity heatmap (C6) — 7×24 heatmap chart.
 *
 * Renders one row per day: 24 cells (one per local hour) whose fill level
 * follows the 0-4 intensity bucket from the view model. Cells are rectangular
 * and stretch across the full track width (flex: 1), so the grid fills the
 * panel area instead of leaving square gaps; the axis row above the grid uses
 * the same label spacer + 24-slot structure, so the 0/6/12/18/23 tick numbers
 * sit exactly above their columns. Pure presentation — no I/O; all copy
 * arrives as locale keys through `t`.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActivityHeatmapRowView } from './viewModel.ts'

/** Fixed label-column width shared by the axis spacer and every date label. */
const LABEL_WIDTH = '34px'

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
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
  gap: '8px',
}

const dateLabelStyle: CSSProperties = {
  flexShrink: 0,
  width: LABEL_WIDTH,
  textAlign: 'right',
  fontSize: '10px',
  fontFamily: 'var(--dsh-font-mono, monospace)',
  opacity: 0.8,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** The cells track: 24 flex cells stretch across whatever width remains. */
const cellsTrackStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  gap: '2px',
}

const cellStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: '8px',
  borderRadius: '2px',
  background: 'var(--dsh-accent-color, #4a9eff)',
  flexShrink: 0,
}

function cellStyleWithOpacity(intensity: number): CSSProperties {
  return { ...cellStyle, opacity: CELL_OPACITY[intensity] ?? 0.08 }
}

/** Axis tick row: identical structure to a data row (spacer + 24 slots). */
const axisLabelStyle: CSSProperties = {
  ...dateLabelStyle,
  opacity: 0.5,
}

const tickStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  textAlign: 'center',
  fontSize: '9px',
  fontFamily: 'var(--dsh-font-mono, monospace)',
  opacity: 0.6,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
}

/** Cell fill level by intensity bucket (CSS opacity; color via theme vars). */
const CELL_OPACITY: readonly number[] = [0.08, 0.25, 0.5, 0.75, 1]

/** Hours whose number appears on the axis row (matches the legacy panel). */
const AXIS_TICK_HOURS: readonly number[] = [0, 6, 12, 18, 23]

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
        <span style={axisLabelStyle} aria-hidden="true" />
        <div style={cellsTrackStyle}>
          {Array.from({ length: 24 }, (_, hour) => (
            <span key={hour} style={tickStyle} aria-hidden="true">
              {AXIS_TICK_HOURS.includes(hour) ? String(hour) : ''}
            </span>
          ))}
        </div>
      </div>
      {rows.map((row) => (
        <div key={row.date} style={rowStyle}>
          <span style={dateLabelStyle}>{row.date}</span>
          <div style={cellsTrackStyle}>
            {row.cells.map((cell) => (
              <span
                key={cell.hour}
                style={cellStyleWithOpacity(cell.intensity)}
                title={`${row.date} ${cell.hour}:00 — ${cell.minutes} ${t('summary.minutes')}`}
              />
            ))}
          </div>
        </div>
      ))}
      {rows.length === 0 && <div style={{ fontSize: '11px', opacity: 0.8 }}>{t('state.empty')}</div>}
    </div>
  )
}
