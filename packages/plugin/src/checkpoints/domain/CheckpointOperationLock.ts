export type CheckpointOperation = 'create' | 'restore' | 'merge' | 'delete';

/** runExclusive 可选参数（CP-LOCK-2） */
export interface CheckpointRunExclusiveOptions {
    /**
     * DSH 移植：源实现的全局文件写锁（backend/core/fileWriteLockManager）在 DSH 下
     * 没有对应物，本字段保留仅为兼容源调用形态——不再产生任何文件锁行为，
     * 预览与执行同样只取工作区级互斥。
     */
    needFileLock?: boolean;
}

/** CP-LOCK-1: 排队等待工作区锁期间被取消时 reject 的错误消息（与文件写锁取消同语义） */
export const CHECKPOINT_LOCK_CANCELLED_MESSAGE = 'Checkpoint operation was cancelled';
/** CP-LOCK-4: pending 队列容量上限——超限时拒绝新请求（fail-fast），防止异常调用风暴下无界排队 */
const MAX_PENDING_OPERATIONS = 100;

interface PendingOperation {
    workspaceIds: string[];
    operation: CheckpointOperation;
    ownerId: string;
    resolve: (release: () => void) => void;
}

/** 可重入锁记录：同一 owner 嵌套调用时复用已持有的 workspace 锁 */
interface ActiveOwnerRecord {
    workspaceIds: string[];
    depth: number;
}

/**
 * 存档操作的工作区级互斥器。
 *
 * DSH 移植：源实现（backend/core/fileWriteLockManager 全局文件写锁）在 DSH 下
 * 没有对应物——该层负责「等待主会话与 SubAgent 已开始的写工具结束、阻止新写工具
 * 进入」，DSH 工具流水线由 dsh-tools 的 exclusive 调度语义承担，故已删除。
 * 本模块只保留工作区级互斥（create/restore/delete 在单工作区内串行，互不相交的
 * 多根工作区可并行）。
 *
 * 可重入：同一 ownerId 在持有相同 workspaceIds 集合期间再次调用 runExclusive
 * 时直接放行（不排队），允许 createCheckpoint → cleanupOldCheckpoints →
 * deleteCheckpoint 这类嵌套链路。
 */
export class CheckpointOperationLockManager {
    private readonly activeWorkspaceIds = new Set<string>();
    private readonly pending: PendingOperation[] = [];
    private readonly activeOwners = new Map<string, ActiveOwnerRecord>();

    async runExclusive<T>(
        workspaceIds: readonly string[],
        operation: CheckpointOperation,
        ownerId: string,
        task: () => Promise<T>,
        abortSignal?: AbortSignal,
        _options?: CheckpointRunExclusiveOptions
    ): Promise<T> {
        const normalizedIds = [...new Set(workspaceIds)].sort();
        if (normalizedIds.length === 0) {
            throw new Error('Checkpoint operation requires at least one workspace root');
        }

        // 可重入：同一 owner 已持有工作区集合的超集时，跳过排队直接进入（嵌套调用）。
        const existing = this.activeOwners.get(ownerId);
        if (existing) {
            if (!normalizedIds.every(id => existing.workspaceIds.includes(id))) {
                // CP-LOCK-3: 同 owner 请求超出已持有集合的嵌套调用会进入队列等待自己 → 死锁。
                // fail-fast：直接抛错，而不是挂起在 pending 队列中。
                throw new Error(
                    `Checkpoint lock re-entry deadlock: owner ${ownerId} already holds ` +
                    `[${existing.workspaceIds.join(', ')}] but requested [${normalizedIds.join(', ')}]`
                );
            }
            const record = existing;
            record.depth += 1;
            try {
                return await task();
            } finally {
                record.depth -= 1;
                if (record.depth <= 0) {
                    this.activeOwners.delete(ownerId);
                }
            }
        }

        // 非嵌套（不同 owner 或请求集合超出已持有范围）：正常排队互斥。
        // 同 owner 的超集请求已在上面 fail-fast（CP-LOCK-3）。
        const releaseWorkspaceLock = await this.acquireWorkspaceLock(normalizedIds, operation, ownerId, abortSignal);
        this.activeOwners.set(ownerId, { workspaceIds: normalizedIds, depth: 1 });
        try {
            return await task();
        } finally {
            this.activeOwners.delete(ownerId);
            releaseWorkspaceLock();
        }
    }

    private acquireWorkspaceLock(
        workspaceIds: string[],
        operation: CheckpointOperation,
        ownerId: string,
        abortSignal?: AbortSignal
    ): Promise<() => void> {
        return new Promise((resolve, reject) => {
            const pendingItem: PendingOperation = { workspaceIds, operation, ownerId, resolve };

            // CP-LOCK-1: 取消信号作用于排队等待——abort 时把 pending 项移出队列并 reject，
            // 而不是等到锁授予后在任务内才失败（排队等待时间无上限）。
            // M-CP-3: 排队等待有意不设超时兜底——长等待只可能由同工作区的其他存档操作
            // 持有锁造成，属正常互斥而非死锁；异常长期占用由 CP-LOCK-4 队列容量上限
            // （fail-fast）与调用方 abort（取消信号）兜底。
            if (abortSignal?.aborted) {
                reject(new Error(CHECKPOINT_LOCK_CANCELLED_MESSAGE));
                return;
            }
            // CP-LOCK-4: 队列容量上限——超过上限拒绝新请求（fail-fast），
            // 异常调用风暴不会让 pending 无界增长（可重入/嵌套调用不经过此排队，不受影响）
            if (this.pending.length >= MAX_PENDING_OPERATIONS) {
                reject(new Error('Checkpoint operation queue is full'));
                return;
            }
            const onAbort = (): void => {
                const index = this.pending.indexOf(pendingItem);
                if (index >= 0) {
                    this.pending.splice(index, 1);
                }
                reject(new Error(CHECKPOINT_LOCK_CANCELLED_MESSAGE));
            };
            if (abortSignal) {
                abortSignal.addEventListener('abort', onAbort, { once: true });
            }
            // 被授予锁时移除 abort 监听，避免授予后 abort 对已 resolve 的 Promise 二次 reject
            pendingItem.resolve = (release: () => void) => {
                abortSignal?.removeEventListener('abort', onAbort);
                resolve(release);
            };

            this.pending.push(pendingItem);
            this.drain();
        });
    }

    private drain(): void {
        for (let index = 0; index < this.pending.length;) {
            const candidate = this.pending[index]!;
            if (candidate.workspaceIds.some(id => this.activeWorkspaceIds.has(id))) {
                index += 1;
                continue;
            }

            this.pending.splice(index, 1);
            for (const id of candidate.workspaceIds) {
                this.activeWorkspaceIds.add(id);
            }

            let released = false;
            candidate.resolve(() => {
                if (released) return;
                released = true;
                for (const id of candidate.workspaceIds) {
                    this.activeWorkspaceIds.delete(id);
                }
                this.drain();
            });
        }
    }

    getActiveWorkspaceCount(): number {
        return this.activeWorkspaceIds.size;
    }

    getPendingOperationCount(): number {
        return this.pending.length;
    }
}

export const checkpointOperationLockManager = new CheckpointOperationLockManager();
