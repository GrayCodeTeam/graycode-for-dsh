/**
 * Checkpoint list — list panel (P4-04).
 *
 * Renders the store state (store.ts) with cursor pagination (load-more),
 * empty / loading / error states, the total counter and the mock-source
 * notice. The component is stateless and replay-safe: it never performs I/O;
 * every action is a declarative callback the host wires to the store
 * (`onLoadNextPage`, `onRetry`, `onToggleExpand`, optional `onVerify`).
 *
 * State mapping:
 * - error + no entries        → error panel (hint text + retry);
 * - loading + no entries      → loading panel;
 * - ready + no entries        → empty panel;
 * - otherwise                 → item list (+ inline error banner while
 *   entries exist, load-more / loading-more footer).
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CheckpointListItem } from './CheckpointListItem.tsx'
import type { CheckpointListStoreState } from './types.ts'

export interface CheckpointListProps {
  t: TranslateNS<'graycode.checkpointList'>
  /** Store snapshot (from createCheckpointListStore). */
  state: CheckpointListStoreState
  /** Host wires this to store.loadNextPage(). */
  onLoadNextPage: () => void
  /** Host wires this to store.loadFirstPage() (empty retry) / loadNextPage() (append retry). */
  onRetry: () => void
  /** Host wires this to store.toggleExpand(id). */
  onToggleExpand: (id: string) => void
  /** Declarative verify entry; absent → verify badge stays read-only (replay/unwired). */
  onVerify?: (checkpointId: string) => void
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.5rem 0.75rem',
  borderRadius: '0.5rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'var(--dsh-text-color, #eee)',
  fontSize: '12px',
  lineHeight: '1.45',
  minWidth: '280px',
  maxWidth: '560px',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'baseline',
  flexWrap: 'wrap',
}

const labelStyle: CSSProperties = {
  opacity: 0.65,
}

const valueStyle: CSSProperties = {
  overflowWrap: 'anywhere',
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
}

const noticeStyle: CSSProperties = {
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px dashed #8b949e',
  color: '#8b949e',
  fontSize: '11px',
}

const itemsStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
}

const footerStyle: CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
  flexWrap: 'wrap',
}

const errorRowStyle: CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
  flexWrap: 'wrap',
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid #f85149',
  background: 'rgba(248, 81, 73, 0.08)',
  color: '#f85149',
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

/**
 * Checkpoint list panel. Mount it with a store snapshot and declarative
 * callbacks (see checkpointList/README.md for wiring).
 */
export function CheckpointList({
  t,
  state,
  onLoadNextPage,
  onRetry,
  onToggleExpand,
  onVerify,
}: CheckpointListProps): ReactNode {
  const entries = state.entries

  if (state.loadState === 'error' && entries.length === 0) {
    return (
      <div data-graycode-checkpoint-list="error" style={panelStyle}>
        <div style={errorRowStyle}>
          <span>{state.error !== null ? t(state.error.messageKey) : t('error.unknown')}</span>
          <button type="button" data-graycode-checkpoint-list="retry" style={buttonStyle} onClick={onRetry}>
            {t('list.retry')}
          </button>
        </div>
      </div>
    )
  }

  if (state.loadState === 'loading' && entries.length === 0) {
    return (
      <div data-graycode-checkpoint-list="loading" style={panelStyle}>
        {t('list.loading')}
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div data-graycode-checkpoint-list="empty" style={panelStyle}>
        {t('list.empty')}
      </div>
    )
  }

  return (
    <div data-graycode-checkpoint-list="list" style={panelStyle}>
      {state.sourceKind === 'mock' && (
        <div data-graycode-checkpoint-list="mockNotice" style={noticeStyle}>
          {t('mock.notice')}
        </div>
      )}
      <div style={headerStyle}>
        <span style={labelStyle}>{t('list.title')}</span>
        <span style={labelStyle}>{t('list.workspace')}</span>
        <span style={valueStyle}>{state.workspaceId}</span>
        {state.total !== null && (
          <span style={labelStyle}>
            {t('list.total')}: {state.total}
          </span>
        )}
      </div>

      <div style={itemsStyle}>
        {entries.map(item => (
          <CheckpointListItem
            key={item.id}
            t={t}
            item={item}
            expanded={item.id === state.expandedId}
            onToggleExpand={onToggleExpand}
            onVerify={onVerify}
          />
        ))}
      </div>

      <div style={footerStyle}>
        {state.loadState === 'error' && (
          <div data-graycode-checkpoint-list="errorBanner" style={errorRowStyle}>
            <span>{state.error !== null ? t(state.error.messageKey) : t('error.unknown')}</span>
            <button type="button" data-graycode-checkpoint-list="retry" style={buttonStyle} onClick={onRetry}>
              {t('list.retry')}
            </button>
          </div>
        )}
        {state.loadState === 'loading' ? (
          <span style={labelStyle}>{t('list.loadingMore')}</span>
        ) : (
          state.hasMore && (
            <button
              type="button"
              data-graycode-checkpoint-list="loadMore"
              style={buttonStyle}
              onClick={onLoadNextPage}
            >
              {t('list.loadMore')}
            </button>
          )
        )}
      </div>
    </div>
  )
}
