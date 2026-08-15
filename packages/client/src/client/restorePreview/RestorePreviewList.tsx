/**
 * Restore preview list — file classification by group with conflict highlight (P4-05).
 *
 * Pure presentational component: renders the ordered classification groups
 * (restore / delete / untracked / unbacked / conflict) with per-group counts,
 * explicit path lists, reason labels and the safety hints that make the
 * destructive surface legible. Conflicts render with a highlighted tone;
 * untracked and unbacked groups carry their "kept/protected" notes.
 *
 * CLIENT BOUNDARY RULES: this card never initiates anything — it only renders
 * the classification computed from the preview payload. Deletion decisions
 * belong to the approval area / state machine, never to this list.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { restoreFailureLocaleKey } from './labels.ts'
import type { PreviewClassification, PreviewFileClass, PreviewFileItem } from './types.ts'

/** Cap per-group rendered items; the remainder is folded into `moreLabel`. */
const MAX_ITEMS_PER_GROUP = 50

export interface RestorePreviewListProps {
  t: TranslateNS<'graycode.restorePreview'>
  classification: PreviewClassification
  /** Legacy archives cannot give exact lists — show the note. */
  legacy?: boolean
  /**
   * Host-reported count of checkpoints auto-pruned alongside this restore.
   * 4.6-L5: `undefined` (absent) or 0 fold the hint — only a positive count
   * renders the note, and the reader preserves an explicitly-present 0 so
   * this check is meaningful.
   */
  autoPrunedCount?: number
}

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
}

const summaryStyle: CSSProperties = {
  opacity: 0.7,
  fontSize: '11px',
}

const groupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
  padding: '0.375rem 0.5rem',
  borderRadius: '0.375rem',
  border: '1px solid var(--dsh-border-color, #333)',
}

const conflictGroupStyle: CSSProperties = {
  ...groupStyle,
  border: '1px solid #f85149',
  background: 'rgba(248, 81, 73, 0.08)',
}

const groupHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontWeight: 600,
}

const groupCountStyle: CSSProperties = {
  marginLeft: 'auto',
  opacity: 0.75,
  fontSize: '11px',
}

const itemStyle: CSSProperties = {
  display: 'flex',
  gap: '0.375rem',
  alignItems: 'baseline',
}

const pathStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  overflowWrap: 'anywhere',
}

const reasonStyle: CSSProperties = {
  flexShrink: 0,
  fontSize: '10px',
  opacity: 0.75,
}

const noteStyle: CSSProperties = {
  fontSize: '11px',
  opacity: 0.8,
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px dashed var(--dsh-border-color, #444)',
}

const moreStyle: CSSProperties = {
  fontSize: '11px',
  opacity: 0.65,
}

/** Hint shown under a group (untracked/unbacked/conflict safety notes). */
function groupHint(t: TranslateNS<'graycode.restorePreview'>, cls: PreviewFileClass): ReactNode {
  if (cls === 'untracked') return <div style={noteStyle}>{t('untrackedKeepHint')}</div>
  if (cls === 'unbacked') return <div style={noteStyle}>{t('unbackedProtectedHint')}</div>
  if (cls === 'conflict') return <div style={noteStyle}>{t('conflictBlockedHint')}</div>
  return null
}

function itemReasonLabel(t: TranslateNS<'graycode.restorePreview'>, item: PreviewFileItem): ReactNode {
  if (item.reason === undefined) return null
  return <span style={reasonStyle}>{t(restoreFailureLocaleKey(item.reason))}</span>
}

/**
 * Grouped preview list. Mount it inside the preview phase of the restore
 * panel (see README.md for wiring).
 */
export function RestorePreviewList({ t, classification, legacy = false, autoPrunedCount }: RestorePreviewListProps): ReactNode {
  return (
    <div data-graycode-restorepreview="list" style={listStyle}>
      <div style={summaryStyle}>
        {t('totalLabel')}: {classification.totalAffected}
      </div>
      {legacy && <div style={noteStyle}>{t('legacyNote')}</div>}
      {autoPrunedCount !== undefined && autoPrunedCount > 0 && (
        <div style={noteStyle} data-graycode-restorepreview="auto-pruned">
          {t('prunedNote')}: {autoPrunedCount}
        </div>
      )}
      {classification.groups.map(group => (
        <div
          key={group.cls}
          data-graycode-restorepreview="group"
          data-class={group.cls}
          style={group.cls === 'conflict' ? conflictGroupStyle : groupStyle}
        >
          <div style={groupHeaderStyle}>
            <span>{t(`class.${group.cls}`)}</span>
            <span style={groupCountStyle}>{group.count}</span>
          </div>
          {group.items.slice(0, MAX_ITEMS_PER_GROUP).map(item => (
            <div key={`${group.cls}:${item.path}`} style={itemStyle}>
              <span style={pathStyle}>{item.path}</span>
              {itemReasonLabel(t, item)}
            </div>
          ))}
          {group.count > group.items.length && (
            <div style={moreStyle}>
              {t('moreLabel').replace('{n}', String(group.count - group.items.length))}
            </div>
          )}
          {groupHint(t, group.cls)}
        </div>
      ))}
      {classification.groups.length === 0 && (
        <div style={noteStyle}>{t('emptyPreview')}</div>
      )}
    </div>
  )
}
