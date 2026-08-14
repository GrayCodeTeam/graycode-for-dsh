/**
 * Workflow run list (P4-02) — list body with paging and the empty / loading /
 * error states.
 *
 * Pure presentation: the accumulated page state (paging.ts) drives
 * everything. Loading covers the first page; a later-page failure keeps the
 * loaded entries and shows an inline error with a retry entry; a full failure
 * with no entries shows the error state (retry only for retryable codes per
 * errors.ts). "Load more" appears while the host reports more pages and is
 * disabled while a page is in flight.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { workflowOverviewErrorHint } from './errors.ts'
import type { WorkflowOverviewPageState } from './paging.ts'
import type { WorkflowRunView } from './viewModel.ts'
import { WorkflowRunCard } from './WorkflowRunCard.tsx'

/** Composed props for the overview list body. */
export interface WorkflowRunListProps {
  /** Framework-injected translate seat for the `graycode.workflowOverview` namespace. */
  t: TranslateNS<'graycode.workflowOverview'>
  /** Accumulated page state (paging.ts). */
  page: WorkflowOverviewPageState
  /** Declarative load-more / retry entry (panel wires it; absent → no button). */
  onLoadMore?: () => void
  /** Declarative locate-session entry (forwarded to each card). */
  onLocateSession?: (run: WorkflowRunView) => void
  /** Declarative open-document entry (forwarded to each card). */
  onOpenDocument?: (run: WorkflowRunView) => void
}

const stateStyle: CSSProperties = {
  padding: '1rem 0.75rem',
  borderRadius: '0.5rem',
  border: '1px dashed var(--dsh-border-color, #333)',
  color: 'var(--dsh-text-color, #eee)',
  fontSize: '12px',
  opacity: 0.8,
}

const errorStateStyle: CSSProperties = {
  ...stateStyle,
  border: '1px solid #f85149',
  background: 'rgba(248, 81, 73, 0.08)',
  color: '#f85149',
  opacity: 1,
}

const errorDetailStyle: CSSProperties = {
  marginTop: '0.25rem',
  fontSize: '11px',
  opacity: 0.8,
  overflowWrap: 'anywhere',
}

const inlineErrorStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginTop: '0.5rem',
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid #f85149',
  background: 'rgba(248, 81, 73, 0.08)',
  color: '#f85149',
  fontSize: '11px',
}

const totalStyle: CSSProperties = {
  fontSize: '11px',
  opacity: 0.7,
  marginBottom: '0.375rem',
}

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
}

const actionsStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  marginTop: '0.5rem',
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

const buttonDisabledStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.45,
  cursor: 'not-allowed',
}

/**
 * List body. Renders exactly one of: loading (first page), error (no
 * entries), empty, or the entry list (+ load more / inline error).
 */
export function WorkflowRunList({ t, page, onLoadMore, onLocateSession, onOpenDocument }: WorkflowRunListProps): ReactNode {
  const errorHint = page.error !== null ? workflowOverviewErrorHint(page.error.code) : null
  const retryable = errorHint?.retryable ?? false

  if (page.phase === 'loading' && page.entries.length === 0) {
    return (
      <div data-graycode-workflow-overview="loading" role="status" style={stateStyle}>
        {t('state.loading')}
      </div>
    )
  }

  if (page.phase === 'error' && page.entries.length === 0) {
    return (
      <div data-graycode-workflow-overview="error" role="alert" style={errorStateStyle}>
        <div>
          {t('state.error')}: {errorHint !== null ? t(errorHint.key) : t('error.unknown')}
        </div>
        {page.error !== null && page.error.message.length > 0 && (
          <div style={errorDetailStyle}>{page.error.message}</div>
        )}
        {retryable && onLoadMore !== undefined && (
          <button
            type="button"
            data-graycode-workflow-overview="retry"
            style={{ ...buttonStyle, marginTop: '0.375rem' }}
            onClick={onLoadMore}
          >
            {t('state.errorRetry')}
          </button>
        )}
      </div>
    )
  }

  if (page.phase === 'ready' && page.entries.length === 0) {
    return (
      <div data-graycode-workflow-overview="empty" style={stateStyle}>
        {t('list.empty')}
      </div>
    )
  }

  return (
    <div data-graycode-workflow-overview="list">
      <div style={totalStyle}>
        <span>{page.total}</span> <span>{t('list.total')}</span>
      </div>
      <div style={listStyle}>
        {page.entries.map((run) => (
          <WorkflowRunCard
            key={run.id}
            t={t}
            run={run}
            onLocateSession={onLocateSession}
            onOpenDocument={onOpenDocument}
          />
        ))}
      </div>

      {page.hasMore && (
        <div style={actionsStyle}>
          <button
            type="button"
            data-graycode-workflow-overview="load-more"
            style={page.phase === 'loading' ? buttonDisabledStyle : buttonStyle}
            disabled={page.phase === 'loading'}
            onClick={onLoadMore}
          >
            {t('list.loadMore')}
          </button>
        </div>
      )}

      {page.phase === 'error' && page.entries.length > 0 && (
        <div data-graycode-workflow-overview="error-inline" role="alert" style={inlineErrorStyle}>
          <span>
            {t('state.error')}: {errorHint !== null ? t(errorHint.key) : t('error.unknown')}
          </span>
          {retryable && onLoadMore !== undefined && (
            <button type="button" data-graycode-workflow-overview="retry" style={buttonStyle} onClick={onLoadMore}>
              {t('state.errorRetry')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
