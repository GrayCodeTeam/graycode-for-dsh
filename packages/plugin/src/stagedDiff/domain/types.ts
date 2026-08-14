/**
 * GrayCode - staged-diff 条目模型与类型契约（ADR-0003 §4 状态机草案）
 *
 * 延迟审阅语义：Gray 写工具把写入意图先变成 staged 条目，用户审阅接受后才经
 * ctx.fs 落盘；拒绝则不落盘。本文件只定义纯数据契约（无任何宿主/IO 依赖）。
 *
 * 与 ADR-0003 §4 的对应：
 * - 条目字段：id / workspaceId / sessionId / path / before / after / toolCallId /
 *   status / createdAt / updatedAt / revision（CAS）；
 * - status 枚举：pending | reviewing | accepted | rejected | done | needs-reapply
 *   （needs-reapply 为崩溃恢复专用状态：accepted 但未落盘，重启后由
 *   restoreFromSidecar 标出，人工确认后重放，不自动落盘）；
 * - before 语义对齐 `FsWriteOutcome.before`：string = 落盘前快照（LF 归一化），
 *   null = 目标不存在（新建）或快照不可得；
 * - 持久化信封：<dataRoot>/staged-diff/entries.json（原子 tmp+rename，见
 *   adapters/storage.ts）。
 */

/** 条目状态（ADR-0003 §4） */
export type StagedEntryStatus =
  | 'pending'
  | 'reviewing'
  | 'accepted'
  | 'rejected'
  | 'done'
  | 'needs-reapply';

/** 全部状态（用于转换表全覆盖测试与加载校验） */
export const STAGED_ENTRY_STATUSES: readonly StagedEntryStatus[] = [
  'pending',
  'reviewing',
  'accepted',
  'rejected',
  'done',
  'needs-reapply',
];

/** 一条延迟审阅写入意图 */
export interface StagedEntry {
  /** 稳定条目 id（幂等键之一；显式 entryId 或 uuid） */
  id: string;
  /** 所属 workspace id（cwd 派生，与 branches/checkpoints 同口径） */
  workspaceId: string;
  /** 产生写入意图的会话 id */
  sessionId: string;
  /** 规范化后的 workspace 相对路径（POSIX 分隔符、无前导 / 或 ..；见 pathSafety.ts） */
  path: string;
  /** 落盘前快照（FsWriteOutcome.before 语义）：null = 目标不存在（新建）或快照不可得 */
  before: string | null;
  /** 目标内容：accepted 后经落盘端口写入 path */
  after: string;
  /** 产生该写入意图的工具调用 id（与 path 构成幂等键） */
  toolCallId?: string;
  status: StagedEntryStatus;
  /** Unix epoch ms */
  createdAt: number;
  /** Unix epoch ms */
  updatedAt: number;
  /** 单调 CAS 计数，每次变更 +1 */
  revision: number;
}

/** sidecar 持久化信封（<dataRoot>/staged-diff/entries.json） */
export interface StagedDiffStore {
  version: number;
  entries: StagedEntry[];
}

export const STAGED_DIFF_STORE_VERSION = 1;

/** sidecar 文件布局 */
export const STAGED_DIFF_STORE_FILE = 'entries.json';

/** 稳定错误码（机器可读，UI/工具不解析错误文案） */
export const StagedDiffErrorCode = {
  ENTRY_NOT_FOUND: 'GRAY_STAGED_ENTRY_NOT_FOUND',
  ILLEGAL_TRANSITION: 'GRAY_STAGED_ILLEGAL_TRANSITION',
  REVISION_CONFLICT: 'GRAY_STAGED_REVISION_CONFLICT',
  INVALID_PATH: 'GRAY_STAGED_INVALID_PATH',
  PATH_ESCAPE: 'GRAY_STAGED_PATH_ESCAPE',
  INVALID_INPUT: 'GRAY_INVALID_INPUT',
  REJECT_CONFLICT: 'GRAY_STAGED_REJECT_CONFLICT',
  APPLY_FAILED: 'GRAY_STAGED_APPLY_FAILED',
  STORAGE_CORRUPT: 'GRAY_STORAGE_CORRUPT',
  STORAGE_WRITE_FAILED: 'GRAY_STAGED_STORAGE_WRITE_FAILED',
} as const;

export type StagedDiffErrorCodeValue = (typeof StagedDiffErrorCode)[keyof typeof StagedDiffErrorCode];

/** staged-diff 操作错误（携带稳定 code，供工具与 UI 直接透传） */
export class StagedDiffError extends Error {
  readonly code: StagedDiffErrorCodeValue;
  /** 冲突/失败时携带的权威条目快照（REVISION_CONFLICT / REJECT_CONFLICT / APPLY_FAILED 时存在） */
  readonly entry?: StagedEntry;

  constructor(
    message: string,
    code: StagedDiffErrorCodeValue,
    extra?: { entry?: StagedEntry; cause?: unknown }
  ) {
    super(message, extra?.cause !== undefined ? { cause: extra.cause } : undefined);
    this.name = 'StagedDiffError';
    this.code = code;
    this.entry = extra?.entry;
  }
}
