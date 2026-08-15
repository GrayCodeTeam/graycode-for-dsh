/**
 * GrayCode Remote API — 共享契约类型（host 侧，Phase 4 Client UI 消费）。
 *
 * 背景（见 src/remote/README.md 完整契约与降级路径说明）：
 * DSH rc.6 存在 Typert Remote 扩展面（ctx.typert / ctx.typertGateway /
 * ctx.remote.$mount），但所需包未链接进本插件（package.json 冻结）且
 * Client 装配由 DSH 官方 dsh-api-remotes 包构建期显式导入 —— 第三方当前
 * 无法挂载自己的 /remote 贡献 → GAP。本层是降级实现：
 * - 信封形态（GrayRemoteResult）逐字段对齐 Typert `RemoteResult`，
 *   DSH 升级后切换为 `@Remote` 装饰器 + 生成贡献时改动最小；
 * - 错误码为 PLAN_V2 §5.6 规定的稳定机器码（GRAY_*），UI 不解析错误文案；
 * - 查询/命令结果经 ProjectionJournal 记录为可回放事件
 *   （会话事件 + 工具结果投影通道，见 projection.ts）。
 */

/** 稳定的 Remote 错误机器码（PLAN_V2 §5.6；GRAY_* 前缀为 Gray 域保留） */
export const GRAY_REMOTE_ERROR_CODES = {
  /** 入参校验失败（字段缺失/类型错误/越界/路径越权）。 */
  INVALID_INPUT: 'GRAY_INVALID_INPUT',
  /** 并发/版本冲突（CAS revision 不符、恢复基线漂移、非法状态迁移）。 */
  CONFLICT: 'GRAY_CONFLICT',
  /** 需要人工审批：恢复未预览/预览 token 缺失或过期、破坏性命令未带 confirm。 */
  APPROVAL_REQUIRED: 'GRAY_APPROVAL_REQUIRED',
  /** 操作被取消（AbortSignal / 领域取消语义）。 */
  CANCELLED: 'GRAY_CANCELLED',
  /** 插件私有存储损坏或写入失败（records/entries/sidecar 不可读）。 */
  STORAGE_CORRUPT: 'GRAY_STORAGE_CORRUPT',
  /** 目标实体不存在（记忆条目、checkpoint、staged 条目、workflow 文档）。 */
  NOT_FOUND: 'GRAY_NOT_FOUND',
  /** 未知 Remote 端点（dispatch 层错误，非业务错误）。 */
  ENDPOINT_NOT_FOUND: 'GRAY_ENDPOINT_NOT_FOUND',
  /** 未预期失败（不透出堆栈/内部路径，见 errors.ts）。 */
  INTERNAL: 'GRAY_INTERNAL',
} as const

export type GrayRemoteErrorCode = (typeof GRAY_REMOTE_ERROR_CODES)[keyof typeof GRAY_REMOTE_ERROR_CODES]

/** PLAN_V2 §5.6 强制要求的五码集合（契约校验测试用）。 */
export const GRAY_REMOTE_MANDATED_CODES: readonly GrayRemoteErrorCode[] = [
  GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
  GRAY_REMOTE_ERROR_CODES.CONFLICT,
  GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED,
  GRAY_REMOTE_ERROR_CODES.CANCELLED,
  GRAY_REMOTE_ERROR_CODES.STORAGE_CORRUPT,
]

/** 一个 Remote 调用的失败描述（对齐 Typert RemoteFailure 形状）。 */
export interface GrayRemoteFailure {
  readonly code: GrayRemoteErrorCode
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
}

/**
 * 所有 Remote 端点统一返回信封：`ok:true + value` 或 `ok:false + error`。
 * 业务错误永不 reject —— 只有装配故障（未注册端点）才在 dispatch 层返回
 * ENDPOINT_NOT_FOUND 信封；调用方不需要 try/catch 恢复业务错误。
 * 形状对齐 `@deepseek-ai/dsh-typert-protocol` 的 `RemoteResult<T>`。
 */
export type GrayRemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GrayRemoteFailure }

/** 端点参数：命名 wire 参数对象（与 Typert InvokeRemoteRequest.args 同构）。 */
export type GrayRemoteArgs = Readonly<Record<string, unknown>>

/** 端点处理器：接收参数与取消信号，返回业务结果或抛 GrayRemoteError。 */
export type GrayRemoteHandler = (
  args: GrayRemoteArgs,
  signal?: AbortSignal
) => Promise<unknown> | unknown

/** 处理器注册表：key = `<namespace>/<method>`。 */
export interface GrayRemoteHandlers {
  readonly [endpoint: string]: GrayRemoteHandler
}

// ==================== 分页约定 ====================

export const GRAY_PAGE_LIMIT_MAX = 100
export const GRAY_PAGE_LIMIT_DEFAULT = 20

/** 一页结果：items + total（过滤后总数）+ nextCursor（末项 id；无更多页时缺省）。 */
export interface GrayPage<T> {
  readonly items: readonly T[]
  readonly total: number
  readonly nextCursor?: string
}

// ==================== 投影（可回放查询通道） ====================

/** 一条可回放投影事件：查询/命令结果以事件形式记录，Client 可重放/订阅。 */
export interface GrayProjectionEntry {
  /** 单调序号（进程内 + 文件续写共用一个序列）。 */
  readonly seq: number
  /** 事件种类，如 `query:workflows/list`、`command:checkpoints/restore`。 */
  readonly kind: string
  /** Unix epoch ms。 */
  readonly at: number
  /** 载荷：查询结果（ok 时 value / 失败时 failure）或命令结果。 */
  readonly payload: unknown
}

/** host 侧投影事件名（瞬态 cordis 事件；升级后映射为转发事件/会话事件）。 */
export const GRAY_PROJECTION_EVENT = 'graycode/remote/projection'

// ==================== workflows（P4-02 workflow 总览） ====================

export type GrayWorkflowRunKind = 'progress' | 'design' | 'plan' | 'review'

/** workflow run 摘要（列表项）。 */
export interface GrayWorkflowRunSummary {
  /** 稳定 id = workspace 相对路径（如 `.graycode/progress.md`）。 */
  readonly id: string
  readonly kind: GrayWorkflowRunKind
  /** workspace 相对路径（POSIX 分隔符）。 */
  readonly path: string
  /** 所属 workspace 根（绝对路径）。 */
  readonly workspace: string
  /** 最近更新（progress 元数据 updatedAt；非 progress 文档为文件 mtime ms）。 */
  readonly updatedAt?: number
  /** 字节大小（listDir/stat 可得时）。 */
  readonly sizeBytes?: number
  /** progress 文档解析出的状态（active/blocked/completed/archived）。 */
  readonly status?: string
  /** progress 文档解析出的阶段（design/plan/implementation/review/maintenance）。 */
  readonly phase?: string
  readonly projectName?: string
}

/** workflows/list 入参：按 workspace 过滤 + 分页。 */
export interface GrayWorkflowListParams {
  /** workspace 根（绝对路径）；Browser Remote 无会话 cwd，必须显式提供。 */
  readonly workspace: string
  readonly cursor?: string
  readonly limit?: number
}

/** workflows/get 入参。 */
export interface GrayWorkflowGetParams {
  /** workspace 根（绝对路径）；必须显式提供。 */
  readonly workspace: string
  /** run id（workspace 相对路径，必须落在 .graycode 白名单 scope 内）。 */
  readonly id: string
}

/** workflows/get 返回：摘要 + 全文 + progress 元数据（解析可得时）。 */
export interface GrayWorkflowRunDetail extends GrayWorkflowRunSummary {
  readonly content: string
  /** progress 文档的元数据（design/plan/review 无）。 */
  readonly metadata?: Readonly<Record<string, unknown>>
}

// ==================== memory（P4-03 memory 管理） ====================

export type GrayMemoryScope = 'global' | 'workspace'

/** 单条记忆视图（与 domain LogEntry 同构，序列化边界显式化）。 */
export interface GrayMemoryEntryView {
  readonly id: number
  readonly date: string
  readonly text: string
}

/** memory/list 入参：搜索（text 子串，大小写不敏感）+ 作用域过滤 + 分页。 */
export interface GrayMemoryListParams {
  /** 缺省 global。workspace 时需 workspace 已存在（只读，不创建）。 */
  readonly scope?: GrayMemoryScope
  /** scope=workspace 时的 workspace 根（绝对路径）。 */
  readonly workspace?: string
  readonly search?: string
  /** Opaque snapshot-bound cursor returned by the previous page. */
  readonly cursor?: string
  readonly limit?: number
}

export interface GrayMemoryListResult extends GrayPage<GrayMemoryEntryView> {
  /** 过滤后总条目数（total 同义，兼容旧客户端）。 */
  /** 完整底层记录快照的 opaque CAS revision；编辑/删除时必须原样回传。 */
  readonly revision: string
}

/** memory/note 入参：手动新增一条原始记忆（等价 memory_note 工具写入路径）。 */
export interface GrayMemoryNoteParams {
  readonly scope?: GrayMemoryScope
  readonly workspace?: string
  /** 单行文本；trim 后落盘，受 entryChars 字节上限约束。 */
  readonly text: string
}

/** memory/edit 入参：原地覆写单条原始记忆（保留 id/date）。 */
export interface GrayMemoryEditParams {
  readonly scope?: GrayMemoryScope
  readonly workspace?: string
  readonly id: number
  readonly text: string
  /** memory/list 返回的完整快照 revision。 */
  readonly expectedRevision: string
}

/** memory/forget 入参：blockId 语义与 memory_forget 工具一致。 */
export interface GrayMemoryForgetParams {
  readonly scope?: GrayMemoryScope
  readonly workspace?: string
  /**
   * `"16-31"` 丢树摘要；`"5"` 删单条原始记忆；`"1,3"` 闭区间删除。
   */
  readonly blockId: string
  /** raw 单条/区间删除时必须回传 memory/list 的快照 revision。 */
  readonly expectedRevision?: string
  /** 破坏性确认：必须为 true，否则 GRAY_APPROVAL_REQUIRED。 */
  readonly confirm: boolean
}

export interface GrayMemoryForgetResult {
  readonly mode: 'summary' | 'single' | 'range'
  /** single/range 模式：删除条数。 */
  readonly removed?: number
  /** summary 模式：丢弃的摘要块数。 */
  readonly gone?: number
  /** summary 模式：首个受影响块 id（"lo-hi"）。 */
  readonly firstId?: string
}

// ==================== checkpoints（P4-04/05 列表与恢复预览） ====================

import type {
  CheckpointDeleteOutcome,
  CheckpointGcResult,
  CheckpointListResult,
  CheckpointPreviewOutcome,
  CheckpointVerifyResult,
  CreateCheckpointResult,
} from '../checkpoints/service.ts'
import type {
  CheckpointSummary,
  RestoreResult,
} from '../checkpoints/domain/types.ts'

/** checkpoints/list 列表项 = 领域摘要 + verify 状态（rc.6 无持久 verify 状态，恒 'unknown'）。 */
export interface GrayCheckpointItemView extends CheckpointSummary {
  /**
   * rc.6 不持久化 verify 结果：列表恒为 'unknown'，UI 按需调 checkpoints/verify。
   * DSH 升级后可改为读取持久化状态。
   */
  readonly verifyState: 'unknown'
}

export interface GrayCheckpointListParams {
  readonly workspace: string
  readonly cursor?: string
  readonly limit?: number
}

export interface GrayCheckpointListResult {
  readonly items: readonly GrayCheckpointItemView[]
  readonly total: number
  readonly nextCursor?: string
}

export interface GrayCheckpointCreateParams {
  readonly workspace: string
  readonly title?: string
  readonly notes?: string
}

export interface GrayCheckpointVerifyParams {
  readonly checkpointId: string
}

export interface GrayCheckpointPreviewParams {
  readonly workspace: string
  readonly checkpointId: string
  readonly deleteUntrackedFiles?: boolean
}

/** checkpoints/restore 入参：previewToken 为 previewRestore 签发的审批 token。 */
export interface GrayCheckpointRestoreParams {
  readonly workspace: string
  readonly checkpointId: string
  /** previewRestore 返回值，必须原样回传；缺失/过期 → GRAY_APPROVAL_REQUIRED。 */
  readonly previewToken: string
  readonly deleteUntrackedFiles?: boolean
}

export interface GrayCheckpointDeleteParams {
  readonly workspace: string
  readonly checkpointId: string
  readonly force?: boolean
  /** Browser destructive-action gate. */
  readonly confirm: true
}

export interface GrayCheckpointGcParams {
  readonly workspace: string
  /** Defaults to true. */
  readonly dryRun?: boolean
  /** Required only when dryRun=false. */
  readonly confirm?: true
}

// ==================== branches（reroll / editRetry 重试端点） ====================

/** branches/reroll 与 branches/editRetry 的公共入参。 */
export interface GrayBranchRetryParams {
  /** 源会话 id（fork 的 parent；未归组时端点层自动建组）。 */
  readonly sessionId: string
  /** 目标轮次号（fork 该轮次之前的完整前缀，并把该轮次的用户消息重发到新会话）。 */
  readonly turn: number
  /** CAS：branches/list 的 revision（数字或数字字符串；可选）。 */
  readonly expectedRevision?: number | string
}

export interface GrayBranchRerollParams extends GrayBranchRetryParams {}

export interface GrayBranchEditRetryParams extends GrayBranchRetryParams {
  /** 编辑后的用户消息文本（重发内容）。 */
  readonly text: string
}

/** branches/reroll 与 branches/editRetry 的成功结果。 */
export interface GrayBranchRetryResult {
  /** fork 产生的 child session id（新候选；已自动激活为当前会话）。 */
  readonly branchSessionId: string
}

// ==================== stagedDiff（P4-06 staged diff 卡片） ====================

import type { StagedEntry, StagedEntryStatus } from '../stagedDiff/domain/types.ts'

export interface GrayStagedDiffListParams {
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly statuses?: readonly StagedEntryStatus[]
  readonly cursor?: string
  readonly limit?: number
}

export interface GrayStagedDiffListResult extends GrayPage<StagedEntry> {}

/** accept/reject 入参：expectedRevision 为 CAS 乐观锁（读到的 revision 原样回传）。 */
export interface GrayStagedDiffDecisionParams {
  readonly entryId: string
  readonly expectedRevision: number
  /** 目标 workspace 根（绝对路径）；Browser Remote 必须显式提供。 */
  readonly workspace: string
}

export type {
  CheckpointDeleteOutcome,
  CheckpointGcResult,
  CheckpointListResult,
  CheckpointPreviewOutcome,
  CheckpointVerifyResult,
  CreateCheckpointResult,
}
export type { CheckpointSummary, RestoreResult }
