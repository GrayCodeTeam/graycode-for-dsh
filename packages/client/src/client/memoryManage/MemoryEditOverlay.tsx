/**
 * Memory edit overlay (P4-03).
 *
 * Modal overlay for editing a single raw memory entry: textarea, live
 * original→new diff preview (added/removed segments + char counts), and the
 * explicit Save / Cancel actions. Saving is disabled while the text is
 * unchanged or empty (the host contract rejects empty `text` with
 * GRAY_INVALID_INPUT, so the UI blocks it up front).
 *
 * CLIENT BOUNDARY RULES: editing is an explicit user action with a visible
 * diff — the user reviews exactly what will change before Save. The overlay
 * performs no I/O itself; `onSave(next)` is declarative and owned by the
 * panel (which issues `memory/edit` through the injected transport).
 */
import { useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  diffMemoryText,
  type MemoryEntryViewModel,
  type MemoryErrorView,
  type MemoryDiffSegmentType,
} from './logic.ts'

/** Composed props for the edit overlay. */
export interface MemoryEditOverlayProps {
  t: TranslateNS<'graycode.memoryManage'>
  /** The entry being edited (mount with `key={entry.id}` to reset per entry). */
  entry: MemoryEntryViewModel
  /** True while the panel awaits `memory/edit`. */
  saving: boolean
  /** Effective host `entryChars` byte limit (undefined → limit unknown). */
  entryChars?: number
  /** Save failure to surface inside the overlay (the panel banner is hidden behind the scrim). */
  error?: MemoryErrorView | null
  /** Declarative save (called with the reviewed new text). */
  onSave: (text: string) => void
  /** Declarative cancel. */
  onCancel: () => void
}

const scrimStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: '3rem 1rem',
  background: 'rgba(0, 0, 0, 0.45)',
}

const dialogStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  width: 'min(560px, 100%)',
  padding: '0.75rem 1rem',
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
  justifyContent: 'space-between',
  gap: '0.5rem',
  fontWeight: 600,
}

const closeStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontSize: '12px',
  cursor: 'pointer',
  opacity: 0.7,
}

const metaStyle: CSSProperties = {
  display: 'flex',
  gap: '0.625rem',
  flexWrap: 'wrap',
  fontSize: '10px',
  opacity: 0.75,
}

const textareaStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.375rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'rgba(0, 0, 0, 0.25)',
  color: 'inherit',
  fontSize: '12px',
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  resize: 'vertical',
}

const diffStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '0.375rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'rgba(0, 0, 0, 0.15)',
  maxHeight: '8rem',
  overflow: 'auto',
}

const diffSummaryStyle: CSSProperties = {
  display: 'flex',
  gap: '0.75rem',
  fontSize: '10px',
}

const diffBodyStyle: CSSProperties = {
  fontSize: '11px',
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
}

const warnStyle: CSSProperties = {
  color: '#d29922',
  fontSize: '11px',
}

const footerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '0.375rem',
}

const saveHintStyle: CSSProperties = {
  marginRight: 'auto',
  fontSize: '10px',
  opacity: 0.65,
}

const buttonStyle: CSSProperties = {
  padding: '0.25rem 0.75rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'transparent',
  color: 'inherit',
  fontSize: '11px',
  cursor: 'pointer',
}

const primaryStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: '#3fb950',
  color: '#3fb950',
}

const buttonDisabledStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.45,
  cursor: 'not-allowed',
}

const byteRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
}

const byteCounterStyle: CSSProperties = {
  fontSize: '10px',
  opacity: 0.7,
}

const byteOverflowStyle: CSSProperties = {
  ...byteCounterStyle,
  color: '#f85149',
  opacity: 1,
  fontWeight: 600,
}

const errorStyle: CSSProperties = {
  color: '#f85149',
  fontSize: '11px',
}

/** UTF-8 byte length of a string (TextEncoder in browsers; fallback for node). */
function utf8Bytes(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length
  return text.length
}

const SEGMENT_STYLE: Record<MemoryDiffSegmentType, CSSProperties> = {
  same: {},
  added: { color: '#3fb950' },
  removed: { color: '#f85149', textDecoration: 'line-through' },
}

/**
 * Modal edit overlay with live diff preview.
 */
export function MemoryEditOverlay({
  t,
  entry,
  saving,
  entryChars,
  error,
  onSave,
  onCancel,
}: MemoryEditOverlayProps): ReactNode {
  const [text, setText] = useState(entry.text)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const diff = useMemo(() => diffMemoryText(entry.text, text), [entry.text, text])
  const empty = text.trim().length === 0
  const bytes = utf8Bytes(text)
  const overLimit = entryChars !== undefined && bytes > entryChars
  const canSave = diff.changed && !empty && !saving && !overLimit

  // 3.4-M6: cancelling with unsaved changes asks for confirmation first — the
  // draft (and the reviewed diff) must never be discarded silently.
  const requestCancel = () => {
    if (diff.changed && !saving) setConfirmingDiscard(true)
    else onCancel()
  }

  return (
    <div data-graycode-memory="edit-overlay" style={scrimStyle}>
      <div data-graycode-memory="edit-dialog" style={dialogStyle} role="dialog" aria-modal="true">
        <div style={headerStyle}>
          <span>
            {t('edit.title')} #{entry.id}
          </span>
          <button type="button" data-graycode-memory="edit-close" style={closeStyle} disabled={saving} onClick={requestCancel}>
            ✕
          </button>
        </div>
        <div style={metaStyle}>
          <span>
            {t('entry.date')}: {entry.date}
          </span>
          <span>
            {t('entry.source')}: {t(`scope.${entry.scope}`)}
          </span>
        </div>
        <textarea
          data-graycode-memory="edit-input"
          value={text}
          rows={4}
          disabled={saving}
          style={textareaStyle}
          onChange={event => {
            setText(event.target.value)
            setConfirmingDiscard(false)
          }}
        />
        <div style={byteRowStyle}>
          <span
            data-graycode-memory="edit-bytes"
            style={overLimit ? byteOverflowStyle : byteCounterStyle}
          >
            {bytes}
            {entryChars !== undefined ? `/${entryChars}` : ''}
          </span>
          {overLimit && (
            <span data-graycode-memory="edit-overflow" style={errorStyle}>
              {t('edit.tooLong')}
            </span>
          )}
        </div>
        {empty && (
          <div data-graycode-memory="edit-required" style={warnStyle}>
            {t('edit.required')}
          </div>
        )}
        <div data-graycode-memory="edit-diff" style={diffStyle}>
          {diff.changed ? (
            <>
              <div style={diffSummaryStyle}>
                <span style={{ color: '#3fb950' }}>
                  +{diff.added} {t('edit.diff.added')}
                </span>
                <span style={{ color: '#f85149' }}>
                  −{diff.removed} {t('edit.diff.removed')}
                </span>
              </div>
              <div style={diffBodyStyle}>
                {diff.segments.map((segment, index) => (
                  <span
                    key={index}
                    data-graycode-memory="diff-segment"
                    data-diff-type={segment.type}
                    style={SEGMENT_STYLE[segment.type]}
                  >
                    {segment.value}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <span data-graycode-memory="diff-unchanged">{t('edit.unchanged')}</span>
          )}
        </div>
        {error != null && (
          <div data-graycode-memory="edit-error" data-code={error.code} style={errorStyle}>
            {t('error.title')}: {t(error.localeKey)}
          </div>
        )}
        <div style={footerStyle}>
          {confirmingDiscard ? (
            <>
              <span style={saveHintStyle}>{t('edit.discardPrompt')}</span>
              <button type="button" data-graycode-memory="edit-keep-editing" style={buttonStyle} onClick={() => setConfirmingDiscard(false)}>
                {t('edit.keepEditing')}
              </button>
              <button type="button" data-graycode-memory="edit-discard" style={buttonStyle} onClick={onCancel}>
                {t('edit.discard')}
              </button>
            </>
          ) : (
            <>
              <span style={saveHintStyle}>{t('edit.saveHint')}</span>
              <button type="button" data-graycode-memory="edit-cancel" style={buttonStyle} disabled={saving} onClick={requestCancel}>
                {t('edit.cancel')}
              </button>
              <button
                type="button"
                data-graycode-memory="edit-save"
                style={canSave ? primaryStyle : buttonDisabledStyle}
                disabled={!canSave}
                onClick={() => { if (canSave) onSave(text) }}
              >
                {saving ? t('loading') : t('edit.save')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
