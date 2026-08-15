/**
 * Staged-diff entry card (P4-06).
 *
 * Renders one staged write intent: file path, before/after summary
 * (new file / deleted / +N −M), status badge, accept/reject actions and a
 * conflict hint for the last failed decision.
 *
 * CLIENT BOUNDARY RULES (PLAN_V2 §5.6):
 * - Replay-safe: the card never performs I/O and never touches the
 *   workspace. `path` is a plain string carried by the entry — the
 *   referenced file may not exist yet (that is the point of staging); the
 *   card renders it as text only.
 * - Accept/reject are declarative: the card only invokes the callbacks the
 *   host injected. With no callbacks (history replay, unwired host) the
 *   buttons render disabled with the `replayOnly` hint.
 * - The badge reflects the entry's projected status only; the card never
 *   optimistically flips a status from a button click (the host's
 *   projection is the single source of truth).
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { StagedEntry } from './contract.ts'
import type { StagedDiffCardError } from './errors.ts'
import {
  STAGED_STATUS_TONE,
  isStagedReapplyStatus,
  stagedEntryActionability,
  stagedStatusLocaleKey,
} from './status.ts'
import { summarizeStagedDiff } from './summary.ts'
import { stagedDiffErrorLocaleKey } from './errors.ts'

/** Composed props for one staged-diff entry card. */
export interface StagedDiffCardProps {
  /** Framework-injected translate seat for the `graycode.stagedDiffCard` namespace. */
  t: TranslateNS<'graycode.stagedDiffCard'>
  /** Projected staged entry (host `stagedDiff/list` / `preview` value). */
  entry: StagedEntry
  /** A decision for this entry is in flight (buttons disabled). */
  busy?: boolean
  /** Last decision failure to surface as the conflict hint. */
  error?: StagedDiffCardError | null
  /** Replay/unwired mode: render read-only, buttons disabled. */
  replayOnly?: boolean
  /** Declarative accept entry; absent during replay/unwired hosts. */
  onAccept?: (entry: StagedEntry) => void
  /** Declarative reject entry; absent during replay/unwired hosts. */
  onReject?: (entry: StagedEntry) => void
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  padding: '0.5rem 0.75rem',
  borderRadius: '0.5rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'var(--dsh-text-color, #eee)',
  fontSize: '12px',
  lineHeight: '1.45',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  flexWrap: 'wrap',
}

const pathStyle: CSSProperties = {
  overflowWrap: 'anywhere',
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
}

const badgeStyle: CSSProperties = {
  marginLeft: 'auto',
  padding: '0.0625rem 0.4375rem',
  borderRadius: '999px',
  border: '1px solid currentColor',
  fontSize: '10px',
  whiteSpace: 'nowrap',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: '0.375rem',
  alignItems: 'baseline',
}

const labelStyle: CSSProperties = {
  opacity: 0.65,
  flexShrink: 0,
}

const hintStyle: CSSProperties = {
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid #d29922',
  background: 'rgba(210, 153, 34, 0.08)',
  color: '#d29922',
}

const errorStyle: CSSProperties = {
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid #f85149',
  background: 'rgba(248, 81, 73, 0.08)',
  color: '#f85149',
}

const actionsStyle: CSSProperties = {
  display: 'flex',
  gap: '0.375rem',
  marginTop: '0.125rem',
}

const buttonStyle: CSSProperties = {
  padding: '0.125rem 0.625rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'transparent',
  color: 'inherit',
  fontSize: '11px',
  cursor: 'pointer',
}

const buttonDisabledStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.45,
  cursor: 'not-allowed',
}

const acceptButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: '#3fb950',
  color: '#3fb950',
}

const acceptButtonDisabledStyle: CSSProperties = {
  ...acceptButtonStyle,
  opacity: 0.45,
  cursor: 'not-allowed',
}

const rejectButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: '#f85149',
  color: '#f85149',
}

const rejectButtonDisabledStyle: CSSProperties = {
  ...rejectButtonStyle,
  opacity: 0.45,
  cursor: 'not-allowed',
}

/** Locale-agnostic short time formatting (browser Intl; safe during replay). */
export function formatStagedTime(time: number): string {
  if (!Number.isFinite(time)) return '—'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(time))
}

/**
 * Render a before/after summary line for the card.
 * @returns e.g. "New file · +12" / "Deleted · −8" / "Modified · +3 −1".
 *
 * Zero-count boundaries (an empty file deleted, an empty new file) render
 * the label without a misleading "−0"/"+0" (4.8-L5).
 */
export function formatStagedSummary(t: TranslateNS<'graycode.stagedDiffCard'>, entry: StagedEntry): string {
  const summary = summarizeStagedDiff(entry.before, entry.after)
  const label = t(`summary.${summary.kind}`)
  if (summary.kind === 'modify') {
    return `${label} · +${summary.addedLines} −${summary.removedLines}`
  }
  if (summary.kind === 'create') {
    return summary.addedLines > 0 ? `${label} · +${summary.addedLines}` : label
  }
  return summary.removedLines > 0 ? `${label} · −${summary.removedLines}` : label
}

/**
 * Staged-diff entry card. Mount it inside `StagedDiffBatchList` (or
 * standalone wherever the host renders a single staged entry).
 */
export function StagedDiffCard({
  t,
  entry,
  busy = false,
  error = null,
  replayOnly = false,
  onAccept,
  onReject,
}: StagedDiffCardProps): ReactNode {
  const actionability = stagedEntryActionability(entry.status)
  const tone = STAGED_STATUS_TONE[entry.status]
  const reapply = isStagedReapplyStatus(entry.status)

  const acceptDisabled = !actionability.canAccept || busy || onAccept === undefined
  const rejectDisabled = !actionability.canReject || busy || onReject === undefined
  const replayTitle = replayOnly ? t('replayOnly') : undefined

  return (
    <div
      data-graycode-stageddiff="entry"
      data-status={entry.status}
      data-path={entry.path}
      role="status"
      style={cardStyle}
    >
      <div style={headerStyle}>
        <span style={pathStyle}>{entry.path}</span>
        <span style={{ ...badgeStyle, color: tone }}>{t(stagedStatusLocaleKey(entry.status))}</span>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>{formatStagedSummary(t, entry)}</span>
      </div>

      {reapply && (
        <div style={hintStyle} data-graycode-stageddiff="reapply">
          {t('reapplyHint')}
        </div>
      )}

      <div style={rowStyle}>
        <span style={labelStyle}>{t('updatedAt')}</span>
        <span>{formatStagedTime(entry.updatedAt)}</span>
      </div>

      {error !== null && (
        <div style={errorStyle} data-graycode-stageddiff="error">
          <span>{t(stagedDiffErrorLocaleKey(error))}</span>
          <span> ({error.code})</span>
        </div>
      )}

      {error !== null && error.retryable && (
        <div style={actionsStyle}>
          <button
            type="button"
            data-graycode-stageddiff="retry"
            style={busy || onAccept === undefined ? buttonDisabledStyle : acceptButtonStyle}
            disabled={busy || onAccept === undefined}
            title={onAccept === undefined ? replayTitle : undefined}
            onClick={() => {
              if (!busy && onAccept !== undefined) onAccept(error.entry ?? entry)
            }}
          >
            {t('action.retry')}
          </button>
        </div>
      )}

      {actionability.actionable && (
        <div style={actionsStyle}>
          <button
            type="button"
            data-graycode-stageddiff="accept"
            style={acceptDisabled ? acceptButtonDisabledStyle : acceptButtonStyle}
            disabled={acceptDisabled}
            title={acceptDisabled ? replayTitle : undefined}
            onClick={() => {
              if (!acceptDisabled && onAccept !== undefined) onAccept(entry)
            }}
          >
            {t('action.accept')}
          </button>
          <button
            type="button"
            data-graycode-stageddiff="reject"
            style={rejectDisabled ? rejectButtonDisabledStyle : rejectButtonStyle}
            disabled={rejectDisabled}
            title={rejectDisabled ? replayTitle : undefined}
            onClick={() => {
              if (!rejectDisabled && onReject !== undefined) onReject(entry)
            }}
          >
            {t('action.reject')}
          </button>
        </div>
      )}
    </div>
  )
}
