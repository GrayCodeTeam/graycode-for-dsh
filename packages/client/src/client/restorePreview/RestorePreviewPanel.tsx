/**
 * Restore preview panel — the P4-05 UI surface (orchestrator).
 *
 * Renders the restore confirmation flow for one checkpoint: preview trigger,
 * classified file list, approval area (token display + explicit confirm
 * checkbox), final-confirmation restore entry, progress with per-file
 * failures and the failed-state retry / re-preview / reset entries.
 *
 * CLIENT BOUNDARY RULES (enforced here and in the state machine):
 * - Destructive restore requires EXPLICIT DOUBLE CONFIRMATION: the confirm
 *   checkbox arms the step (phase `confirm`), then the "Restore now" button
 *   actually runs it. Both are disabled until the machine allows them.
 * - Preview and restore are bound to the SAME previewId: the panel always
 *   passes `session.previewId` (= the approval token) back to `onRestore`.
 * - Progress and per-item failures come from host data only — nothing here
 *   treats a cache or local state as a write success.
 * - Replay-safe: the panel never performs I/O; every entry is a declarative
 *   callback (`onPreview` / `onConfirm` / `onConfirmWithToken` / `onRestore` /
 *   `onRePreview` / `onReset`) wired by the host. Unwired callbacks render
 *   disabled with the `replayOnly` hint.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { restoreErrorHint } from './errors.ts'
import { classifyPreviewFiles, previewHasBlockingConflicts } from './model.ts'
import { RestorePreviewList } from './RestorePreviewList.tsx'
import { RestoreProgressView } from './RestoreProgressView.tsx'
import { canConfirm } from './stateMachine.ts'
import type { RestorePhase, RestoreSession, RestoreStep } from './types.ts'

/** Composed props for the restore preview panel. */
export interface RestorePreviewPanelProps {
  /** Framework-injected translate seat for the `graycode.restorePreview` namespace. */
  t: TranslateNS<'graycode.restorePreview'>
  /** Machine state snapshot (idle/preview/confirm/running/done/failed). */
  step: RestoreStep
  /** Checkpoint this panel operates on (drives preview + paste-token mode). */
  checkpointId: string
  /** Workspace root (absolute); omitted = host default. */
  workspace?: string
  /** Whether the preview/restore should plan untracked-file deletion. */
  deleteUntrackedFiles?: boolean
  /** False when host endpoints are not wired — the panel shows the mock banner. */
  hostAvailable?: boolean
  /** Declarative entries; absent during replay/unwired hosts → disabled + replayOnly. */
  onPreview?: (params: { checkpointId: string; workspace?: string; deleteUntrackedFiles?: boolean }) => void
  /** First confirmation: armed the loaded preview (acknowledgeUntracked = checkbox state). */
  onConfirm?: (acknowledgeUntracked: boolean) => void
  /** Paste-token mode: confirm restore with a token from another surface. */
  onConfirmWithToken?: (params: { token: string; checkpointId: string; workspace?: string; deleteUntrackedFiles: boolean }) => void
  /** Run the restore with the confirmed session (carries the bound previewId). */
  onRestore?: (session: RestoreSession) => void
  /** Back to idle to re-run the preview (stale-token path). */
  onRePreview?: () => void
  /** Back to idle from any terminal state. */
  onReset?: () => void
}

const PHASE_TONE: Record<RestorePhase, string> = {
  idle: '#8b949e',
  preview: '#58a6ff',
  confirm: '#d29922',
  running: '#58a6ff',
  done: '#3fb950',
  failed: '#f85149',
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.5rem 0.75rem',
  borderRadius: '0.5rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'var(--dsh-text-color, #eee)',
  fontSize: '12px',
  lineHeight: '1.45',
  minWidth: '280px',
  maxWidth: '520px',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  flexWrap: 'wrap',
}

const titleStyle: CSSProperties = {
  fontWeight: 600,
}

const phaseBadgeStyle: CSSProperties = {
  marginLeft: 'auto',
  padding: '0.0625rem 0.4375rem',
  borderRadius: '999px',
  border: '1px solid currentColor',
  fontSize: '10px',
  whiteSpace: 'nowrap',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: '0.375rem',
  alignItems: 'baseline',
}

const labelStyle: CSSProperties = {
  opacity: 0.65,
  flexShrink: 0,
}

const valueStyle: CSSProperties = {
  overflowWrap: 'anywhere',
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
}

const tokenValueStyle: CSSProperties = {
  ...valueStyle,
  fontSize: '11px',
}

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
}

const approvalStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  padding: '0.375rem 0.5rem',
  borderRadius: '0.375rem',
  border: '1px solid var(--dsh-border-color, #333)',
}

const actionsStyle: CSSProperties = {
  display: 'flex',
  gap: '0.375rem',
  marginTop: '0.125rem',
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

const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.45,
  cursor: 'not-allowed',
}

const inputStyle: CSSProperties = {
  padding: '0.125rem 0.375rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'transparent',
  color: 'inherit',
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: '11px',
}

const checkboxStyle: CSSProperties = {
  display: 'flex',
  gap: '0.375rem',
  alignItems: 'flex-start',
}

const hintStyle: CSSProperties = {
  fontSize: '11px',
  opacity: 0.75,
}

const warnStyle: CSSProperties = {
  fontSize: '11px',
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid #d29922',
  background: 'rgba(210, 153, 34, 0.08)',
  color: '#d29922',
}

const errorStyle: CSSProperties = {
  fontSize: '11px',
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid #f85149',
  background: 'rgba(248, 81, 73, 0.08)',
  color: '#f85149',
}

const successStyle: CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  color: '#3fb950',
}

const countsRowStyle: CSSProperties = {
  display: 'flex',
  gap: '0.75rem',
  flexWrap: 'wrap',
  fontSize: '11px',
  opacity: 0.85,
}

/**
 * Restore preview panel. Mount it wherever the host renders checkpoint
 * restore surfaces (see restorePreview/README.md for wiring).
 */
export function RestorePreviewPanel({
  t,
  step,
  checkpointId,
  workspace,
  deleteUntrackedFiles = false,
  hostAvailable = true,
  onPreview,
  onConfirm,
  onConfirmWithToken,
  onRestore,
  onRePreview,
  onReset,
}: RestorePreviewPanelProps): ReactNode {
  const [ack, setAck] = useState(false)
  const [token, setToken] = useState('')
  const [pasteMode, setPasteMode] = useState(false)

  // Local UI state resets whenever the machine moves to a new phase/preview.
  useEffect(() => {
    setAck(false)
    setToken('')
    setPasteMode(false)
  }, [step.phase, step.previewAt])

  const flags = { deleteUntrackedFiles: step.session?.deleteUntrackedFiles ?? deleteUntrackedFiles }
  const classification = step.preview === null ? null : classifyPreviewFiles(step.preview, flags)
  const confirmArmed = canConfirm(step) && ack
  const hint = step.error === null ? null : restoreErrorHint(step.error)
  const previewDisabled = !hostAvailable || onPreview === undefined

  return (
    <div data-graycode-restorepreview="panel" data-phase={step.phase} style={panelStyle}>
      <div style={headerStyle}>
        <span style={titleStyle}>{t('title')}</span>
        <span style={{ ...phaseBadgeStyle, color: PHASE_TONE[step.phase] }}>{t(`phase.${step.phase}`)}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>{t('checkpointLabel')}</span>
        <span style={valueStyle}>{checkpointId}</span>
      </div>

      {!hostAvailable && <div style={warnStyle}>{t('mockModeHint')}</div>}

      {step.phase === 'idle' && (
        <div style={actionsStyle}>
          <button
            type="button"
            data-graycode-restorepreview="preview"
            style={previewDisabled ? disabledButtonStyle : buttonStyle}
            disabled={previewDisabled}
            title={previewDisabled ? t('replayOnly') : undefined}
            onClick={() => {
              if (!previewDisabled && onPreview !== undefined) onPreview({ checkpointId, workspace, deleteUntrackedFiles })
            }}
          >
            {t('previewButton')}
          </button>
          <button
            type="button"
            data-graycode-restorepreview="paste-toggle"
            style={buttonStyle}
            onClick={() => setPasteMode(mode => !mode)}
          >
            {t('pasteTokenButton')}
          </button>
        </div>
      )}

      {step.phase === 'idle' && pasteMode && (
        <div style={approvalStyle} data-graycode-restorepreview="paste-token">
          <div>{t('pasteTokenTitle')}</div>
          <input
            type="text"
            data-graycode-restorepreview="token"
            style={inputStyle}
            value={token}
            placeholder={t('tokenPlaceholder')}
            onChange={event => setToken(event.target.value)}
          />
          <div style={hintStyle}>{t('tokenHint')}</div>
          <button
            type="button"
            data-graycode-restorepreview="restore-with-token"
            style={token.trim().length === 0 || onConfirmWithToken === undefined ? disabledButtonStyle : buttonStyle}
            disabled={token.trim().length === 0 || onConfirmWithToken === undefined}
            title={onConfirmWithToken === undefined ? t('replayOnly') : undefined}
            onClick={() => {
              if (onConfirmWithToken !== undefined && token.trim().length > 0) {
                onConfirmWithToken({ token: token.trim(), checkpointId, workspace, deleteUntrackedFiles })
              }
            }}
          >
            {t('restoreButton')}
          </button>
        </div>
      )}

      {(step.phase === 'preview' || step.phase === 'confirm') && (
        <div style={bodyStyle}>
          {step.preview === null ? (
            <div style={hintStyle}>{t('previewing')}</div>
          ) : (
            <>
              {classification !== null && (
                <RestorePreviewList t={t} classification={classification} legacy={step.preview.legacy === true} />
              )}

              {step.phase === 'preview' && (
                <div style={approvalStyle} data-graycode-restorepreview="approval">
                  {step.session !== null && (
                    <div style={rowStyle}>
                      <span style={labelStyle}>{t('tokenLabel')}</span>
                      <code style={tokenValueStyle}>{step.session.previewId}</code>
                    </div>
                  )}
                  <div style={hintStyle}>{t('stalePreviewHint')}</div>
                  {previewHasBlockingConflicts(step.preview) && (
                    <div style={errorStyle}>{t('conflictBlockedHint')}</div>
                  )}
                  <label style={checkboxStyle}>
                    <input
                      type="checkbox"
                      data-graycode-restorepreview="confirm-checkbox"
                      checked={ack}
                      disabled={!canConfirm(step)}
                      onChange={event => setAck(event.target.checked)}
                    />
                    {t('confirmCheckbox')}
                  </label>
                  <button
                    type="button"
                    data-graycode-restorepreview="confirm"
                    style={!confirmArmed || onConfirm === undefined ? disabledButtonStyle : buttonStyle}
                    disabled={!confirmArmed || onConfirm === undefined}
                    title={onConfirm === undefined ? t('replayOnly') : undefined}
                    onClick={() => {
                      if (onConfirm !== undefined && confirmArmed) onConfirm(ack)
                    }}
                  >
                    {t('confirmButton')}
                  </button>
                </div>
              )}

              {step.phase === 'confirm' && (
                <div style={approvalStyle} data-graycode-restorepreview="armed">
                  <div style={warnStyle}>{t('confirmWarning')}</div>
                  <button
                    type="button"
                    data-graycode-restorepreview="restore"
                    style={onRestore === undefined || step.session === null ? disabledButtonStyle : buttonStyle}
                    disabled={onRestore === undefined || step.session === null}
                    title={onRestore === undefined ? t('replayOnly') : undefined}
                    onClick={() => {
                      if (onRestore !== undefined && step.session !== null) onRestore(step.session)
                    }}
                  >
                    {t('restoreButton')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {step.phase === 'running' && (
        <div style={bodyStyle}>
          {step.progress === null
            ? <div style={hintStyle}>{t('previewing')}</div>
            : <RestoreProgressView t={t} progress={step.progress} />}
        </div>
      )}

      {step.phase === 'done' && (
        <div style={bodyStyle} data-graycode-restorepreview="done">
          <div style={successStyle}>{t('doneTitle')}</div>
          {step.result !== null && (
            <div style={countsRowStyle}>
              <span>{t('restoredCountLabel')}: {step.result.restored}</span>
              <span>{t('deletedCountLabel')}: {step.result.deleted}</span>
              <span>{t('skippedCountLabel')}: {step.result.skipped}</span>
              <span>{t('failedCountLabel')}: {step.result.failures.length}</span>
            </div>
          )}
          <div style={actionsStyle}>
            <button
              type="button"
              data-graycode-restorepreview="reset"
              style={onReset === undefined ? disabledButtonStyle : buttonStyle}
              disabled={onReset === undefined}
              title={onReset === undefined ? t('replayOnly') : undefined}
              onClick={onReset}
            >
              {t('resetButton')}
            </button>
          </div>
        </div>
      )}

      {step.phase === 'failed' && (
        <div style={bodyStyle} data-graycode-restorepreview="failed">
          <div style={errorStyle}>{t('failedTitle')}</div>
          {hint !== null && step.error !== null && (
            <div style={errorStyle} data-graycode-restorepreview="error-hint">
              <span>{step.error.code} — {t(hint.key)}</span>
            </div>
          )}
          {step.progress !== null && <RestoreProgressView t={t} progress={step.progress} />}
          <div style={actionsStyle}>
            {step.retryable && step.session !== null && (
              <button
                type="button"
                data-graycode-restorepreview="retry"
                style={onRestore === undefined ? disabledButtonStyle : buttonStyle}
                disabled={onRestore === undefined}
                title={onRestore === undefined ? t('replayOnly') : undefined}
                onClick={() => {
                  if (onRestore !== undefined && step.session !== null) onRestore(step.session)
                }}
              >
                {t('retryButton')}
              </button>
            )}
            {step.rePreviewRequired && (
              <button
                type="button"
                data-graycode-restorepreview="re-preview"
                style={onRePreview === undefined ? disabledButtonStyle : buttonStyle}
                disabled={onRePreview === undefined}
                title={onRePreview === undefined ? t('replayOnly') : undefined}
                onClick={onRePreview}
              >
                {t('rePreviewButton')}
              </button>
            )}
            <button
              type="button"
              data-graycode-restorepreview="reset"
              style={onReset === undefined ? disabledButtonStyle : buttonStyle}
              disabled={onReset === undefined}
              title={onReset === undefined ? t('replayOnly') : undefined}
              onClick={onReset}
            >
              {t('resetButton')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
