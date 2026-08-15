/**
 * CheckpointOperationLock - 工作区级互斥（跨进程文件锁）
 *
 * DSH 移植（CP-LOCK-5）：源实现「等待主会话与 SubAgent 已开始的写工具结束、阻止新写工具
 * 进入」的全局文件写锁（backend/core/fileWriteLockManager）在 DSH 下由 dsh-tools 的
 * exclusive 调度语义承担（isConcurrencySafe: () => false），故已删除；本模块负责
 * checkpoints 操作（create/restore/delete/gc）在**单工作区内串行、互不相交的多根工作区
 * 可并行**，并升级为**跨进程文件锁**：
 *
 * - 锁文件：`<lockDir>/<sha256(workspaceId) 前 32 hex>.lock`，原子创建（`wx`）即持有；
 * - 持有者元数据（pid/createdAt/ownerId）+ **心跳刷新**（周期写回句柄，更新 mtime/createdAt）
 *   ——陈旧锁检测只对「长时间无心跳」的锁生效，长操作（大工作区恢复）不会被误判打破；
 * - 获取**超时**（lockTimeoutMs，缺省 5 分钟；<= 0 = 不限时）与轮询重试；
 * - **Windows 兼容**：EPERM/EACCES（他进程持有句柄、杀软瞬时占用）按「未获取」重试；
 *   打破陈旧锁时 unlink 遇 EPERM = 持有者可能存活，放弃打破；
 *   释放先 close 文件句柄再 unlink（句柄释放），unlink 失败残留的锁由陈旧检测兜底。
 *
 * 进程内保留队列调度（公平排队、abort 取消、队列容量上限、同 owner 可重入），
 * 文件锁只负责「跨进程/跨实例」互斥；同一进程内不同 manager 实例（如测试模拟两个进程）
 * 经同一 lockDir 也会互斥。
 *
 * API 兼容：runExclusive(workspaceIds, operation, ownerId, task, abortSignal?, options?)
 * 签名不变；`CheckpointRunExclusiveOptions.needFileLock` 保留仅为兼容源调用形态，
 * 文件锁现为本模块固有行为（不再需要显式请求）。
 */
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/** fs.open 返回的句柄类型（避免依赖 @types/node 的 FileHandle 导出位置差异） */
type FileHandle = Awaited<ReturnType<typeof fs.open>>;

export type CheckpointOperation = 'create' | 'restore' | 'merge' | 'delete';

/** runExclusive 可选参数（CP-LOCK-2） */
export interface CheckpointRunExclusiveOptions {
    /**
     * DSH 移植：源实现的全局文件写锁（backend/core/fileWriteLockManager）在 DSH 下
     * 没有对应物，本字段保留仅为兼容源调用形态——不再产生额外行为：
     * 工作区级互斥（含跨进程文件锁）总是生效，无需显式请求。
     */
    needFileLock?: boolean;
}

/** 锁管理器构造选项（跨进程文件锁参数，CP-LOCK-5） */
export interface CheckpointOperationLockManagerOptions {
    /**
     * 锁文件目录。缺省 = `os.tmpdir()/graycode-dsh-checkpoint-locks`（进程级单例的
     * 跨进程命名空间）。生产路径（CheckpointService）显式传入插件私有根内目录
     * （`<dataRoot>/checkpoints/.locks`），多实例共享 dataRoot 时互斥跨进程生效。
     */
    lockDir?: string;
    /**
     * 获取工作区文件锁的总超时（毫秒）；<= 0 = 不限时（缺省 5 分钟）。
     * 注意：进程内排队等待（同工作区其他本地操作持有）不在此超时范围
     * （排队无超时是既有设计，M-CP-3），本超时只约束跨进程文件锁轮询。
     */
    lockTimeoutMs?: number;
    /** 陈旧锁判定（毫秒）：锁文件无心跳更新超过该时长即视为持有者已死；缺省 60 秒 */
    staleLockMs?: number;
    /** 锁获取轮询间隔（毫秒）；缺省 100 */
    pollIntervalMs?: number;
    /** 测试注入时钟（缺省 Date.now） */
    now?: () => number;
}

/** CP-LOCK-1: 排队等待工作区锁期间被取消时 reject 的错误消息（与文件写锁取消同语义） */
export const CHECKPOINT_LOCK_CANCELLED_MESSAGE = 'Checkpoint operation was cancelled';
/** CP-LOCK-4: pending 队列容量上限——超限时拒绝新请求（fail-fast），防止异常调用风暴下无界排队 */
const MAX_PENDING_OPERATIONS = 100;

/** 锁文件默认目录（未显式指定 lockDir 时）：系统临时目录下的跨进程共享命名空间 */
const DEFAULT_LOCK_DIR = path.join(os.tmpdir(), 'graycode-dsh-checkpoint-locks');
/** 锁获取总超时默认值（毫秒）：5 分钟 */
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
/** 陈旧锁判定默认值（毫秒）：60 秒无心跳即打破 */
const DEFAULT_STALE_LOCK_MS = 60 * 1000;
/** 轮询间隔默认值（毫秒） */
const DEFAULT_POLL_INTERVAL_MS = 100;

interface PendingOperation {
    workspaceIds: string[];
    operation: CheckpointOperation;
    ownerId: string;
    abortSignal?: AbortSignal;
    resolve: (release: () => Promise<void>) => void;
    reject: (err: unknown) => void;
}

/** 可重入锁记录：同一 owner 嵌套调用时复用已持有的 workspace 锁 */
interface ActiveOwnerRecord {
    workspaceIds: string[];
    depth: number;
}

/** 锁文件元数据（心跳写回句柄，陈旧检测依据） */
interface LockFileMeta {
    pid: number;
    createdAt: number;
    ownerId: string;
}

/** 单个工作区的跨进程文件锁（原子创建 + 心跳 + 陈旧检测 + 句柄释放） */
class WorkspaceFileLock {
    private readonly lockPath: string;
    private readonly staleLockMs: number;
    private readonly now: () => number;

    constructor(lockPath: string, staleLockMs: number, now: () => number) {
        this.lockPath = lockPath;
        this.staleLockMs = staleLockMs;
        this.now = now;
    }

    /**
     * 尝试获取锁（原子创建锁文件）。成功返回 release（句柄关闭 + 锁文件删除）；
     * 失败返回 null（调用方轮询重试）。陈旧锁：createdAt（内容元数据，优先）或 mtime
     * 超过 staleLockMs 时尝试打破（unlink）后立即重试一次。
     */
    async tryAcquire(ownerId: string): Promise<(() => Promise<void>) | null> {
        let handle: FileHandle;
        try {
            handle = await fs.open(this.lockPath, 'wx');
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'EEXIST') {
                if (await this.tryBreakStaleLock()) {
                    // 已打破陈旧锁（或锁已被移除）：立即重试一次创建
                    return this.tryAcquire(ownerId);
                }
                return null;
            }
            // Windows 兼容：EPERM = 他进程持有句柄（无共享删除）或杀软瞬时占用；
            // EACCES = 权限瞬时拒绝；ENOENT = 锁目录尚未就绪。均按「未获取」重试。
            if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') {
                return null;
            }
            throw err;
        }

        const meta: LockFileMeta = { pid: process.pid, createdAt: this.now(), ownerId };
        try {
            await handle.writeFile(`${JSON.stringify(meta)}\n`, 'utf-8');
        } catch {
            // 元数据写入失败：释放句柄并尝试移除锁文件，交由调用方重试
            await handle.close().catch(() => {});
            await this.unlinkBestEffort();
            return null;
        }

        let released = false;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        // 心跳：周期性写回句柄更新 mtime/createdAt——让陈旧检测只对「长时间无心跳」的锁生效，
        // 长操作（大工作区恢复/创建）不会被其他等待者误判为死锁而打破。
        if (this.staleLockMs > 0) {
            const intervalMs = Math.max(1000, Math.floor(this.staleLockMs / 3));
            heartbeat = setInterval(() => {
                void handle
                    .writeFile(`${JSON.stringify({ ...meta, createdAt: this.now() })}\n`, 'utf-8')
                    .catch(() => {});
            }, intervalMs);
            // 不让心跳定时器阻止进程退出
            if (typeof heartbeat.unref === 'function') {
                heartbeat.unref();
            }
        }

        return async () => {
            if (released) {
                return;
            }
            released = true;
            if (heartbeat !== undefined) {
                clearInterval(heartbeat);
            }
            // 文件句柄释放：先 close 再 unlink（Windows 上句柄未释放时 unlink 可能 EPERM）
            await handle.close().catch(() => {});
            await this.unlinkBestEffort();
        };
    }

    /** 陈旧锁检测与打破：createdAt（内容元数据优先）或 mtime 超过 staleLockMs 才打破 */
    private async tryBreakStaleLock(): Promise<boolean> {
        let stale = false;
        try {
            const raw = await fs.readFile(this.lockPath, 'utf-8');
            const parsed = JSON.parse(raw) as Partial<LockFileMeta>;
            if (typeof parsed.createdAt === 'number') {
                stale = this.now() - parsed.createdAt > this.staleLockMs;
            } else {
                // 内容损坏（写入中途崩溃）：回退 mtime 判定
                const stat = await fs.stat(this.lockPath);
                stale = this.now() - stat.mtimeMs > this.staleLockMs;
            }
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                return true; // 已被其他等待者移除：可重试创建
            }
            return false; // 读失败：保守按「不陈旧」处理，等待下次轮询
        }
        if (!stale) {
            return false;
        }
        return this.unlinkBestEffort();
    }

    private async unlinkBestEffort(): Promise<boolean> {
        try {
            await fs.unlink(this.lockPath);
            return true;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            // ENOENT = 已被移除（视为成功）；EPERM/EACCES = 他进程正持有句柄 → 不打破
            // （Windows 上打开句柄未释放时 unlink 会 EPERM，说明持有者可能存活）
            return code === 'ENOENT';
        }
    }
}

/**
 * 存档操作的工作区级互斥器（进程内队列 + 跨进程文件锁）。
 *
 * 进程内语义与既有实现一致：同 ownerId 在持有相同 workspaceIds 集合期间再次调用
 * runExclusive 直接放行（可重入，createCheckpoint → cleanupOldCheckpoints →
 * deleteCheckpoint 这类嵌套链路）；不同 owner 排队互斥；排队可被 abort 取消（CP-LOCK-1）；
 * 队列容量上限（CP-LOCK-4）。跨进程互斥由文件锁承担（CP-LOCK-5）：
 * 多工作区操作按字典序获取锁文件，避免跨进程 ABBA 死锁。
 */
export class CheckpointOperationLockManager {
    private readonly lockDir: string;
    private readonly lockTimeoutMs: number;
    private readonly staleLockMs: number;
    private readonly pollIntervalMs: number;
    private readonly now: () => number;

    private readonly activeWorkspaceIds = new Set<string>();
    /** 正在执行文件锁获取的工作区 id（防止同进程多个 pending 对同一工作区重复尝试） */
    private readonly acquiringWorkspaceIds = new Set<string>();
    private readonly pending: PendingOperation[] = [];
    private readonly activeOwners = new Map<string, ActiveOwnerRecord>();
    private readonly fileLocks = new Map<string, WorkspaceFileLock>();
    private drainScheduled = false;

    constructor(options: CheckpointOperationLockManagerOptions = {}) {
        this.lockDir = options.lockDir ?? DEFAULT_LOCK_DIR;
        this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
        this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
        this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        this.now = options.now ?? Date.now;
    }

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
            // 释放：移除本地活跃标记 + 释放跨进程文件锁（close 句柄 + unlink），再调度队列
            await releaseWorkspaceLock();
        }
    }

    private acquireWorkspaceLock(
        workspaceIds: string[],
        operation: CheckpointOperation,
        ownerId: string,
        abortSignal?: AbortSignal
    ): Promise<() => Promise<void>> {
        return new Promise((resolve, reject) => {
            const pendingItem: PendingOperation = { workspaceIds, operation, ownerId, abortSignal, resolve, reject };

            // CP-LOCK-1: 取消信号作用于排队等待——abort 时把 pending 项移出队列并 reject，
            // 而不是等到锁授予后在任务内才失败（排队等待时间无上限）。
            // M-CP-3: 排队等待有意不设超时兜底——长等待只可能由同工作区的其他存档操作
            // 持有锁造成，属正常互斥而非死锁；异常长期占用由 CP-LOCK-4 队列容量上限
            // （fail-fast）与调用方 abort（取消信号）兜底。跨进程文件锁的获取超时
            // （lockTimeoutMs）只约束文件锁轮询，不覆盖本进程内排队。
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
            pendingItem.resolve = (release: () => Promise<void>) => {
                abortSignal?.removeEventListener('abort', onAbort);
                resolve(release);
            };
            pendingItem.reject = (err: unknown) => {
                abortSignal?.removeEventListener('abort', onAbort);
                reject(err);
            };

            this.pending.push(pendingItem);
            this.drain();
        });
    }

    private drain(): void {
        if (this.drainScheduled) {
            return;
        }
        this.drainScheduled = true;
        void (async () => {
            try {
                for (;;) {
                    const candidateIndex = this.findGrantableIndex();
                    if (candidateIndex < 0) {
                        break;
                    }
                    const candidate = this.pending[candidateIndex]!;
                    this.pending.splice(candidateIndex, 1);
                    for (const id of candidate.workspaceIds) {
                        this.acquiringWorkspaceIds.add(id);
                    }
                    try {
                        const fileRelease = await this.acquireFileLocks(candidate);
                        for (const id of candidate.workspaceIds) {
                            this.acquiringWorkspaceIds.delete(id);
                            this.activeWorkspaceIds.add(id);
                        }
                        // 组合释放：清除本地活跃标记（释放队列后续项）+ 释放跨进程文件锁 +
                        // 清理 fileLocks Map 条目（L1）+ 调度队列
                        let released = false;
                        const release = async (): Promise<void> => {
                            if (released) {
                                return;
                            }
                            released = true;
                            for (const id of candidate.workspaceIds) {
                                this.activeWorkspaceIds.delete(id);
                            }
                            await fileRelease();
                            // L1：锁释放后清理 fileLocks Map 条目——多工作区长生命周期不再
                            // 无界增长。WorkspaceFileLock 无跨获取的持久状态（每次 tryAcquire
                            // 重新打开锁文件），删除后下一位获取者重新创建即可；仅当该工作区
                            // 仍有活跃/正在获取的请求时保留（避免删除仍被使用的对象）。
                            this.releaseFileLockEntries(candidate.workspaceIds);
                            this.drain();
                        };
                        candidate.resolve(release);
                    } catch (err) {
                        for (const id of candidate.workspaceIds) {
                            this.acquiringWorkspaceIds.delete(id);
                        }
                        candidate.reject(err);
                    }
                }
            } finally {
                this.drainScheduled = false;
                // 竞态兜底：drain 循环退出瞬间有新入队且可授予的请求时，补一次调度
                // （不会无限循环：无可授予请求时条件为 false，等待 release/enqueue 再 kick）
                if (this.findGrantableIndex() >= 0) {
                    this.drain();
                }
            }
        })();
    }

    /** 第一个可授予的 pending 项：其工作区集合不与本地活跃/正在获取的集合相交 */
    private findGrantableIndex(): number {
        return this.pending.findIndex(item =>
            !item.workspaceIds.some(
                id => this.activeWorkspaceIds.has(id) || this.acquiringWorkspaceIds.has(id)
            )
        );
    }

    /**
     * 跨进程文件锁获取：多工作区按字典序逐个获取（跨进程顺序一致，避免 ABBA 死锁）；
     * 任一失败（超时/取消/IO）时逆序释放已持有的锁，不留残留。
     */
    private async acquireFileLocks(candidate: PendingOperation): Promise<() => Promise<void>> {
        await fs.mkdir(this.lockDir, { recursive: true });
        const sortedIds = [...candidate.workspaceIds].sort();
        const acquired: Array<() => Promise<void>> = [];
        const deadline = this.lockTimeoutMs > 0 ? this.now() + this.lockTimeoutMs : Number.POSITIVE_INFINITY;
        try {
            for (const id of sortedIds) {
                const release = await this.acquireOneLock(id, candidate.ownerId, candidate.abortSignal, deadline);
                acquired.push(release);
            }
        } catch (err) {
            for (const release of acquired.reverse()) {
                await release();
            }
            throw err;
        }
        let released = false;
        return async () => {
            if (released) {
                return;
            }
            released = true;
            for (const release of acquired.reverse()) {
                await release();
            }
        };
    }

    /** 轮询获取单个工作区的文件锁（EPERM/EACCES/EEXIST 非陈旧均按未获取重试；超时/取消抛错） */
    private async acquireOneLock(
        workspaceId: string,
        ownerId: string,
        abortSignal: AbortSignal | undefined,
        deadline: number
    ): Promise<() => Promise<void>> {
        const lock = this.fileLockFor(workspaceId);
        for (;;) {
            if (abortSignal?.aborted) {
                throw new Error(CHECKPOINT_LOCK_CANCELLED_MESSAGE);
            }
            if (this.now() >= deadline) {
                throw new Error(
                    `Timed out waiting for checkpoint lock on workspace ${workspaceId} after ` +
                    `${this.lockTimeoutMs}ms (lock held by another process or operation)`
                );
            }
            const release = await lock.tryAcquire(ownerId);
            if (release) {
                return release;
            }
            await sleep(this.pollIntervalMs, abortSignal);
        }
    }

    private fileLockFor(workspaceId: string): WorkspaceFileLock {
        let lock = this.fileLocks.get(workspaceId);
        if (!lock) {
            // workspaceId 可能含任意字符：sha256 哈希后作为安全锁文件名
            const digest = crypto.createHash('sha256').update(workspaceId).digest('hex').slice(0, 32);
            lock = new WorkspaceFileLock(path.join(this.lockDir, `${digest}.lock`), this.staleLockMs, this.now);
            this.fileLocks.set(workspaceId, lock);
        }
        return lock;
    }

    /**
     * L1：锁释放后清理 fileLocks Map 条目（无活跃/正在获取请求时删除）。
     *
     * 多工作区长生命周期下，若 Map 只增不减会无界增长。释放时删除是安全的：
     * WorkspaceFileLock 不保存跨获取的持久状态（tryAcquire 每次重新打开锁文件），
     * 删除后下一位请求者经 fileLockFor 按需重建（同一 lockPath，互斥语义不变）。
     */
    private releaseFileLockEntries(workspaceIds: readonly string[]): void {
        for (const id of workspaceIds) {
            if (!this.activeWorkspaceIds.has(id) && !this.acquiringWorkspaceIds.has(id)) {
                this.fileLocks.delete(id);
            }
        }
    }

    getActiveWorkspaceCount(): number {
        return this.activeWorkspaceIds.size;
    }

    getPendingOperationCount(): number {
        return this.pending.length;
    }
}

/** 轮询间隔睡眠；abort 时提前返回（调用方循环内重新检查取消标志） */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** 进程级单例（CheckpointDeletionService 批删路径使用；缺省锁目录 = 系统临时目录命名空间） */
export const checkpointOperationLockManager = new CheckpointOperationLockManager();
