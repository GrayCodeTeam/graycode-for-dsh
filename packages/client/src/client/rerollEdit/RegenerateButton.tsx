/**
 * 重新生成当前轮（F1 的按钮部分）。
 *
 * 由 TurnTailActions（`conversation.chat.turnTail` 链座位的唯一当选条目）内联
 * 渲染：链选择器直接给出该轮的会话轮号，不再经 messageId → legacy nodes 反查
 * （旧路径依赖宿主 IconActions 行对 extraActions 的渲染时机，且首轮防御
 * turn ≤ 1 时静默不可见——「没有重roll」抱怨的两个来源）。现在每个已完成
 * 且 turn > 1 的轮次都有稳定可见的按钮；点击调用插件的 `branches/reroll`
 * 端点（可信 `/graycode` remote 通道），成功后若返回 branchSessionId 则跳转
 * 打开（与 subagent back-to-main 同路由），并回调 onCommitted 让分支切换器
 * 刷新候选。端点错误就地展示（行内警告 + console.warn），绝不吞掉。
 */
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GrayRemoteInvoke } from '../settings/types.ts'
import { isNoPreviousTurnFailure, isRerollableTurn } from './logic.ts'

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

/** Props：/graycode remote 通道 + 可选跳转与提交回调。 */
export interface RegenerateActionProps {
  /** The completed turn's session turn number. */
  readonly turn: number
  /** Framework-injected current session id. */
  readonly sessionId: string
  /** Framework-injected translate seat for the `graycode.rerollEdit` namespace. */
  readonly t: TranslateNS<'graycode.rerollEdit'>
  readonly remote: GrayRemoteInvoke
  /** Open a branch session after a successful reroll (absent without the sessions service). */
  readonly open?: (sessionId: string) => void
  /** reroll 成功后的回调（分支候选缓存失效等）。 */
  readonly onCommitted?: () => void
}

type RerollPhase = 'idle' | 'working' | 'failed'

/** Regenerate action for one completed turn (renders nothing on the first turn). */
export function RegenerateAction({ turn, sessionId, t, remote, open, onCommitted }: RegenerateActionProps): ReactNode {
  const [phase, setPhase] = useState<RerollPhase>('idle')
  const [failure, setFailure] = useState<string | null>(null)

  // 首轮（turn ≤ 1）没有可 fork 的前缀，宿主必报 GRAY_BRANCH_NO_PREVIOUS_TURN；
  // 直接不渲染按钮，避免点击后暴露英文原文错误（防御保持不变）。
  if (!isRerollableTurn(turn)) return null

  const start = async (): Promise<void> => {
    if (phase === 'working') return
    setPhase('working')
    setFailure(null)
    try {
      const result = await remote('branches', 'reroll', { sessionId, turn })
      if (result.ok) {
        setPhase('idle')
        if (onCommitted !== undefined) onCommitted()
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
