/**
 * Regenerate assistant message (F1).
 *
 * Registered into the host's additive `conversation.chat.assistant-actions`
 * list slot (same seat the built-in copy/branch controls share): the owner
 * hands the addressed assistant `messageId`, the session turn is resolved
 * from the conversation snapshot via {@link turnOfMessage}, and the click
 * calls the plugin's `branches/reroll` endpoint through the trusted
 * `/graycode` remote dispatcher. A successful reroll that names a branch
 * session navigates to it (same route as the subagent back-to-main action);
 * an endpoint error is surfaced in place (inline warning + console.warn),
 * never swallowed.
 *
 * The component is a thin presentational shell: visibility and the turn
 * resolution live in the pure {@link turnOfMessage} reader, so the
 * node-environment tests cover the decision logic without React.
 */
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GrayRemoteInvoke } from '../settings/types.ts'
import { isNoPreviousTurnFailure, turnOfMessage, type RerollSnapshotLike } from './logic.ts'

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

const buttonDisabledStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.55,
  cursor: 'progress',
}

const errorStyle: CSSProperties = {
  color: '#f85149',
  fontSize: '10px',
  lineHeight: '1.4',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: '16rem',
}

function RefreshIcon({ size = 12 }: { size?: number }): ReactNode {
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
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </svg>
  )
}

/** Injected seat: the `/graycode` remote dispatcher plus optional branch navigation. */
export interface RegenerateInjected {
  readonly remote: GrayRemoteInvoke
  /** Open a branch session after a successful reroll (absent without the sessions service). */
  readonly open?: (sessionId: string) => void
}

export interface RegenerateButtonProps extends RegenerateInjected {
  /** Framework-injected addressed assistant message id. */
  readonly messageId: unknown
  /** Framework-injected current session id. */
  readonly sessionId: string
  /** Framework-injected conversation snapshot selector. */
  readonly useSession: <T>(selector: (state: RerollSnapshotLike) => T) => T
  /** Framework-injected translate seat for the `graycode.rerollEdit` namespace. */
  readonly t: TranslateNS<'graycode.rerollEdit'>
}

type RerollPhase = 'idle' | 'working' | 'failed'

/** Regenerate action for one finalized assistant message (renders nothing when unresolvable). */
export function RegenerateButton({ messageId, sessionId, useSession, remote, open, t }: RegenerateButtonProps): ReactNode {
  const snapshot = useSession((state) => state)
  const turn = turnOfMessage(snapshot, messageId)
  const [phase, setPhase] = useState<RerollPhase>('idle')
  const [failure, setFailure] = useState<string | null>(null)

  if (turn === undefined) return null

  const start = async (): Promise<void> => {
    if (phase === 'working') return
    setPhase('working')
    setFailure(null)
    try {
      const result = await remote('branches', 'reroll', { sessionId, turn })
      if (result.ok) {
        setPhase('idle')
        const branchSessionId = (result.value as { branchSessionId?: unknown } | undefined)?.branchSessionId
        if (typeof branchSessionId === 'string' && branchSessionId.length > 0 && open !== undefined) {
          open(branchSessionId)
        }
        return
      }
      setPhase('failed')
      // Well-known host domain errors get a localized message (the envelope
      // carries the domain code in `details.causeCode`); anything else falls
      // back to the raw error text.
      setFailure(isNoPreviousTurnFailure(result.error)
        ? t('reroll.noPreviousTurn')
        : `${t('reroll.failed')}: ${result.error.message}`)
      console.warn(`[graycode.regenerate] ${result.error.code}: ${result.error.message}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setPhase('failed')
      setFailure(`${t('reroll.failed')}: ${detail}`)
      console.warn('[graycode.regenerate] transport failure:', error)
    }
  }

  const working = phase === 'working'
  const label = working ? t('reroll.working') : t('reroll.label')
  return (
    <>
      <button
        type="button"
        data-graycode-reroll="regenerate"
        style={working ? buttonDisabledStyle : buttonStyle}
        disabled={working}
        title={failure ?? label}
        onClick={() => { void start() }}
      >
        <RefreshIcon size={12} />
        <span>{label}</span>
      </button>
      {failure !== null && (
        <span data-graycode-reroll="regenerate-error" style={errorStyle}>{failure}</span>
      )}
    </>
  )
}
