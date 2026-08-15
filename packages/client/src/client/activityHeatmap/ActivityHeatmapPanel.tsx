/**
 * Activity heatmap panel (C6) — the management surface container.
 *
 * Owns the range switcher / toggle state (query.ts) and the loaded stats, and
 * drives a {@link ActivityStatsDataSource}:
 *
 * - Mounted WITHOUT a source (history replay, unwired host): renders a
 *   degraded hint state — no fetch is ever initiated (client boundary rules).
 * - Mounted WITH a source (live view): fetches stats on mount and whenever
 *   the applied range / toggles change; a failure surfaces the error state
 *   with a retry entry for retryable codes.
 *
 * The panel itself performs no other I/O; the three chart areas
 * (heatmap / daily bars / monthly bars) are pure projections of the result.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { readActivityThrownError } from './wire.ts'
import { ACTIVITY_RANGES, createActivityStatsQuery, withActivityRange, type ActivityStatsQueryModel } from './query.ts'
import { activityStatsErrorHint } from './errors.ts'
import type { ActivityStatsDataSource, ActivityStatsError, ActivityTokensDataSource, ActivityTokensResultLike } from './types.ts'
import { ActivityHeatmapChart } from './ActivityHeatmapChart.tsx'
import { ActivityDailyBars } from './ActivityDailyBars.tsx'
import { ActivityMonthlyBars } from './ActivityMonthlyBars.tsx'
import { ActivityTokenStats } from './ActivityTokenStats.tsx'
import {
  buildActivityDailyBars,
  buildActivityHeatmap,
  buildActivityMonthlyBars,
  buildActivitySummary,
  buildActivityTokenStats,
  formatActivityDuration,
  formatGeneratedAt,
  type ActivityDailyBarView,
  type ActivityHeatmapRowView,
  type ActivityMonthlyBarView,
  type ActivitySummaryView,
} from './viewModel.ts'

/** Composed props for the activity panel. */
export interface ActivityHeatmapPanelProps {
  /** Framework-injected translate seat for the `graycode.activityHeatmap` namespace. */
  t: TranslateNS<'graycode.activityHeatmap'>
  /**
   * Data source. Absent during replay / unwired hosts → degraded hint state,
   * no fetch. Callers must keep the instance stable across renders (memoize
   * or hoist) to avoid refetch loops.
   */
  source?: ActivityStatsDataSource
  /**
   * Token statistics source (browser-side session-projection aggregation).
   * Absent during replay / unwired hosts → the token section is skipped.
   * Callers must keep the instance stable across renders.
   */
  tokensSource?: ActivityTokensDataSource
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  padding: '0.75rem',
  borderRadius: '0.5rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'var(--dsh-text-color, #eee)',
  fontSize: '12px',
  lineHeight: '1.45',
  minWidth: '300px',
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 600,
}

const hintStyle: CSSProperties = {
  padding: '1rem 0.75rem',
  borderRadius: '0.5rem',
  border: '1px dashed var(--dsh-border-color, #333)',
  fontSize: '12px',
  opacity: 0.8,
}

const controlsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  flexWrap: 'wrap',
}

const rangeButtonStyle: CSSProperties = {
  padding: '0.125rem 0.375rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'transparent',
  color: 'inherit',
  fontSize: '11px',
  cursor: 'pointer',
}

const rangeButtonActiveStyle: CSSProperties = {
  ...rangeButtonStyle,
  borderColor: 'var(--dsh-accent-color, #4a9eff)',
  color: 'var(--dsh-accent-color, #4a9eff)',
}

const toggleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  fontSize: '11px',
  opacity: 0.9,
}

const headerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '0.5rem',
}

const generatedStyle: CSSProperties = {
  fontSize: '10px',
  fontFamily: 'var(--dsh-font-mono, monospace)',
  opacity: 0.7,
}

const overviewStyle: CSSProperties = {
  display: 'flex',
  gap: '0.75rem',
  padding: '0.5rem 0.625rem',
  borderRadius: '0.375rem',
  borderLeft: '3px solid var(--dsh-accent-color, #4a9eff)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
}

const overviewItemStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
  flex: 1,
  minWidth: 0,
}

const overviewValueStyle: CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  whiteSpace: 'nowrap',
}

const overviewValueActiveStyle: CSSProperties = {
  ...overviewValueStyle,
  color: 'var(--dsh-success-color, #4caf50)',
}

const overviewLabelStyle: CSSProperties = {
  fontSize: '10px',
  opacity: 0.7,
}

/** Render-ready page state for the panel. */
type PanelPhase =
  | { phase: 'loading' }
  | { phase: 'error'; error: ActivityStatsError }
  | { phase: 'loaded' }

/**
 * Activity heatmap panel. Mount it wherever the host renders management views
 * (see activityHeatmap/README.md for wiring).
 */
export function ActivityHeatmapPanel({
  t,
  source,
  tokensSource,
}: ActivityHeatmapPanelProps): ReactNode {
  const [range, setRange] = useState<ActivityStatsQueryModel>(createActivityStatsQuery)
  const [showHourly, setShowHourly] = useState(true)
  const [showMonthly, setShowMonthly] = useState(true)
  const [state, setState] = useState<PanelPhase>({ phase: 'loading' })
  const [summary, setSummary] = useState<ActivitySummaryView | null>(null)
  const [heatmap, setHeatmap] = useState<readonly ActivityHeatmapRowView[]>([])
  const [daily, setDaily] = useState<readonly ActivityDailyBarView[]>([])
  const [monthly, setMonthly] = useState<readonly ActivityMonthlyBarView[]>([])
  const [tokens, setTokens] = useState<ActivityTokensResultLike | null>(null)
  const [tokensError, setTokensError] = useState<ActivityStatsError | null>(null)
  const disposed = useRef(false)

  useEffect(() => {
    disposed.current = false
    return () => {
      disposed.current = true
    }
  }, [])

  // Stats fetch: on mount and whenever the range / toggles change. Aborting
  // the controller drops stale responses.
  useEffect(() => {
    if (source === undefined) return
    const controller = new AbortController()
    setState({ phase: 'loading' })
    source.stats(
      {
        range: range.range,
        includeHourly: showHourly,
        includeMonthly: showMonthly,
      },
      controller.signal,
    )
      .then((result) => {
        if (disposed.current || controller.signal.aborted) return
        setSummary(buildActivitySummary(result))
        setHeatmap(buildActivityHeatmap(result))
        setDaily(buildActivityDailyBars(result))
        setMonthly(buildActivityMonthlyBars(result))
        setState({ phase: 'loaded' })
      })
      .catch((error: unknown) => {
        if (disposed.current || controller.signal.aborted) return
        setState({ phase: 'error', error: readActivityThrownError(error) })
      })
    return () => controller.abort()
  }, [source, range, showHourly, showMonthly])

  // Token fetch: on mount and whenever the range changes (toggles do not
  // affect the token aggregation). Latest-wins guard — the session list has
  // no abort transport, so stale responses are dropped by request id.
  useEffect(() => {
    if (tokensSource === undefined) return
    let latest = true
    setTokensError(null)
    setTokens(null)
    tokensSource.tokens({ range: range.range }).then(
      (result) => {
        if (!disposed.current && latest) setTokens(result)
      },
      (error: unknown) => {
        if (!disposed.current && latest) setTokensError(readActivityThrownError(error))
      },
    )
    return () => {
      latest = false
    }
  }, [tokensSource, range])

  const retry = useCallback((): void => {
    // Re-trigger the fetch effect by toggling through a fresh query object.
    setRange((current) => ({ ...current }))
  }, [])

  if (source === undefined) {
    return (
      <div data-graycode-activity-heatmap="panel" data-state="replay" style={panelStyle}>
        <h2 style={titleStyle}>{t('title')}</h2>
        <div style={hintStyle}>{t('state.replayOnly')}</div>
      </div>
    )
  }

  const errorHint = state.phase === 'error' ? activityStatsErrorHint(state.error.code) : null

  return (
    <div
      data-graycode-activity-heatmap="panel"
      data-state={state.phase}
      style={panelStyle}
    >
      <div style={headerStyle}>
        <h2 style={titleStyle}>{t('title')}</h2>
        {summary !== null && <span style={generatedStyle}>{formatGeneratedAt(summary.generatedAt)}</span>}
      </div>

      <div style={controlsStyle}>
        {ACTIVITY_RANGES.map((candidate) => {
          const active = candidate === range.range
          return (
            <button
              key={candidate}
              type="button"
              style={active ? rangeButtonActiveStyle : rangeButtonStyle}
              onClick={() => setRange((current) => withActivityRange(current, candidate))}
            >
              {t(`range.${candidate}`)}
            </button>
          )
        })}
      </div>

      <div style={controlsStyle}>
        <label style={toggleStyle}>
          <input
            type="checkbox"
            checked={showHourly}
            onChange={(event) => setShowHourly(event.target.checked)}
          />
          {t('toggle.hourly')}
        </label>
        <label style={toggleStyle}>
          <input
            type="checkbox"
            checked={showMonthly}
            onChange={(event) => setShowMonthly(event.target.checked)}
          />
          {t('toggle.monthly')}
        </label>
      </div>

      {state.phase === 'loading' && <div style={hintStyle}>{t('state.loading')}</div>}

      {state.phase === 'error' && errorHint !== null && (
        <div style={hintStyle}>
          <div>{t(errorHint.key)}</div>
          {errorHint.retryable && (
            <button type="button" style={rangeButtonStyle} onClick={retry}>
              {t('state.errorRetry')}
            </button>
          )}
        </div>
      )}

      {state.phase === 'loaded' && summary !== null && (
        <>
          <div style={overviewStyle}>
            <div style={overviewItemStyle}>
              <span style={overviewValueStyle}>
                {formatActivityDuration(summary.todayMinutes, { hour: t('summary.hours'), minute: t('summary.minutes') })}
              </span>
              <span style={overviewLabelStyle}>{t('summary.today')}</span>
            </div>
            <div style={overviewItemStyle}>
              <span style={summary.currentActive ? overviewValueActiveStyle : overviewValueStyle}>
                {summary.currentActive
                  ? formatActivityDuration(summary.currentMinutes, { hour: t('summary.hours'), minute: t('summary.minutes') })
                  : '—'}
              </span>
              <span style={overviewLabelStyle}>{t('summary.currentSession')}</span>
            </div>
            <div style={overviewItemStyle}>
              <span style={overviewValueStyle}>
                {formatActivityDuration(summary.totalMinutes, { hour: t('summary.hours'), minute: t('summary.minutes') })}
              </span>
              <span style={overviewLabelStyle}>{t('summary.totalInRange')}</span>
            </div>
          </div>

          {showHourly && <ActivityHeatmapChart t={t} rows={heatmap} />}
          <ActivityDailyBars t={t} bars={daily} />
          {showMonthly && <ActivityMonthlyBars t={t} bars={monthly} />}

          {tokensSource !== undefined && tokens !== null && (
            <ActivityTokenStats t={t} view={buildActivityTokenStats(tokens)} />
          )}
          {tokensSource !== undefined && tokens === null && tokensError !== null && (
            <div style={hintStyle}>
              <div>{t(activityStatsErrorHint(tokensError.code)?.key ?? 'error.unknown')}</div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
