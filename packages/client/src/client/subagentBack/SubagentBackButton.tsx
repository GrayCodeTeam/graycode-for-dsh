/**
 * Subagent back-to-main action (S1).
 *
 * Registered into the host's additive `conversation.session.header.actions`
 * list slot (same seat as the built-in subagent catalog button). Renders ONLY
 * for subagent sessions (`origin === 'subagent'` with a `parentId`) and opens
 * the parent session on click — the same route the host's own header
 * breadcrumb uses (`sessions.open(parentId)`), so "return to the main session"
 * is one click from inside the subagent viewer.
 *
 * The component is a thin presentational shell: visibility is decided by the
 * pure {@link subagentBackTarget} reader and navigation goes through the
 * injected `open` seat, so the node-environment tests cover the decision
 * logic without React.
 */
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

const buttonStyle: CSSProperties = {
  padding: '0.125rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'transparent',
  color: 'inherit',
  fontSize: '12px',
  lineHeight: '1.6',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

/** Structural mirror of the `SessionSummary` row the slot framework injects. */
export interface SubagentBackSummaryLike {
  readonly origin?: string
  readonly parentId?: string
  readonly id: string
}

/** Structural mirror of the `useSessions` snapshot selector the slot injects. */
export interface SubagentBackSessionListStateLike {
  /**
   * Session summaries keyed by session id. Optional: a drifted host snapshot
   * may omit it, and the selector must not crash on that (3.3-M3).
   */
  readonly byId?: Readonly<Record<string, SubagentBackSummaryLike | undefined>>
}

/** Injected seat: navigate the host conversation view to a session. */
export interface SubagentBackInjected {
  readonly open: (sessionId: string) => void
}

export interface SubagentBackButtonProps extends SubagentBackInjected {
  /** Framework-injected current session id. */
  readonly sessionId: string
  /** Framework-injected session-list snapshot selector. */
  readonly useSessions: <T>(selector: (state: SubagentBackSessionListStateLike) => T) => T
  /** Framework-injected translate seat for the `graycode.subagentBack` namespace. */
  readonly t: TranslateNS<'graycode.subagentBack'>
}

/**
 * Decide the back-to-main target for a session summary: the parent session id
 * when the session is a subagent with a recorded parent, undefined otherwise
 * (the action then renders nothing). Defensive: `origin`/`parentId` are
 * narrowed structurally so a drifted host row can never crash the header.
 */
export function subagentBackTarget(summary: SubagentBackSummaryLike | undefined): string | undefined {
  if (summary === undefined) return undefined
  if (summary.origin !== 'subagent') return undefined
  if (typeof summary.parentId !== 'string' || summary.parentId.length === 0) return undefined
  return summary.parentId
}

/**
 * Decide the back-to-main target from a live session-list snapshot (3.3-M3):
 * the current session must be a subagent WITH a parent, and the parent must
 * actually exist in the snapshot — a deleted parent must not render a dead
 * button. A missing `byId` seat (drifted host contract) renders nothing too,
 * so the "never crashes the header" promise holds against any snapshot shape.
 */
export function subagentBackTargetFromState(
  state: SubagentBackSessionListStateLike | undefined,
  sessionId: string,
): string | undefined {
  if (state === undefined || state.byId === undefined) return undefined
  const summary = state.byId[sessionId]
  const target = subagentBackTarget(summary)
  if (target === undefined) return undefined
  if (state.byId[target] === undefined) return undefined
  return target
}

/** Back-to-main header action (renders nothing outside subagent sessions). */
export function SubagentBackButton({ sessionId, useSessions, open, t }: SubagentBackButtonProps): ReactNode {
  const [pending, setPending] = useState(false)
  // Single selector read: the byId guard lives inside the pure decision so a
  // drifted snapshot (missing byId, deleted parent) renders null — no crash.
  const target = useSessions((state) => subagentBackTargetFromState(state, sessionId))
  if (target === undefined) return null
  const disabled = pending
  return (
    <button
      type="button"
      style={disabled ? { ...buttonStyle, opacity: 0.5, cursor: 'wait' } : buttonStyle}
      disabled={disabled}
      onClick={() => {
        if (pending) return
        // Disable while handling (4.3-L5): a double-click must not fire the
        // navigation twice; the seat stays one-shot until the view unmounts.
        setPending(true)
        open(target)
      }}
      title={t('label')}
    >
      {t('label')}
    </button>
  )
}
