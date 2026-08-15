/**
 * 用户消息操作行（编辑铅笔 + 重roll，key 化 chat 节点渲染器）。
 *
 * 注册进宿主的 `conversation.chat.node` key 化座位（key =
 * {@link EDIT_ACTION_KIND}，载荷经 ChatNodeDataMap 合并声明）：节点由
 * editNode.ts 的 Definition 锚定在每个 append 型用户消息正后方，本渲染器
 * 把它画成「编辑铅笔 + 重新生成」的紧凑操作行，视觉上紧贴用户消息——宿主
 * 没有用户消息操作行座位，这是唯一能贴到用户消息复制按钮旁的加法路径
 * （用户明确要求重roll 出现在用户消息旁，而非轮尾）。
 *
 * 可见性纯逻辑防御（渲染 nothing 而非报错）：
 * - turn 缺失（位置 unresolved）或 turn ≤ 1（首轮无前缀可 fork，宿主必报
 *   GRAY_BRANCH_NO_PREVIOUS_TURN；RegenerateAction 内部同样防御）；
 * - source.kind 非 'user'（agent 注入的合成上下文不可编辑）；
 * - 节点锚定的消息不是本轮「开轮」用户消息（steering 消息 seq 对不上
 *   editTargetOfTurn 解析出的开轮消息 seq）。
 *
 * 编辑点击打开轻量弹窗（EditTurnOverlay，textarea 预填原文 + 确认/取消），
 * 确认走插件 `branches/editRetry`；重roll 直接调 `branches/reroll`（成功后
 * 失效分支缓存并跳转新分支会话）。两者都经 /graycode remote 通道；失败在
 * 行内可读展示（console.warn 同步留痕），绝不静默、绝不炸聊天流。
 */
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GrayRemoteInvoke } from '../settings/types.ts'
import { editTargetOfTurn, isRerollableTurn, type EditSnapshotLike } from './logic.ts'
import { EditTurnOverlay } from './EditTurnButton.tsx'
import { RegenerateAction } from './RegenerateButton.tsx'
import type { EditActionChatNode } from './editNode.ts'

/** 图标按钮样式对齐宿主 MessageIconActions 的 action 类（28px 圆形 hover 位）。 */
const pencilStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '22px',
  height: '22px',
  padding: 0,
  borderRadius: '4px',
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary, inherit)',
  opacity: 0.65,
  cursor: 'pointer',
}

/** 紧贴用户气泡：负上边距抵消 flow 列表的 16px 间距，让按钮读作消息附属。 */
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  marginTop: '-10px',
  marginLeft: '2px',
  minHeight: '22px',
}

function PencilIcon({ size = 13 }: { size?: number }): ReactNode {
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

/** 注入面：/graycode remote 通道 + 会话跳转 + 编辑/重roll 成功后的回调（分支缓存失效）。 */
export interface EditUserActionInjected {
  readonly remote: GrayRemoteInvoke
  /** reroll 成功后跳转到新分支会话（缺省无 sessions 服务时不跳）。 */
  readonly open?: (sessionId: string) => void
  /** editRetry / reroll 成功后调用（例如让分支切换器刷新候选列表）。 */
  readonly onCommitted?: () => void
}

export interface EditUserActionProps extends EditUserActionInjected {
  /** key 化座位注入的节点载荷（keyProps share）。 */
  readonly node: EditActionChatNode
  /** Framework-injected current session id. */
  readonly sessionId: string
  /** Framework-injected conversation snapshot selector. */
  readonly useSession: <T>(selector: (state: EditSnapshotLike) => T) => T
  /** Framework-injected translate seat for the `graycode.rerollEdit` namespace. */
  readonly t: TranslateNS<'graycode.rerollEdit'>
}

/** 用户消息操作行（编辑铅笔 + 重roll；不可解析/不可编辑时渲染 nothing）。 */
export function EditUserAction({ node, sessionId, useSession, remote, open, onCommitted, t }: EditUserActionProps): ReactNode {
  const data = node.data
  const [openEditor, setOpenEditor] = useState(false)
  // Hooks 必须无条件调用（早退判断全部放在订阅之后）。
  const snapshot = useSession((state) => state)

  // 首轮防御 + 合成上下文防御：不渲染（点击只会得到宿主英文错误）。
  if (data.sourceKind !== 'user') return null
  if (data.turn === undefined || !isRerollableTurn(data.turn)) return null

  const target = editTargetOfTurn(snapshot, data.turn)
  // 只有锚定在「开轮」用户消息上的节点才渲染（steering 消息的 seq 对不上）。
  if (target === undefined || target.seq !== data.seq) return null

  return (
    <div data-graycode-reroll="edit-user-action" style={rowStyle}>
      <button
        type="button"
        data-graycode-reroll="edit-user-pencil"
        style={pencilStyle}
        title={t('edit.label')}
        aria-label={t('edit.label')}
        onClick={() => setOpenEditor(true)}
      >
        <PencilIcon size={13} />
      </button>
      <RegenerateAction
        turn={data.turn}
        sessionId={sessionId}
        t={t}
        remote={remote}
        open={open}
        onCommitted={onCommitted}
      />
      {openEditor && (
        <EditTurnOverlay
          key={`${sessionId}:${data.turn}`}
          t={t}
          sessionId={sessionId}
          turn={data.turn}
          initialText={target.text}
          remote={remote}
          onCommitted={onCommitted}
          onClose={() => setOpenEditor(false)}
        />
      )}
    </div>
  )
}
