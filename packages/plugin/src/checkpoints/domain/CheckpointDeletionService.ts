/**
 * CheckpointDeletionService - 检查点删除族（第二批拆分）。
 *
 * 从 CheckpointManager 收敛的 4 个删除方法（deleteCheckpointInternal /
 * deleteCheckpointsFromIndexInternal / deleteCheckpointsBatch /
 * deleteCheckpointsByNodeIds），方法体原样平移，纯重构：
 * - 「强制保留祖先闭包」统一复用 computeForcedKeepIds（原
 *   deleteCheckpointsFromIndexInternal 内联复制了一份相同闭包逻辑，现收敛为同一实现）；
 * - isSafeCheckpointDirName 校验（CP-DEL-1）、引用计数闸门（deleteCheckpointsByNodeIds）、
 *   级联/「写回成功后才删盘」语义与旧实现完全一致；
 * - 锁（CheckpointOperationLock）获取位置随方法体平移（batch/byNodeIds 原方法内获取），
 *   无锁 Internal 版仍由调用方保证已持有工作区级存档锁；
 * - M5：batch/byNodeIds 持锁键 = 壳层锁键 ∪ 对话工作区键（deletionLockIds），与单删/
 *   创建/恢复的工作区根键互斥；壳层应注入与创建/恢复同一 lockDir 的 lockManager。
 *
 * 依赖经 deps 注入（conversationManager / getStorage（每工作区 manifest 仓库 + blob 池）/
 * 删除锁 ID / 操作进度注册表 / 取消错误判定），避免反向引用 CheckpointManager
 * 造成运行时循环依赖。磁盘清理（内容寻址布局）：删除只减 blob 引用 + 删 manifest，
 * blob 物理回收由独立 GC（refcount=0 且超过 grace period）负责，删除路径不删 blob。
 */

import type { CheckpointRecordMetadataStore } from './recordStore.ts';
import type {
    BatchCheckpointDeleteItem,
    BatchCheckpointDeleteResult,
    CheckpointOperationProgress,
    CheckpointRecord
} from './types.ts';
import { isSafeCheckpointDirName } from './CheckpointManifestRepository.ts';
import type { CheckpointManifestRepository } from './CheckpointManifestRepository.ts';
import type { BlobStore } from './BlobStore.ts';
import { checkpointOperationLockManager, type CheckpointOperationLockManager } from './CheckpointOperationLock.ts';
import { throwIfAborted } from './checkpointConcurrency.ts';

/** 单个工作区的内容寻址存储（manifest 仓库 + blob 池；删除路径的磁盘清理入口） */
export interface CheckpointWorkspaceStorage {
    manifests: CheckpointManifestRepository;
    blobs: BlobStore;
}

/**
 * BCP-06：计算「必须保留」的存档 ID 祖先闭包（CP-05 逻辑抽取，纯函数）。
 *
 * 从所有 keepIds（本次删除集合之外的保留记录）向前遍历完整 baseCheckpointId 祖先链：
 * 被保留记录直接或间接依赖的祖先都不能删（否则保留记录恢复时断链）。
 * 返回集合包含 keepIds 自身 + 全部祖先。
 *
 * 复用方：deleteCheckpointInternal / deleteCheckpointsFromIndexInternal /
 * deleteCheckpointsBatch（CP-05）/ deleteCheckpointsByNodeIds（BCP-06 引用计数删除合并），
 * 保证「引用计数归零但被增量链引用为 base」的存档同样被拒绝。
 */
export function computeForcedKeepIds(
    records: readonly CheckpointRecord[],
    keepIds: ReadonlySet<string>
): Set<string> {
    const byId = new Map(records.map(cp => [cp.id, cp] as const));
    const forcedKeep = new Set<string>();
    for (const cp of records) {
        if (!keepIds.has(cp.id)) {
            continue;
        }
        forcedKeep.add(cp.id);
        let baseId = cp.baseCheckpointId;
        while (baseId && !forcedKeep.has(baseId)) {
            forcedKeep.add(baseId);
            baseId = byId.get(baseId)?.baseCheckpointId;
        }
    }
    return forcedKeep;
}

/** CheckpointDeletionService 依赖（由 CheckpointService 构造时注入） */
export interface CheckpointDeletionServiceDeps {
    conversationManager: CheckpointRecordMetadataStore;
    /** 工作区内容寻址存储入口（删除/驱逐时清理 manifest + 减 blob 引用） */
    getStorage: (conversationId: string) => CheckpointWorkspaceStorage;
    /**
     * 删除族额外锁键（由壳层计算）。M5 约定：批删/按节点删除实际持锁键 =
     * 本方法返回值 ∪ 被删除对话的工作区级键（deletionLockIds）——单删/创建/恢复持
     * 工作区根键，若只持全局虚拟键会互斥失效（删除与创建/恢复并发 → blob 引用竞态
     * 提前回收）。壳层可返回全局虚拟键（跨工作区兜底），工作区级互斥由本服务补齐。
     */
    getDeletionLockIds: () => string[];
    /**
     * M5：跨进程锁管理器（可选）。缺省 = 进程级单例（checkpointOperationLockManager）。
     * 生产壳层应注入与创建/恢复/单删共用同一 lockDir 的实例（CheckpointService 的
     * lockManager）——否则 batch/byNodeIds 在独立锁命名空间内运行，即便键一致也不与
     * 工作区级锁互斥。注入后批删/按节点删与创建/恢复/单删/GC 真正串行。
     */
    lockManager?: CheckpointOperationLockManager;
    /** 注册删除操作进度/取消句柄（壳层 operations 注册表；batch 使用） */
    beginOperation: (
        kind: CheckpointOperationProgress['kind'],
        conversationId?: string,
        checkpointId?: string
    ) => { operationId: string; signal: AbortSignal; report: (patch: Partial<CheckpointOperationProgress>) => CheckpointOperationProgress | null };
    /** 结束删除操作（壳层 operations 注册表） */
    endOperation: (operationId: string) => void;
    /** 文件写锁获取被取消的普通 Error 判定（M4/CP-LOCK-1，壳层私有方法） */
    isFileLockCancellationError: (error: unknown) => boolean;
}

/**
 * 删除后的磁盘清理（内容寻址布局）：读 manifest 取 blob 清单 → 删 manifest →
 * 减 blob 引用（refcount 归零的 blob 由独立 GC 在 grace period 后回收，不在此删除）。
 */
export async function cleanupCheckpointStorage(
    storage: CheckpointWorkspaceStorage,
    checkpointId: string
): Promise<void> {
    const manifest = await storage.manifests.loadManifest(checkpointId);
    if (manifest) {
        const blobHashes = [...new Set(Object.values(manifest.files).map(entry => entry.hash))];
        await storage.blobs.decrementRefs(blobHashes);
    }
    await storage.manifests.deleteManifest(checkpointId);
}

/**
 * 检查点删除服务
 */
export class CheckpointDeletionService {
    constructor(private readonly deps: CheckpointDeletionServiceDeps) {}

    /** M5：实际使用的跨进程锁管理器（壳层注入时与创建/恢复/单删共用同一 lockDir；缺省进程级单例） */
    private get lock(): CheckpointOperationLockManager {
        return this.deps.lockManager ?? checkpointOperationLockManager;
    }

    /**
     * M5：删除操作的完整锁键集合 = 壳层提供的锁键 ∪ 当前对话的工作区级键。
     *
     * 修复前 batch/byNodeIds 只持壳层全局虚拟键（如 'checkpoint-global-storage'），而
     * 单删/创建/恢复持工作区根键（roots.map(root => root.id)）——两者不互斥：删除与
     * 创建/恢复可在同一工作区并发，refcount 增减竞态导致 blob 提前回收。conversationId
     * 在本模块即工作区 id（conversationIdFor 返回根 id，records 按工作区 id 隔离），
     * 追加该键后与创建/恢复/单删/GC 共用同一把工作区级锁。多根工作区（DSH 下恒单根）
     * 时创建/恢复持全部根键，本方法只追加对话主键——需覆盖多根时由壳层在
     * getDeletionLockIds 中返回全部根键（约定见 deps 注释）。
     */
    private deletionLockIds(conversationId: string): string[] {
        const shellProvided = this.deps.getDeletionLockIds();
        if (!conversationId || conversationId.length === 0) {
            return [...shellProvided];
        }
        return [...shellProvided, conversationId];
    }

    /**
     * 无锁删除检查点（调用方必须已持有工作区级存档锁）。
     *
     * 供 cleanupOldCheckpoints 等锁内链路复用：createCheckpoint 的锁内
     * 清理旧存档时若再走公开方法，会以不同 ownerId 等待自己持有的锁而死锁。
     *
     * @param options.force 显式跳过链保护（computeForcedKeepIds 祖先闭包闸门）；
     *   供 force 删除路径复用同一实现（越界 backupDir 仍拒绝）。
     */
    async deleteCheckpointInternal(
        conversationId: string,
        checkpointId: string,
        options?: { force?: boolean }
    ): Promise<boolean> {
        // 元数据更新（读-判-算保留集合）在链内原子完成；磁盘清理放在写回成功之后，
        // 此时竞态窗口已收敛，不会出现「读到旧列表 → 删磁盘 → 覆盖他人新写入」的丢记录场景。
        let removedCheckpointId: string | undefined;
        try {
            const result = await this.deps.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                const checkpoint = list.find(cp => cp.id === checkpointId);
                if (!checkpoint) {
                    return current; // 不存在：原引用=无变更跳过写回
                }
                // CP-DEL-1: 损坏/恶意元数据中的 backupDir 可能越界（如 `../../victim`），
                // 绝不把未校验目录名交给文件操作——拒绝删除并告警，记录保留。
                if (!isSafeCheckpointDirName(checkpoint.backupDir)) {
                    console.warn(`[CheckpointManager] Refusing to delete checkpoint ${checkpointId}: unsafe backupDir ${checkpoint.backupDir}`);
                    return current;
                }
                // CP-05: 被其他检查点引用为基快照时拒绝删除（返回原引用=无变更跳过写回），
                // 否则会破坏增量链，恢复时 chainBroken 100% 失败。
                // 口径与 deleteCheckpointsBatch / deleteCheckpointsByNodeIds 统一：
                // computeForcedKeepIds 祖先闭包（含间接引用）——直接引用检查只覆盖一层，
                // 链 A→B→C 删除 C 时 A 只被 B 间接依赖，闭包口径保证与批量删除的
                // 强制保留集合一致。force=true 显式跳过本闸门。
                if (options?.force !== true) {
                    const keepIds = new Set(list.filter(cp => cp.id !== checkpointId).map(cp => cp.id));
                    if (computeForcedKeepIds(list, keepIds).has(checkpointId)) {
                        return current;
                    }
                }
                removedCheckpointId = checkpointId;
                return list.filter(cp => cp.id !== checkpointId);
            });
            void result;
        } catch (err) {
            // C-17: 元数据写回失败是真实存储/IO 错误（区别于「记录不存在/被拒绝」返回 false 的
            // 正常路径），显式记录后返回 false，不冒泡；调用方据此区分「不存在」与「IO 失败」。
            console.error(`[CheckpointManager] Failed to delete checkpoint ${checkpointId} (metadata write failed):`, err);
            return false;
        }

        if (removedCheckpointId === undefined) {
            // 未删除：记录不存在 / 被引用为基快照 / backupDir 越界（以上路径已分别处理或告警）
            return false;
        }

        // 内容寻址布局：删除只减 blob 引用 + 删 manifest（blob 由独立 GC 回收）
        await cleanupCheckpointStorage(this.deps.getStorage(conversationId), removedCheckpointId);

        return true;
    }

    /**
     * 无锁版 deleteCheckpointsFromIndex（调用方必须已持有工作区级存档锁）。
     *
     * @param lineageNodeIds BCP-08 分支隔离：当前编辑分支（主历史活跃路径）在 fromIndex 之后的
     *   节点 id 集合。提供时，带 messageNodeId 的候选必须属于该 lineage 才删除——分支 A 编辑消息
     *   时，分支 B 中 messageIndex >= fromIndex 的存档（messageNodeId 指向 B 的节点）不被误删；
     *   缺省（undefined）时跳过分支过滤闸门，保持按索引删除的旧语义（与 deleteCheckpointsByNodeIds
     *   缺省 referenceCounts 跳过引用计数闸门同模式）。无 messageNodeId 的旧存档（无法判断分支归属）
     *   始终按索引删除。
     */
    async deleteCheckpointsFromIndexInternal(
        conversationId: string,
        fromIndex: number,
        excludeCheckpointId?: string,
        lineageNodeIds?: Set<string>
    ): Promise<number> {
        try {
            // 计算与写回在链内原子完成（基于最新列表），磁盘清理放在写回成功之后
            let toDelete: CheckpointRecord[] = [];
            await this.deps.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                const checkpoints = Array.isArray(current) ? current as CheckpointRecord[] : [];
                const byId = new Map(checkpoints.map(cp => [cp.id, cp] as const));

                // 需要保留的检查点 ID 集合：目标检查点及其增量基链（否则保留的检查点会因基快照被删而无法恢复）
                // + 消息索引在保留区间内（messageIndex < fromIndex）的节点。
                const keepIds = new Set<string>();
                if (excludeCheckpointId) {
                    let cur = byId.get(excludeCheckpointId);
                    while (cur && !keepIds.has(cur.id)) {
                        keepIds.add(cur.id);
                        cur = cur.baseCheckpointId ? byId.get(cur.baseCheckpointId) : undefined;
                    }
                }
                for (const cp of checkpoints) {
                    if (cp.messageIndex < fromIndex) {
                        keepIds.add(cp.id);
                    }
                }

                // CP-IDX-1: 祖先闭包——从所有保留节点向前遍历完整祖先链，被依赖的基快照
                // 即使消息索引 >= fromIndex 也强制保留。
                // 编辑/回档/重试会让消息索引回退：B(index=10) → 截断对话 → 重试产生
                // R(index=3, base=B) → 再次截断到 fromIndex=4 时，仅按索引判断会删 B 而留 R →
                // R 的 baseCheckpointId 悬空（chainBroken 且无法修复）。
                // 闭包与 deleteCheckpointsBatch 的 CP-05 口径一致。
                const forcedKeep = computeForcedKeepIds(checkpoints, keepIds);

                // 筛选出需要删除的检查点（消息索引 >= fromIndex、不在保留闭包中、backupDir 安全）
                toDelete = checkpoints.filter(cp => {
                    if (cp.messageIndex < fromIndex || forcedKeep.has(cp.id)) {
                        return false;
                    }
                    // BCP-08 分支隔离：提供 lineage 时，带 messageNodeId 的候选必须属于当前分支
                    // lineage（主历史活跃路径节点）——其他分支共享 messageIndex 的存档保留；
                    // 无 messageNodeId 的旧存档无法判断分支归属，保持按索引删除的旧语义。
                    if (lineageNodeIds && cp.messageNodeId && !lineageNodeIds.has(cp.messageNodeId)) {
                        return false;
                    }
                    // CP-DEL-1: 未校验目录名绝不删除（记录保留 + 告警）
                    if (!isSafeCheckpointDirName(cp.backupDir)) {
                        console.warn(`[CheckpointManager] Refusing to delete checkpoint ${cp.id}: unsafe backupDir ${cp.backupDir}`);
                        return false;
                    }
                    return true;
                });
                if (toDelete.length === 0) {
                    return current; // 无变更，跳过写回
                }
                // 保留：索引保留区 + 强制保留闭包 + backupDir 越界被拒绝删除的记录
                const toDeleteIds = new Set(toDelete.map(cp => cp.id));
                return checkpoints.filter(cp => !toDeleteIds.has(cp.id));
            });

            // 写回成功后才清理：减 blob 引用 + 删 manifest（blob 由独立 GC 回收）
            const storage = this.deps.getStorage(conversationId);
            for (const cp of toDelete) {
                await cleanupCheckpointStorage(storage, cp.id);
            }
            
            return toDelete.length;
            
        } catch (err) {
            console.error('[CheckpointManager] Failed to delete checkpoints from index:', err);
            return 0;
        }
    }

    /**
     * 批量删除多个对话的检查点（支持跨对话）
     *
     * 遵循与单删一致的增量链保护规则：被「不在本次删除集合内」的检查点
     * 引用为基快照（baseCheckpointId）时，拒绝删除该检查点；
     * 批量删除整条链（基与后继都在删除集合内）时不受此限制。
     *
     * @param items 每个对话的删除请求；checkpointIds 为空数组时表示删除该对话全部检查点
     */
    async deleteCheckpointsBatch(items: BatchCheckpointDeleteItem[]): Promise<BatchCheckpointDeleteResult[]> {
        const results: BatchCheckpointDeleteResult[] = [];

        for (const item of items) {
            const result: BatchCheckpointDeleteResult = {
                conversationId: item.conversationId,
                deletedIds: [],
                rejectedIds: [],
                success: false
            };

            // M7: 每个对话注册进度/取消句柄（设置页批量删除可展示进度并取消）
            const { operationId, signal, report } = this.deps.beginOperation('delete', item.conversationId);
            try {
                await this.lock.runExclusive(
                    this.deletionLockIds(item.conversationId),
                    'delete',
                    `checkpoint:${item.conversationId}:delete-batch:${operationId}`,
                    async () => {
                        // 计算与写回在链内原子完成；磁盘清理放在写回成功之后
                        let toDeleteIdsForCleanup: string[] = [];
                        await this.deps.conversationManager.updateCustomMetadata(item.conversationId, 'checkpoints', current => {
                            const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                            if (list.length === 0) {
                                return current; // 无变更，跳过写回
                            }

                            // 空 ID 列表 = 删除该对话全部检查点
                            const deleteSet = new Set(
                                item.checkpointIds.length === 0 ? list.map(cp => cp.id) : item.checkpointIds
                            );

                            // CP-05: 闭包计算强制保留集合（BCP-06 抽取为 computeForcedKeepIds）——
                            // 从所有保留节点向前遍历完整祖先链，被保留节点直接或间接依赖的祖先
                            // 都不能删（否则保留节点恢复时断链）。
                            // 旧实现只检查一层直接引用：链 A→B→C 删除 {A,B} 时 A 被删而 B 保留 → B 断链。
                            const keepIds = new Set(list.filter(cp => !deleteSet.has(cp.id)).map(cp => cp.id));
                            const forcedKeep = computeForcedKeepIds(list, keepIds);

                            // 请求删除但被强制保留的 ID 全部拒绝，并返回给前端展示原因
                            const rejectedIds = new Set<string>();
                            for (const id of deleteSet) {
                                if (forcedKeep.has(id)) rejectedIds.add(id);
                            }

                            // CP-DEL-1: backupDir 越界的记录绝不删除（进 rejectedIds 上报前端 + 告警）
                            const toDelete = [...deleteSet].filter(id => !rejectedIds.has(id));
                            for (const id of toDelete) {
                                const cp = list.find(c => c.id === id);
                                if (cp && !isSafeCheckpointDirName(cp.backupDir)) {
                                    console.warn(`[CheckpointManager] Refusing to delete checkpoint ${id}: unsafe backupDir ${cp.backupDir}`);
                                    rejectedIds.add(id);
                                }
                            }

                            result.rejectedIds = [...rejectedIds];
                            // CP-BATCH-1: 请求中不存在的 checkpointId（记录已被并发删除/从未来过）不计入
                            // deletedIds——safeToDelete 先过滤 list 中存在性，避免虚报删除成功。
                            const safeToDelete = toDelete.filter(
                                id => !rejectedIds.has(id) && list.some(cp => cp.id === id)
                            );
                            if (safeToDelete.length === 0) {
                                return current; // 无变更，跳过写回
                            }

                            result.deletedIds = safeToDelete;
                            toDeleteIdsForCleanup = safeToDelete;

                            return list.filter(cp => !safeToDelete.includes(cp.id));
                        });

                        // 写回成功后才清理：减 blob 引用 + 删 manifest（blob 由独立 GC 回收）
                        const storage = this.deps.getStorage(item.conversationId);
                        report({ phase: 'deleting', processed: 0, total: toDeleteIdsForCleanup.length });
                        let deletedCount = 0;
                        for (const cpId of toDeleteIdsForCleanup) {
                            throwIfAborted(signal);
                            await cleanupCheckpointStorage(storage, cpId);
                            deletedCount++;
                            report({ processed: deletedCount });
                        }
                        report({ phase: signal.aborted ? 'cancelled' : 'done', cancelled: signal.aborted });

                        result.success = true;
                    },
                    signal
                );
            } catch (err) {
                // M4: 等待文件写锁期间被取消 → 取消结果（不冒泡）
                if (signal.aborted || this.deps.isFileLockCancellationError(err)) {
                    report({ phase: 'cancelled', cancelled: true });
                } else {
                    console.error(`[CheckpointManager] Failed to delete checkpoints batch for ${item.conversationId}:`, err);
                    report({ phase: 'failed', cancelled: false });
                }
            } finally {
                this.deps.endOperation(operationId);
            }

            results.push(result);
        }

        return results;
    }

    /**
     * BCP-06：按分支节点删除存档（引用计数删除——BranchService purge/prune 物理清理后的联动入口）。
     *
     * 候选 = 本对话中 messageNodeId ∈ nodeIds 的存档记录；旧存档无 messageNodeId 不匹配 → 不误删。
     * 三重拒绝闸门（按序合并进 rejectedIds）：
     * 1. 引用计数：options.referenceCounts 中 refCount > 0 的候选拒绝（仍被其他存活分支节点引用），
     *    除非 options.force = true（force 只跳过引用计数闸门，不跳过链保护）;
     *    缺省 referenceCounts 时跳过本闸门（退化为研究 §5.4 的 nodeId 清理语义，仅链保护）；
     * 2. CP-05 祖先闭包：即使 refCount === 0，被保留存档引用为 base（增量链依赖）的候选也拒绝——
     *    与 deleteCheckpointsBatch 的 rejectedIds 语义合并（BCP-07：增量链共享不因引用计数删除破坏）;
     * 3. CP-DEL-1：backupDir 越界的记录拒绝（绝不把未校验目录名交给 fs.rm）。
     *
     * 写回/删盘与 deleteCheckpointsBatch 同路径：updateCustomMetadata 链内原子写回，
     * 写回成功后才删除备份目录；失败只留孤儿目录，不影响增量链正确性。
     * 锁：工作区级存档锁（delete），调用方必须从会话锁之外发起（锁序约束见 BranchService 头注释）。
     */
    async deleteCheckpointsByNodeIds(
        conversationId: string,
        nodeIds: string[],
        options?: { force?: boolean; referenceCounts?: Map<string, number> }
    ): Promise<BatchCheckpointDeleteResult> {
        const result: BatchCheckpointDeleteResult = {
            conversationId,
            deletedIds: [],
            rejectedIds: [],
            success: false,
        };
        if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
            result.success = true;
            return result;
        }
        try {
            await this.lock.runExclusive(
                this.deletionLockIds(conversationId),
                'delete',
                `checkpoint:${conversationId}:delete-by-node-ids:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                async () => {
                    // 计算与写回在链内原子完成；磁盘清理放在写回成功之后（与 deleteCheckpointsBatch 一致）
                    let toDeleteIdsForCleanup: string[] = [];
                    await this.deps.conversationManager.updateCustomMetadata(conversationId, 'checkpoints', current => {
                        const list = Array.isArray(current) ? current as CheckpointRecord[] : [];
                        if (list.length === 0) {
                            result.success = true;
                            return current; // 无变更，跳过写回
                        }

                        const nodeIdSet = new Set(nodeIds);
                        // 候选：messageNodeId 精确匹配被移除节点（旧存档无 messageNodeId → 不误删）
                        const candidates = list.filter(
                            cp => cp.messageNodeId !== undefined && nodeIdSet.has(cp.messageNodeId)
                        );
                        if (candidates.length === 0) {
                            result.success = true;
                            return current; // 无变更，跳过写回
                        }
                        const candidateIds = new Set(candidates.map(cp => cp.id));
                        const rejectedIds = new Set<string>();

                        // 闸门 1：引用计数（refCount>0 → 拒绝，除非 force）
                        const referenceCounts = options?.referenceCounts;
                        if (!options?.force && referenceCounts) {
                            for (const id of candidateIds) {
                                if ((referenceCounts.get(id) ?? 0) > 0) {
                                    rejectedIds.add(id);
                                }
                            }
                        }

                        // 闸门 2：CP-05 祖先闭包（被保留存档引用为 base → 拒绝，即使 refCount 0）
                        const keepIds = new Set(
                            list.filter(cp => !candidateIds.has(cp.id)).map(cp => cp.id)
                        );
                        const forcedKeep = computeForcedKeepIds(list, keepIds);
                        for (const id of candidateIds) {
                            if (forcedKeep.has(id)) {
                                rejectedIds.add(id);
                            }
                        }

                        // 闸门 3：CP-DEL-1 backupDir 越界 → 拒绝 + 告警
                        const toDelete = [...candidateIds].filter(id => !rejectedIds.has(id));
                        for (const id of toDelete) {
                            const cp = list.find(c => c.id === id);
                            if (cp && !isSafeCheckpointDirName(cp.backupDir)) {
                                console.warn(`[CheckpointManager] Refusing to delete checkpoint ${id}: unsafe backupDir ${cp.backupDir}`);
                                rejectedIds.add(id);
                            }
                        }

                        result.rejectedIds = [...rejectedIds];
                        const safeToDelete = toDelete.filter(id => !rejectedIds.has(id));
                        if (safeToDelete.length === 0) {
                            result.success = true;
                            return current; // 无变更，跳过写回
                        }

                        result.deletedIds = safeToDelete;
                        toDeleteIdsForCleanup = safeToDelete;
                        return list.filter(cp => !safeToDelete.includes(cp.id));
                    });

                    // 写回成功后才清理：减 blob 引用 + 删 manifest（blob 由独立 GC 回收）
                    const storage = this.deps.getStorage(conversationId);
                    for (const cpId of toDeleteIdsForCleanup) {
                        await cleanupCheckpointStorage(storage, cpId);
                    }
                    result.success = true;
                }
            );
        } catch (err) {
            console.error('[CheckpointManager] Failed to delete checkpoints by node ids:', err);
        }
        return result;
    }
}
