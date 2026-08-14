/**
 * GrayCode - BranchCoordinatorService（树状分支协调器）
 *
 * V2 §P3E：对话正文真源是 dsh append-only Session；原生谱系（parentSession /
 * seedLength）由 SessionHeader 承载；本服务只管理 Gray sidecar（分组、候选次序、
 * 显示名、软删除、激活候选），存于 `<dataRoot>/branches/groups.json`。
 *
 * 创建候选顺序（§P3E 并发与原子性）：
 *   1. 通过 SessionAdapter 创建并持久化 child Session（带完整轮次前缀 seed）；
 *   2. 写 Gray sidecar（revision/CAS 更新）；
 *   3. 发布 active 变更（sidecar 提交后）。
 * sidecar 写失败时保留普通 dsh fork Session，但不加入 Gray 分支组，
 * 并向调用方报告可恢复的孤儿（orphan = true）。
 *
 * 变更操作在同一进程内串行（promise 链互斥），跨实例仍靠 revision CAS 防护。
 */
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
    BranchCandidateKind,
    BranchError,
    BranchErrorCode,
    BranchGroupStore,
    BRANCH_GROUP_STORE_VERSION,
    BRANCH_STORE_FILE,
    GrayBranchGroup,
} from './domain/types.ts';
import {
    activateCandidate,
    addCandidate,
    assertRevision,
    createBranchGroup,
    deleteCandidate,
    parseBranchGroupStore,
    renameCandidate,
    restoreCandidate,
} from './domain/branchGroup.ts';
import {
    directUserMessageSeqOfTurn,
    forkBoundaryBeforeTurn,
    hasOpenTurn,
    lastCompleteBoundary,
    scanTurns,
    type BranchEventView,
} from './domain/turnLocator.ts';

/** 与 dsh 会话/Agent 交互的端口（唯一允许持有宿主类型的区域） */
export interface BranchSessionAdapter {
    /** 会话事件日志（领域视图）；会话不 live 时返回空数组 */
    eventsOf(sessionId: string): readonly BranchEventView[];
    /** 会话工作目录（header.cwd）；无则 undefined */
    cwdOf(sessionId: string): string | undefined;
    /** 会话 agentPreset（header.agentPreset）；无则 undefined */
    agentPresetOf(sessionId: string): string | undefined;
    /**
     * 以 parent 的完整轮次前缀为 seed 创建 child session（含 Agent，若宿主
     * 已注册 agent factory）。seedLength = boundary + 1，谱系记录 parentSession。
     */
    forkChild(input: {
        parent: { id: string; events: readonly BranchEventView[] };
        boundary: number | undefined;
        childSessionId: string;
        cwd?: string;
        agentPreset?: string;
    }): Promise<{ sessionId: string; agentAttached: boolean }>;
    /**
     * 向 child session 的 Agent 投递一条用户消息并唤醒驱动
     * （reroll / edit retry 的「把用户消息重新发送到新 Session」）。
     */
    sendUserMessage(input: { sessionId: string; content: readonly unknown[] }): Promise<void>;
}

/** workspace id 生成：与 checkpoints 的 ws_<sha256 前 16 位> 同口径 */
export function createBranchWorkspaceId(cwd: string): string {
    const normalized = cwd.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
    const key = process.platform === 'win32' || process.platform === 'darwin'
        ? normalized.toLowerCase()
        : normalized;
    return `ws_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

/** createBranch 返回 */
export interface CreateBranchResult {
    groupId: string;
    sessionId: string;
    parentSessionId: string;
    boundary?: number;
    kind: BranchCandidateKind;
    agentAttached: boolean;
    orphan: boolean;
    revision: number;
}

/** reroll / editRetry 返回 */
export interface RetryBranchResult {
    groupId: string;
    sessionId: string;
    boundary: number;
    targetTurn: number;
    messageSent: boolean;
    agentAttached: boolean;
    orphan: boolean;
    revision: number;
}

/** switch / delete / restore / rename 返回 */
export interface BranchMutationResult {
    groupId: string;
    sessionId: string;
    revision: number;
    activeSessionId: string;
}

export interface BranchCoordinatorConfig {
    /** 插件私有数据根（sidecar 位于 <dataRoot>/branches/） */
    dataRoot: string;
}

export class BranchCoordinatorService {
    private readonly rootDir: string;
    private readonly storePath: string;
    private groups: GrayBranchGroup[] = [];
    private loaded = false;
    /** 进程内串行互斥：让 CAS 在单进程内有效 */
    private mutationChain: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly config: BranchCoordinatorConfig,
        private readonly adapter: BranchSessionAdapter
    ) {
        this.rootDir = path.join(config.dataRoot, 'branches');
        this.storePath = path.join(this.rootDir, BRANCH_STORE_FILE);
    }

    /** 加载 sidecar；文件缺失视为空库。加载失败（损坏/版本不支持）响亮抛错。 */
    async initialize(): Promise<void> {
        try {
            const raw = await fs.readFile(this.storePath, 'utf8');
            this.groups = parseBranchGroupStore(raw);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                this.groups = [];
            } else {
                throw error;
            }
        }
        this.loaded = true;
    }

    dispose(): void {
        this.groups = [];
        this.loaded = false;
    }

    listGroups(): GrayBranchGroup[] {
        return [...this.groups];
    }

    getGroup(groupId: string): GrayBranchGroup | undefined {
        return this.groups.find(g => g.id === groupId);
    }

    /** 包含该会话候选的分组（任意候选状态） */
    groupForSession(sessionId: string): GrayBranchGroup | undefined {
        return this.groups.find(g => g.candidates.some(c => c.sessionId === sessionId));
    }

    /** 会话事件日志（透传适配器；用于轮次摘要等展示投影） */
    eventsOf(sessionId: string): readonly BranchEventView[] {
        return this.adapter.eventsOf(sessionId);
    }

    /** 会话工作目录（header.cwd；用于工具默认值） */
    cwdOf(sessionId: string): string | undefined {
        return this.adapter.cwdOf(sessionId);
    }

    /** 幂等获取/创建分组：按 (workspaceId, rootSessionId) 定位既有分组 */
    ensureGroup(input: {
        workspaceId?: string;
        rootSessionId: string;
        label?: string;
    }): Promise<GrayBranchGroup> {
        return this.mutate(async () => {
            const existing = this.groups.find(
                g => g.rootSessionId === input.rootSessionId && g.workspaceId === input.workspaceId
            );
            if (existing) return existing;
            const group = createBranchGroup({
                id: crypto.randomUUID(),
                workspaceId: input.workspaceId,
                rootSessionId: input.rootSessionId,
                label: input.label,
            });
            await this.persist([...this.groups, group]);
            this.groups = [...this.groups, group];
            return group;
        });
    }

    /** 手动分支：以 parent 的完整轮次前缀 fork 新候选（boundary 缺省取最近完整轮次末尾） */
    createBranch(input: {
        groupId: string;
        parentSessionId: string;
        boundary?: number;
        label?: string;
        expectedRevision?: number;
    }): Promise<CreateBranchResult> {
        return this.mutate(async () => {
            const group = this.requireGroup(input.groupId);
            const parent = this.requireLiveCandidate(group, input.parentSessionId);
            const boundary = input.boundary ?? lastCompleteBoundary(parent.events);
            if (boundary === undefined && hasOpenTurn(parent.events)) {
                throw new BranchError(
                    'parent session has an open turn; no complete fork boundary available',
                    BranchErrorCode.NO_PREVIOUS_TURN
                );
            }
            return this.forkAndRecord({
                group,
                parent,
                boundary,
                kind: 'manual',
                label: input.label,
                expectedRevision: input.expectedRevision,
            });
        });
    }

    /** 重新生成：fork 目标轮次之前的完整前缀，把该轮次的原始用户消息重发到新会话 */
    reroll(input: {
        groupId: string;
        sessionId: string;
        turn: number;
        expectedRevision?: number;
    }): Promise<RetryBranchResult> {
        return this.mutate(async () => {
            const group = this.requireGroup(input.groupId);
            const source = this.requireLiveCandidate(group, input.sessionId);
            const boundary = forkBoundaryBeforeTurn(source.events, input.turn);
            if (boundary === undefined) {
                const target = scanTurns(source.events).find(t => t.turn === input.turn);
                if (!target) {
                    throw new BranchError(
                        `turn ${input.turn} not found in session "${input.sessionId}"`,
                        BranchErrorCode.TARGET_TURN_NOT_FOUND
                    );
                }
                throw new BranchError(
                    `turn ${input.turn} is the first turn; nothing to fork before it`,
                    BranchErrorCode.NO_PREVIOUS_TURN
                );
            }
            const userMessageSeq = directUserMessageSeqOfTurn(source.events, input.turn);
            if (userMessageSeq === undefined) {
                throw new BranchError(
                    `turn ${input.turn} has no direct user message to replay`,
                    BranchErrorCode.NO_USER_MESSAGE
                );
            }
            const content = (source.events[userMessageSeq] as unknown as { data: { content: readonly unknown[] } }).data.content;
            const created = await this.forkAndRecord({
                group,
                parent: source,
                boundary,
                kind: 'reroll',
                label: `reroll turn ${input.turn}`,
                expectedRevision: input.expectedRevision,
            });
            const messageSent = await this.sendAfterFork(created.sessionId, content);
            return {
                ...created,
                boundary,
                targetTurn: input.turn,
                messageSent,
            };
        });
    }

    /** 编辑并重试：fork 目标轮次之前的完整前缀，把编辑后的用户消息发到新会话 */
    editRetry(input: {
        groupId: string;
        sessionId: string;
        turn: number;
        text: string;
        expectedRevision?: number;
    }): Promise<RetryBranchResult> {
        return this.mutate(async () => {
            const group = this.requireGroup(input.groupId);
            const source = this.requireLiveCandidate(group, input.sessionId);
            const boundary = forkBoundaryBeforeTurn(source.events, input.turn);
            if (boundary === undefined) {
                const target = scanTurns(source.events).find(t => t.turn === input.turn);
                if (!target) {
                    throw new BranchError(
                        `turn ${input.turn} not found in session "${input.sessionId}"`,
                        BranchErrorCode.TARGET_TURN_NOT_FOUND
                    );
                }
                throw new BranchError(
                    `turn ${input.turn} is the first turn; nothing to fork before it`,
                    BranchErrorCode.NO_PREVIOUS_TURN
                );
            }
            const created = await this.forkAndRecord({
                group,
                parent: source,
                boundary,
                kind: 'edit',
                label: `edit retry turn ${input.turn}`,
                expectedRevision: input.expectedRevision,
            });
            const messageSent = await this.sendAfterFork(created.sessionId, [
                { type: 'text', text: input.text },
            ]);
            return {
                ...created,
                boundary,
                targetTurn: input.turn,
                messageSent,
            };
        });
    }

    /** 候选切换：只改 activeSessionId（对话指针），不重写任何日志 */
    switchCandidate(input: {
        groupId: string;
        sessionId: string;
        expectedRevision?: number;
    }): Promise<BranchMutationResult> {
        return this.mutate(async () => {
            const group = this.requireGroup(input.groupId);
            const next = activateCandidate(group, input.sessionId, input.expectedRevision);
            await this.persistGroup(next);
            this.replaceGroup(next);
            return {
                groupId: next.id,
                sessionId: next.activeSessionId,
                revision: next.revision,
                activeSessionId: next.activeSessionId,
            };
        });
    }

    /** 软删除候选（root / 激活候选不可删；dsh Session 保留） */
    deleteCandidate(input: {
        groupId: string;
        sessionId: string;
        expectedRevision?: number;
    }): Promise<BranchMutationResult> {
        return this.mutate(async () => {
            const group = this.requireGroup(input.groupId);
            const next = deleteCandidate(group, input.sessionId, input.expectedRevision);
            await this.persistGroup(next);
            this.replaceGroup(next);
            return {
                groupId: next.id,
                sessionId: input.sessionId,
                revision: next.revision,
                activeSessionId: next.activeSessionId,
            };
        });
    }

    /** 恢复软删除候选 */
    restoreCandidate(input: {
        groupId: string;
        sessionId: string;
        expectedRevision?: number;
    }): Promise<BranchMutationResult> {
        return this.mutate(async () => {
            const group = this.requireGroup(input.groupId);
            const next = restoreCandidate(group, input.sessionId, input.expectedRevision);
            await this.persistGroup(next);
            this.replaceGroup(next);
            return {
                groupId: next.id,
                sessionId: input.sessionId,
                revision: next.revision,
                activeSessionId: next.activeSessionId,
            };
        });
    }

    /** 重命名候选显示名 */
    renameCandidate(input: {
        groupId: string;
        sessionId: string;
        label: string;
        expectedRevision?: number;
    }): Promise<BranchMutationResult> {
        return this.mutate(async () => {
            const group = this.requireGroup(input.groupId);
            const next = renameCandidate(group, input.sessionId, input.label, input.expectedRevision);
            await this.persistGroup(next);
            this.replaceGroup(next);
            return {
                groupId: next.id,
                sessionId: input.sessionId,
                revision: next.revision,
                activeSessionId: next.activeSessionId,
            };
        });
    }

    // ─── 内部 ─────────────────────────────────────────────

    private requireGroup(groupId: string): GrayBranchGroup {
        if (!this.loaded) {
            throw new BranchError('branch service is not initialized', BranchErrorCode.STORAGE_CORRUPT);
        }
        const group = this.getGroup(groupId);
        if (!group) {
            throw new BranchError(
                `branch group "${groupId}" not found`,
                BranchErrorCode.GROUP_NOT_FOUND
            );
        }
        return group;
    }

    /** 取组内候选并验证其会话仍 live（会话对象来自适配器侧，服务侧只持 id 集合） */
    private requireLiveCandidate(
        group: GrayBranchGroup,
        sessionId: string
    ): { id: string; events: readonly BranchEventView[]; cwd?: string; agentPreset?: string } {
        const candidate = group.candidates.find(c => c.sessionId === sessionId);
        if (!candidate) {
            throw new BranchError(
                `session "${sessionId}" is not a candidate of branch group "${group.id}"`,
                BranchErrorCode.SESSION_NOT_IN_GROUP
            );
        }
        return {
            id: sessionId,
            events: this.adapter.eventsOf(sessionId),
            cwd: this.adapter.cwdOf(sessionId),
            agentPreset: this.adapter.agentPresetOf(sessionId),
        };
    }

    /** fork + sidecar 记录的公共路径（步骤顺序：校验 CAS → fork 会话 → 写 sidecar → 发布） */
    private async forkAndRecord(input: {
        group: GrayBranchGroup;
        parent: { id: string; events: readonly BranchEventView[]; cwd?: string; agentPreset?: string };
        boundary: number | undefined;
        kind: BranchCandidateKind;
        label?: string;
        expectedRevision?: number;
    }): Promise<CreateBranchResult> {
        // CAS 先于 fork：陈旧 revision 直接拒绝，避免创建无用的孤儿 fork 会话
        assertRevision(input.group, input.expectedRevision);
        const childSessionId = `branch-${crypto.randomUUID()}`;
        let forkOutcome: { sessionId: string; agentAttached: boolean };
        try {
            forkOutcome = await this.adapter.forkChild({
                parent: { id: input.parent.id, events: input.parent.events },
                boundary: input.boundary,
                childSessionId,
                cwd: input.parent.cwd,
                agentPreset: input.parent.agentPreset,
            });
        } catch (error) {
            if (error instanceof BranchError) throw error;
            throw new BranchError(
                `session fork rejected: ${error instanceof Error ? error.message : String(error)}`,
                BranchErrorCode.FORK_REJECTED,
                { sessionErrorCode: (error as { code?: string }).code }
            );
        }
        try {
            const next = addCandidate(input.group, {
                sessionId: forkOutcome.sessionId,
                parentSessionId: input.parent.id,
                boundary: input.boundary,
                kind: input.kind,
                label: input.label,
                expectedRevision: input.expectedRevision,
            });
            await this.persistGroup(next);
            this.replaceGroup(next);
            return {
                groupId: next.id,
                sessionId: forkOutcome.sessionId,
                parentSessionId: input.parent.id,
                boundary: input.boundary,
                kind: input.kind,
                agentAttached: forkOutcome.agentAttached,
                orphan: false,
                revision: next.revision,
            };
        } catch (error) {
            if (error instanceof BranchError && error.code === BranchErrorCode.STORAGE_WRITE_FAILED) {
                // sidecar 写失败：保留 fork 会话，不入组，报告孤儿（§P3E）
                return {
                    groupId: input.group.id,
                    sessionId: forkOutcome.sessionId,
                    parentSessionId: input.parent.id,
                    boundary: input.boundary,
                    kind: input.kind,
                    agentAttached: forkOutcome.agentAttached,
                    orphan: true,
                    revision: input.group.revision,
                };
            }
            throw error;
        }
    }

    private async sendAfterFork(sessionId: string, content: readonly unknown[]): Promise<boolean> {
        try {
            await this.adapter.sendUserMessage({ sessionId, content });
            return true;
        } catch {
            return false;
        }
    }

    private replaceGroup(next: GrayBranchGroup): void {
        this.groups = this.groups.map(g => (g.id === next.id ? next : g));
    }

    /** 原子持久化整个 sidecar（tmp + rename） */
    private async persist(groups: GrayBranchGroup[]): Promise<void> {
        const record: BranchGroupStore = {
            version: BRANCH_GROUP_STORE_VERSION,
            groups,
        };
        const tmpPath = `${this.storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
            await fs.mkdir(this.rootDir, { recursive: true });
            await fs.writeFile(tmpPath, JSON.stringify(record, null, 2), 'utf8');
            await fs.rename(tmpPath, this.storePath);
        } catch (error) {
            await fs.rm(tmpPath, { force: true }).catch(() => undefined);
            throw new BranchError(
                `branch sidecar write failed: ${error instanceof Error ? error.message : String(error)}`,
                BranchErrorCode.STORAGE_WRITE_FAILED
            );
        }
    }

    private async persistGroup(next: GrayBranchGroup): Promise<void> {
        await this.persist(this.groups.map(g => (g.id === next.id ? next : g)));
    }

    /** 进程内串行互斥；mutation 抛错时链条继续 */
    private mutate<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.mutationChain.then(operation, operation);
        this.mutationChain = run.catch(() => undefined);
        return run;
    }
}
