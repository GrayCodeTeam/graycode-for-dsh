/**
 * BlobStore - 内容寻址 Blob 池（V2 §7.6 存储布局核心）。
 *
 * 布局（blobRoot = `<dataRoot>/checkpoints/<workspace-id>`）：
 *   blobs/<content-hash>          # 内容寻址，同 hash 复用
 *   staging/<operation-id>/       # 写入暂存（fsync/close 后校验，再原子提交）
 *   quarantine/<operation-id>/    # 失败证据（不静默删除）
 *   blobRefs.json                 # 引用计数表（domain 记录的一部分：count + orphanedAt）
 *
 * 写入顺序（§7.6）：
 * 1. 调用方枚举并规范化相对路径（拒绝越界/设备文件/不允许的符号链接）；
 * 2. stageCopy：复制进 staging，fsync/close 后校验 size/hash；
 * 3. commitBlob：原子 move 到 blobs/<hash>；同 hash 已存在则复用；
 * 4. 调用方提交 manifest/domain 记录后 incrementRefs；
 * 6. cleanupStaging 清理；失败项 quarantine（含 entries.json 记录）。
 *
 * GC（独立 dry-run 优先，与恢复/创建互斥由调用方锁保证）：
 * - 以 manifests 目录为权威源重算引用计数，调和 blobRefs.json；
 * - 只处理 refcount=0 且超过 grace period 的 blob；
 * - orphanedAt 记录 refcount 归零时刻（blob mtime 只是创建时刻，不能作孤儿起点）。
 */
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { hashFileStreaming } from './fileHashing.ts';

/** 内容寻址键格式：sha256 十六进制（64 位小写 hex） */
export const BLOB_HASH_PATTERN = /^[a-f0-9]{64}$/;

/** 校验内容哈希可作为 blobs/<hash> 文件名（拒绝越界/损坏的寻址键） */
export function isSafeBlobHash(hash: string): boolean {
    return typeof hash === 'string' && BLOB_HASH_PATTERN.test(hash);
}

/** staging 内未提交文件的扩展名（提交/回收时按该形态识别） */
export const BLOB_STAGED_FILE_SUFFIX = '.part';

/** 引用计数表载荷（<workspace>/blobRefs.json） */
export interface BlobRefsPayload {
    version: 1;
    counts: Record<string, { count: number; orphanedAt?: number }>;
}

export interface StageCommitResult {
    ok: true;
    hash: string;
    size: number;
    /** true = 目标 blob 已存在，本次复用（staged 副本已回收） */
    reused: boolean;
}

/**
 * staging 校验失败（size/hash 与扫描期不一致，CP-TOCTOU-1）。
 * stagedPath 指向仍留在 staging 的副本——调用方应将其移入 quarantine（证据，不静默删除）。
 */
export class StageMismatchError extends Error {
    constructor(message: string, readonly stagedPath: string) {
        super(message);
        this.name = 'StageMismatchError';
    }
}

export interface QuarantineEntry {
    path: string;
    reason: string;
    at: number;
}

/** 单个工作区的内容寻址存储（blobRoot 下的 fs 操作，不含领域锁/记录——由调用方编排） */
export class BlobStore {
    /** blobRoot（`<dataRoot>/checkpoints/<workspace-id>`） */
    readonly rootDir: string;
    readonly blobsDir: string;
    readonly stagingRootDir: string;
    readonly quarantineRootDir: string;
    /** 引用计数表文件（原子写：tmp + rename） */
    readonly refsFile: string;

    constructor(rootDir: string) {
        this.rootDir = rootDir;
        this.blobsDir = path.join(rootDir, 'blobs');
        this.stagingRootDir = path.join(rootDir, 'staging');
        this.quarantineRootDir = path.join(rootDir, 'quarantine');
        this.refsFile = path.join(rootDir, 'blobRefs.json');
    }

    /** 确保 blob 池目录存在 */
    async initialize(): Promise<void> {
        await fs.mkdir(this.blobsDir, { recursive: true });
        await fs.mkdir(this.stagingRootDir, { recursive: true });
        await fs.mkdir(this.quarantineRootDir, { recursive: true });
    }

    /** blob 绝对路径（非法 hash 抛错，防止越界拼接） */
    blobPath(hash: string): string {
        if (!isSafeBlobHash(hash)) {
            throw new Error(`Invalid blob hash: ${hash}`);
        }
        return path.join(this.blobsDir, hash);
    }

    /** 该 hash 的 blob 是否已存在于池中（同 hash 复用判定） */
    async blobExists(hash: string): Promise<boolean> {
        try {
            await fs.access(this.blobPath(hash));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 写入顺序第 2/3 步：staging 复制（fsync/close）→ 校验 size/hash → 原子提交。
     *
     * 源文件可能在扫描与复制之间被改写（CP-TOCTOU-1）：复制完成后重新流式哈希，
     * 与调用方扫描期得到的 expectedHash/size 比对，不一致视为失败（不提交，
     * 证据由调用方决定 quarantine 或由本方法失败路径自行清理）。
     *
     * @param opId 操作 ID（staging/<opId>/ 目录名；须为安全目录名）
     * @param srcPath 源文件绝对路径
     * @param expectedHash 扫描期内容哈希；缺省 = 不校验（仅计算）
     * @param expectedSize 扫描期文件大小；缺省 = 不校验
     */
    async stageAndCommit(
        opId: string,
        srcPath: string,
        expectedHash?: string,
        expectedSize?: number
    ): Promise<StageCommitResult> {
        const stagedPath = await this.stageCopy(opId, srcPath);
        const stat = await fs.stat(stagedPath);
        const size = Number(stat.size);
        const hash = await hashFileStreaming(stagedPath);
        if (expectedHash !== undefined && hash !== expectedHash) {
            // 失败：staged 副本留在 staging，调用方负责移入 quarantine（证据不静默删除）
            throw new StageMismatchError(`staged content hash mismatch (expected ${expectedHash}, got ${hash})`, stagedPath);
        }
        if (expectedSize !== undefined && size !== expectedSize) {
            throw new StageMismatchError(`staged content size mismatch (expected ${expectedSize}, got ${size})`, stagedPath);
        }
        return this.commitStaged(stagedPath, hash, size);
    }

    /** 写入顺序第 2 步：复制源文件到 staging/<opId>/，fsync + close 后再返回 */
    private async stageCopy(opId: string, srcPath: string): Promise<string> {
        const stagingDir = this.stagingDir(opId);
        await fs.mkdir(stagingDir, { recursive: true });
        const stagedPath = path.join(
            stagingDir,
            `${crypto.randomUUID().replaceAll('-', '')}${BLOB_STAGED_FILE_SUFFIX}`
        );
        try {
            await fs.copyFile(srcPath, stagedPath);
            // fsync/close 后才可校验与提交（§7.6 第 2 步）。
            // 注意：Windows 上 FlushFileBuffers 需要写句柄（'r' 只读句柄 fsync 会 EPERM）
            const handle = await fs.open(stagedPath, 'r+');
            try {
                await handle.sync();
            } finally {
                await handle.close();
            }
            return stagedPath;
        } catch (err) {
            // 复制阶段失败：回收半截副本（尚无校验语义，条目级证据由调用方记录）
            await fs.rm(stagedPath, { force: true }).catch(() => undefined);
            throw err;
        }
    }

    /** 写入顺序第 3 步：原子 move 到 blobs/<hash>；已存在则回收 staged 副本（复用） */
    private async commitStaged(stagedPath: string, hash: string, size: number): Promise<StageCommitResult> {
        const target = this.blobPath(hash);
        await fs.mkdir(this.blobsDir, { recursive: true });
        // staging 与 blobs 同卷：rename 即原子 move（§7.6 第 3 步）
        // L6b：复用判定先于 rename——POSIX rename 会静默覆盖已存在目标（EEXIST 分支在
        // POSIX 上不触发，reused 恒为 false → newBlobBytes 统计虚高：同内容多文件并发
        // 提交时重复计新字节）。先探测目标存在性；工作区锁已保证同 hash 写互斥（含跨进程
        // 文件锁），探测与 rename 之间无并发写者。
        try {
            await fs.access(target);
            await fs.rm(stagedPath, { force: true });
            return { ok: true, hash, size, reused: true };
        } catch (accessErr) {
            if ((accessErr as NodeJS.ErrnoException).code !== 'ENOENT') {
                // 非 ENOENT（权限等）：不吞错——交给下方 rename 抛真实错误
            }
        }
        try {
            await fs.rename(stagedPath, target);
            return { ok: true, hash, size, reused: false };
        } catch (renameErr) {
            const code = (renameErr as NodeJS.ErrnoException).code;
            // 目标已存在（并发窗口/既有同 hash blob）：复用语义
            if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') {
                try {
                    await fs.access(target);
                    await fs.rm(stagedPath, { force: true });
                    return { ok: true, hash, size, reused: true };
                } catch {
                    throw renameErr;
                }
            }
            throw renameErr;
        }
    }

    /** staging/<opId> 目录绝对路径 */
    stagingDir(opId: string): string {
        return path.join(this.stagingRootDir, opId);
    }

    /**
     * 写入顺序第 6 步：清理 staging/<opId>（成功提交的已移出；残留即失败证据，先 quarantine）。
     */
    async cleanupStaging(opId: string): Promise<void> {
        try {
            await fs.rm(this.stagingDir(opId), { recursive: true, force: true });
        } catch (err) {
            // 清理失败不影响主流程（残留 staging 目录作为崩溃证据保留）
            console.warn(`[graycode-checkpoints] Failed to clean staging ${opId}:`, err);
        }
    }

    /** per-opId quarantine entries 写串行链（并发 staging 失败条目不互相覆盖） */
    private readonly quarantineWriteChains = new Map<string, Promise<void>>();

    private chainQuarantineWrite(opId: string, task: () => Promise<void>): Promise<void> {
        const prev = this.quarantineWriteChains.get(opId) ?? Promise.resolve();
        const next = prev.then(task, task);
        this.quarantineWriteChains.set(opId, next);
        next.finally(() => {
            if (this.quarantineWriteChains.get(opId) === next) {
                this.quarantineWriteChains.delete(opId);
            }
        }).catch(() => {
            // 链尾清理失败由 next 的调用方处理，此处仅避免未处理拒绝
        });
        return next;
    }

    /**
     * 失败项移入 quarantine/<opId>/ 并记录（§7.6 第 6 步：不静默删除证据）。
     * stagedPath 不存在（复制阶段即失败）时只记录条目。
     */
    async quarantine(opId: string, scopedPath: string, reason: string, stagedPath?: string): Promise<void> {
        const quarantineDir = path.join(this.quarantineRootDir, opId);
        await fs.mkdir(quarantineDir, { recursive: true });
        if (stagedPath) {
            const fileName = path.basename(stagedPath) || 'evidence';
            const target = path.join(quarantineDir, fileName);
            try {
                await fs.rename(stagedPath, target);
            } catch {
                try {
                    await fs.copyFile(stagedPath, target);
                    await fs.rm(stagedPath, { force: true });
                } catch (err) {
                    console.warn(`[graycode-checkpoints] Failed to quarantine evidence ${stagedPath}:`, err);
                }
            }
        }
        // entries.json 的读-改-写经 per-opId 串行链，并发失败条目不丢失
        await this.chainQuarantineWrite(opId, async () => {
            const entries = await this.readQuarantineEntries(opId);
            entries.push({ path: scopedPath, reason, at: Date.now() });
            await this.writeQuarantineEntries(opId, entries);
        });
    }

    /** 读取 quarantine/<opId>/entries.json（缺失/损坏返回空数组） */
    async readQuarantineEntries(opId: string): Promise<QuarantineEntry[]> {
        try {
            const raw = await fs.readFile(path.join(this.quarantineRootDir, opId, 'entries.json'), 'utf-8');
            const parsed = JSON.parse(raw) as unknown;
            return Array.isArray(parsed) ? parsed as QuarantineEntry[] : [];
        } catch {
            return [];
        }
    }

    private async writeQuarantineEntries(opId: string, entries: QuarantineEntry[]): Promise<void> {
        const dir = path.join(this.quarantineRootDir, opId);
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, 'entries.json');
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf-8');
        await fs.rename(tmp, file);
    }

    // ==================== 引用计数（domain 记录） ====================

    /** 读取引用计数表（缺失返回空表；损坏条目按 count=0 净化，杜绝 NaN 写回） */
    async readRefs(): Promise<BlobRefsPayload['counts']> {
        try {
            const raw = await fs.readFile(this.refsFile, 'utf-8');
            const parsed = JSON.parse(raw) as Partial<BlobRefsPayload>;
            if (parsed && typeof parsed === 'object' && parsed.counts && typeof parsed.counts === 'object') {
                const counts: BlobRefsPayload['counts'] = {};
                for (const [hash, entry] of Object.entries(parsed.counts)) {
                    if (!entry || typeof entry !== 'object') {
                        continue;
                    }
                    const rawCount = (entry as { count?: unknown }).count;
                    const count = Number(rawCount);
                    // L6a：count 非有限数值（NaN/字符串/负数/缺失）→ 按 0 净化，
                    // 杜绝 NaN 写回 blobRefs.json（incrementRefs/decrementRefs 直接 +1/-1）
                    counts[hash] = {
                        count: Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
                        ...(typeof (entry as { orphanedAt?: unknown }).orphanedAt === 'number'
                            ? { orphanedAt: (entry as { orphanedAt?: number }).orphanedAt }
                            : {})
                    };
                }
                return counts;
            }
            return {};
        } catch {
            return {};
        }
    }

    /** 原子写引用计数表（tmp + rename；tmp 带随机后缀，避免并发写同路径 tmp 互相覆盖） */
    private async writeRefs(counts: BlobRefsPayload['counts']): Promise<void> {
        await fs.mkdir(this.rootDir, { recursive: true });
        const payload: BlobRefsPayload = { version: 1, counts };
        const tmp = `${this.refsFile}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
        await fs.rename(tmp, this.refsFile);
    }

    /** 提交后增加引用（每个去重 hash 一次；count 0→1 时清除 orphanedAt） */
    async incrementRefs(hashes: readonly string[]): Promise<void> {
        const counts = await this.readRefs();
        for (const hash of hashes) {
            if (!isSafeBlobHash(hash)) {
                continue;
            }
            const entry = counts[hash] ?? { count: 0 };
            counts[hash] = { count: entry.count + 1, orphanedAt: undefined };
        }
        await this.writeRefs(counts);
    }

    /** 删除/驱逐后减少引用（count 归零时记录 orphanedAt = GC grace 起点） */
    async decrementRefs(hashes: readonly string[]): Promise<void> {
        const counts = await this.readRefs();
        for (const hash of hashes) {
            if (!isSafeBlobHash(hash)) {
                continue;
            }
            const entry = counts[hash];
            if (!entry) {
                continue; // 表内无记录（GC 会按 manifests 权威重算调和）
            }
            const next = entry.count - 1;
            if (next <= 0) {
                counts[hash] = { count: 0, orphanedAt: entry.orphanedAt ?? Date.now() };
            } else {
                counts[hash] = { count: next };
            }
        }
        await this.writeRefs(counts);
    }

    // ==================== GC 辅助 ====================

    /** 列出 blob 池中的全部内容哈希（按文件名；非法命名跳过并返回 issue） */
    async listBlobs(): Promise<{ hashes: string[]; invalidNames: string[] }> {
        let names: string[];
        try {
            names = await fs.readdir(this.blobsDir);
        } catch {
            return { hashes: [], invalidNames: [] };
        }
        const hashes: string[] = [];
        const invalidNames: string[] = [];
        for (const name of names) {
            if (isSafeBlobHash(name)) {
                hashes.push(name);
            } else {
                invalidNames.push(name);
            }
        }
        return { hashes, invalidNames };
    }

    /** blob 文件 mtime（孤儿起点回退值；真实孤儿起点以 blobRefs.orphanedAt 为准） */
    async blobMtimeMs(hash: string): Promise<number> {
        try {
            const stat = await fs.stat(this.blobPath(hash));
            return Math.max(stat.mtimeMs, stat.ctimeMs);
        } catch {
            return Date.now();
        }
    }

    /** blob 文件大小（回收统计用） */
    async blobSize(hash: string): Promise<number> {
        try {
            const stat = await fs.stat(this.blobPath(hash));
            return Number(stat.size);
        } catch {
            return 0;
        }
    }

    /** 物理删除单个 blob（GC 用） */
    async removeBlob(hash: string): Promise<boolean> {
        try {
            await fs.rm(this.blobPath(hash), { force: true });
            return true;
        } catch {
            return false;
        }
    }

    /** GC 调和后写回引用计数表（调和：count 与 orphanedAt 均以调用方计算为准） */
    async reconcileRefs(counts: BlobRefsPayload['counts']): Promise<void> {
        await this.writeRefs(counts);
    }
}
