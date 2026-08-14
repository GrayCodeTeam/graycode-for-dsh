/**
 * GrayCode - Branch 分组纯状态机（领域层，零宿主依赖）
 *
 * 所有变更都返回新对象（不可变风格）并单调递增 revision，供 CAS 并发控制：
 * 写入方携带 expectedRevision，与当前 revision 不一致即拒绝（返回权威快照）。
 * 本层不持有任何 I/O；持久化与 dsh 适配由 application/adapters 层负责。
 */
import {
    BRANCH_GROUP_STORE_VERSION,
    BRANCH_RETENTION_MS,
    BranchCandidate,
    BranchCandidateKind,
    BranchError,
    BranchErrorCode,
    GrayBranchGroup,
    MAX_CANDIDATES_PER_PARENT,
} from './types.ts';

/** 新建分支组：root 会话即第一个候选（kind='root'） */
export function createBranchGroup(input: {
    id: string;
    workspaceId?: string;
    rootSessionId: string;
    label?: string;
    createdAt?: number;
}): GrayBranchGroup {
    const createdAt = input.createdAt ?? Date.now();
    return {
        id: input.id,
        workspaceId: input.workspaceId,
        rootSessionId: input.rootSessionId,
        activeSessionId: input.rootSessionId,
        candidates: [
            {
                sessionId: input.rootSessionId,
                kind: 'root',
                label: input.label,
                createdAt,
            },
        ],
        revision: 1,
        createdAt,
    };
}

/** 查找组内候选；不存在时抛 SESSION_NOT_IN_GROUP */
export function getCandidate(group: GrayBranchGroup, sessionId: string): BranchCandidate {
    const candidate = group.candidates.find(c => c.sessionId === sessionId);
    if (!candidate) {
        throw new BranchError(
            `session "${sessionId}" is not a candidate of branch group "${group.id}"`,
            BranchErrorCode.SESSION_NOT_IN_GROUP
        );
    }
    return candidate;
}

/** 校验 CAS：expectedRevision 与当前 revision 不一致即抛 REVISION_CONFLICT（附权威快照） */
export function assertRevision(
    group: GrayBranchGroup,
    expectedRevision: number | undefined
): void {
    if (expectedRevision === undefined) return;
    if (expectedRevision !== group.revision) {
        throw new BranchError(
            `branch group "${group.id}" revision conflict: expected ${expectedRevision}, current ${group.revision}`,
            BranchErrorCode.REVISION_CONFLICT,
            { authoritativeGroup: group }
        );
    }
}

/**
 * TREE-02（决策 4）：同一父会话下非删除候选数量上限。
 * 超限拒绝创建（不自动删除）；root 候选无 parentSessionId，不适用。
 */
export function assertCandidateLimit(
    group: GrayBranchGroup,
    parentSessionId: string | undefined
): void {
    if (parentSessionId === undefined) return;
    const live = group.candidates.filter(
        c => c.parentSessionId === parentSessionId && c.deletedAt === undefined
    ).length;
    if (live >= MAX_CANDIDATES_PER_PARENT) {
        throw new BranchError(
            `parent session "${parentSessionId}" already has ${MAX_CANDIDATES_PER_PARENT} live candidates; ` +
                'delete some before forking again',
            BranchErrorCode.CANDIDATE_LIMIT_EXCEEDED
        );
    }
}

/** 追加候选（kind 任意）。返回新组。 */
export function addCandidate(
    group: GrayBranchGroup,
    input: {
        sessionId: string;
        parentSessionId?: string;
        boundary?: number;
        kind: BranchCandidateKind;
        label?: string;
        workspaceSnapshotId?: string;
        expectedRevision?: number;
        createdAt?: number;
        /** 追加后立即激活新候选（reroll/edit_retry 的旧版 updateTail:true 语义；只切会话指针） */
        activate?: boolean;
    }
): GrayBranchGroup {
    assertRevision(group, input.expectedRevision);
    if (group.candidates.some(c => c.sessionId === input.sessionId)) {
        throw new BranchError(
            `session "${input.sessionId}" is already a candidate of branch group "${group.id}"`,
            BranchErrorCode.SESSION_ALREADY_IN_GROUP
        );
    }
    assertCandidateLimit(group, input.parentSessionId);
    const candidate: BranchCandidate = {
        sessionId: input.sessionId,
        parentSessionId: input.parentSessionId,
        boundary: input.boundary,
        kind: input.kind,
        label: input.label,
        workspaceSnapshotId: input.workspaceSnapshotId,
        createdAt: input.createdAt ?? Date.now(),
    };
    return {
        ...group,
        candidates: [...group.candidates, candidate],
        activeSessionId: input.activate ? input.sessionId : group.activeSessionId,
        revision: group.revision + 1,
    };
}

/** 切换激活候选（只切对话指针；不修改任何会话日志）。返回新组。 */
export function activateCandidate(
    group: GrayBranchGroup,
    sessionId: string,
    expectedRevision?: number
): GrayBranchGroup {
    assertRevision(group, expectedRevision);
    const candidate = getCandidate(group, sessionId);
    if (candidate.deletedAt !== undefined) {
        throw new BranchError(
            `candidate "${sessionId}" is deleted; restore it before activation`,
            BranchErrorCode.CANDIDATE_DELETED
        );
    }
    if (group.activeSessionId === sessionId) return group;
    return { ...group, activeSessionId: sessionId, revision: group.revision + 1 };
}

/** 软删除候选（root 候选不可删除）。返回新组。 */
export function deleteCandidate(
    group: GrayBranchGroup,
    sessionId: string,
    expectedRevision?: number,
    deletedAt?: number
): GrayBranchGroup {
    assertRevision(group, expectedRevision);
    const candidate = getCandidate(group, sessionId);
    if (candidate.kind === 'root') {
        throw new BranchError(
            'the root candidate of a branch group cannot be deleted',
            BranchErrorCode.INVALID_INPUT
        );
    }
    if (group.activeSessionId === sessionId) {
        throw new BranchError(
            'cannot delete the active candidate; switch first',
            BranchErrorCode.INVALID_INPUT
        );
    }
    const timestamp = deletedAt ?? Date.now();
    return {
        ...group,
        candidates: group.candidates.map(c =>
            c.sessionId === sessionId ? { ...c, deletedAt: timestamp } : c
        ),
        revision: group.revision + 1,
    };
}

/** 清除候选 tombstone（恢复）。返回新组。 */
export function restoreCandidate(
    group: GrayBranchGroup,
    sessionId: string,
    expectedRevision?: number
): GrayBranchGroup {
    assertRevision(group, expectedRevision);
    const candidate = getCandidate(group, sessionId);
    if (candidate.deletedAt === undefined) return group;
    const { deletedAt: _deletedAt, ...rest } = candidate;
    return {
        ...group,
        candidates: group.candidates.map(c =>
            c.sessionId === sessionId ? { ...rest } : c
        ),
        revision: group.revision + 1,
    };
}

/** 更新候选显示名。返回新组。 */
export function renameCandidate(
    group: GrayBranchGroup,
    sessionId: string,
    label: string,
    expectedRevision?: number
): GrayBranchGroup {
    assertRevision(group, expectedRevision);
    if (label.trim().length === 0) {
        throw new BranchError('candidate label must not be empty', BranchErrorCode.INVALID_INPUT);
    }
    const candidate = getCandidate(group, sessionId);
    if (candidate.label === label) return group;
    return {
        ...group,
        candidates: group.candidates.map(c =>
            c.sessionId === sessionId ? { ...c, label } : c
        ),
        revision: group.revision + 1,
    };
}

/**
 * TREE-09：惰性物理清理超过保留期的软删候选（tombstone 移除，dsh Session 本身保留）。
 * root 候选与激活候选永不清理（防御；激活候选本就不可能处于已删状态）。
 * 无过期项时返回原对象；否则 revision +1。
 */
export function purgeExpiredCandidates(
    group: GrayBranchGroup,
    now: number = Date.now()
): GrayBranchGroup {
    const cutoff = now - BRANCH_RETENTION_MS;
    const kept = group.candidates.filter(c => {
        if (c.deletedAt === undefined) return true;
        if (c.kind === 'root') return true;
        if (c.sessionId === group.activeSessionId) return true;
        // deletedAt >= cutoff：仍在保留期内（未超过 30 天）
        return c.deletedAt >= cutoff;
    });
    if (kept.length === group.candidates.length) return group;
    return {
        ...group,
        candidates: kept,
        revision: group.revision + 1,
    };
}

/** 持久化信封校验（加载时使用；损坏即抛 STORAGE_CORRUPT） */
export function parseBranchGroupStore(raw: string): GrayBranchGroup[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new BranchError(
            `branch sidecar is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            BranchErrorCode.STORAGE_CORRUPT
        );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new BranchError('branch sidecar root must be an object', BranchErrorCode.STORAGE_CORRUPT);
    }
    const record = parsed as { version?: unknown; groups?: unknown };
    if (record.version !== BRANCH_GROUP_STORE_VERSION || !Array.isArray(record.groups)) {
        throw new BranchError(
            `unsupported branch sidecar version ${String(record.version)}`,
            BranchErrorCode.STORAGE_CORRUPT
        );
    }
    return record.groups as GrayBranchGroup[];
}
