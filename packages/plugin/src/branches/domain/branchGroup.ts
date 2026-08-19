/**
 * GrayCode - Branch 分组纯状态机（领域层，零宿主依赖）
 *
 * 所有变更都返回新对象（不可变风格）并单调递增 revision，供 CAS 并发控制：
 * 写入方携带 expectedRevision，与当前 revision 不一致即拒绝（返回权威快照）。
 * 本层不持有任何 I/O；持久化与 dsh 适配由 application/adapters 层负责。
 */
import {
    BRANCH_GROUP_STORE_VERSION,
    BranchCandidate,
    BranchCandidateKind,
    BranchError,
    BranchErrorCode,
    DAY_MS,
    DEFAULT_BRANCH_RETENTION_DAYS,
    GrayBranchGroup,
    MAX_CANDIDATES_PER_PARENT,
    MAX_CANDIDATE_LABEL_LENGTH,
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
    const subtree = collectCandidateSubtree(group, sessionId);
    if (subtree.has(group.activeSessionId)) {
        throw new BranchError(
            'cannot delete a candidate subtree containing the active candidate; switch first',
            BranchErrorCode.INVALID_INPUT
        );
    }
    const timestamp = deletedAt ?? Date.now();
    const changed = group.candidates.some(c => subtree.has(c.sessionId) && c.deletedAt === undefined);
    if (!changed) return group;
    return {
        ...group,
        candidates: group.candidates.map(c =>
            subtree.has(c.sessionId) && c.deletedAt === undefined ? { ...c, deletedAt: timestamp } : c
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
    const subtree = collectCandidateSubtree(group, sessionId);
    if (candidate.deletedAt === undefined && !group.candidates.some(c => subtree.has(c.sessionId) && c.deletedAt !== undefined)) {
        return group;
    }
    return {
        ...group,
        candidates: group.candidates.map(c => {
            if (!subtree.has(c.sessionId) || c.deletedAt === undefined) return c;
            const { deletedAt: _deletedAt, ...rest } = c;
            return rest;
        }),
        revision: group.revision + 1,
    };
}

/** 收集一个候选及其全部后代（parentSessionId 邻接，防御循环/乱序 sidecar）。 */
function collectCandidateSubtree(group: GrayBranchGroup, sessionId: string): Set<string> {
    const subtree = new Set<string>([sessionId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const candidate of group.candidates) {
            if (
                candidate.parentSessionId !== undefined &&
                subtree.has(candidate.parentSessionId) &&
                !subtree.has(candidate.sessionId)
            ) {
                subtree.add(candidate.sessionId);
                changed = true;
            }
        }
    }
    return subtree;
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
    // 与老版 renameBranchCandidate（backend/services/branchCandidateService.ts）一致：
    // label 非空且 ≤ 200 字符
    if (label.trim().length > MAX_CANDIDATE_LABEL_LENGTH) {
        throw new BranchError(
            `candidate label must be at most ${MAX_CANDIDATE_LABEL_LENGTH} characters`,
            BranchErrorCode.INVALID_INPUT
        );
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
    now: number = Date.now(),
    retentionDays: number = DEFAULT_BRANCH_RETENTION_DAYS
): GrayBranchGroup {
    // 与原项目一致：0 表示禁用自动/过期清理，只保留手动逐项删除/恢复能力。
    if (retentionDays === 0) return group;
    const cutoff = now - retentionDays * DAY_MS;
    const kept = group.candidates.filter(c => {
        if (c.deletedAt === undefined) return true;
        if (c.kind === 'root') return true;
        if (c.sessionId === group.activeSessionId) return true;
        // deletedAt >= cutoff：仍在配置的保留期内
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
    // 信封通过后逐组逐候选校验字段类型：损坏数据不得静默进运行态（否则后续 CAS/
    // 激活/软删会以错误形状运行）。任一字段非法即按 STORAGE_CORRUPT 报错并给出组 id。
    const groups: GrayBranchGroup[] = [];
    for (const [index, entry] of record.groups.entries()) {
        if (!isValidGroup(entry)) {
            const id = isRecord(entry) && typeof entry.id === 'string' ? entry.id : `#${index}`;
            throw new BranchError(
                `branch sidecar group ${id} is corrupt (invalid group/candidate shape)`,
                BranchErrorCode.STORAGE_CORRUPT
            );
        }
        groups.push(entry as GrayBranchGroup);
    }
    return groups;
}

// ─── 逐组逐候选形状校验（类型守卫；只读不归一化） ───────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

const BRANCH_CANDIDATE_KINDS = new Set<string>(['root', 'reroll', 'edit', 'manual']);

function isValidCandidate(value: unknown): value is BranchCandidate {
    if (!isRecord(value)) return false;
    if (!isNonEmptyString(value.sessionId)) return false;
    if (typeof value.kind !== 'string' || !BRANCH_CANDIDATE_KINDS.has(value.kind)) return false;
    if (!isFiniteNumber(value.createdAt)) return false;
    if (value.parentSessionId !== undefined && !isNonEmptyString(value.parentSessionId)) return false;
    if (value.boundary !== undefined && !Number.isInteger(value.boundary)) return false;
    if (value.label !== undefined && typeof value.label !== 'string') return false;
    if (value.deletedAt !== undefined && !isFiniteNumber(value.deletedAt)) return false;
    if (value.workspaceSnapshotId !== undefined && !isNonEmptyString(value.workspaceSnapshotId)) return false;
    return true;
}

function isValidGroup(value: unknown): value is GrayBranchGroup {
    if (!isRecord(value)) return false;
    if (!isNonEmptyString(value.id)) return false;
    if (!isNonEmptyString(value.rootSessionId)) return false;
    if (!isNonEmptyString(value.activeSessionId)) return false;
    if (!Array.isArray(value.candidates) || !value.candidates.every(isValidCandidate)) return false;
    if (!Number.isInteger(value.revision) || (value.revision as number) < 1) return false;
    if (!isFiniteNumber(value.createdAt)) return false;
    if (value.workspaceId !== undefined && !isNonEmptyString(value.workspaceId)) return false;
    return true;
}
