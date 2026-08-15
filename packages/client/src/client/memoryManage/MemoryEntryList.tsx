/**
 * Memory entry list (P4-03 / audit M-03).
 *
 * Renders the accumulated entry pages: per-row selection checkbox, content
 * (with query-match highlighting), date, source marker (scope badge), and the
 * explicit edit / forget actions. A header row offers select-all over the
 * currently loaded page. The forget confirmation bar mounts inline per row
 * when the forget machine is armed for that entry.
 *
 * CLIENT BOUNDARY RULES: pure presentation — no I/O, no timers. Actions are
 * declarative callbacks owned by the panel (which owns the transports and the
 * forget/batch state machines). In replay/unwired mode (`wired: false`) the
 * action buttons and checkboxes render disabled with the `replayOnly` hint.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgetState, MemoryEntryViewModel, MemoryMatchRange } from './logic.ts'
import { ForgetConfirmBar } from './ForgetConfirm.tsx'

/** Composed props for the entry list. */
export interface MemoryEntryListProps {
  t: TranslateNS<'graycode.memoryManage'>
  /** Accumulated entries of the current query/scope. */
  items: readonly MemoryEntryViewModel[]
  /** False in replay/unwired mode — actions render disabled. */
  wired: boolean
  /** Forget machine state (rows show the confirm bar for their own target). */
  forget: ForgetState
  /** Selected entry ids (M-03 multi-select). */
  selectedIds: readonly number[]
  /** Whether the whole loaded page is selected (header checkbox state). */
  allSelected: boolean
  /** True while a destructive batch operation is in flight (lock the checkboxes). */
  selectionDisabled?: boolean
  onEdit: (entry: MemoryEntryViewModel) => void
  onForgetRequest: (entry: MemoryEntryViewModel) => void
  onForgetConfirm: () => void
  onForgetCancel: () => void
  /** Toggle one row's selection. */
  onToggleSelect: (id: number) => void
  /** Header select-all toggle (current loaded page). */
  onToggleSelectAll: () => void
}

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  listStyle: 'none',
  margin: 0,
  padding: 0,
}

const selectBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  fontSize: '11px',
  marginBottom: '0.125rem',
}

const selectAllLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  cursor: 'pointer',
  userSelect: 'none',
}

const selectAllHintStyle: CSSProperties = {
  fontSize: '10px',
  opacity: 0.6,
}

const rowSelectStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '10px',
  opacity: 0.8,
}

const selectLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  cursor: 'pointer',
  userSelect: 'none',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '0.5rem 0.625rem',
  borderRadius: '0.5rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
}

const textStyle: CSSProperties = {
  fontSize: '12px',
  lineHeight: '1.45',
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
}

const highlightStyle: CSSProperties = {
  background: 'rgba(88, 166, 255, 0.28)',
  color: 'inherit',
  borderRadius: '0.125rem',
  padding: '0 0.0625rem',
}

const metaStyle: CSSProperties = {
  display: 'flex',
  gap: '0.625rem',
  alignItems: 'center',
  flexWrap: 'wrap',
  fontSize: '10px',
  opacity: 0.75,
}

const labelStyle: CSSProperties = {
  opacity: 0.65,
}

const sourceBadgeStyle: CSSProperties = {
  padding: '0.0625rem 0.375rem',
  borderRadius: '999px',
  border: '1px solid currentColor',
  whiteSpace: 'nowrap',
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

const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: '#f85149',
  color: '#f85149',
}

const buttonDisabledStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.45,
  cursor: 'not-allowed',
}

/** Render the entry text with query matches wrapped in <mark> segments. */
function renderHighlighted(text: string, ranges: readonly MemoryMatchRange[]): ReactNode {
  if (ranges.length === 0) return text
  const nodes: ReactNode[] = []
  let from = 0
  for (const range of ranges) {
    if (range.end <= from) continue // defensive: skip degenerate/overlapping ranges
    const start = Math.max(range.start, from)
    if (start > from) nodes.push(text.slice(from, start))
    nodes.push(
      <mark key={nodes.length} data-graycode-memory="highlight" style={highlightStyle}>
        {text.slice(start, range.end)}
      </mark>,
    )
    from = range.end
  }
  if (from < text.length) nodes.push(text.slice(from))
  return nodes
}

/**
 * Entry list of the memory management panel.
 */
export function MemoryEntryList({
  t,
  items,
  wired,
  forget,
  selectedIds,
  allSelected,
  selectionDisabled = false,
  onEdit,
  onForgetRequest,
  onForgetConfirm,
  onForgetCancel,
  onToggleSelect,
  onToggleSelectAll,
}: MemoryEntryListProps): ReactNode {
  const selectable = wired && !selectionDisabled
  return (
    <div>
      <div data-graycode-memory="select-bar" style={selectBarStyle}>
        <label style={selectAllLabelStyle} title={t('list.selectAllHint')}>
          <input
            type="checkbox"
            data-graycode-memory="select-all"
            checked={allSelected}
            disabled={!selectable}
            onChange={() => { if (selectable) onToggleSelectAll() }}
          />
          <span>{t('list.selectAll')}</span>
        </label>
        <span data-graycode-memory="select-all-hint" style={selectAllHintStyle}>
          {t('list.selectAllHint')}
        </span>
      </div>
      <ul data-graycode-memory="list" style={listStyle}>
        {items.map(entry => {
          const armed =
            forget.target !== null
            && forget.target.id === entry.id
            && (forget.phase === 'confirming' || forget.phase === 'submitting' || forget.phase === 'error')
          const busy = forget.phase === 'submitting' && armed
          const selected = selectedIds.includes(entry.id)
          return (
            <li key={entry.id} data-graycode-memory="entry" data-entry-id={entry.id} data-scope={entry.scope} style={rowStyle}>
              <div style={rowSelectStyle}>
                <label style={selectLabelStyle} title={`#${entry.id}`}>
                  <input
                    type="checkbox"
                    data-graycode-memory="select"
                    data-entry-id={entry.id}
                    checked={selected}
                    disabled={!selectable}
                    onChange={() => { if (selectable) onToggleSelect(entry.id) }}
                  />
                  <span>#{entry.id}</span>
                </label>
              </div>
              <div style={textStyle}>{renderHighlighted(entry.text, entry.highlight)}</div>
              <div style={metaStyle}>
                <span>
                  <span style={labelStyle}>{t('entry.date')}</span> {entry.date}
                </span>
                <span data-graycode-memory="source" data-scope={entry.scope} style={sourceBadgeStyle}>
                  {t('entry.source')}: {t(`scope.${entry.scope}`)}
                </span>
              </div>
              <div style={actionsStyle}>
                <button
                  type="button"
                  data-graycode-memory="edit"
                  style={wired ? buttonStyle : buttonDisabledStyle}
                  disabled={!wired}
                  title={wired ? undefined : t('replayOnly')}
                  onClick={() => { if (wired) onEdit(entry) }}
                >
                  {t('entry.edit')}
                </button>
                <button
                  type="button"
                  data-graycode-memory="forget"
                  style={wired ? dangerButtonStyle : buttonDisabledStyle}
                  disabled={!wired || busy}
                  title={wired ? undefined : t('replayOnly')}
                  onClick={() => { if (wired && !busy) onForgetRequest(entry) }}
                >
                  {t('entry.forget')}
                </button>
              </div>
              {armed && <ForgetConfirmBar t={t} state={forget} onConfirm={onForgetConfirm} onCancel={onForgetCancel} />}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
