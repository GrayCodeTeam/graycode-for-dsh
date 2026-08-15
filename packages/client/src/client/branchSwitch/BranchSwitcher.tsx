/**
 * 分支候选切换器（Gray-Code 风格 ‹ 2/3 ›，两个挂载变体共用芯片）。
 *
 * - TurnBranchSwitcher：挂在 turnTail 链（经 TurnTailActions），仅当当前轮
 *   是本会话的 fork 轮且该轮候选集 > 1 时渲染（candidatesAtTurn，per-turn
 *   粒度；boundary → turnEnds 映射失败自动不渲染）；
 * - SessionBranchSwitcher：挂在 `conversation.session.header.actions`
 *   （会话级兜底，整组候选轮换；当前会话是组根或 per-turn 映射不可用时仍
 *   可切换）。
 *
 * 切换动作：插件 Remote 通道没有 branches/switch 端点，客户端等价实现是
 * sessions.open(候选会话)——候选即完整会话，跳转即切换（activeSessionId
 * 指针不动，属已知取舍，见 logic.ts 文件头）。remote 拉取失败/无组/单候选
 * 一律渲染 nothing，绝不炸聊天流。
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GrayRemoteInvoke } from '../settings/types.ts'
import {
  branchGroupOfSession,
  candidatesAtTurn,
  candidatesOfGroup,
  candidateLabel,
  stepCandidate,
  type CandidateSwitchView,
} from './logic.ts'
import { useBranchGroups } from './branchData.ts'

const barStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '2px',
  padding: '1px 4px',
  borderRadius: '6px',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'transparent',
  fontSize: '11px',
  lineHeight: '1.6',
  color: 'inherit',
  userSelect: 'none',
  whiteSpace: 'nowrap',
}

const chevronStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '18px',
  height: '20px',
  padding: 0,
  border: 'none',
  borderRadius: '4px',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: '12px',
  lineHeight: 1,
}

const positionStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  padding: '0 6px',
  minWidth: '52px',
  justifyContent: 'center',
  fontVariantNumeric: 'tabular-nums',
  opacity: 0.85,
}

function Chevron({ dir }: { dir: 'left' | 'right' }): ReactNode {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {dir === 'left' ? <path d="M15 18l-6-6 6-6" /> : <path d="M9 18l6-6-6-6" />}
    </svg>
  )
}

/** 两个变体共用的注入面。 */
export interface BranchSwitchInjected {
  readonly remote: GrayRemoteInvoke
  /** 打开目标候选会话（sessions 服务缺省时点击 no-op）。 */
  readonly open?: (sessionId: string) => void
}

/** 芯片本体：候选集、当前下标与循环步进切换（纯展示 + onSwitch 回调）。 */
export function BranchSwitchChip({
  view,
  sessionId,
  t,
  onSwitch,
}: {
  view: CandidateSwitchView
  sessionId: string
  t: TranslateNS<'graycode.branchSwitch'>
  onSwitch: (sessionId: string) => void
}): ReactNode {
  const previous = stepCandidate(view, -1)
  const next = stepCandidate(view, 1)
  const current = view.candidates[view.index]
  const label = candidateLabel(current, current?.kind === 'root' ? t('branch.root') : t('branch.active'))
  const position = t('branch.position', { index: view.index + 1, total: view.total })
  return (
    <div data-graycode-branch="switcher" style={barStyle} title={position}>
      <button
        type="button"
        data-graycode-branch="previous"
        style={chevronStyle}
        title={t('branch.previous')}
        aria-label={t('branch.previous')}
        onClick={() => { if (previous !== undefined) onSwitch(previous.sessionId) }}
      >
        <Chevron dir="left" />
      </button>
      <span data-graycode-branch="position" style={positionStyle}>
        <span>{view.index + 1} / {view.total}</span>
        <span style={{ opacity: 0.6 }}>{label}</span>
      </span>
      <button
        type="button"
        data-graycode-branch="next"
        style={chevronStyle}
        title={t('branch.next')}
        aria-label={t('branch.next')}
        onClick={() => { if (next !== undefined) onSwitch(next.sessionId) }}
      >
        <Chevron dir="right" />
      </button>
      {/* 当前会话锚点（测试/调试辅助，不参与展示） */}
      <span data-graycode-branch="current" data-session-id={sessionId} hidden />
    </div>
  )
}

/** turnTail 链的快照结构需求：完成轮 → turn/end seq 索引。 */
export interface TurnEndsSnapshotLike {
  readonly turnEnds?: Iterable<readonly [number, number]> | undefined
}

export interface TurnBranchSwitcherProps extends BranchSwitchInjected {
  /** 链选择器给出的完成轮号。 */
  readonly turn: number
  readonly sessionId: string
  /** Framework-injected conversation snapshot selector（读 turnEnds）。 */
  readonly useSession: <T>(selector: (state: TurnEndsSnapshotLike) => T) => T
  /** Injected translate seat for the `graycode.branchSwitch` namespace. */
  readonly t: TranslateNS<'graycode.branchSwitch'>
}

/** 轮级候选切换器：仅 fork 轮渲染（其余轮渲染 nothing）。 */
export function TurnBranchSwitcher({ turn, sessionId, useSession, t, remote, open }: TurnBranchSwitcherProps): ReactNode {
  // Hooks 必须无条件调用，可见性判断全部放在订阅之后。
  const groups = useBranchGroups(remote, sessionId)
  const turnEnds = useSession((state) => state.turnEnds)
  if (groups.status !== 'ready') return null
  if (turnEnds === undefined) return null
  const view = candidatesAtTurn(branchGroupOfSession(groups.items, sessionId), sessionId, turn, turnEnds)
  if (view === undefined) return null
  return (
    <BranchSwitchChip
      view={view}
      sessionId={sessionId}
      t={t}
      onSwitch={(target) => { if (open !== undefined) open(target) }}
    />
  )
}

export interface SessionBranchSwitcherProps extends BranchSwitchInjected {
  readonly sessionId: string
  /** Injected translate seat for the `graycode.branchSwitch` namespace. */
  readonly t: TranslateNS<'graycode.branchSwitch'>
}

/** 会话级候选切换器（header 座位兜底：整组候选 > 1 才渲染）。 */
export function SessionBranchSwitcher({ sessionId, t, remote, open }: SessionBranchSwitcherProps): ReactNode {
  const groups = useBranchGroups(remote, sessionId)
  if (groups.status !== 'ready') return null
  const view = candidatesOfGroup(branchGroupOfSession(groups.items, sessionId), sessionId)
  if (view === undefined) return null
  return (
    <BranchSwitchChip
      view={view}
      sessionId={sessionId}
      t={t}
      onSwitch={(target) => { if (open !== undefined) open(target) }}
    />
  )
}
