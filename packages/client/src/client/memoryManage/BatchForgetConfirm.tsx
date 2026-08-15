/**
 * Batch forget confirmation overlay (P4-03 / audit M-03).
 *
 * Modal second-confirmation for the multi-select batch delete. It renders
 * only when the batch-forget state machine is armed (confirming | submitting
 * | error):
 *
 * - `confirming` → warning naming the selected count (captured at arm time)
 *   + Cancel / Confirm;
 * - `submitting` → in-flight note (buttons locked — double-submit guard);
 * - `error` → mapped stable-code message + Cancel / retry Confirm.
 *
 * CLIENT BOUNDARY RULES: this component performs no I/O — it only renders the
 * machine state and forwards the declarative `onConfirm` / `onCancel`
 * callbacks. The destructive `memory/forgetBatch` call goes out only after the
 * user pressed Confirm here (the state machine enforces it). The modal scrim
 * mirrors MemoryEditOverlay so the panel banner stays hidden while open.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { applyMemoryTextCount, type BatchForgetState } from './logic.ts'

/** Composed props for the armed batch-forget confirm overlay. */
export interface BatchForgetConfirmProps {
  t: TranslateNS<'graycode.memoryManage'>
  /** Batch-forget machine state (armed: confirming | submitting | error). */
  state: BatchForgetState
  /** Declarative confirm (the only path that issues `memory/forgetBatch`). */
  onConfirm: () => void
  /** Declarative cancel (returns to idle). */
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
  border: '1px solid #f85149',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'var(--dsh-text-color, #eee)',
  fontSize: '12px',
  lineHeight: '1.45',
}

const headingStyle: CSSProperties = {
  fontWeight: 600,
  color: '#f85149',
}

const warningStyle: CSSProperties = {
  opacity: 0.9,
}

const actionsStyle: CSSProperties = {
  display: 'flex',
  gap: '0.375rem',
  justifyContent: 'flex-end',
  marginTop: '0.25rem',
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
 * Armed batch-forget confirmation modal (renders nothing for unarmed phases —
 * the caller decides when to mount it).
 */
export function BatchForgetConfirm({ t, state, onConfirm, onCancel }: BatchForgetConfirmProps): ReactNode {
  const count = state.target?.ids.length ?? 0

  if (state.phase === 'submitting') {
    return (
      <div data-graycode-memory="batch-forget-overlay" style={scrimStyle}>
        <div data-graycode-memory="batch-forget-submitting" style={dialogStyle} role="dialog" aria-modal="true">
          <span style={headingStyle}>{t('batchForget.submitting')}</span>
        </div>
      </div>
    )
  }

  if (state.phase === 'error' && state.error !== null) {
    return (
      <div data-graycode-memory="batch-forget-overlay" style={scrimStyle}>
        <div
          data-graycode-memory="batch-forget-error"
          data-code={state.error.code}
          style={dialogStyle}
          role="dialog"
          aria-modal="true"
        >
          <span style={headingStyle}>{t('error.title')}: {t(state.error.localeKey)}</span>
          <div style={actionsStyle}>
            <button type="button" data-graycode-memory="batch-forget-cancel" style={buttonStyle} onClick={onCancel}>
              {t('batchForget.cancel')}
            </button>
            <button type="button" data-graycode-memory="batch-forget-confirm-btn" style={dangerStyle} onClick={onConfirm}>
              {t('batchForget.confirm')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div data-graycode-memory="batch-forget-overlay" style={scrimStyle}>
      <div data-graycode-memory="batch-forget-confirm" style={dialogStyle} role="dialog" aria-modal="true">
        <span style={headingStyle}>{t('batchForget.title')}</span>
        <span style={warningStyle}>
          {applyMemoryTextCount(t('batchForget.warning'), count)}
        </span>
        <div style={actionsStyle}>
          <button type="button" data-graycode-memory="batch-forget-cancel" style={buttonStyle} onClick={onCancel}>
            {t('batchForget.cancel')}
          </button>
          <button type="button" data-graycode-memory="batch-forget-confirm-btn" style={dangerStyle} onClick={onConfirm}>
            {t('batchForget.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
