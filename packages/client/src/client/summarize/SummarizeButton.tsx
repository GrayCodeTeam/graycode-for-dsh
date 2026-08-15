/**
 * Manual conversation summary (S-summary).
 *
 * Registered into the host's additive `conversation.session.header.actions`
 * list slot. Click opens a modal dialog that drives the flow via
 * {@link runSummarize} (working → success/failed) over the trusted
 * `/graycode` remote dispatcher; the dialog shows the generated summary
 * (multi-line read-only block + copy + close) or the failure message inline
 * (+ console.warn), never silently.
 *
 * The component is a thin presentational shell: the whole decision surface
 * lives in the pure {@link runSummarize} / {@link unpackSummarizeResult}
 * logic, so the node-environment tests cover it without React.
 */
import { useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  runSummarize,
  type SummarizePhase,
  type SummarizeRemoteLike,
} from './logic.ts'

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

const buttonDisabledStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.55,
  cursor: 'progress',
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
  width: 'min(640px, 100%)',
  maxHeight: '70vh',
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

const workingStyle: CSSProperties = {
  padding: '0.5rem 0',
  opacity: 0.7,
}

const textStyle: CSSProperties = {
  margin: 0,
  padding: '0.5rem',
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  flex: '1 1 auto',
  minHeight: '6rem',
  maxHeight: '50vh',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'rgba(0, 0, 0, 0.25)',
  color: 'inherit',
  fontSize: '12px',
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
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

/** Injected seat: the `summary/*` remote dispatcher. */
export interface SummarizeInjected {
  readonly remote: SummarizeRemoteLike
}

export interface SummarizeButtonProps extends SummarizeInjected {
  /** Framework-injected current session id. */
  readonly sessionId: string
  /** Framework-injected translate seat for the `graycode.summarize` namespace. */
  readonly t: TranslateNS<'graycode.summarize'>
}

/** Manual summary header action: opens the summary dialog on click. */
export function SummarizeButton({ sessionId, remote, t }: SummarizeButtonProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<SummarizePhase>('idle')
  const [text, setText] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // M-1：working 期间关闭弹层 = 中止本次总结（AbortSignal 透传给 runSummarize）
  const abortRef = useRef<AbortController | null>(null)

  const start = (): void => {
    if (phase === 'working') return
    setOpen(true)
    setText(null)
    setFailure(null)
    setPhase('working')
    const controller = new AbortController()
    abortRef.current = controller
    void runSummarize(remote, sessionId, (state) => {
      setPhase(state.phase)
      if (state.phase === 'success') setText(state.text ?? null)
      if (state.phase === 'failed') setFailure(state.failure ?? null)
    }, t, { signal: controller.signal }).finally(() => {
      if (abortRef.current === controller) abortRef.current = null
    })
  }

  const close = (): void => {
    // working 期间关闭 = 中止等待 + 恢复按钮（宿主悬挂不再永久卡死 UI）
    abortRef.current?.abort()
    abortRef.current = null
    setOpen(false)
    setPhase('idle')
    setText(null)
    setFailure(null)
  }

  const working = phase === 'working'
  return (
    <>
      <button
        type="button"
        data-graycode-summarize="action"
        style={working ? buttonDisabledStyle : buttonStyle}
        disabled={working}
        title={t('actions.summarize')}
        onClick={start}
      >
        {working ? t('actions.summarizing') : t('actions.summarize')}
      </button>
      {open && phase !== 'idle' && (
        <SummarizeOverlay
          t={t}
          phase={phase}
          text={text}
          failure={failure}
          onClose={close}
        />
      )}
    </>
  )
}

export interface SummarizeOverlayProps {
  t: TranslateNS<'graycode.summarize'>
  phase: SummarizePhase
  text: string | null
  failure: string | null
  onClose: () => void
}

/** Summary dialog: working indicator / read-only summary text + copy + close / error. */
export function SummarizeOverlay({ t, phase, text, failure, onClose }: SummarizeOverlayProps): ReactNode {
  const [copied, setCopied] = useState(false)
  const working = phase === 'working'

  const copy = async (): Promise<void> => {
    if (text === null) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      console.warn('[graycode.summarize] clipboard failed:', error)
    }
  }

  return (
    <div data-graycode-summarize="overlay" style={scrimStyle}>
      <div data-graycode-summarize="dialog" style={dialogStyle} role="dialog" aria-modal="true">
        <div style={headerStyle}>
          <span>{t('title')}</span>
          <button
            type="button"
            data-graycode-summarize="close"
            style={closeStyle}
            onClick={onClose}
            aria-label={t('close')}
          >
            ✕
          </button>
        </div>
        {working && (
          <div data-graycode-summarize="working" style={workingStyle}>
            {t('actions.summarizing')}
          </div>
        )}
        {phase === 'success' && text !== null && (
          <>
            <pre data-graycode-summarize="text" style={textStyle}>{text}</pre>
            <div style={footerStyle}>
              <button
                type="button"
                data-graycode-summarize="copy"
                style={actionStyle}
                onClick={() => { void copy() }}
              >
                {copied ? t('copied') : t('copy')}
              </button>
              <button
                type="button"
                data-graycode-summarize="close-btn"
                style={actionStyle}
                onClick={onClose}
              >
                {t('close')}
              </button>
            </div>
          </>
        )}
        {phase === 'failed' && failure !== null && (
          <div data-graycode-summarize="error" style={errorStyle}>{failure}</div>
        )}
      </div>
    </div>
  )
}
