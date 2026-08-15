/**
 * Checkpoint list — item row with expandable details (P4-04).
 *
 * Renders one checkpoint list item: type chip, id, created time, snapshot
 * size, file count, parent-chain label, verify badge (read-only) and an
 * expand toggle. The expanded detail shows the parent chain, phase, tool,
 * conversation, excluded count and content hash, plus the read-only verify
 * section with an optional declarative `onVerify` entry (absent during replay
 * or when the host bridge is unwired — the button then renders disabled).
 *
 * CLIENT BOUNDARY RULES (PLAN_V2 §5.6): the item never performs I/O; it only
 * renders what the store handed it and invokes declarative callbacks.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CheckpointVerifyBadge } from './CheckpointVerifyBadge.tsx'
import {
  checkpointOriginLabelKey,
  checkpointPhaseLabelKey,
  checkpointTypeLabelKey,
  formatCheckpointBytes,
  formatCheckpointTime,
  shouldShowCheckpointOriginBadge,
  shortCheckpointId,
} from './viewModel.ts'
import type { CheckpointChainLink, CheckpointListItemVM } from './types.ts'

export interface CheckpointListItemProps {
  t: TranslateNS<'graycode.checkpointList'>
  item: CheckpointListItemVM
  expanded: boolean
  /** Declarative expand toggle (host wires it to store.toggleExpand). */
  onToggleExpand: (id: string) => void
  /**
   * Declarative verify entry. Absent during replay/unwired hosts — the button
   * then renders disabled (no I/O is ever initiated by the item).
   */
  onVerify?: (checkpointId: string) => void
}

const itemStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '0.375rem 0.625rem',
  borderRadius: '0.375rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
  flexWrap: 'wrap',
  fontSize: '12px',
  lineHeight: '1.45',
}

const typeChipStyle: CSSProperties = {
  padding: '0.0625rem 0.375rem',
  borderRadius: '999px',
  border: '1px solid currentColor',
  fontSize: '10px',
  whiteSpace: 'nowrap',
  color: '#58a6ff',
}

/** Origin badge (only 'auto' snapshots render one). */
const originBadgeStyle: CSSProperties = {
  padding: '0.0625rem 0.375rem',
  borderRadius: '999px',
  border: '1px solid currentColor',
  fontSize: '10px',
  whiteSpace: 'nowrap',
  color: '#bc8cff',
}

const idStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  overflowWrap: 'anywhere',
}

const labelStyle: CSSProperties = {
  opacity: 0.65,
}

const valueStyle: CSSProperties = {
  overflowWrap: 'anywhere',
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
}

const detailsStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '0.375rem 0.5rem',
  borderRadius: '0.25rem',
  background: 'rgba(127, 127, 127, 0.08)',
  fontSize: '11px',
  lineHeight: '1.45',
}

const chainStyle: CSSProperties = {
  display: 'flex',
  gap: '0.375rem',
  flexWrap: 'wrap',
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

/** Parent-chain display (bounded links + truncation hint). */
export function CheckpointChainList({
  t,
  chain,
  truncated,
}: {
  t: TranslateNS<'graycode.checkpointList'>
  chain: readonly CheckpointChainLink[]
  truncated: boolean
}): ReactNode {
  if (chain.length === 0) {
    return <span style={labelStyle}>{t('item.parentNone')}</span>
  }
  const tailTruncated = truncated && !chain.some(link => link.beyondWindow)
  return (
    <span style={chainStyle} data-graycode-checkpoint-list="chain">
      {chain.map(link => (
        <span
          key={`${link.depth}-${link.id}`}
          style={valueStyle}
          data-graycode-checkpoint-list="chainLink"
          data-beyond-window={link.beyondWindow || undefined}
        >
          #{link.depth} {shortCheckpointId(link.id)}
          {link.beyondWindow && <span style={labelStyle}> {t('item.chainMore')}</span>}
        </span>
      ))}
      {tailTruncated && <span style={labelStyle}>{t('item.chainMore')}</span>}
    </span>
  )
}

/** One checkpoint list item (row + expandable details). */
export function CheckpointListItem({
  t,
  item,
  expanded,
  onToggleExpand,
  onVerify,
}: CheckpointListItemProps): ReactNode {
  const verifyDisabled = onVerify === undefined
  return (
    <div data-graycode-checkpoint-list="item" data-checkpoint-id={item.id} data-type={item.type} style={itemStyle}>
      <div style={rowStyle}>
        <span data-graycode-checkpoint-list="typeChip" style={typeChipStyle}>
          {t(checkpointTypeLabelKey(item.type))}
        </span>
        {shouldShowCheckpointOriginBadge(item.origin) && (
          <span data-graycode-checkpoint-list="originBadge" data-origin={item.origin} style={originBadgeStyle}>
            {t(checkpointOriginLabelKey(item.origin))}
          </span>
        )}
        <span style={idStyle}>{item.id}</span>
        <span style={labelStyle}>{formatCheckpointTime(item.timestamp)}</span>
        <span style={labelStyle}>
          {t('item.size')}: {formatCheckpointBytes(item.backupBytes)}
        </span>
        <span style={labelStyle}>
          {t('item.files')}: {item.fileCount}
        </span>
        <span style={labelStyle} data-graycode-checkpoint-list="parentLabel">
          {t('item.parent')}: {item.parentId === null ? t('item.parentNone') : shortCheckpointId(item.parentId)}
        </span>
        <CheckpointVerifyBadge t={t} state={item.verifyState} />
        <button
          type="button"
          data-graycode-checkpoint-list="expand"
          style={buttonStyle}
          onClick={() => onToggleExpand(item.id)}
        >
          {t(expanded ? 'item.collapse' : 'item.expand')}
        </button>
      </div>

      {expanded && (
        <div data-graycode-checkpoint-list="details" style={detailsStyle}>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('item.createdAt')}</span>
            <span>{formatCheckpointTime(item.timestamp)}</span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('item.phase')}</span>
            <span>{t(checkpointPhaseLabelKey(item.phase))}</span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('item.tool')}</span>
            <span>{item.toolName}</span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('item.conversation')}</span>
            <span style={valueStyle}>{item.conversationId}</span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('item.messageIndex')}</span>
            <span>{item.messageIndex}</span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('item.excluded')}</span>
            <span>{item.excludedCount}</span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('item.contentHash')}</span>
            <span style={valueStyle}>{shortCheckpointId(item.contentHash)}</span>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('item.chain')}</span>
            <CheckpointChainList t={t} chain={item.chain} truncated={item.chainTruncated} />
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>{t('verify.title')}</span>
            <CheckpointVerifyBadge t={t} state={item.verifyState} />
            <span style={labelStyle}>{t('verify.readonly')}</span>
            <button
              type="button"
              data-graycode-checkpoint-list="verify"
              style={verifyDisabled ? buttonDisabledStyle : buttonStyle}
              disabled={verifyDisabled}
              title={verifyDisabled ? t('verify.replayOnly') : undefined}
              onClick={() => {
                if (!verifyDisabled) onVerify(item.id)
              }}
            >
              {t('verify.run')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
