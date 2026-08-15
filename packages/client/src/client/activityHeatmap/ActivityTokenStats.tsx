/**
 * Activity heatmap (C6) — token statistics section.
 *
 * Renders the aggregated token usage below the activity charts:
 * - overview cards: total / input (uncached) / output (incl. thinking) /
 *   cache read / cache write;
 * - per-day bars (newest first);
 * - per-session bars (top sessions by total, descending).
 *
 * The buckets mirror the host token-meter's `TokenUsageProjection`
 * (disjoint buckets; reasoning already inside output). Pure presentation —
 * no I/O; all copy arrives as locale keys through `t`.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { formatTokenCount, type ActivityTokenStatsView } from './viewModel.ts'

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  marginTop: '0.5rem',
  borderTop: '1px solid var(--dsh-border-color, #333)',
  paddingTop: '0.5rem',
}

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: '12px',
  fontWeight: 600,
}

const overviewStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.5rem',
  padding: '0.375rem 0.5rem',
  borderRadius: '0.375rem',
  background: 'var(--dsh-surface-color, #1e1e1e)',
}

const overviewItemStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
  minWidth: '4.5rem',
}

const overviewValueStyle: CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  whiteSpace: 'nowrap',
}

const overviewLabelStyle: CSSProperties = {
  fontSize: '10px',
  opacity: 0.7,
}

const barRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '10px',
}

const barLabelStyle: CSSProperties = {
  minWidth: '6em',
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

const emptyStyle: CSSProperties = {
  fontSize: '11px',
  opacity: 0.8,
}

export interface ActivityTokenStatsProps {
  /** Framework-injected translate seat for the `graycode.activityHeatmap` namespace. */
  t: TranslateNS<'graycode.activityHeatmap'>
  /** Render-ready token view (totals + day bars + session bars). */
  view: ActivityTokenStatsView
}

/** Token statistics section. */
export function ActivityTokenStats({ t, view }: ActivityTokenStatsProps): ReactNode {
  const maxDay = view.byDay.reduce((current, bar) => Math.max(current, bar.totalTokens), 0)
  const maxSession = view.sessions.reduce((current, bar) => Math.max(current, bar.totalTokens), 0)
  return (
    <div style={sectionStyle}>
      <h3 style={sectionTitleStyle}>{t('tokens.title')}</h3>
      <div style={overviewStyle}>
        <div style={overviewItemStyle}>
          <span style={overviewValueStyle}>{formatTokenCount(view.totals.totalTokens)}</span>
          <span style={overviewLabelStyle}>{t('tokens.total')}</span>
        </div>
        <div style={overviewItemStyle}>
          <span style={overviewValueStyle}>{formatTokenCount(view.totals.inputTokens)}</span>
          <span style={overviewLabelStyle}>{t('tokens.input')}</span>
        </div>
        <div style={overviewItemStyle}>
          <span style={overviewValueStyle}>{formatTokenCount(view.totals.outputTokens)}</span>
          <span style={overviewLabelStyle}>{t('tokens.output')}</span>
        </div>
        <div style={overviewItemStyle}>
          <span style={overviewValueStyle}>{formatTokenCount(view.totals.cacheReadTokens)}</span>
          <span style={overviewLabelStyle}>{t('tokens.cacheRead')}</span>
        </div>
        <div style={overviewItemStyle}>
          <span style={overviewValueStyle}>{formatTokenCount(view.totals.cacheWriteTokens)}</span>
          <span style={overviewLabelStyle}>{t('tokens.cacheWrite')}</span>
        </div>
      </div>

      <h3 style={{ ...sectionTitleStyle, fontSize: '11px', marginTop: '0.375rem' }}>{t('tokens.byDay')}</h3>
      {view.byDay.map(bar => (
        <div key={bar.date} style={barRowStyle}>
          <span style={barLabelStyle}>{bar.date}</span>
          <div style={barTrackStyle}>
            <div style={barFillStyle(maxDay > 0 ? bar.totalTokens / maxDay : 0)} />
          </div>
          <span style={barValueStyle}>{formatTokenCount(bar.totalTokens)}</span>
        </div>
      ))}
      {view.byDay.length === 0 && <div style={emptyStyle}>{t('tokens.empty')}</div>}

      <h3 style={{ ...sectionTitleStyle, fontSize: '11px', marginTop: '0.375rem' }}>{t('tokens.bySession')}</h3>
      {view.sessions.map(session => (
        <div key={session.sessionId} style={barRowStyle} title={`${session.title || session.sessionId} · ${session.date}`}>
          <span style={barLabelStyle}>{session.title.length > 0 ? session.title : t('tokens.untitled')}</span>
          <div style={barTrackStyle}>
            <div style={barFillStyle(maxSession > 0 ? session.totalTokens / maxSession : 0)} />
          </div>
          <span style={barValueStyle}>{formatTokenCount(session.totalTokens)}</span>
        </div>
      ))}
      {view.sessions.length === 0 && <div style={emptyStyle}>{t('tokens.empty')}</div>}
    </div>
  )
}
