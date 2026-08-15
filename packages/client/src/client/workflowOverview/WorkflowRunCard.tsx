/**
 * Workflow run entry card (P4-02).
 *
 * Renders one `workflows/list` item: kind badge, workspace label, progress
 * status/phase, document path, timestamps, size, project name, plus
 * declarative session-locate and open-document entries.
 *
 * CLIENT BOUNDARY RULES (DSH_MIGRATION_PLAN.md §P4 / §5.6):
 * - Replay-safe: the card never performs I/O and never touches the workspace.
 *   `path`/`workspace` are plain strings carried by remote data — the
 *   referenced files may no longer exist; the card renders them as text only.
 * - Actions are declarative: the card only invokes the callbacks the host
 *   injected. With no callback (history replay, unwired host) the buttons
 *   render disabled with the `replayOnly` hint.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkflowRunKind } from './types.ts'
import {
  formatWorkflowRunSize,
  formatWorkflowRunTime,
  workflowRunTimeIso,
  type WorkflowRunView,
} from './viewModel.ts'

/** Composed props for one workflow run card. */
export interface WorkflowRunCardProps {
  /** Framework-injected translate seat for the `graycode.workflowOverview` namespace. */
  t: TranslateNS<'graycode.workflowOverview'>
  /** Normalized run view (built by viewModel.ts). */
  run: WorkflowRunView
  /**
   * Declarative locate-session entry. Absent during replay/unwired hosts —
   * the button then renders disabled (no I/O is ever initiated by the card).
   */
  onLocateSession?: (run: WorkflowRunView) => void
  /** Declarative open-document entry (same replay rule). */
  onOpenDocument?: (run: WorkflowRunView) => void
}

/** Kind badge tones (kept in the card; no CSS module in the skeleton). */
const KIND_TONE: Record<WorkflowRunKind, string> = {
  progress: '#58a6ff',
  design: '#bc8cff',
  plan: '#d29922',
  review: '#3fb950',
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
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  flexWrap: 'wrap',
}

const kindBadgeStyle: CSSProperties = {
  padding: '0.0625rem 0.4375rem',
  borderRadius: '999px',
  border: '1px solid currentColor',
  fontSize: '10px',
  whiteSpace: 'nowrap',
}

const chipStyle: CSSProperties = {
  padding: '0.0625rem 0.4375rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  fontSize: '10px',
  whiteSpace: 'nowrap',
  opacity: 0.85,
}

const workspaceStyle: CSSProperties = {
  fontSize: '10px',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  opacity: 0.7,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '12rem',
}

const timeStyle: CSSProperties = {
  marginLeft: 'auto',
  fontSize: '10px',
  opacity: 0.7,
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

/** Render the size row content (value + translated unit, or a neutral dash). */
function renderSize(t: TranslateNS<'graycode.workflowOverview'>, run: WorkflowRunView): ReactNode {
  const size = formatWorkflowRunSize(run.sizeBytes)
  if (size === null) return '—'
  return (
    <span>
      {size.value} {t(size.unitKey)}
    </span>
  )
}

/**
 * One workflow run entry. Mount it inside the overview list
 * (WorkflowRunList.tsx); the list is wired by the main session
 * (workflowOverview/README.md).
 */
export function WorkflowRunCard({ t, run, onLocateSession, onOpenDocument }: WorkflowRunCardProps): ReactNode {
  const locateDisabled = onLocateSession === undefined
  const openDisabled = onOpenDocument === undefined

  return (
    <article
      data-graycode-workflow-overview="card"
      data-kind={run.kind}
      data-status={run.status ?? undefined}
      data-phase={run.phase ?? undefined}
      style={cardStyle}
    >
      <header style={headerStyle}>
        <span style={{ ...kindBadgeStyle, color: KIND_TONE[run.kind] }}>
          {run.kindLabelKey !== null ? t(run.kindLabelKey) : run.kind}
        </span>
        {run.projectName !== null && <span style={chipStyle}>{run.projectName}</span>}
        {run.statusLabelKey !== null && <span style={chipStyle}>{t(run.statusLabelKey)}</span>}
        {run.phaseLabelKey !== null && <span style={chipStyle}>{t(run.phaseLabelKey)}</span>}
        <span style={workspaceStyle} title={run.workspace}>
          {run.workspaceLabel}
        </span>
        <time style={timeStyle} dateTime={workflowRunTimeIso(run.updatedAt) ?? undefined}>
          {formatWorkflowRunTime(run.updatedAt)}
        </time>
      </header>

      <div style={rowStyle} data-graycode-workflow-overview="path">
        <span style={labelStyle}>{t('run.workspace')}</span>
        <span style={valueStyle} title={run.workspace}>
          {run.workspace}
        </span>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>{t('run.project')}</span>
        <span>{run.projectName ?? '—'}</span>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>{t('run.size')}</span>
        <span>{renderSize(t, run)}</span>
      </div>

      <div style={actionsStyle}>
        <button
          type="button"
          data-graycode-workflow-overview="locate"
          style={locateDisabled ? buttonDisabledStyle : buttonStyle}
          disabled={locateDisabled}
          title={locateDisabled ? t('state.replayOnly') : undefined}
          onClick={() => {
            if (onLocateSession !== undefined) onLocateSession(run)
          }}
        >
          {t('run.locateSession')}
        </button>
        <button
          type="button"
          data-graycode-workflow-overview="open"
          style={openDisabled ? buttonDisabledStyle : buttonStyle}
          disabled={openDisabled}
          title={openDisabled ? t('state.replayOnly') : undefined}
          onClick={() => {
            if (onOpenDocument !== undefined) onOpenDocument(run)
          }}
        >
          {t('run.openDocument')}
        </button>
      </div>
    </article>
  )
}
