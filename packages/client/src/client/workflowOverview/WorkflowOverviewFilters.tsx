/**
 * Workflow overview filters (P4-02) — workspace / session filter row.
 *
 * Controlled inputs: the panel owns the values. The session filter renders
 * disabled with a hint while the host does not support it (rc.6 —
 * GAP-remote-1, see query.ts), so the user's intent is never silently
 * dropped: the seat is visible but inert until the host contract grows a
 * session field.
 *
 * The form submits on Enter (apply) and never performs I/O itself — the
 * apply/reset callbacks are declarative.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** Composed props for the filter row. */
export interface WorkflowOverviewFiltersProps {
  /** Framework-injected translate seat for the `graycode.workflowOverview` namespace. */
  t: TranslateNS<'graycode.workflowOverview'>
  /** Current workspace input value (controlled by the panel). */
  workspace: string
  /** Current session input value (controlled by the panel). */
  sessionId: string
  /** Whether the host supports session filtering (query.ts capability flag). */
  sessionFilterAvailable: boolean
  onWorkspaceChange: (value: string) => void
  onSessionChange: (value: string) => void
  /** Apply the current inputs (panel resets the page and refetches). */
  onApply: () => void
  /** Reset inputs and filters. */
  onReset: () => void
}

const filtersStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: '0.75rem',
  flexWrap: 'wrap',
  padding: '0.5rem 0.75rem',
  borderRadius: '0.5rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'var(--dsh-text-color, #eee)',
  fontSize: '12px',
  marginBottom: '0.5rem',
}

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  minWidth: '14rem',
  flex: '1 1 14rem',
}

const labelStyle: CSSProperties = {
  fontSize: '10px',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  opacity: 0.7,
}

const inputStyle: CSSProperties = {
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'inherit',
  fontSize: '12px',
}

const hintStyle: CSSProperties = {
  fontSize: '10px',
  opacity: 0.7,
}

const actionsStyle: CSSProperties = {
  display: 'flex',
  gap: '0.375rem',
  paddingBottom: '0.0625rem',
}

const buttonStyle: CSSProperties = {
  padding: '0.25rem 0.875rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'transparent',
  color: 'inherit',
  fontSize: '12px',
  cursor: 'pointer',
}

/**
 * Filter row. Controlled; submits on Enter; session input disabled on rc.6.
 */
export function WorkflowOverviewFilters({
  t,
  workspace,
  sessionId,
  sessionFilterAvailable,
  onWorkspaceChange,
  onSessionChange,
  onApply,
  onReset,
}: WorkflowOverviewFiltersProps): ReactNode {
  return (
    <form
      data-graycode-workflow-overview="filters"
      style={filtersStyle}
      onSubmit={(event) => {
        event.preventDefault()
        onApply()
      }}
    >
      <label style={fieldStyle}>
        <span style={labelStyle}>{t('filter.workspace')}</span>
        <input
          type="text"
          value={workspace}
          placeholder={t('filter.workspacePlaceholder')}
          onChange={(event) => onWorkspaceChange(event.target.value)}
          style={inputStyle}
        />
      </label>
      <label style={fieldStyle}>
        <span style={labelStyle}>{t('filter.session')}</span>
        <input
          type="text"
          value={sessionId}
          placeholder={t('filter.sessionPlaceholder')}
          disabled={!sessionFilterAvailable}
          title={sessionFilterAvailable ? undefined : t('filter.sessionUnavailable')}
          onChange={(event) => onSessionChange(event.target.value)}
          style={inputStyle}
          data-graycode-workflow-overview="session-filter"
        />
        {!sessionFilterAvailable && <span style={hintStyle}>{t('filter.sessionUnavailable')}</span>}
      </label>
      <div style={actionsStyle}>
        <button type="submit" data-graycode-workflow-overview="apply" style={buttonStyle}>
          {t('filter.apply')}
        </button>
        <button type="button" data-graycode-workflow-overview="reset" style={buttonStyle} onClick={onReset}>
          {t('filter.reset')}
        </button>
      </div>
    </form>
  )
}
