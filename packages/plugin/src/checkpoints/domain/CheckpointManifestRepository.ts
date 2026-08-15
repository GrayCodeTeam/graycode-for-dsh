/**
 * CheckpointManifestRepository - 内容寻址布局的存档 manifest 读写（V2 §7.6）。
 *
 * 布局：`<dataRoot>/checkpoints/<workspace-id>/manifests/<checkpoint-id>.json`。
 *
 * - schema version 3 单文件 manifest：`files`（完整文件清单 path→blobHash/size/mode）
 *   与 `changes`（相对父检查点的差异）同文件存储——内容寻址下 blob 不可变，
 *   mtime 等易变字段不再随存档存储，旧的 manifest.json/files.json 双文件配对
 *   （filesRevision/.prev 回滚）随之废除（无旧数据兼容负担，直接替换）；
 * - 原子写入：tmp + rename；同一存档的写入经 per-checkpointId 单飞队列串行化；
 * - 读路径带校验（checkpointId 匹配 / version 合法 / 字段形状）+ LRU 缓存；
 * - enrichRecord：新格式记录（元数据不含 fileHashes）从 manifest 回填完整数据。
 *
 * 路径语义：checkpointId 即 manifest 文件名（非目录名）；读写前必须通过
 * isSafeCheckpointDirName 校验（CP-PATH-1：防止损坏/恶意 ID 越界拼接）。
 */
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { CheckpointIgnoreSnapshot } from './types.ts';
import type { CheckpointManifest, CheckpointRecord } from './types.ts';
import { CheckpointPathError } from './CheckpointWorkspace.ts';

export const CHECKPOINT_MANIFEST_VERSION = 3;

/**
 * 存档目录/文件名安全校验（CP-DEL-1 / CP-PATH-1 / CP-RET-2 共用）。
 *
 * checkpointId / backupDir 来自对话元数据或工具参数，可能被手工编辑、损坏或恶意构造；
 * 删除、manifest 读写路径在使用 `path.join(checkpointsDir, name)` 之前必须校验，
 * 否则可能越界操作存档目录外内容。
 *
 * 规则：非空、无路径分隔符、非 `.` / `..`、非绝对路径 / 盘符、无空白与控制字符；
 * 等价于「解析后必然落在存档目录内的单层目录名」。
 * 测试常用的 `cp-1` / `a-1` 等连字符命名均放行；真实存档名为 `cp_xxx`。
 */
export function isSafeCheckpointDirName(name: string): boolean {
    if (typeof name !== 'string' || name.length === 0) {
        return false;
    }
    if (name === '.' || name === '..' || name.includes('\0')) {
        return false;
    }
    // 单层目录名：拒绝路径分隔符（含 Windows 反斜杠）与绝对路径/盘符前缀
    if (name.includes('/') || name.includes('\\')) {
        return false;
    }
    if (path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) {
        return false;
    }
    return /^[a-zA-Z0-9_.-]+$/.test(name);
}

/** 校验失败抛 CheckpointPathError（供 manifest 路径等需要硬失败的位置使用） */
export function assertSafeCheckpointDirName(name: string): void {
    if (!isSafeCheckpointDirName(name)) {
        throw new CheckpointPathError('INVALID_CHECKPOINT_PATH', `Unsafe checkpoint dir name: ${name}`);
    }
}

/** 内容哈希形状校验（sha256 hex；损坏的寻址键不进入校验/恢复路径） */
function isBlobHash(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/**
 * 检查点管理器（per-workspace：workspaceDir = `<dataRoot>/checkpoints/<workspace-id>`）
 */
export class CheckpointManifestRepository {
    /** 元数据缓存 LRU 上限（manifest 含完整文件清单，条目可达 MB 级，上限取小） */
    private static readonly META_CACHE_LIMIT = 8;
    private readonly metaCache = new Map<string, CheckpointManifest>();
    /**
     * per-checkpointId 写队列（single-flight）：同一存档的磁盘写入串行化，
     * 避免并发写者互踩共享 tmp 文件名（M1）。
     */
    private readonly writeChains = new Map<string, Promise<void>>();

    /** 工作区目录（`<dataRoot>/checkpoints/<workspace-id>`；GC 扫描 manifests 用） */
    readonly workspaceDir: string;

    constructor(workspaceDir: string) {
        this.workspaceDir = workspaceDir;
    }

    /** manifest 文件路径（checkpointId 即 manifest 文件名）；非法 ID 抛 CheckpointPathError（CP-PATH-1） */
    getManifestPath(checkpointId: string): string {
        assertSafeCheckpointDirName(checkpointId);
        return path.join(this.workspaceDir, 'manifests', `${checkpointId}.json`);
    }

    /** 清空缓存（可指定单个存档） */
    clearCache(checkpointId?: string): void {
        if (checkpointId !== undefined) {
            this.metaCache.delete(checkpointId);
        } else {
            this.metaCache.clear();
        }
    }

    /** LRU 读取：命中后重插刷新为“最新”（Map 迭代顺序 = 插入顺序） */
    private cacheGet(checkpointId: string): CheckpointManifest | undefined {
        const hit = this.metaCache.get(checkpointId);
        if (hit !== undefined) {
            this.metaCache.delete(checkpointId);
            this.metaCache.set(checkpointId, hit);
        }
        return hit;
    }

    /** LRU 写入：插入并淘汰最久未使用的条目 */
    private cacheSet(checkpointId: string, value: CheckpointManifest): void {
        this.metaCache.delete(checkpointId);
        this.metaCache.set(checkpointId, value);
        while (this.metaCache.size > CheckpointManifestRepository.META_CACHE_LIMIT) {
            const oldest = this.metaCache.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.metaCache.delete(oldest);
        }
    }

    /** 按 checkpointId 串行执行写入任务（single-flight 写队列） */
    private chainWrite(checkpointId: string, task: () => Promise<void>): Promise<void> {
        const prev = this.writeChains.get(checkpointId) ?? Promise.resolve();
        const next = prev.then(task, task);
        this.writeChains.set(checkpointId, next);
        next.finally(() => {
            if (this.writeChains.get(checkpointId) === next) {
                this.writeChains.delete(checkpointId);
            }
        }).catch(() => {
            // finally 链的拒绝由 next 的调用方处理，此处仅避免未处理拒绝
        });
        return next;
    }

    /**
     * 写入 manifest（原子：tmp + rename，提交点 rename）。写入成功后更新缓存；
     * 失败时清理残留 tmp 文件（L3），避免半截文件残留。
     */
    async writeManifest(checkpointId: string, manifest: CheckpointManifest): Promise<void> {
        assertSafeCheckpointDirName(checkpointId);
        // L2: manifest.checkpointId 必须与参数一致，否则产出配对错乱的 manifest
        if (manifest.checkpointId !== checkpointId) {
            throw new Error(`writeManifest checkpointId mismatch: ${manifest.checkpointId} !== ${checkpointId}`);
        }
        let tmpPath: string | undefined;
        try {
            await this.chainWrite(checkpointId, async () => {
                const targetPath = this.getManifestPath(checkpointId);
                // L5：tmp 带随机后缀——固定 `.tmp` 名在未来绕过写队列的并发写路径上会
                // 互踩；随机后缀 + 同目录 rename 保证原子提交互不干扰
                tmpPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
                await fs.mkdir(path.dirname(targetPath), { recursive: true });
                await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2), 'utf-8');
                await fs.rename(tmpPath, targetPath); // 提交点
                tmpPath = undefined;
            });
        } catch (err) {
            // 写失败（只读介质/磁盘满等）：清掉该存档缓存，避免「内存与磁盘不一致」残留
            this.clearCache(checkpointId);
            // L5：按本次实际使用的 tmp 名清理（随机后缀，不能再用固定名）
            if (tmpPath) {
                try {
                    await fs.rm(tmpPath, { force: true });
                } catch {
                    // 清理失败不影响主错误
                }
            }
            throw err;
        }
        this.cacheSet(checkpointId, manifest);
    }

    /** 删除 manifest 文件（删除/驱逐 checkpoint 时调用；幂等） */
    async deleteManifest(checkpointId: string): Promise<void> {
        assertSafeCheckpointDirName(checkpointId);
        this.clearCache(checkpointId);
        try {
            await fs.rm(this.getManifestPath(checkpointId), { force: true });
        } catch {
            // 幂等：不存在即视为删除成功
        }
    }

    /** manifest 磁盘内容是否为可接受的布局（版本已知、checkpointId 匹配、字段形状合法） */
    private isValidManifestJson(parsed: unknown, checkpointId: string): parsed is CheckpointManifest {
        if (!parsed || typeof parsed !== 'object') {
            return false;
        }
        const candidate = parsed as Partial<CheckpointManifest>;
        if (candidate.checkpointId !== checkpointId) {
            return false;
        }
        if (typeof candidate.version !== 'number' || !Number.isInteger(candidate.version)
            || candidate.version < 1 || candidate.version > CHECKPOINT_MANIFEST_VERSION) {
            // 版本缺失/非法/未知（> 当前）：布局可能不同，按损坏处理
            return false;
        }
        // M3: 元数据字段形状校验——恢复/排除说明等路径直接消费这些字段，
        // 缺字段/形状非法的损坏 manifest 若不拦截会在下游触发 TypeError
        if (!Array.isArray(candidate.workspaceRoots) || !Array.isArray(candidate.emptyDirs)
            || !Array.isArray(candidate.changes) || !Array.isArray(candidate.excluded)
            || !candidate.ignoreSnapshot || typeof candidate.ignoreSnapshot !== 'object') {
            return false;
        }
        if (!candidate.files || typeof candidate.files !== 'object' || Array.isArray(candidate.files)) {
            return false;
        }
        // files 条目形状：hash 必须是内容寻址键形状（H1：数组/假空形状拒绝，防「空工作区」误判）
        for (const entry of Object.values(candidate.files)) {
            if (!entry || typeof entry !== 'object'
                || !isBlobHash(entry.hash)
                || typeof entry.size !== 'number'
                || typeof entry.mode !== 'number') {
                return false;
            }
        }
        return true;
    }

    /**
     * 按 checkpointId 加载 manifest（含完整文件清单）。损坏/缺失返回 null
     * （不缓存损坏内容；恢复路径按存档数据丢失处理，fail-closed）。
     */
    async loadManifest(checkpointId: string): Promise<CheckpointManifest | null> {
        // CP-PATH-1: 非法 checkpointId 直接抛错，不允许落入缓存/磁盘路径
        assertSafeCheckpointDirName(checkpointId);
        const cached = this.cacheGet(checkpointId);
        if (cached) {
            return cached;
        }
        try {
            const raw = await fs.readFile(this.getManifestPath(checkpointId), 'utf-8');
            const parsed = JSON.parse(raw) as unknown;
            if (this.isValidManifestJson(parsed, checkpointId)) {
                this.cacheSet(checkpointId, parsed);
                return parsed;
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * 用 manifest 数据补全记录（新格式记录在元数据中不存 fileHashes，
     * 需要完整数据时从 manifest 回填；旧格式记录已有 fileHashes → 原样返回）。
     */
    async enrichRecord(record: CheckpointRecord): Promise<CheckpointRecord> {
        if (record.fileHashes) {
            return record;
        }
        const manifest = await this.loadManifest(record.id);
        if (!manifest) {
            return record;
        }
        const fileHashes: Record<string, string> = {};
        for (const [scopedPath, file] of Object.entries(manifest.files)) {
            fileHashes[scopedPath] = file.hash;
        }
        return {
            ...record,
            fileHashes,
            emptyDirs: manifest.emptyDirs.length > 0 ? manifest.emptyDirs : record.emptyDirs,
            changes: manifest.changes.length > 0 ? manifest.changes : record.changes,
            // CP-PARTIAL-2：部分快照标记从 manifest 回填（恢复侧据此禁用删除判定）
            ...(manifest.partial === true ? { partial: true } : {})
        };
    }
}
