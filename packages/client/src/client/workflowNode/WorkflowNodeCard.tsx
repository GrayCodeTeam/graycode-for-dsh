/**
 * Workflow conversation node card (P4-01).
 *
 * Renders one Gray workflow tool call (create/update_design,
 * create/update_progress, create_review, …) as a dedicated node card in the
 * conversation flow: tool name, status badge
 * (draft/active/completed/failed/cancelled), document path, timestamps, error
 * and retry entry.
 *
 * CLIENT BOUNDARY RULES (PLAN_V2 §5.6):
 * - Replay-safe: the card never performs I/O and never touches the workspace.
 *   `path` is a plain string carried by event data — the referenced file may
 *   no longer exist; the card renders it as text only.
 * - Open/retry are declarative: the card only invokes the callbacks the host
 *   injected. With no callback (history replay, unwired host) the buttons
 *   render disabled with the `replayOnly` hint.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { workflowToolLocaleKey } from './tools.ts'
import type { WorkflowNodeData, WorkflowToolStatus } from './types.ts'

/** Composed props for the workflow node card. */
export interface WorkflowNodeCardProps {
  /** Framework-injected translate seat for the `graycode.workflow` namespace. */
  t: TranslateNS<'graycode.workflow'>
  /** Projected workflow tool node payload (built by the workflow Definition). */
  node: WorkflowNodeData
  /**
   * Declarative open-document entry. Absent during replay/unwired hosts —
   * the button then renders disabled (no I/O is ever initiated by the card).
   */
  onOpenDocument?: (path: string) => void
  /** Declarative retry entry; only meaningful for failed/cancelled nodes. */
  onRetry?: (node: WorkflowNodeData) => void
}

/** Status badge tones (kept in the card; no CSS module in the skeleton). */
const STATUS_TONE: Record<WorkflowToolStatus, string> = {
  draft: '#8b949e',
  active: '#58a6ff',
  completed: '#3fb950',
  failed: '#f85149',
  cancelled: '#8b949e',
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
  minWidth: '260px',
  maxWidth: '420px',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  flexWrap: 'wrap',
}

const familyStyle: CSSProperties = {
  fontSize: '10px',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  opacity: 0.7,
}

const statusStyle: CSSProperties = {
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

const valueStyle: CSSProperties = {
  overflowWrap: 'anywhere',
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
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

/** Locale-agnostic short time formatting (browser Intl; safe during replay). */
export function formatWorkflowTime(time: number): string {
  if (!Number.isFinite(time)) return '—'
  const date = new Date(time)
  // Finite but out-of-range epochs make an Invalid Date whose Intl formatting
  // throws a RangeError — degrade to the neutral dash instead of crashing the
  // render (audit M3).
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

/**
 * Workflow node card. Mount it wherever the host renders chat view nodes of
 * kind `graycode.workflow` (see workflowNode/README.md for wiring).
 */
export function WorkflowNodeCard({ t, node, onOpenDocument, onRetry }: WorkflowNodeCardProps): ReactNode {
  const toolLabel = workflowToolLocaleKey(node.tool)
  const tone = STATUS_TONE[node.status]
  const canOpen = node.path !== null && onOpenDocument !== undefined
  const canRetry = node.retryable && onRetry !== undefined
  const openDisabled = node.path === null || onOpenDocument === undefined
  const retryDisabled = !node.retryable || onRetry === undefined

  return (
    <div
      data-graycode-workflow="node"
      data-tool={node.tool}
      data-status={node.status}
      data-family={node.family ?? undefined}
      data-retryable={node.retryable}
      role="status"
      style={cardStyle}
    >
      <div style={headerStyle}>
        {node.family !== null && <span style={familyStyle}>{t(`family.${node.family}`)}</span>}
        <span>{toolLabel !== null ? t(toolLabel) : node.tool}</span>
        <span style={{ ...statusStyle, color: tone }}>{t(`status.${node.status}`)}</span>
      </div>

      {node.summary !== null && (
        <div style={rowStyle}>
          <span style={labelStyle}>{t('summary')}</span>
          <span>{node.summary}</span>
        </div>
      )}

      <div style={rowStyle}>
        <span style={labelStyle}>{t('path')}</span>
        <span style={valueStyle}>{node.path ?? '—'}</span>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>{t('calledAt')}</span>
        <span>{formatWorkflowTime(node.calledAt)}</span>
      </div>

      {node.resultAt !== null && (
        <div style={rowStyle}>
          <span style={labelStyle}>{t('completedAt')}</span>
          <span>{formatWorkflowTime(node.resultAt)}</span>
        </div>
      )}

      {node.error !== null && (
        <div style={errorStyle} data-graycode-workflow="error">
          <span>
            {t('error')}: {node.error.code} — {node.error.name}
          </span>
          {node.error.message !== undefined && <div>{node.error.message}</div>}
        </div>
      )}

      {(node.path !== null || node.retryable) && (
        <div style={actionsStyle}>
          {node.path !== null && (
            <button
              type="button"
              data-graycode-workflow="open"
              style={openDisabled ? buttonDisabledStyle : buttonStyle}
              disabled={openDisabled}
              title={openDisabled ? t('replayOnly') : undefined}
              onClick={() => {
                if (canOpen && node.path !== null) onOpenDocument(node.path)
              }}
            >
              {t('openDocument')}
            </button>
          )}
          {node.retryable && (
            <button
              type="button"
              data-graycode-workflow="retry"
              style={retryDisabled ? buttonDisabledStyle : buttonStyle}
              disabled={retryDisabled}
              title={retryDisabled ? t('replayOnly') : undefined}
              onClick={() => {
                if (canRetry) onRetry(node)
              }}
            >
              {t('retry')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
