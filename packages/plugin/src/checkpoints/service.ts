/**
 * CheckpointService - DSH 工作区存档服务（内容寻址 Blob 布局，V2 §7.6）。
 *
 * 存储布局（blobRoot = `<dataRoot>/checkpoints/<workspace-id>`）：
 *   blobs/<content-hash>          # 内容寻址，同 hash 复用
 *   manifests/<checkpoint-id>.json# 单文件 manifest（文件清单 path→blobHash/size/mode、
 *                                 # 父 checkpointId、changes、排除规则版本、空目录等）
 *   staging/<operation-id>/       # 写入暂存（fsync/close 后校验，原子提交）
 *   quarantine/<operation-id>/    # 失败证据（不静默删除）
 *   blobRefs.json                 # 引用计数表（count + orphanedAt，GC grace 起点）
 * records.json（全局，按 workspace-id 隔离）保存 domain 记录：checkpoint id、workspace id、
 * manifest version、文件路径/hash（在 manifest）、父 checkpoint（增量父链）、排除规则版本、
 * 引用计数、状态、lastEvent。
 *
 * 写入顺序（§7.6）：
 * 1. 枚举并规范化相对路径（CheckpointIgnoreResolver 四层排除 + 路径防穿越 + 符号链接排除）；
 * 2. 新 Blob 写入 staging，fsync/close 后校验 size/hash（CP-TOCTOU-1）；
 * 3. 原子移动到 blobs/<hash>；同 hash 已存在则复用；
 * 4. 提交 manifest/domain 记录并增加引用（incrementRefs）；
 * 5. 发布 checkpoint-created 事件（记录到 records.lastEvent + 日志；DSH 无事件基础设施）；
 * 6. 清理 staging；失败项移入 quarantine 并记录，不静默删除证据。
 *
 * 恢复门闸（§7.6 不变量）：preview 与 apply 绑定同一 previewId
 * （= checkpointId+workspace 指纹 sha256）、workspace、manifest hash 与目标基线摘要；
 * apply 前重新比对当前文件哈希与 preview 时基线，目标变化后旧 preview 失效。
 *
 * 删除只减少引用；Blob GC 是独立 dry-run 优先操作（refcount=0 且超过 grace period 才删，
 * 与恢复/创建经工作区级锁互斥）。
 *
 * 保留语义：恢复计划纯计算（CheckpointRestoreEngine）、增量父链（baseCheckpointId + changes，
 * 环检测）、链保护（computeForcedKeepIds）、排除规则 4 层（CheckpointIgnoreResolver）、
 * 路径防穿越（CheckpointWorkspace）、工作区级互斥（CheckpointOperationLock）、hash 校验。
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { CheckpointRecordMetadataStore } from './domain/recordStore.ts';
import {
    CheckpointDeletionService,
    cleanupCheckpointStorage,
    type CheckpointWorkspaceStorage
} from './domain/CheckpointDeletionService.ts';
import { buildIgnoreSnapshot } from './domain/CheckpointExclusionProfiles.ts';
import { CheckpointIgnoreResolver } from './domain/CheckpointIgnoreResolver.ts';
import {
    CheckpointManifestRepository,
    CHECKPOINT_MANIFEST_VERSION,
    isSafeCheckpointDirName
} from './domain/CheckpointManifestRepository.ts';
import { BlobStore, isSafeBlobHash } from './domain/BlobStore.ts';
import { CheckpointOperationLockManager, CHECKPOINT_LOCK_CANCELLED_MESSAGE } from './domain/CheckpointOperationLock.ts';
import {
    computeRestorePlan,
    restoreWorkspaceSnapshot,
    toScopedKey,
    type RestoreChainEntry,
    type RestoreTargetState
} from './domain/CheckpointRestoreEngine.ts';
import {
    createRuntimeWorkspaceRoots,
    createWorkspaceScopedPath,
    createWorkspaceSnapshot,
    parseWorkspaceScopedPath,
    validateWorkspaceSnapshot,
    type RuntimeWorkspaceRoot
} from './domain/CheckpointWorkspace.ts';
import {
    buildWorkspaceSnapshot,
    type SnapshotFileStat
} from './domain/CheckpointSnapshotBuilder.ts';
import {
    DEFAULT_CHECKPOINT_CONCURRENCY,
    runBounded,
    throwIfAborted,
    CheckpointAbortError
} from './domain/checkpointConcurrency.ts';
import { hashFileStreaming } from './domain/fileHashing.ts';
import type {
    CheckpointExcludedNote,
    CheckpointFileChange,
    CheckpointManifest,
    CheckpointOperationProgress,
    CheckpointRecord,
    CheckpointSummary,
    RestoreFailure,
    RestorePreviewResult,
    RestoreResult
} from './domain/types.ts';

/** 插件配置（index.ts 的 Config 解析后传入） */
export interface CheckpointServiceConfig {
    /** 插件私有数据根（`<dataRoot>/checkpoints/...` 为存档根） */
    dataRoot: string;
    /** 保留的最大存档数（<= 0 = 无上限，与源 maxCheckpoints 语义一致） */
    maxCheckpoints: number;
    /** 默认排除类别开关（profileId -> boolean；缺省按类别默认启用） */
    excludeProfiles: Record<string, boolean>;
    /** 用户自定义排除模式（支持 `!` 否定，不能覆盖强制排除） */
    excludePatterns: string[];
    /** 单文件大小上限（字节）；0 或负数 = 不限制 */
    maxFileSizeBytes: number;
    /** Blob GC grace period（天）；<= 0 = 引用归零立即回收 */
    blobGracePeriodDays: number;
}

/** checkpoint_create 返回 */
export interface CreateCheckpointResult {
    checkpointId: string;
    type: 'full' | 'incremental';
    fileCount: number;
    sizeBytes: number;
    excludedCount: number;
    baseCheckpointId?: string;
    description?: string;
}

/** checkpoint_list 返回 */
export interface CheckpointListResult {
    items: CheckpointSummary[];
    total: number;
    nextCursor?: string;
}

/** checkpoint_preview 返回（RestorePreviewResult + 门闸 token） */
export interface CheckpointPreviewOutcome {
    preview: RestorePreviewResult;
    /**
     * 本次预览签发的恢复门闸 token（= previewId，checkpointId+workspace 指纹 sha256）。
     * restore 必须原样回传；token 同时绑定 manifest hash 与目标基线摘要，
     * apply 前重新比对，目标变化后旧 token 失效（需重新 preview）。
     */
    previewToken?: string;
    /** token 绑定的目标基线摘要（preview 时当前工作区文件哈希的聚合） */
    baselineDigest?: string;
}

/** checkpoint_delete 返回 */
export interface CheckpointDeleteOutcome {
    success: boolean;
    deleted: boolean;
    /** 被链保护（后继引用为 base）拒绝时的提示 */
    rejected?: string;
    reason?: string;
}

/** checkpoint_verify 返回（只读校验，不修改任何文件） */
export interface CheckpointVerifyResult {
    ok: boolean;
    checkpointId: string;
    issues: string[];
    checkedFiles: number;
    chainLength: number;
    /** 单文件 manifest 布局下为「manifest 自洽」标记（加载成功即配对成立） */
    filesRevisionPaired: boolean;
}

/** checkpoint_gc 返回 */
export interface CheckpointGcResult {
    /** true = 本次为 dry-run（不删除任何文件） */
    dryRun: boolean;
    /** 本次实际/将要删除的 blob 哈希 */
    removedBlobs: string[];
    /** 本次实际删除的字节数（dry-run 恒为 0） */
    removedBytes: number;
    /** refcount=0 但仍在 grace period 内的孤儿 blob（本次不处理） */
    pendingBlobs: Array<{ hash: string; orphanedSince: number; ageMs: number }>;
    /** 参与调和校验的 blob 引用条目数 */
    refsVerified: number;
    issue?: string;
}

/** 恢复准备上下文（preview 与 restore 共用同一校验/计算路径，清单严格一致） */
interface RestorePreparedContext {
    checkpoint: CheckpointRecord;
    targetState?: RestoreTargetState;
    manifest?: CheckpointManifest;
    chain: CheckpointRecord[];
    chainEntries: RestoreChainEntry[];
    currentHashes: Record<string, string>;
    currentEmptyDirs: string[];
    protectedScopedPaths: Set<string>;
    deletableScopedPaths: Set<string>;
}

/** 沿父链解析出的完整文件集（含各节点 manifest，供链一致性与清单构建） */
interface ResolvedChainState {
    checkpointId: string;
    workspaceFingerprint: string;
    fileHashes: Record<string, string>;
    emptyDirs: string[];
    manifest: CheckpointManifest;
    manifestsByNode: Map<string, CheckpointManifest>;
}

/** 恢复门闸 token 绑定（previewId = token 本体） */
interface PreviewTokenBinding {
    previewId: string;
    checkpointId: string;
    workspaceFingerprint: string;
    /** manifest 载荷内容哈希（manifest 不可变；绑定校验） */
    manifestHash: string;
    /** 目标基线摘要：preview 时当前工作区文件哈希聚合，apply 前重新比对 */
    baselineDigest: string;
}

/** 轻量日志辅助（源 Logger 的 DSH 内联最小实现：console 前缀） */
const log = (message: string, ...args: unknown[]): void => {
    console.log(`[graycode-checkpoints] ${message}`, ...args);
};
const warn = (message: string, ...args: unknown[]): void => {
    console.warn(`[graycode-checkpoints] ${message}`, ...args);
};
const error = (message: string, ...args: unknown[]): void => {
    console.error(`[graycode-checkpoints] ${message}`, ...args);
};

/** 生成存档 ID：crypto.randomUUID（DSH 记录存储契约） */
function generateCheckpointId(): string {
    return `cp_${crypto.randomUUID().replaceAll('-', '')}`;
}

/** 生成 staging/quarantine 操作 ID（安全目录名） */
function generateOperationId(): string {
    return `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 工作区目录 → uri（与源测试/远端工作区序列化同形：file:// 前缀 + posix 分隔符） */
function cwdToUri(cwd: string): string {
    return `file:///${cwd.replace(/\\/g, '/')}`;
}

/**
 * 检查点服务
 */
export class CheckpointService {
    /** 存档根目录（`<dataRoot>/checkpoints`，下按 workspace-id 分目录） */
    readonly checkpointsDir: string;
    /** 记录文件（`<dataRoot>/checkpoints/records.json`，按 workspace-id 隔离） */
    readonly recordsFile: string;

    private readonly config: CheckpointServiceConfig;
    private readonly lockManager = new CheckpointOperationLockManager();
    private readonly deletionService: CheckpointDeletionService;
    private readonly store: RecordStoreImpl;

    /** 恢复门闸：previewId → 绑定（checkpointId+workspace+manifestHash+基线摘要；进程内有效） */
    private readonly previewTokens = new Map<string, PreviewTokenBinding>();
    /** 每工作区内容寻址存储（blob 池 + manifest 仓库）缓存 */
    private readonly storages = new Map<string, CheckpointWorkspaceStorage>();
    /** 操作进度注册表（CheckpointDeletionService 依赖；最小实现） */
    private readonly operations = new Map<string, { progress: CheckpointOperationProgress; controller: AbortController }>();
    /**
     * records.json 写串行链（源 withMetadataWriteSerialized 语义）。
     * @internal RecordStoreImpl 持有本服务引用，通过该字段串行化并发写。
     */
    recordsWriteChain: Promise<unknown> = Promise.resolve();

    constructor(config: CheckpointServiceConfig) {
        this.config = config;
        this.checkpointsDir = path.join(config.dataRoot, 'checkpoints');
        this.recordsFile = path.join(this.checkpointsDir, 'records.json');
        this.store = new RecordStoreImpl(this);
        this.deletionService = new CheckpointDeletionService({
            conversationManager: this.store,
            getStorage: conversationId => this.workspaceStorageFor(conversationId),
            // 本服务只调用无锁版 deleteCheckpointInternal（调用方已持工作区级锁）；
            // batch/byNodeIds 的锁 ID 计算在 DSH 下退化为稳定虚拟键。
            getDeletionLockIds: () => ['checkpoint-global-storage'],
            beginOperation: (kind, conversationId, checkpointId) => this.beginOperation(kind, conversationId, checkpointId),
            endOperation: operationId => this.endOperation(operationId),
            // 全局文件写锁层已删除（见 CheckpointOperationLock 头注释）：无该取消错误
            isFileLockCancellationError: () => false
        });
    }

    /** 确保存档目录存在 */
    async initialize(): Promise<void> {
        await fs.mkdir(this.checkpointsDir, { recursive: true });
    }

    /** 释放内部资源（测试/生命周期用） */
    dispose(): void {
        for (const controller of this.operations.values()) {
            controller.controller.abort();
        }
        this.operations.clear();
        this.previewTokens.clear();
        this.storages.clear();
    }

    // ==================== 工作区身份适配（cwd → workspaceRoots） ====================

    /**
     * 由会话 cwd 解析运行时工作区根（单根）。
     * workspaceRootId 用源 createWorkspaceRootId（sha256 前 16 位）语义。
     */
    resolveRuntimeRoots(cwd: string | undefined): RuntimeWorkspaceRoot[] {
        const fsPath = path.resolve(cwd ?? process.cwd());
        return createRuntimeWorkspaceRoots([
            { name: path.basename(fsPath) || 'workspace', uri: cwdToUri(fsPath), fsPath }
        ]);
    }

    /** 工作区 → 记录隔离键（conversationId = 工作区根 id） */
    conversationIdFor(cwd: string | undefined): string {
        const roots = this.resolveRuntimeRoots(cwd);
        if (roots.length === 0) {
            throw new Error('No workspace root');
        }
        const first = roots[0];
        if (!first) {
            throw new Error('No workspace root');
        }
        return first.id;
    }

    /** 工作区内容寻址存储（blob 池 + manifest 仓库；workspace-id 即目录名，越界名拒绝） */
    private workspaceStorageFor(conversationId: string): CheckpointWorkspaceStorage {
        if (!isSafeCheckpointDirName(conversationId)) {
            throw new Error(`Unsafe workspace id: ${conversationId}`);
        }
        let storage = this.storages.get(conversationId);
        if (!storage) {
            const workspaceDir = path.join(this.checkpointsDir, conversationId);
            storage = {
                blobs: new BlobStore(workspaceDir),
                manifests: new CheckpointManifestRepository(workspaceDir)
            };
            this.storages.set(conversationId, storage);
        }
        return storage;
    }

    // ==================== checkpoint_create ====================

    /**
     * 创建工作区快照（内容寻址布局，§7.6 写入顺序）。
     *
     * 增量语义：与父检查点比对（按 hash 差集）——内容未变（同 hash）的 blob 复用，
     * 仅新内容写入 blob 池；manifest 记录完整文件集 + 相对父链的 changes。
     */
    async createCheckpoint(
        cwd: string | undefined,
        options?: { title?: string; notes?: string; signal?: AbortSignal }
    ): Promise<CreateCheckpointResult | null> {
        const roots = this.resolveRuntimeRoots(cwd);
        const conversationId = roots[0]?.id ?? '';
        const checkpointId = generateCheckpointId();
        const opId = generateOperationId();
        const signal = options?.signal;

        try {
            return await this.lockManager.runExclusive(
                roots.map(root => root.id),
                'create',
                `checkpoint:${conversationId}:${checkpointId}`,
                async () => {
                    const storage = this.workspaceStorageFor(conversationId);
                    await storage.blobs.initialize();
                    return this.executeBackup({
                        conversationId,
                        roots,
                        checkpointId,
                        opId,
                        storage,
                        title: options?.title,
                        notes: options?.notes,
                        signal
                    });
                },
                signal
            );
        } finally {
            // 无进程级遗留（staging/quarantine 证据保留）
        }
    }

    /** 锁内备份执行主体（§7.6 写入顺序 1-6） */
    private async executeBackup(params: {
        conversationId: string;
        roots: RuntimeWorkspaceRoot[];
        checkpointId: string;
        opId: string;
        storage: CheckpointWorkspaceStorage;
        title?: string;
        notes?: string;
        signal?: AbortSignal;
    }): Promise<CreateCheckpointResult | null> {
        const { conversationId, roots, checkpointId, opId, storage } = params;
        const signal = params.signal;
        try {
            // 上一检查点：沿父链解析完整文件集（增量基线；hash 差集决定写入量）
            const existing = await this.store.getCheckpointRecords(conversationId);
            const lastCheckpoint = existing.length > 0 ? existing[existing.length - 1] : null;
            let prevState: ResolvedChainState | undefined;
            if (lastCheckpoint) {
                const resolved = await this.resolveChainState(conversationId, lastCheckpoint.id);
                if (resolved.ok) {
                    // 同一 conversationId 下工作区身份不一致（异常）：从完整备份开始
                    if (resolved.state.workspaceFingerprint === createWorkspaceSnapshot(roots).workspaceFingerprint) {
                        prevState = resolved.state;
                    }
                }
            }

            // §7.6 第 1 步：枚举并规范化相对路径（四层排除 + 防穿越 + 符号链接/设备文件排除）
            const workspaceSnapshot = createWorkspaceSnapshot(roots);
            const snapshot = await buildWorkspaceSnapshot({
                roots,
                customIgnorePatterns: this.config.excludePatterns,
                enabledProfiles: this.config.excludeProfiles,
                maxFileSizeBytes: this.config.maxFileSizeBytes,
                // 排除整个插件私有数据根（含 checkpoints/records.json 等）：绝不进入存档
                excludeAbsolutePaths: [path.dirname(this.checkpointsDir)],
                // 内容寻址下 blob 不可变，mtime 等易变字段不随存档存储——
                // 不做 stat 级哈希复用（每次全量重哈希，仅写入量按 hash 差集收敛）
                previous: undefined
            });

            const currentHashes: Record<string, string> = { ...snapshot.fileHashes };
            const currentStats: Record<string, SnapshotFileStat> = { ...snapshot.fileStats };
            const unbackedPaths: string[] = [];
            const unbackedPathSet = new Set<string>();
            const markUnbacked = (scopedPath: string): void => {
                unbackedPaths.push(scopedPath);
                unbackedPathSet.add(scopedPath);
                delete currentHashes[scopedPath];
                delete currentStats[scopedPath];
            };

            // §7.6 第 2-3 步：新 Blob 写 staging（fsync/close 后校验）→ 原子提交；
            // 同 hash 已存在 → 复用（不重写）；失败 → quarantine 记录 + markUnbacked
            let blobWriteCount = 0;
            let newBlobBytes = 0;
            let reuseCount = 0;
            const blobTargets: Array<{ scopedPath: string; hash: string; size: number; srcPath: string }> = [];
            for (const scopedPath of Object.keys(currentHashes).sort()) {
                const hash = currentHashes[scopedPath];
                const stat = currentStats[scopedPath];
                if (!hash || !stat) {
                    continue;
                }
                const parsed = parseWorkspaceScopedPath(scopedPath, roots);
                blobTargets.push({
                    scopedPath,
                    hash,
                    size: stat.size,
                    srcPath: path.join(parsed.root.fsPath, ...parsed.relativePath.split('/'))
                });
            }
            await runBounded(blobTargets, DEFAULT_CHECKPOINT_CONCURRENCY, async target => {
                throwIfAborted(signal);
                try {
                    if (await storage.blobs.blobExists(target.hash)) {
                        reuseCount += 1;
                        return;
                    }
                    const result = await storage.blobs.stageAndCommit(opId, target.srcPath, target.hash, target.size);
                    if (result.reused) {
                        reuseCount += 1;
                    } else {
                        blobWriteCount += 1;
                        newBlobBytes += result.size;
                    }
                } catch (err) {
                    // staging 失败（源文件在扫描与复制间被改写 / IO 错误）：证据进 quarantine，不静默删除
                    const stagedPath = (err as { stagedPath?: string } | null)?.stagedPath;
                    const reason = err instanceof Error ? err.message : String(err);
                    await storage.blobs.quarantine(opId, target.scopedPath, reason, stagedPath);
                    markUnbacked(target.scopedPath);
                }
            });

            // 大小超限与不可读文件合并进 unbackedPaths（恢复时受保护，绝不自动删除）
            for (const entry of [...snapshot.sizeExcluded, ...snapshot.unreadable]) {
                if (!unbackedPathSet.has(entry.scopedPath)) {
                    unbackedPathSet.add(entry.scopedPath);
                    unbackedPaths.push(entry.scopedPath);
                }
            }

            // 增量差异（相对父检查点的 changes；added/modified/deleted）
            const changes: CheckpointFileChange[] = [];
            const previousHashes = prevState?.fileHashes ?? {};
            for (const scopedPath of Object.keys(currentHashes).sort()) {
                const hash = currentHashes[scopedPath];
                if (!(scopedPath in previousHashes)) {
                    changes.push({ path: scopedPath, type: 'added', hash });
                } else if (previousHashes[scopedPath] !== hash) {
                    changes.push({ path: scopedPath, type: 'modified', hash });
                }
            }
            for (const scopedPath of Object.keys(previousHashes)) {
                if (!(scopedPath in currentHashes)) {
                    changes.push({ path: scopedPath, type: 'deleted' });
                }
            }

            // 综合内容签名（基于实际备份成功的文件集合，sha256）
            const contentHash = this.digestOfHashes(currentHashes);

            // 完整文件清单：scopedPath → { hash(=blobHash), size, mode }
            const files: CheckpointManifest['files'] = {};
            for (const [scopedPath, hash] of Object.entries(currentHashes)) {
                const stat = currentStats[scopedPath];
                files[scopedPath] = {
                    hash,
                    size: stat?.size ?? 0,
                    mode: stat?.mode ?? 0o644
                };
            }

            const exclusionSnapshot = buildIgnoreSnapshot({
                enabledProfiles: this.config.excludeProfiles,
                maxFileSizeBytes: this.config.maxFileSizeBytes,
                customPatterns: this.config.excludePatterns
            });
            const manifest: CheckpointManifest = {
                version: CHECKPOINT_MANIFEST_VERSION,
                checkpointId,
                workspaceRoots: workspaceSnapshot.workspaceRoots,
                workspaceFingerprint: workspaceSnapshot.workspaceFingerprint,
                parentCheckpointId: prevState ? prevState.checkpointId : undefined,
                createdAt: Date.now(),
                files,
                changes,
                emptyDirs: snapshot.emptyDirs,
                excluded: snapshot.excluded,
                ignoreSnapshot: exclusionSnapshot,
                excludeRuleVersion: exclusionSnapshot.version,
                contentHash
            };
            throwIfAborted(signal);
            // §7.6 第 4 步：提交 manifest（原子写）
            await storage.manifests.writeManifest(checkpointId, manifest);

            const manifestHash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');

            // 记录：存在 base 时 type=incremental（链结构），baseCheckpointId 保留
            const description = [params.title, params.notes].filter(part => part && part.length > 0).join(' — ');
            const isIncremental = prevState !== undefined;
            const blobCount = new Set(Object.values(files).map(entry => entry.hash)).size;
            const checkpoint: CheckpointRecord = {
                id: checkpointId,
                conversationId,
                messageIndex: 0,
                toolName: 'checkpoint_create',
                phase: 'before',
                timestamp: Date.now(),
                backupDir: checkpointId,
                fileCount: Object.keys(files).length,
                contentHash,
                description: description || undefined,
                type: isIncremental ? 'incremental' : 'full',
                baseCheckpointId: isIncremental ? prevState?.checkpointId : undefined,
                changes,
                ignorePatterns: this.config.excludePatterns,
                excludedCount: snapshot.excluded.length,
                excludedBytes: snapshot.excluded.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
                ignoreSnapshot: exclusionSnapshot,
                unbackedPaths: unbackedPaths.length > 0 ? unbackedPaths.sort() : undefined,
                emptyDirs: snapshot.emptyDirs,
                workspaceRoots: workspaceSnapshot.workspaceRoots,
                workspaceFingerprint: workspaceSnapshot.workspaceFingerprint,
                backupBytes: newBlobBytes,
                manifestVersion: CHECKPOINT_MANIFEST_VERSION,
                manifestHash,
                excludeRuleVersion: exclusionSnapshot.version,
                blobCount,
                status: 'active'
            };
            throwIfAborted(signal);
            await this.store.updateCheckpoints(conversationId, list => [...list, checkpoint]);

            // 提交后增加 blob 引用（§7.6 第 4 步：domain 引用计数 +1）
            await storage.blobs.incrementRefs([...new Set(Object.values(files).map(entry => entry.hash))]);

            // §7.6 第 5 步：发布 checkpoint-created 事件（DSH 无事件基础设施 → 记日志 + lastEvent）
            const lastEvent = `checkpoint-created:${checkpointId}@${Date.now()}`;
            await this.store.updateCheckpoints(conversationId, list =>
                list.map(cp => (cp.id === checkpointId ? { ...cp, lastEvent } : cp))
            );
            log('checkpoint_created', {
                checkpointId,
                type: checkpoint.type,
                workspace: conversationId,
                fileCount: Object.keys(files).length,
                blobWrites: blobWriteCount,
                blobReuses: reuseCount,
                newBytes: newBlobBytes
            });

            // 保留策略清理（超过 maxCheckpoints 时驱逐最旧存档）
            await this.cleanupExcessCheckpoints(conversationId);

            // §7.6 第 6 步：清理 staging（成功提交的已移出；残留即失败证据，先入 quarantine）
            await this.quarantineStagingLeftovers(storage, opId);
            await storage.blobs.cleanupStaging(opId);

            return {
                checkpointId,
                type: checkpoint.type ?? 'full',
                fileCount: Object.keys(files).length,
                sizeBytes: newBlobBytes,
                excludedCount: snapshot.excluded.length,
                baseCheckpointId: checkpoint.baseCheckpointId,
                description: checkpoint.description
            };
        } catch (err) {
            if (!(err instanceof CheckpointAbortError)) {
                error('Failed to create checkpoint:', err);
            }
            // 记录没提交 ⇔ manifest 不应可见：staging 残留进 quarantine（证据）→ 移除已写 manifest
            try {
                await this.quarantineStagingLeftovers(storage, opId);
                await storage.blobs.cleanupStaging(opId);
            } catch (cleanupErr) {
                warn('Failed to recycle staging after failed create:', cleanupErr);
            }
            storage.manifests.clearCache(checkpointId);
            try {
                await storage.manifests.deleteManifest(checkpointId);
            } catch (rmErr) {
                warn('Failed to remove uncommitted manifest:', rmErr);
            }
            return null;
        }
    }

    /** staging 残留（未提交的 .part 文件）移入 quarantine 并记录（不静默删除证据） */
    private async quarantineStagingLeftovers(storage: CheckpointWorkspaceStorage, opId: string): Promise<void> {
        const stagingDir = storage.blobs.stagingDir(opId);
        let names: string[];
        try {
            names = await fs.readdir(stagingDir);
        } catch {
            return; // staging 目录不存在 = 无残留
        }
        for (const name of names) {
            await storage.blobs.quarantine(opId, name, 'create-staging-leftover', path.join(stagingDir, name));
        }
    }

    /**
     * 保留策略：超过 maxCheckpoints 时驱逐最旧存档。
     *
     * 内容寻址布局：驱逐 = 记录移除 + 链重挂 + 删 manifest + 减 blob 引用
     * （blob 物理回收由 GC 负责，驱逐不删 blob）。
     */
    private async cleanupExcessCheckpoints(conversationId: string): Promise<void> {
        if (this.config.maxCheckpoints <= 0) {
            return;
        }
        const checkpoints = await this.store.getCheckpointRecords(conversationId);
        if (checkpoints.length <= this.config.maxCheckpoints) {
            return;
        }
        const sorted = [...checkpoints].sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : 1));
        const excess = sorted.length - this.config.maxCheckpoints;
        for (let i = 0; i < excess && i < sorted.length; i += 1) {
            const cp = sorted[i];
            if (!cp) {
                break;
            }
            const evicted = await this.evictCheckpoint(conversationId, cp);
            if (!evicted) {
                break;
            }
        }
    }

    /** 驱逐单个存档：链重挂后继 → 记录移除 → 删 manifest + 减 blob 引用 */
    private async evictCheckpoint(conversationId: string, target: CheckpointRecord): Promise<boolean> {
        if (!isSafeCheckpointDirName(target.backupDir)) {
            warn(`Refusing to evict checkpoint ${target.id}: unsafe backupDir ${target.backupDir}`);
            return false;
        }
        let removed = false;
        await this.store.updateCheckpoints(conversationId, list => {
            if (!list.some(cp => cp.id === target.id)) {
                return list;
            }
            removed = true;
            return list
                .filter(cp => cp.id !== target.id)
                .map(cp => (cp.baseCheckpointId === target.id ? { ...cp, baseCheckpointId: target.baseCheckpointId } : cp));
        });
        if (!removed) {
            return false;
        }
        await cleanupCheckpointStorage(this.workspaceStorageFor(conversationId), target.id);
        return true;
    }

    // ==================== checkpoint_list ====================

    /** 列出工作区存档（按时间倒序分页） */
    async listCheckpoints(
        cwd: string | undefined,
        options?: { cursor?: string; limit?: number }
    ): Promise<CheckpointListResult> {
        const conversationId = this.conversationIdFor(cwd);
        const records = await this.store.getCheckpointRecords(conversationId);
        const sorted = [...records].sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? 1 : -1));
        const limit = Math.max(1, Math.min(options?.limit ?? 20, 100));
        let startIndex = 0;
        if (options?.cursor) {
            const cursorIndex = sorted.findIndex(record => record.id === options.cursor);
            if (cursorIndex >= 0) {
                startIndex = cursorIndex + 1;
            }
        }
        const page = sorted.slice(startIndex, startIndex + limit);
        const nextCursor = startIndex + limit < sorted.length ? page[page.length - 1]?.id : undefined;
        return {
            items: page.map(record => this.toSummary(record)),
            total: sorted.length,
            nextCursor
        };
    }

    /** 记录 → 轻量摘要（源 CheckpointQueryService.toSummary） */
    private toSummary(record: CheckpointRecord): CheckpointSummary {
        return {
            id: record.id,
            conversationId: record.conversationId,
            messageNodeId: record.messageNodeId,
            messageIndex: record.messageIndex,
            toolName: record.toolName,
            phase: record.phase,
            timestamp: record.timestamp,
            type: record.type ?? 'full',
            baseCheckpointId: record.baseCheckpointId,
            contentHash: record.contentHash,
            fileCount: record.fileCount,
            backupBytes: typeof record.backupBytes === 'number' ? record.backupBytes : 0,
            excludedCount: typeof record.excludedCount === 'number' ? record.excludedCount : 0,
            manifestVersion: typeof record.manifestVersion === 'number' ? record.manifestVersion : 0
        };
    }

    // ==================== checkpoint_preview / checkpoint_restore ====================

    /**
     * 预览恢复（CP-09）：计算恢复计划（将恢复/删除/跳过的文件数 + 待删除文件清单），
     * 不执行任何文件写入。预览通过后签发 previewToken（§7.6 不变量）：
     * 绑定 previewId（checkpointId+workspace 指纹 sha256）、manifest hash 与
     * 目标基线摘要（preview 时当前工作区文件哈希聚合），restore 必须原样回传。
     */
    async previewRestore(
        cwd: string | undefined,
        checkpointId: string,
        options?: { deleteUntrackedFiles?: boolean }
    ): Promise<CheckpointPreviewOutcome> {
        const roots = this.resolveRuntimeRoots(cwd);
        const conversationId = roots[0]?.id ?? '';
        const workspaceFingerprint = createWorkspaceSnapshot(roots).workspaceFingerprint;

        try {
            const outcome = await this.lockManager.runExclusive(
                roots.map(root => root.id),
                'restore',
                `checkpoint:${conversationId}:${checkpointId}:preview:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                async () => {
                    const prepared = await this.prepareRestore(conversationId, checkpointId, roots);
                    if (!prepared.ok) {
                        const r = prepared.result;
                        return {
                            preview: {
                                success: r.success,
                                restored: r.restored,
                                deleted: r.deleted,
                                deletedIfUnconfirmed: 0,
                                skipped: r.skipped,
                                deletablePaths: [],
                                untrackedPaths: [],
                                error: r.error,
                                failures: r.failures,
                                unbackedPaths: r.unbackedPaths,
                                excludedNote: r.excludedNote
                            } satisfies RestorePreviewResult,
                            mint: undefined
                        };
                    }
                    const {
                        checkpoint,
                        targetState,
                        chainEntries,
                        currentHashes,
                        currentEmptyDirs,
                        protectedScopedPaths,
                        deletableScopedPaths
                    } = prepared.ctx;

                    // 与 restoreWorkspaceSnapshot 共用 computeRestorePlan，清单与执行严格一致
                    const plan = computeRestorePlan(
                        {
                            checkpointsDir: this.checkpointsDir,
                            blobsDir: this.workspaceStorageFor(conversationId).blobs.blobsDir,
                            roots,
                            protectedScopedPaths,
                            deletableScopedPaths
                        },
                        chainEntries,
                        targetState as RestoreTargetState,
                        currentHashes,
                        currentEmptyDirs
                    );

                    return {
                        preview: {
                            success: true,
                            restored: plan.added.length + plan.modified.length,
                            // deleted = 确认删除 untracked 后总数；deletedIfUnconfirmed 仅计快照记录过的路径
                            deleted: plan.toDelete.length + plan.deletedInSnapshot.length + plan.untrackedToDelete.length,
                            deletedIfUnconfirmed: plan.toDelete.length + plan.deletedInSnapshot.length,
                            skipped: plan.skipped,
                            deletablePaths: [
                                ...plan.toDelete.map(p => this.toDisplayPath(p, roots)),
                                ...plan.deletedInSnapshot.map(p => this.toDisplayPath(p, roots))
                            ],
                            untrackedPaths: [
                                ...plan.untrackedToDelete.map(p => this.toDisplayPath(p, roots)),
                                ...plan.untrackedEmptyDirs.map(p => this.toDisplayPath(p, roots))
                            ],
                            unbackedPaths: this.toDisplayUnbackedPaths(checkpoint.unbackedPaths, roots),
                            excludedNote: this.buildExcludedNote(prepared.ctx.manifest)
                        } satisfies RestorePreviewResult,
                        mint: {
                            checkpointId,
                            workspaceFingerprint,
                            manifestHash: checkpoint.manifestHash ?? '',
                            baselineDigest: this.digestOfHashes(currentHashes)
                        }
                    };
                }
            );
            const token = outcome.mint ? this.mintPreviewToken(outcome.mint) : undefined;
            return {
                preview: outcome.preview,
                previewToken: token,
                baselineDigest: outcome.mint?.baselineDigest
            };
        } catch (err) {
            error('Failed to preview restore:', err);
            return {
                preview: {
                    success: false,
                    restored: 0,
                    deleted: 0,
                    deletedIfUnconfirmed: 0,
                    skipped: 0,
                    deletablePaths: [],
                    untrackedPaths: [],
                    error: err instanceof Error ? err.message : 'Unknown error'
                }
            };
        }
    }

    /**
     * 恢复检查点（预览→确认→恢复门闸，§7.6 不变量）。
     *
     * - token 必须携带 preview 时签发的 previewId（绑定 workspace/manifest hash/基线摘要）；
     * - apply 前重新比对当前工作区文件哈希与 preview 时基线：目标变化后旧 preview 失效，
     *   拒绝并要求重新 preview；
     * - 复制阶段先于删除阶段；复制 0 失败才执行删除；逐文件失败清单；
     * - deleteUntrackedFiles=false 时只恢复快照记录过的文件，不删未跟踪文件（#29）。
     */
    async restoreCheckpoint(
        cwd: string | undefined,
        checkpointId: string,
        previewToken: string,
        options?: { deleteUntrackedFiles?: boolean; signal?: AbortSignal }
    ): Promise<RestoreResult> {
        const roots = this.resolveRuntimeRoots(cwd);
        const conversationId = roots[0]?.id ?? '';
        const workspaceFingerprint = createWorkspaceSnapshot(roots).workspaceFingerprint;

        // 门闸：无有效 token（未预览 / 预览过期 / 工作区或存档不匹配）拒绝
        const binding = this.validatePreviewToken(previewToken, checkpointId, workspaceFingerprint);
        if (!binding) {
            return {
                success: false,
                restored: 0,
                deleted: 0,
                skipped: 0,
                error: 'Restore denied: invalid or missing previewToken (run checkpoint_preview first and pass its previewToken unchanged)'
            };
        }

        try {
            const result = await this.lockManager.runExclusive(
                roots.map(root => root.id),
                'restore',
                `checkpoint:${conversationId}:${checkpointId}:restore:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                async () => {
                    // apply 前重新比对当前文件哈希与 preview 时基线（目标变化后旧 preview 失效）
                    const currentState = await this.collectCurrentWorkspaceState(roots);
                    if (this.digestOfHashes(currentState.currentHashes) !== binding.baselineDigest) {
                        return {
                            success: false,
                            restored: 0,
                            deleted: 0,
                            skipped: 0,
                            error: 'Restore denied: workspace changed since preview (baseline mismatch); run checkpoint_preview again and pass its new previewToken'
                        };
                    }

                    const prepared = await this.prepareRestore(conversationId, checkpointId, roots, {
                        currentState
                    });
                    if (!prepared.ok) {
                        return prepared.result;
                    }
                    const {
                        checkpoint,
                        targetState,
                        chainEntries,
                        protectedScopedPaths,
                        deletableScopedPaths
                    } = prepared.ctx;

                    // manifest hash 绑定：manifest 不可变，记录与 preview 时不一致即拒绝
                    if (binding.manifestHash && checkpoint.manifestHash !== binding.manifestHash) {
                        return {
                            success: false,
                            restored: 0,
                            deleted: 0,
                            skipped: 0,
                            error: 'Restore denied: checkpoint manifest changed since preview; run checkpoint_preview again'
                        };
                    }

                    const engineResult = await restoreWorkspaceSnapshot(
                        {
                            checkpointsDir: this.checkpointsDir,
                            blobsDir: this.workspaceStorageFor(conversationId).blobs.blobsDir,
                            roots,
                            protectedScopedPaths,
                            deletableScopedPaths,
                            deleteUntrackedFiles: options?.deleteUntrackedFiles === true,
                            signal: options?.signal
                        },
                        chainEntries,
                        targetState as RestoreTargetState,
                        currentState.currentHashes,
                        currentState.currentEmptyDirs
                    );

                    // 失败路径转为相对路径展示（scoped 键对用户不友好）
                    const failures: RestoreFailure[] = engineResult.failures.map(f => ({
                        path: this.toDisplayPath(f.path, roots),
                        reason: f.reason
                    }));
                    const hasFailures = failures.length > 0;

                    log('restore_from_chain', {
                        checkpointId,
                        restored: engineResult.restored,
                        deleted: engineResult.deleted,
                        skipped: engineResult.skipped,
                        failureCount: failures.length
                    });

                    return {
                        success: engineResult.success,
                        restored: engineResult.restored,
                        deleted: engineResult.deleted,
                        skipped: engineResult.skipped,
                        failures: hasFailures ? failures : undefined,
                        error: hasFailures ? this.formatFailureSummary(failures) : undefined,
                        unbackedPaths: this.toDisplayUnbackedPaths(checkpoint.unbackedPaths, roots),
                        excludedNote: this.buildExcludedNote(prepared.ctx.manifest)
                    };
                },
                options?.signal
            );
            if (result.success) {
                this.previewTokens.delete(previewToken);
            }
            return result;
        } catch (err) {
            if ((err as Error)?.message === CHECKPOINT_LOCK_CANCELLED_MESSAGE || (options?.signal)?.aborted) {
                return { success: false, restored: 0, deleted: 0, skipped: 0, error: 'cancelled' };
            }
            error('Failed to restore checkpoint:', err);
            return { success: false, restored: 0, deleted: 0, skipped: 0, error: err instanceof Error ? err.message : 'Unknown error' };
        }
    }

    /** 恢复门闸 token：previewId（checkpointId+workspace 指纹 sha256）+ 绑定基线/manifest hash */
    private mintPreviewToken(binding: Omit<PreviewTokenBinding, 'previewId'>): string {
        const previewId = crypto.createHash('sha256')
            .update(`${binding.checkpointId}\n${binding.workspaceFingerprint}`)
            .digest('hex')
            .slice(0, 32);
        this.previewTokens.set(previewId, { previewId, ...binding });
        return previewId;
    }

    /** 校验恢复门闸 token（进程内签发、checkpoint/工作区严格匹配；返回绑定或 null） */
    private validatePreviewToken(
        token: string,
        checkpointId: string,
        workspaceFingerprint: string
    ): PreviewTokenBinding | null {
        const entry = this.previewTokens.get(token);
        if (!entry || entry.checkpointId !== checkpointId || entry.workspaceFingerprint !== workspaceFingerprint) {
            return null;
        }
        return entry;
    }

    /**
     * 恢复公共准备（CP-09）：工作区校验、增量链完整性验证（含环检测）、
     * 沿父链解析完整文件集、收集当前工作区状态、计算删除边界。
     * previewRestore 与 restoreCheckpoint 共用此路径，保证「预览确认的删除清单」
     * 与「实际执行的删除」基于同一套校验与计算；本方法不执行文件写入。
     */
    private async prepareRestore(
        conversationId: string,
        checkpointId: string,
        roots: readonly RuntimeWorkspaceRoot[],
        options?: { currentState?: { currentHashes: Record<string, string>; currentEmptyDirs: string[] } }
    ): Promise<{ ok: true; ctx: RestorePreparedContext } | { ok: false; result: RestoreResult }> {
        const failResult = (message: string, extra?: Partial<RestoreResult>): { ok: false; result: RestoreResult } => ({
            ok: false,
            result: { success: false, restored: 0, deleted: 0, skipped: 0, error: message, ...extra }
        });

        const checkpoints = await this.store.getCheckpointRecords(conversationId);
        const checkpoint = checkpoints.find(cp => cp.id === checkpointId);
        if (!checkpoint) {
            return failResult('Checkpoint not found');
        }

        // CP-01: 新格式存档（带工作区身份元数据）必须通过工作区校验
        if (checkpoint.workspaceRoots?.length) {
            const validation = validateWorkspaceSnapshot(
                checkpoint.workspaceRoots,
                checkpoint.workspaceFingerprint,
                roots
            );
            if (!validation.valid) {
                return failResult('Current workspace does not match the checkpoint workspace');
            }
        }

        // 沿父链解析完整文件集（manifest 缺失/损坏、changes 与 files 不一致 → fail-closed）
        const resolved = await this.resolveChainState(conversationId, checkpointId);
        if (!resolved.ok) {
            return failResult(resolved.error, { failures: [] });
        }
        const { fileHashes, manifest, manifestsByNode } = resolved.state;

        // 链上所有带身份元数据的节点必须与当前工作区一致（跨工作区混链 fail-closed）
        for (const cp of this.getChainRecords(checkpoints, checkpoint).chain) {
            const nodeManifest = manifestsByNode.get(cp.id);
            if (nodeManifest && nodeManifest.workspaceFingerprint !== checkpoint.workspaceFingerprint) {
                return failResult('Chain contains a checkpoint from a different workspace', { failures: [] });
            }
        }

        // 先用当前规则裁剪目标状态（每个根独立 ignore 作用域），再进行 diff / restore
        const filteredTarget = await this.filterRestoreTargetScoped(
            fileHashes,
            manifest.emptyDirs,
            roots
        );
        const targetState: RestoreTargetState = filteredTarget ? { ...filteredTarget } : { fileHashes: {}, emptyDirs: [] };
        if (manifest.partial === true) {
            targetState.partial = true;
        }

        // 工作区当前状态与目标状态使用同一 ignore 口径收集
        const collected = options?.currentState ?? (await this.collectCurrentWorkspaceState(roots));

        // 快照时可见但未备份的路径（复制失败/大小超限/不可读）：恢复时绝不能删除
        const protectedScopedPaths = new Set<string>();
        for (const rawKey of checkpoint.unbackedPaths ?? []) {
            protectedScopedPaths.add(toScopedKey(rawKey, roots));
        }
        // 快照时被规则排除的文件/目录同样纳入保护（用户放宽规则后不会被误删）
        for (const entry of manifest.excluded ?? []) {
            if (entry.reason === 'default' || entry.reason === 'gitignore' || entry.reason === 'custom') {
                protectedScopedPaths.add(toScopedKey(entry.path, roots));
            }
        }

        // #29: 只删除目标快照 fileHashes 中记录过的路径
        const deletableScopedPaths = new Set<string>();
        for (const rawKey of Object.keys(fileHashes)) {
            deletableScopedPaths.add(toScopedKey(rawKey, roots));
        }

        // 增量链节点：每节点完整映射（fileHashes/blobHashes/modes 同源）+ changes
        const chain = this.getChainRecords(checkpoints, checkpoint).chain;
        const chainEntries: RestoreChainEntry[] = chain.map(cp => {
            const nodeManifest = manifestsByNode.get(cp.id);
            const nodeHashes: Record<string, string> = {};
            const nodeBlobs: Record<string, string> = {};
            const nodeModes: Record<string, number> = {};
            for (const [scopedPath, entry] of Object.entries(nodeManifest?.files ?? {})) {
                nodeHashes[scopedPath] = entry.hash;
                nodeBlobs[scopedPath] = entry.hash;
                nodeModes[scopedPath] = entry.mode;
            }
            return {
                checkpointId: cp.id,
                backupDir: cp.backupDir,
                fileHashes: nodeHashes,
                blobHashes: nodeBlobs,
                modes: nodeModes,
                changes: nodeManifest?.changes
            };
        });

        return {
            ok: true,
            ctx: {
                checkpoint,
                targetState,
                manifest,
                chain,
                chainEntries,
                currentHashes: collected.currentHashes,
                currentEmptyDirs: collected.currentEmptyDirs,
                protectedScopedPaths,
                deletableScopedPaths
            }
        };
    }

    /**
     * 沿父链解析完整文件集（V2 §7.6「恢复时沿父链解析完整文件集」）。
     *
     * - 环检测/断链显式失败（fail-closed，与源 getIncrementalChain 语义一致）；
     * - 链上每节点 manifest 必须存在（等价旧实现的「备份目录存在性」校验）；
     * - 从最旧节点开始按 changes 叠加（added/modified 覆盖、deleted 移除），
     *   与各节点自身完整 files 映射交叉校验——changes 与 files 不一致即数据损坏。
     */
    private async resolveChainState(
        conversationId: string,
        checkpointId: string
    ): Promise<{ ok: true; state: ResolvedChainState } | { ok: false; error: string }> {
        const checkpoints = await this.store.getCheckpointRecords(conversationId);
        const found = checkpoints.find(cp => cp.id === checkpointId);
        if (!found) {
            return { ok: false, error: 'Checkpoint not found' };
        }
        const { chain, broken } = this.getChainRecords(checkpoints, found);
        if (broken) {
            return { ok: false, error: 'Incremental chain is broken (missing or cyclic baseCheckpointId)' };
        }
        if (chain.length === 0) {
            return { ok: false, error: 'Cannot build restore chain' };
        }

        const manifests: CheckpointManifest[] = [];
        const manifestsByNode = new Map<string, CheckpointManifest>();
        const storage = this.workspaceStorageFor(conversationId);
        for (const cp of chain) {
            const manifest = await storage.manifests.loadManifest(cp.id);
            if (!manifest) {
                return { ok: false, error: `Checkpoint manifest missing: ${cp.id}` };
            }
            if (manifest.checkpointId !== cp.id) {
                return { ok: false, error: `Manifest checkpointId mismatch: ${cp.id}` };
            }
            manifests.push(manifest);
            manifestsByNode.set(cp.id, manifest);
        }

        // 从最旧节点向最新叠加 changes，并与各节点完整 files 交叉校验
        let fileHashes: Record<string, string> = {};
        for (let i = 0; i < chain.length; i += 1) {
            const manifest = manifests[i]!;
            const overlay = { ...fileHashes };
            for (const change of manifest.changes) {
                if (change.type === 'deleted') {
                    delete overlay[change.path];
                    continue;
                }
                const file = manifest.files[change.path];
                if (!file || (change.hash !== undefined && change.hash !== file.hash)) {
                    return { ok: false, error: `Chain changes inconsistent with files at ${manifest.checkpointId}: ${change.path}` };
                }
                overlay[change.path] = file.hash;
            }
            for (const [scopedPath, entry] of Object.entries(manifest.files)) {
                if (overlay[scopedPath] !== entry.hash) {
                    return { ok: false, error: `Chain overlay mismatch at ${manifest.checkpointId}: ${scopedPath}` };
                }
            }
            fileHashes = overlay;
        }

        const targetManifest = manifests[manifests.length - 1]!;
        return {
            ok: true,
            state: {
                checkpointId,
                workspaceFingerprint: targetManifest.workspaceFingerprint,
                fileHashes,
                emptyDirs: targetManifest.emptyDirs,
                manifest: targetManifest,
                manifestsByNode
            }
        };
    }

    /**
     * 获取从基准点到目标点的增量链（源 CheckpointRestoreService.getIncrementalChain）。
     * 环检测：损坏元数据（base 指向自身/成环）会让 while 无限循环——visited 集合截断，
     * 按链断裂处理（调用方显式报 chainBroken，fail-closed）。
     */
    private getChainRecords(
        checkpoints: CheckpointRecord[],
        targetCheckpoint: CheckpointRecord
    ): { chain: CheckpointRecord[]; broken: boolean } {
        const chain: CheckpointRecord[] = [];
        let current: CheckpointRecord | undefined = targetCheckpoint;
        const byId = new Map(checkpoints.map(cp => [cp.id, cp] as const));
        const visited = new Set<string>();
        let broken = false;

        while (current) {
            if (visited.has(current.id)) {
                broken = true;
                break;
            }
            visited.add(current.id);
            chain.unshift(current);

            if (current.type !== 'incremental' || !current.baseCheckpointId) {
                break; // 到达完整备份，停止
            }
            current = byId.get(current.baseCheckpointId);
            if (!current) {
                broken = true; // #28: 增量链断裂（找不到 baseCheckpointId 对应的检查点）
            }
        }
        return { chain, broken };
    }

    // ==================== checkpoint_delete ====================

    /**
     * 删除检查点（只减少引用：删 manifest + 减 blob 引用；blob 由 GC 回收）。
     *
     * 链保护（computeForcedKeepIds 祖先闭包）：被保留记录直接或间接引用为 base 的
     * 存档拒绝删除；force=true 显式跳过链保护（后继存档恢复时按断链处理）。
     */
    async deleteCheckpoint(
        cwd: string | undefined,
        checkpointId: string,
        options?: { force?: boolean; signal?: AbortSignal }
    ): Promise<CheckpointDeleteOutcome> {
        const roots = this.resolveRuntimeRoots(cwd);
        const conversationId = roots[0]?.id ?? '';
        try {
            return await this.lockManager.runExclusive(
                roots.map(root => root.id),
                'delete',
                `checkpoint:${conversationId}:${checkpointId}:delete:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                async () => {
                    const deleted = await this.deletionService.deleteCheckpointInternal(conversationId, checkpointId, {
                        force: options?.force === true
                    });
                    if (deleted) {
                        return { success: true, deleted: true };
                    }
                    const records = await this.store.getCheckpointRecords(conversationId);
                    const exists = records.some(cp => cp.id === checkpointId);
                    return {
                        success: false,
                        deleted: false,
                        ...(exists
                            ? { rejected: 'Checkpoint is referenced as a base snapshot by another checkpoint (chain protection); pass force=true to delete anyway' }
                            : { reason: 'Checkpoint not found' })
                    };
                },
                options?.signal
            );
        } catch (err) {
            if ((err as Error)?.message === CHECKPOINT_LOCK_CANCELLED_MESSAGE || (options?.signal)?.aborted) {
                return { success: false, deleted: false, reason: 'cancelled' };
            }
            error('Failed to delete checkpoint:', err);
            return { success: false, deleted: false, reason: err instanceof Error ? err.message : 'Unknown error' };
        }
    }

    // ==================== checkpoint_gc ====================

    /**
     * Blob GC（独立 dry-run 优先操作，§7.6）：
     * - 以 manifests 目录为权威源重算 blob 引用计数（调和 blobRefs.json）；
     * - 只处理 refcount=0 且超过 grace period（blobGracePeriodDays）的 blob；
     * - 经工作区级锁与 restore/create/delete 互斥；
     * - dryRun=true（默认）只列出待删 blob，不删除任何文件。
     */
    async collectGarbage(
        cwd: string | undefined,
        options?: { dryRun?: boolean; signal?: AbortSignal }
    ): Promise<CheckpointGcResult> {
        const roots = this.resolveRuntimeRoots(cwd);
        const conversationId = roots[0]?.id ?? '';
        const dryRun = options?.dryRun !== false; // dry-run 优先
        const graceMs = this.config.blobGracePeriodDays > 0
            ? this.config.blobGracePeriodDays * 24 * 60 * 60 * 1000
            : 0;

        const fail = (issue: string): CheckpointGcResult => ({
            dryRun,
            removedBlobs: [],
            removedBytes: 0,
            pendingBlobs: [],
            refsVerified: 0,
            issue
        });

        try {
            return await this.lockManager.runExclusive(
                roots.map(root => root.id),
                'delete',
                `checkpoint:${conversationId}:gc:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                async () => {
                    const storage = this.workspaceStorageFor(conversationId);
                    await storage.blobs.initialize();
                    const refs = await storage.blobs.readRefs();
                    // 权威引用计数：扫描 manifests（domain 记录与磁盘的调和基准）
                    const authoritative = await this.computeAuthoritativeBlobCounts(storage.manifests);
                    const { hashes, invalidNames } = await storage.blobs.listBlobs();

                    // 调和 blobRefs.json：count 以 manifests 为准，orphanedAt 保留已有归零时刻
                    const reconciled: Record<string, { count: number; orphanedAt?: number }> = {};
                    for (const hash of hashes) {
                        const count = authoritative.get(hash) ?? 0;
                        const prev = refs[hash];
                        reconciled[hash] = {
                            count,
                            orphanedAt: count === 0 ? (prev?.orphanedAt ?? undefined) : undefined
                        };
                    }

                    const now = Date.now();
                    const pending: CheckpointGcResult['pendingBlobs'] = [];
                    const toRemove: string[] = [];
                    const orphans = hashes.filter(hash => (authoritative.get(hash) ?? 0) === 0);
                    for (const hash of orphans.sort()) {
                        const orphanedSince = reconciled[hash]?.orphanedAt ?? await storage.blobs.blobMtimeMs(hash);
                        const ageMs = now - orphanedSince;
                        if (graceMs <= 0 || ageMs >= graceMs) {
                            toRemove.push(hash);
                        } else {
                            pending.push({ hash, orphanedSince, ageMs });
                        }
                    }

                    let removedBytes = 0;
                    if (!dryRun) {
                        for (const hash of toRemove) {
                            throwIfAborted(options?.signal);
                            const size = await storage.blobs.blobSize(hash);
                            if (await storage.blobs.removeBlob(hash)) {
                                removedBytes += size;
                                delete reconciled[hash];
                            }
                        }
                        await storage.blobs.reconcileRefs(reconciled);
                    }

                    log('collect_garbage', {
                        workspace: conversationId,
                        dryRun,
                        removed: toRemove.length,
                        pending: pending.length,
                        refsVerified: hashes.length
                    });

                    return {
                        dryRun,
                        removedBlobs: toRemove,
                        removedBytes,
                        pendingBlobs: pending,
                        refsVerified: hashes.length,
                        ...(invalidNames.length > 0
                            ? { issue: `invalid blob filenames found: ${invalidNames.join(', ')}` }
                            : {})
                    };
                },
                options?.signal
            );
        } catch (err) {
            if ((err as Error)?.message === CHECKPOINT_LOCK_CANCELLED_MESSAGE || (options?.signal)?.aborted) {
                return { ...fail('cancelled') };
            }
            error('Failed to collect garbage:', err);
            return fail(err instanceof Error ? err.message : 'Unknown error');
        }
    }

    /** 权威 blob 引用计数：扫描工作区 manifests 中全部 files 映射 */
    private async computeAuthoritativeBlobCounts(manifests: CheckpointManifestRepository): Promise<Map<string, number>> {
        const counts = new Map<string, number>();
        let names: string[];
        try {
            names = await fs.readdir(path.join(manifests.workspaceDir, 'manifests'));
        } catch {
            return counts; // manifests 目录不存在 = 无引用
        }
        for (const name of names) {
            if (!name.endsWith('.json')) {
                continue;
            }
            const cpId = name.slice(0, -'.json'.length);
            if (!isSafeCheckpointDirName(cpId)) {
                continue;
            }
            const manifest = await manifests.loadManifest(cpId);
            if (!manifest) {
                continue;
            }
            for (const entry of Object.values(manifest.files)) {
                if (!isSafeBlobHash(entry.hash)) {
                    continue;
                }
                counts.set(entry.hash, (counts.get(entry.hash) ?? 0) + 1);
            }
        }
        return counts;
    }

    // ==================== checkpoint_verify ====================

    /**
     * 只读校验：manifest 存在且自洽、blob 存在且内容哈希与寻址键一致、
     * 增量链完整性（环检测 + 链上 manifest 存在性）。不修改任何文件。
     */
    async verifyCheckpoint(checkpointId: string): Promise<CheckpointVerifyResult> {
        const issues: string[] = [];
        let checkedFiles = 0;
        let chainLength = 0;
        let filesRevisionPaired = false;

        if (!isSafeCheckpointDirName(checkpointId)) {
            issues.push(`Unsafe checkpoint id: ${checkpointId}`);
            return { ok: false, checkpointId, issues, checkedFiles, chainLength, filesRevisionPaired };
        }

        // 记录（跨工作区查找；缺失不影响 manifest 级校验）
        const records = await this.store.readAllRecords();
        const record = records.find(cp => cp.id === checkpointId);
        if (!record) {
            issues.push('Checkpoint record not found in records.json');
        }

        // manifest：先按记录所在工作区定位；无记录时扫描各工作区 manifests
        let manifest: CheckpointManifest | null = null;
        let manifestWorkspace: string | undefined;
        if (record) {
            manifest = await this.workspaceStorageFor(record.conversationId).manifests.loadManifest(checkpointId);
            if (manifest) {
                manifestWorkspace = record.conversationId;
            }
        }
        if (!manifest) {
            const workspaceNames = (await fs.readdir(this.checkpointsDir).catch(() => [])).filter(name =>
                isSafeCheckpointDirName(name)
            );
            for (const name of workspaceNames) {
                const found = await this.workspaceStorageFor(name).manifests.loadManifest(checkpointId);
                if (found) {
                    manifest = found;
                    manifestWorkspace = name;
                    break;
                }
            }
        }
        if (!manifest) {
            issues.push('manifest missing, unreadable, or invalid');
            return { ok: false, checkpointId, issues, checkedFiles, chainLength, filesRevisionPaired };
        }
        if (record && manifestWorkspace && manifestWorkspace !== record.conversationId) {
            issues.push('manifest located in a different workspace than the record');
        }
        // 单文件 manifest 布局：加载成功即自洽（配对语义随双文件布局移除）
        filesRevisionPaired = true;

        // 逐文件校验 blob：存在性 + 内容哈希与寻址键一致
        const blobs = manifestWorkspace ? this.workspaceStorageFor(manifestWorkspace).blobs : undefined;
        for (const [scopedPath, entry] of Object.entries(manifest.files)) {
            if (!blobs) {
                issues.push(`blob pool unavailable: ${scopedPath}`);
                break;
            }
            try {
                const hash = await hashFileStreaming(blobs.blobPath(entry.hash));
                checkedFiles += 1;
                if (hash !== entry.hash) {
                    issues.push(`hash mismatch: ${scopedPath} (expected ${entry.hash}, got ${hash})`);
                }
            } catch {
                issues.push(`blob missing: ${scopedPath} (${entry.hash})`);
            }
        }

        // 增量链完整性：base 索引 + 环检测（broken 即失败）+ 链上 manifest 存在性
        if (record) {
            const { chain, broken } = this.getChainRecords(records, record);
            chainLength = chain.length;
            if (broken) {
                issues.push('Incremental chain is broken (missing or cyclic baseCheckpointId)');
            }
            for (const cp of chain) {
                if (!isSafeCheckpointDirName(cp.backupDir)) {
                    issues.push(`Unsafe backupDir on chain node ${cp.id}: ${cp.backupDir}`);
                    continue;
                }
                const nodeManifest = await this.workspaceStorageFor(cp.conversationId).manifests.loadManifest(cp.id);
                if (!nodeManifest) {
                    issues.push(`Chain node manifest missing: ${cp.id}`);
                }
            }
        }

        return { ok: issues.length === 0, checkpointId, issues, checkedFiles, chainLength, filesRevisionPaired };
    }

    // ==================== 恢复辅助（源 CheckpointRestoreService 移植） ====================

    /** 为某个根目录创建检查点忽略解析器（当前规则口径，与快照构建同一四层排除模型） */
    private createIgnoreResolver(rootDir: string): CheckpointIgnoreResolver {
        return new CheckpointIgnoreResolver(rootDir, this.config.excludePatterns, {
            enabledProfiles: this.config.excludeProfiles,
            profilePatterns: undefined,
            excludeAbsolutePaths: [path.dirname(this.checkpointsDir)]
        });
    }

    /**
     * 基于「当前工作区规则」过滤检查点目标状态。
     * 无法解析的键跳过，不恢复该路径。
     */
    private async filterRestoreTargetScoped(
        fileHashes: Record<string, string>,
        emptyDirs: string[],
        roots: readonly RuntimeWorkspaceRoot[]
    ): Promise<{ fileHashes: Record<string, string>; emptyDirs: string[] }> {
        const resolvers = new Map<string, CheckpointIgnoreResolver>();
        const getResolver = (root: RuntimeWorkspaceRoot): CheckpointIgnoreResolver => {
            let resolver = resolvers.get(root.id);
            if (!resolver) {
                resolver = this.createIgnoreResolver(root.fsPath);
                resolvers.set(root.id, resolver);
            }
            return resolver;
        };

        const filteredFileHashes: Record<string, string> = {};
        const fileTargets = Object.entries(fileHashes).map(([rawKey, hash]) => ({ rawKey, hash }));
        await runBounded(fileTargets, DEFAULT_CHECKPOINT_CONCURRENCY, async ({ rawKey, hash }) => {
            const scopedKey = toScopedKey(rawKey, roots);
            try {
                const parsed = parseWorkspaceScopedPath(scopedKey, roots as RuntimeWorkspaceRoot[]);
                if (!(await getResolver(parsed.root).isIgnored(parsed.relativePath, false))) {
                    filteredFileHashes[scopedKey] = hash;
                }
            } catch (err) {
                warn(`Skip unparsable checkpoint path ${scopedKey}:`, err);
            }
        });

        const emptyDirResults: Array<string | undefined> = new Array(emptyDirs.length);
        const dirTargets = emptyDirs.map((rawKey, idx) => ({ rawKey, idx }));
        await runBounded(dirTargets, DEFAULT_CHECKPOINT_CONCURRENCY, async ({ rawKey, idx }) => {
            const scopedKey = toScopedKey(rawKey, roots);
            try {
                const parsed = parseWorkspaceScopedPath(scopedKey, roots as RuntimeWorkspaceRoot[]);
                if (!(await getResolver(parsed.root).isIgnored(parsed.relativePath, true))) {
                    emptyDirResults[idx] = scopedKey;
                }
            } catch (err) {
                warn(`Skip unparsable checkpoint dir ${scopedKey}:`, err);
            }
        });
        const filteredEmptyDirs: string[] = emptyDirResults.filter((key): key is string => key !== undefined);

        return { fileHashes: filteredFileHashes, emptyDirs: filteredEmptyDirs };
    }

    /** 收集当前工作区的文件哈希与空目录（scoped 键；与目标过滤同一 ignore 口径） */
    private async collectCurrentWorkspaceState(
        roots: readonly RuntimeWorkspaceRoot[]
    ): Promise<{ currentHashes: Record<string, string>; currentEmptyDirs: string[] }> {
        const currentHashes: Record<string, string> = {};
        const currentEmptyDirs: string[] = [];
        const hashTargets: Array<{ filePath: string; scopedPath: string }> = [];
        for (const root of roots) {
            const resolver = this.createIgnoreResolver(root.fsPath);
            const { files, dirs } = await resolver.collectEntries();
            for (const file of files) {
                const relativePath = path.relative(root.fsPath, file).replace(/\\/g, '/');
                hashTargets.push({ filePath: file, scopedPath: createWorkspaceScopedPath(root.id, relativePath) });
            }
            for (const dir of dirs) {
                const relativePath = path.relative(root.fsPath, dir).replace(/\\/g, '/');
                currentEmptyDirs.push(createWorkspaceScopedPath(root.id, relativePath));
            }
        }
        await runBounded(hashTargets, DEFAULT_CHECKPOINT_CONCURRENCY, async ({ filePath, scopedPath }) => {
            try {
                const hash = await hashFileStreaming(filePath);
                if (hash) {
                    currentHashes[scopedPath] = hash;
                }
            } catch {
                // 读取失败（文件被删/权限）的文件跳过，不进入 currentHashes
            }
        });
        return { currentHashes, currentEmptyDirs };
    }

    /** 文件集聚合摘要（preview 基线 / manifest contentHash 共用口径：scopedPath+hash 排序后 sha256） */
    private digestOfHashes(fileHashes: Record<string, string>): string {
        const builder = crypto.createHash('sha256');
        let first = true;
        for (const scopedPath of Object.keys(fileHashes).sort()) {
            if (!first) {
                builder.update('\n');
            }
            first = false;
            builder.update(`${scopedPath}\n${fileHashes[scopedPath]}`);
        }
        return builder.digest('hex');
    }

    /** 把 scoped 失败路径转为相对路径展示；解析失败时保留原值 */
    toDisplayPath(scopedKey: string, roots: readonly RuntimeWorkspaceRoot[]): string {
        try {
            return parseWorkspaceScopedPath(scopedKey, roots as RuntimeWorkspaceRoot[]).relativePath;
        } catch {
            return scopedKey;
        }
    }

    /** 把存档记录的 unbackedPaths（scoped 键）批量转为显示路径（上限 50 条） */
    toDisplayUnbackedPaths(
        unbackedPaths: string[] | undefined,
        roots: readonly RuntimeWorkspaceRoot[]
    ): string[] | undefined {
        if (!unbackedPaths || unbackedPaths.length === 0) {
            return undefined;
        }
        const displayed = unbackedPaths.map(pathKey => this.toDisplayPath(pathKey, roots));
        return displayed.length > 50 ? displayed.slice(0, 50) : displayed;
    }

    /** 把失败清单压缩成单行摘要（超出 5 条时截断并计数） */
    formatFailureSummary(failures: RestoreFailure[]): string {
        const shown = failures.slice(0, 5).map(f => `${f.path}: ${f.reason}`).join('; ');
        const rest = failures.length - 5;
        return rest > 0 ? `${shown}; ${rest} more failure(s)` : shown;
    }

    /** EX-11: 构建恢复时的排除说明（快照规则 vs 当前规则） */
    private buildExcludedNote(manifest: CheckpointManifest | undefined): CheckpointExcludedNote | undefined {
        if (!manifest) {
            return undefined;
        }
        const excludedCount = manifest.excluded.length;
        if (excludedCount === 0) {
            return undefined;
        }
        const snapshotRules = manifest.ignoreSnapshot;
        const currentRules = buildIgnoreSnapshot({
            enabledProfiles: this.config.excludeProfiles,
            maxFileSizeBytes: this.config.maxFileSizeBytes,
            customPatterns: this.config.excludePatterns
        });
        const rulesChanged =
            snapshotRules.maxFileSizeBytes !== currentRules.maxFileSizeBytes ||
            snapshotRules.customPatterns.join('\n') !== currentRules.customPatterns.join('\n') ||
            serializeEnabledProfiles(snapshotRules.enabledProfiles) !== serializeEnabledProfiles(currentRules.enabledProfiles) ||
            serializeProfilePatterns(snapshotRules.profilePatterns) !== serializeProfilePatterns(currentRules.profilePatterns) ||
            snapshotRules.version !== currentRules.version ||
            snapshotRules.forcedRulesVersion !== currentRules.forcedRulesVersion ||
            snapshotRules.defaultProfileVersion !== currentRules.defaultProfileVersion;
        const message = rulesChanged
            ? `${excludedCount} file(s) were excluded when this checkpoint was created, and the current exclusion rules differ from the snapshot rules`
            : `${excludedCount} file(s) were excluded when this checkpoint was created (they will not be restored or deleted)`;
        return { excludedCount, rulesChanged, message, snapshotRules, currentRules };
    }

    // ==================== 操作进度注册表（CheckpointDeletionService 依赖） ====================

    private beginOperation(
        kind: CheckpointOperationProgress['kind'],
        conversationId?: string,
        checkpointId?: string
    ): { operationId: string; signal: AbortSignal; report: (patch: Partial<CheckpointOperationProgress>) => CheckpointOperationProgress | null } {
        const operationId = `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const controller = new AbortController();
        const record = {
            progress: {
                operationId,
                kind,
                conversationId,
                checkpointId,
                phase: 'pending',
                processed: 0,
                total: 0,
                cancelled: false,
                startedAt: Date.now(),
                updatedAt: Date.now()
            } satisfies CheckpointOperationProgress,
            controller
        };
        this.operations.set(operationId, record);
        return {
            operationId,
            signal: controller.signal,
            report: patch => {
                const live = this.operations.get(operationId);
                if (!live) {
                    return null;
                }
                live.progress = { ...live.progress, ...patch, updatedAt: Date.now() };
                return live.progress;
            }
        };
    }

    private endOperation(operationId: string): void {
        const record = this.operations.get(operationId);
        if (record) {
            record.controller.abort();
        }
        this.operations.delete(operationId);
    }
}

/**
 * 记录存储实现：`<dataRoot>/checkpoints/records.json`（简单 JSON 数组，按 workspace-id 隔离）。
 *
 * 原子写：写 tmp + rename；写串行链保证并发更新不互相覆盖（源
 * withMetadataWriteSerialized 语义）。conversationId = 工作区根 id（cwd 派生）。
 */
class RecordStoreImpl implements CheckpointRecordMetadataStore {
    constructor(private readonly service: CheckpointService) {}

    /** 读取全部记录（跨工作区）；文件缺失/损坏返回空数组 */
    async readAllRecords(): Promise<CheckpointRecord[]> {
        try {
            const raw = await fs.readFile(this.service.recordsFile, 'utf-8');
            const parsed = JSON.parse(raw) as unknown;
            return Array.isArray(parsed) ? parsed as CheckpointRecord[] : [];
        } catch {
            return [];
        }
    }

    /** 原子写回：写 tmp + rename */
    private async writeAllRecords(records: CheckpointRecord[]): Promise<void> {
        await fs.mkdir(path.dirname(this.service.recordsFile), { recursive: true });
        const tmpPath = `${this.service.recordsFile}.tmp`;
        await fs.writeFile(tmpPath, JSON.stringify(records, null, 2), 'utf-8');
        await fs.rename(tmpPath, this.service.recordsFile);
    }

    /** 链内原子更新（串行化；updater 返回原引用 = 无变更跳过写回） */
    private updateAllRecords(
        updater: (current: CheckpointRecord[]) => CheckpointRecord[] | Promise<CheckpointRecord[]>
    ): Promise<CheckpointRecord[]> {
        const run = this.service.recordsWriteChain.then(async () => {
            const current = await this.readAllRecords();
            const next = await updater(current);
            if (next !== current) {
                await this.writeAllRecords(next);
            }
            return next;
        });
        this.service.recordsWriteChain = run.catch(() => undefined);
        return run;
    }

    /** 工作区隔离：只暴露该 conversationId 的记录 */
    private scoped(records: CheckpointRecord[], conversationId: string): CheckpointRecord[] {
        return records.filter(record => record.conversationId === conversationId);
    }

    /** 读取该工作区的存档记录列表 */
    getCheckpointRecords(conversationId: string): Promise<CheckpointRecord[]> {
        return this.readAllRecords().then(records => this.scoped(records, conversationId));
    }

    async getCustomMetadata(conversationId: string, key: 'checkpoints'): Promise<unknown> {
        if (key !== 'checkpoints') {
            return undefined;
        }
        return this.getCheckpointRecords(conversationId);
    }

    async updateCustomMetadata(
        conversationId: string,
        key: 'checkpoints',
        updater: (current: unknown) => unknown | Promise<unknown>
    ): Promise<unknown> {
        if (key !== 'checkpoints') {
            return undefined;
        }
        return this.updateAllRecords(async current => {
            const scoped = this.scoped(current, conversationId);
            const next = await updater(scoped);
            if (next === scoped) {
                return current; // 无变更：跳过写回（原引用判定）
            }
            if (!Array.isArray(next)) {
                return current; // fail-closed：写回被拒
            }
            const nextList = next as CheckpointRecord[];
            const others = current.filter(record => record.conversationId !== conversationId);
            return [...others, ...nextList];
        }).then(all => {
            const conversationRecords = this.scoped(all, conversationId);
            return conversationRecords;
        });
    }

    /** 直接更新该工作区的记录列表（create 路径使用） */
    async updateCheckpoints(
        conversationId: string,
        updater: (current: CheckpointRecord[]) => CheckpointRecord[]
    ): Promise<CheckpointRecord[]> {
        return this.updateAllRecords(current => {
            const scoped = this.scoped(current, conversationId);
            const next = updater(scoped);
            if (next === scoped) {
                return current;
            }
            const others = current.filter(record => record.conversationId !== conversationId);
            return [...others, ...next];
        });
    }
}

/** 规范化序列化 enabledProfiles：键排序后比较，忽略对象键顺序差异（M-4） */
function serializeEnabledProfiles(profiles: Record<string, boolean>): string {
    return Object.entries(profiles)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => `${key}:${value}`)
        .join('|');
}

/** 规范化序列化 profilePatterns（键排序后比较；空数组条目跳过） */
function serializeProfilePatterns(patterns: Record<string, string[]> | undefined): string {
    if (!patterns) {
        return '';
    }
    return Object.entries(patterns)
        .filter(([, list]) => list.length > 0)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, list]) => `${id}:${list.join('\n')}`)
        .join('\u0000');
}
