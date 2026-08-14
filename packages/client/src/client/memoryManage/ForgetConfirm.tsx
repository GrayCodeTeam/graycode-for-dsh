/**
 * Forget confirmation bar (P4-03).
 *
 * The second-confirmation UI for the entry-level forget action. It renders
 * only when the forget state machine is armed for an entry:
 *
 * - `confirming` → warning (with the exact text captured at arm time) +
 *   Cancel / Confirm-forget;
 * - `submitting` → in-flight note (buttons locked — double-submit guard);
 * - `error` → mapped stable-code message + Cancel / retry Confirm.
 *
 * CLIENT BOUNDARY RULES: this component performs no I/O — it only renders the
 * machine state and forwards the declarative `onConfirm` / `onCancel`
 * callbacks. The destructive call goes out only after the user pressed
 * Confirm here (the state machine enforces it).
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgetState } from './logic.ts'

/** Composed props for the armed forget confirm bar. */
export interface ForgetConfirmBarProps {
  t: TranslateNS<'graycode.memoryManage'>
  /** Forget machine state (armed: confirming | submitting | error). */
  state: ForgetState
  /** Declarative confirm (the only path that issues `memory/forget`). */
  onConfirm: () => void
  /** Declarative cancel (returns to idle). */
  onCancel: () => void
}

const barStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  marginTop: '0.375rem',
  padding: '0.5rem 0.625rem',
  borderRadius: '0.375rem',
  border: '1px solid #f85149',
  background: 'rgba(248, 81, 73, 0.07)',
  fontSize: '11px',
}

const headingStyle: CSSProperties = {
  fontWeight: 600,
  color: '#f85149',
}

const warningStyle: CSSProperties = {
  opacity: 0.9,
}

const previewStyle: CSSProperties = {
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  background: 'rgba(0, 0, 0, 0.25)',
  overflowWrap: 'anywhere',
  maxHeight: '3.5rem',
  overflow: 'hidden',
}

const actionsStyle: CSSProperties = {
  display: 'flex',
  gap: '0.375rem',
  justifyContent: 'flex-end',
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

const dangerStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: '#f85149',
  color: '#f85149',
}

/**
 * Armed forget confirmation bar (renders nothing for unarmed phases — the
 * caller decides when to mount it).
 */
export function ForgetConfirmBar({ t, state, onConfirm, onCancel }: ForgetConfirmBarProps): ReactNode {
  if (state.phase === 'submitting') {
    return (
      <div data-graycode-memory="forget-submitting" style={barStyle}>
        <span style={headingStyle}>{t('forget.submitting')}</span>
      </div>
    )
  }

  if (state.phase === 'error' && state.error !== null) {
    return (
      <div data-graycode-memory="forget-error" data-code={state.error.code} style={barStyle}>
        <span style={headingStyle}>{t('error.title')}: {t(state.error.localeKey)}</span>
        <div style={actionsStyle}>
          <button type="button" data-graycode-memory="forget-cancel" style={buttonStyle} onClick={onCancel}>
            {t('forget.cancel')}
          </button>
          <button type="button" data-graycode-memory="forget-confirm-btn" style={dangerStyle} onClick={onConfirm}>
            {t('forget.confirm')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div data-graycode-memory="forget-confirm" style={barStyle}>
      <span style={headingStyle}>{t('forget.title')}</span>
      <span style={warningStyle}>{t('forget.warning')}</span>
      {state.preview !== null && state.preview.length > 0 && (
        <div data-graycode-memory="forget-preview" style={previewStyle}>
          {state.preview}
        </div>
      )}
      <div style={actionsStyle}>
        <button type="button" data-graycode-memory="forget-cancel" style={buttonStyle} onClick={onCancel}>
          {t('forget.cancel')}
        </button>
        <button type="button" data-graycode-memory="forget-confirm-btn" style={dangerStyle} onClick={onConfirm}>
          {t('forget.confirm')}
        </button>
      </div>
    </div>
  )
}
