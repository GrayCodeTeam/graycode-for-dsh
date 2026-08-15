/**
 * turnTail 链的唯一当选条目（分支候选切换器壳）。
 *
 * `conversation.chat.turnTail` 是 chain 座位：一次渲染只选举一个条目（首个
 * 选择器非空者胜出，见 ui-slots renderer 的选举语义）。重roll 已并入用户消息
 * 操作行（EditUserAction，紧贴用户消息），这里只留轮级分支切换器（非 fork 轮
 * 或候选 ≤ 1 时不渲染）；任一失败都不波及聊天流。
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GrayRemoteInvoke } from '../settings/types.ts'
import { TurnBranchSwitcher, type TurnEndsSnapshotLike } from '../branchSwitch/BranchSwitcher.tsx'

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  flexWrap: 'wrap',
  minHeight: '22px',
}

/** 注入面：remote 通道、会话跳转与切换器文案。 */
export interface TurnTailActionsInjected {
  readonly remote: GrayRemoteInvoke
  /** 切换后打开目标分支会话（缺省无 sessions 服务时不跳）。 */
  readonly open?: (sessionId: string) => void
  /** 绑定 `graycode.branchSwitch` 命名空间的翻译座位（切换器文案）。 */
  readonly branchT: TranslateNS<'graycode.branchSwitch'>
}

export interface TurnTailActionsProps extends TurnTailActionsInjected {
  /** Chain selector result: the completed turn's session turn number. */
  readonly matched: { readonly turn: number }
  /** Framework-injected current session id. */
  readonly sessionId: string
  /** Framework-injected conversation snapshot selector（切换器读 turnEnds）。 */
  readonly useSession: <T>(selector: (state: TurnEndsSnapshotLike) => T) => T
}

/** turnTail 条目：轮级分支切换器（重roll 在用户消息操作行，见 EditUserAction）。 */
export function TurnTailActions({ matched, sessionId, useSession, remote, open, branchT }: TurnTailActionsProps): ReactNode {
  return (
    <div data-graycode-reroll="turn-tail-actions" style={rowStyle}>
      <TurnBranchSwitcher
        turn={matched.turn}
        sessionId={sessionId}
        useSession={useSession}
        t={branchT}
        remote={remote}
        open={open}
      />
    </div>
  )
}
