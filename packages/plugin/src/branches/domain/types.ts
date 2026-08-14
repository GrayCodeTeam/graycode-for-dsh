/**
 * GrayCode - Branch 模块类型契约（V2 §P3E 树状分支 sidecar）
 *
 * 对话正文真源始终是 DSH append-only Session；本 sidecar 只保存分组、候选次序、
 * 显示名称、软删除、激活候选与 Workspace Snapshot 关联，不保存对话正文副本。
 * 原生谱系（parentSession / seedLength）由 SessionHeader 承载，本域不复制。
 */

/** 分支候选的产生方式 */
export type BranchCandidateKind = 'root' | 'reroll' | 'edit' | 'manual';

/** 一个候选分支（= 一条独立 dsh Session） */
export interface BranchCandidate {
    /** 候选对应的 dsh Session id */
    sessionId: string;
    /** 源会话 id（fork 来源；root 候选无） */
    parentSessionId?: string;
    /** 对应 ctx.sessions.fork(source, boundary) 的 inclusive source event seq */
    boundary?: number;
    kind: BranchCandidateKind;
    /** 用户可见显示名（可选） */
    label?: string;
    /** 软删除时间戳；存在即视为已删除（dsh Session 仍保留） */
    deletedAt?: number;
    /** 关联的 Workspace Snapshot id（Phase 3C 集成预留） */
    workspaceSnapshotId?: string;
    /** 候选创建时间（Unix epoch ms） */
    createdAt: number;
}

/** 一个分支组：同一根会话下的候选集合 */
export interface GrayBranchGroup {
    /** 稳定分组 id */
    id: string;
    /** 所属 workspace id（cwd sha256 前 16 位；root 会话无 cwd 时缺省） */
    workspaceId?: string;
    /** 根会话 id（该组创建时的主会话） */
    rootSessionId: string;
    /** 当前激活候选的 session id */
    activeSessionId: string;
    /** 候选列表（root 候选在首位；按加入顺序） */
    candidates: BranchCandidate[];
    /** 单调 CAS 计数，每次变更 +1 */
    revision: number;
    /** 分组创建时间（Unix epoch ms） */
    createdAt: number;
}

/** 持久化信封（schema 版本化） */
export interface BranchGroupStore {
    version: number;
    groups: GrayBranchGroup[];
}

export const BRANCH_GROUP_STORE_VERSION = 1;

/** sidecar 文件布局 */
export const BRANCH_STORE_FILE = 'groups.json';

/** TREE-02（决策 4）：同一父会话下非删除候选数量上限；超限拒绝创建，不自动删除 */
export const MAX_CANDIDATES_PER_PARENT = 10;

/** TREE-09：软删候选默认保留期（天）；超过保留期的 tombstone 惰性物理清理 */
export const DEFAULT_BRANCH_RETENTION_DAYS = 30;

/** 软删保留期（毫秒） */
export const BRANCH_RETENTION_MS = DEFAULT_BRANCH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** 稳定错误码（机器可读，UI 不解析错误文案） */
export const BranchErrorCode = {
    GROUP_NOT_FOUND: 'GRAY_BRANCH_GROUP_NOT_FOUND',
    SESSION_NOT_IN_GROUP: 'GRAY_BRANCH_SESSION_NOT_IN_GROUP',
    SESSION_ALREADY_IN_GROUP: 'GRAY_BRANCH_SESSION_ALREADY_IN_GROUP',
    CANDIDATE_DELETED: 'GRAY_BRANCH_CANDIDATE_DELETED',
    REVISION_CONFLICT: 'GRAY_BRANCH_REVISION_CONFLICT',
    INVALID_INPUT: 'GRAY_INVALID_INPUT',
    TARGET_TURN_NOT_FOUND: 'GRAY_BRANCH_TARGET_TURN_NOT_FOUND',
    NO_PREVIOUS_TURN: 'GRAY_BRANCH_NO_PREVIOUS_TURN',
    NO_USER_MESSAGE: 'GRAY_BRANCH_NO_USER_MESSAGE',
    CANDIDATE_LIMIT_EXCEEDED: 'GRAY_BRANCH_CANDIDATE_LIMIT_EXCEEDED',
    FORK_REJECTED: 'GRAY_BRANCH_FORK_REJECTED',
    STORAGE_CORRUPT: 'GRAY_STORAGE_CORRUPT',
    STORAGE_WRITE_FAILED: 'GRAY_BRANCH_STORAGE_WRITE_FAILED',
} as const;

export type BranchErrorCodeValue = (typeof BranchErrorCode)[keyof typeof BranchErrorCode];

/** 分支操作错误（携带稳定 code，供工具与 Remote 直接透传） */
export class BranchError extends Error {
    readonly code: BranchErrorCodeValue;
    /** 冲突时携带的权威快照（REVISION_CONFLICT 时存在） */
    readonly authoritativeGroup?: GrayBranchGroup;
    /** fork 拒绝时携带的会话级错误码（SessionForkError.code 透传） */
    readonly sessionErrorCode?: string;

    constructor(
        message: string,
        code: BranchErrorCodeValue,
        extra?: { authoritativeGroup?: GrayBranchGroup; sessionErrorCode?: string }
    ) {
        super(message);
        this.name = 'BranchError';
        this.code = code;
        this.authoritativeGroup = extra?.authoritativeGroup;
        this.sessionErrorCode = extra?.sessionErrorCode;
    }
}
