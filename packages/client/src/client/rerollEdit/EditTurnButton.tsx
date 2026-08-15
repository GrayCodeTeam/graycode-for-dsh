/**
 * Edit user message (F2).
 *
 * Registered into the host's additive `conversation.chat.turnTail` chain slot
 * (rendered per completed turn, before the closing assistant's IconActions):
 * the chain selector hands the completed turn's session turn number as
 * `matched`, the editable user message of that turn is resolved from the
 * conversation snapshot via {@link editTargetOfTurn}, and the click opens a
 * lightweight modal (textarea prefilled with the original text + confirm /
 * cancel — the same inline-style scrim/dialog pattern as the memory edit
 * overlay). Confirm calls the plugin's `branches/editRetry` endpoint through
 * the trusted `/graycode` remote dispatcher; an endpoint error stays inside
 * the dialog (readable warning + console.warn), never silent.
 *
 * The component is a thin presentational shell: the turn → message mapping
 * lives in the pure {@link editTargetOfTurn} reader, so the node-environment
 * tests cover the decision logic without React.
 */
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GrayRemoteInvoke } from '../settings/types.ts'
import { editTargetOfTurn, isNoPreviousTurnFailure, type EditSnapshotLike } from './logic.ts'

const buttonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  padding: '0.125rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'transparent',
  color: 'inherit',
  fontSize: '11px',
  lineHeight: '1.6',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
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

const warnStyle: CSSProperties = {
  color: '#d29922',
  fontSize: '11px',
}

const errorStyle: CSSProperties = {
  color: '#f85149',
  fontSize: '11px',
  overflowWrap: 'anywhere',
}

const footerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '0.375rem',
}

const actionStyle: CSSProperties = {
  padding: '0.25rem 0.75rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'transparent',
  color: 'inherit',
  fontSize: '11px',
  cursor: 'pointer',
}

const primaryStyle: CSSProperties = {
  ...actionStyle,
  borderColor: '#3fb950',
  color: '#3fb950',
}

const actionDisabledStyle: CSSProperties = {
  ...actionStyle,
  opacity: 0.45,
  cursor: 'not-allowed',
}

function PencilIcon({ size = 12 }: { size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
      <path d="M13.5 6.5l3 3" />
    </svg>
  )
}

/** Injected seat: the `/graycode` remote dispatcher. */
export interface EditTurnInjected {
  readonly remote: GrayRemoteInvoke
}

export interface EditTurnButtonProps extends EditTurnInjected {
  /** Chain selector result: the completed turn's session turn number. */
  readonly matched: { readonly turn: number }
  /** Framework-injected current session id. */
  readonly sessionId: string
  /** Framework-injected conversation snapshot selector. */
  readonly useSession: <T>(selector: (state: EditSnapshotLike) => T) => T
  /** Framework-injected translate seat for the `graycode.rerollEdit` namespace. */
  readonly t: TranslateNS<'graycode.rerollEdit'>
}

/** Edit action for one completed turn (renders nothing when its user message is unresolvable). */
export function EditTurnButton({ matched, sessionId, useSession, remote, t }: EditTurnButtonProps): ReactNode {
  const snapshot = useSession((state) => state)
  const target = editTargetOfTurn(snapshot, matched.turn)
  const [open, setOpen] = useState(false)

  if (target === undefined) return null

  return (
    <>
      <button type="button" data-graycode-reroll="edit-turn" style={buttonStyle} onClick={() => setOpen(true)}>
        <PencilIcon size={12} />
        <span>{t('edit.label')}</span>
      </button>
      {open && (
        <EditTurnOverlay
          key={`${sessionId}:${matched.turn}`}
          t={t}
          sessionId={sessionId}
          turn={matched.turn}
          initialText={target.text}
          remote={remote}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

export interface EditTurnOverlayProps {
  t: TranslateNS<'graycode.rerollEdit'>
  sessionId: string
  turn: number
  /** Original user message text (the textarea prefill). */
  initialText: string
  remote: GrayRemoteInvoke
  onClose: () => void
}

type EditPhase = 'idle' | 'working' | 'failed'

/** Modal edit dialog: textarea + confirm/cancel; failures stay visible. */
export function EditTurnOverlay({ t, sessionId, turn, initialText, remote, onClose }: EditTurnOverlayProps): ReactNode {
  const [text, setText] = useState(initialText)
  const [phase, setPhase] = useState<EditPhase>('idle')
  const [failure, setFailure] = useState<string | null>(null)

  const empty = text.trim().length === 0
  const working = phase === 'working'

  const confirm = async (): Promise<void> => {
    if (working || empty) return
    setPhase('working')
    setFailure(null)
    try {
      const result = await remote('branches', 'editRetry', { sessionId, turn, text })
      if (result.ok) {
        onClose()
        return
      }
      setPhase('failed')
      // Well-known host domain errors get a localized message (the envelope
      // carries the domain code in `details.causeCode`); anything else falls
      // back to the raw error text.
      setFailure(isNoPreviousTurnFailure(result.error)
        ? t('edit.noPreviousTurn')
        : `${t('edit.failed')}: ${result.error.message}`)
      console.warn(`[graycode.editRetry] ${result.error.code}: ${result.error.message}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setPhase('failed')
      setFailure(`${t('edit.failed')}: ${detail}`)
      console.warn('[graycode.editRetry] transport failure:', error)
    }
  }

  return (
    <div data-graycode-reroll="edit-overlay" style={scrimStyle}>
      <div data-graycode-reroll="edit-dialog" style={dialogStyle} role="dialog" aria-modal="true">
        <div style={headerStyle}>
          <span>{t('edit.title')}</span>
          <button type="button" data-graycode-reroll="edit-close" style={closeStyle} disabled={working} onClick={onClose}>
            ✕
          </button>
        </div>
        <textarea
          data-graycode-reroll="edit-input"
          value={text}
          rows={6}
          disabled={working}
          style={textareaStyle}
          onChange={event => setText(event.target.value)}
        />
        {empty && (
          <div data-graycode-reroll="edit-required" style={warnStyle}>
            {t('edit.required')}
          </div>
        )}
        {failure !== null && (
          <div data-graycode-reroll="edit-error" style={errorStyle}>{failure}</div>
        )}
        <div style={footerStyle}>
          <button type="button" data-graycode-reroll="edit-cancel" style={actionStyle} disabled={working} onClick={onClose}>
            {t('edit.cancel')}
          </button>
          <button
            type="button"
            data-graycode-reroll="edit-confirm"
            style={working || empty ? actionDisabledStyle : primaryStyle}
            disabled={working || empty}
            onClick={() => { void confirm() }}
          >
            {working ? t('edit.saving') : t('edit.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
