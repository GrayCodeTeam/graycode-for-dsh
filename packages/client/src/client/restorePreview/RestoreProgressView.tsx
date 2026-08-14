/**
 * Restore progress view — progress bar, counters and per-file failures (P4-05).
 *
 * Pure presentational component over the merged {@link RestoreProgress}:
 * phase, processed/total, percent bar, restored/deleted/skipped/failed
 * counters and the accumulated per-file failure list (逐项失败结果). The
 * failed items are rendered verbatim from host data — never collapsed into a
 * bare "failed".
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { restoreFailureLocaleKey } from './labels.ts'
import { progressPercent } from './progress.ts'
import type { RestoreProgress } from './types.ts'

export interface RestoreProgressViewProps {
  t: TranslateNS<'graycode.restorePreview'>
  progress: RestoreProgress
}

const progressStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  gap: '0.375rem',
  alignItems: 'baseline',
}

const phaseStyle: CSSProperties = {
  marginLeft: 'auto',
  opacity: 0.7,
  fontSize: '11px',
}

const barTrackStyle: CSSProperties = {
  height: '0.5rem',
  borderRadius: '999px',
  background: 'var(--dsh-border-color, #333)',
  overflow: 'hidden',
}

const barFillStyle: CSSProperties = {
  height: '100%',
  borderRadius: '999px',
  background: '#58a6ff',
  transition: 'width 0.2s ease',
}

const countsStyle: CSSProperties = {
  display: 'flex',
  gap: '0.75rem',
  flexWrap: 'wrap',
  fontSize: '11px',
  opacity: 0.85,
}

const failuresStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid #f85149',
  background: 'rgba(248, 81, 73, 0.08)',
}

const failureItemStyle: CSSProperties = {
  display: 'flex',
  gap: '0.375rem',
  alignItems: 'baseline',
}

const failurePathStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  overflowWrap: 'anywhere',
}

const failureReasonStyle: CSSProperties = {
  flexShrink: 0,
  fontSize: '10px',
  opacity: 0.8,
}

/**
 * In-flight / terminal restore progress. Mount it during the `running` phase
 * and (with the failed items) on partial-failure states.
 */
export function RestoreProgressView({ t, progress }: RestoreProgressViewProps): ReactNode {
  const percent = progressPercent(progress)
  return (
    <div data-graycode-restorepreview="progress" data-phase={progress.phase} style={progressStyle}>
      <div style={headerStyle}>
        <span>{t('progressLabel')}</span>
        <span style={phaseStyle}>{progress.phase}</span>
        <span>
          {t('processedLabel')}: {progress.processed}/{progress.total}
        </span>
      </div>
      <div role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} style={barTrackStyle}>
        <div style={{ ...barFillStyle, width: `${percent}%` }} />
      </div>
      <div style={countsStyle}>
        <span>{t('restoredCountLabel')}: {progress.restored}</span>
        <span>{t('deletedCountLabel')}: {progress.deleted}</span>
        <span>{t('skippedCountLabel')}: {progress.skipped}</span>
        <span>{t('failedCountLabel')}: {progress.failed}</span>
      </div>
      {progress.failedItems.length > 0 && (
        <div style={failuresStyle} data-graycode-restorepreview="failures">
          <div>{t('failuresTitle')}</div>
          {progress.failedItems.map(item => (
            <div key={item.path} style={failureItemStyle}>
              <span style={failurePathStyle}>{item.path}</span>
              <span style={failureReasonStyle}>{t(restoreFailureLocaleKey(item.reason))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
