/**
 * 编辑用户消息弹窗（F2 的对话框部分，供 EditUserAction 复用）。
 *
 * 轻量模态：textarea 预填原用户消息 + 确认/取消（与 memory 编辑浮层相同的
 * 内联样式 scrim/dialog 模式）。确认调用插件的 `branches/editRetry` 端点
 * （可信 `/graycode` remote 通道）；端点错误留在弹窗内可读展示（warning +
 * console.warn），绝不静默。成功后关闭弹窗并回调 `onCommitted`（分支候选
 * 缓存失效，让切换器立即看到新候选）。
 *
 * 本文件只保留弹窗本体与共享样式；F2 的入口按钮（原 turnTail 链壳）已由
 * 贴近用户消息的 EditUserAction（key 化 chat 节点渲染器）取代。
 */
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GrayRemoteInvoke } from '../settings/types.ts'
import { isNoPreviousTurnFailure } from './logic.ts'

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

export interface EditTurnOverlayProps {
  t: TranslateNS<'graycode.rerollEdit'>
  sessionId: string
  turn: number
  /** Original user message text (the textarea prefill). */
  initialText: string
  remote: GrayRemoteInvoke
  /** editRetry 成功后的回调（分支候选缓存失效等）。 */
  onCommitted?: () => void
  onClose: () => void
}

type EditPhase = 'idle' | 'working' | 'failed'

/** Modal edit dialog: textarea + confirm/cancel; failures stay visible. */
export function EditTurnOverlay({ t, sessionId, turn, initialText, remote, onCommitted, onClose }: EditTurnOverlayProps): ReactNode {
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
        if (onCommitted !== undefined) onCommitted()
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
