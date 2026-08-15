/**
 * GrayCode - Memory 新格式底层存储
 *
 * 新运行时写入格式（JSONL，schema 见 memoryFormat.ts / docs/memory-format.md）：
 * - records.jsonl    追加式条目日志（一行一条 StoredRecord；损坏行以 null 占位
 *                    保留位置，logLen 口径与旧固定宽度物理计数一致）；
 * - summaries.jsonl  二叉树摘要（一行一条 StoredSummary，键 "lo:hi"）；
 * - meta.json        schema 版本 + 旧格式导入标记。
 *
 * 旧 LOG.txt（320/1024B 固定宽度）与 TREE/（288B 摘要槽位）只在首次打开时
 * 只读导入（importLegacyLocked，复用 logFormat.ts 的解析器），导入后新运行时
 * 不再写旧格式；旧文件保留不动（可人工恢复/审计）。records.jsonl 一旦存在
 * （哪怕为空）即视为已就绪，不会重复导入。
 *
 * 所有读写由内部 AsyncLock 串行化；记录/摘要带 mtime+size 一致性缓存，
 * 同一目录被多个实例（测试/未来多进程）访问时也能看到彼此的写入。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'node:crypto';
import {
    LOG_REC, TREE_REC,
    type LogEntry, type MemoryConfig,
} from './types.ts';
import { AsyncLock } from './AsyncLock.ts';
import { getProcessPathCoordinator, type ProcessPathCoordinator } from './processLock.ts';
import {
    die, ISO_DATE_RE, localDateString, OLD_LOG_REC, parse, records,
} from './logFormat.ts';
import { renameConfigOverwrite } from './configFile.ts';
import {
    MEMORY_FORMAT_VERSION,
    type LegacyImportInfo,
    type MemoryMeta,
    type StoredRecord,
    type StoredSummary,
    buildMetaContent,
    decodeRecordLine,
    decodeSummaryLine,
    encodeRecordLine,
    encodeSummaryLine,
    summaryKey,
} from './memoryFormat.ts';

/** 从任意异常中提取 errno code（无则 undefined） */
function errnoCode(e: unknown): string | undefined {
    if (e && typeof e === 'object' && 'code' in e) {
        const code = (e as { code?: unknown }).code;
        if (typeof code === 'string') return code;
    }
    return undefined;
}

/**
 * 探测旧格式记录切片的头部 "#id <ISO date>"（允许 text 为空/缺失）：
 * 仅用于 LOG 宽度判别（320 vs 1024），不要求 text 完整（=audit 4.13-L11）。
 */
function probeLegacyHead(slice: string): { id: number; date: string } | null {
    const m = /^#(\d+) (\d{4}-\d{2}-\d{2})(?: |$)/.exec(slice);
    if (!m) return null;
    return { id: parseInt(m[1]!, 10), date: m[2]! };
}

/**
 * Optimistic concurrency failure for mutations issued from a stale list
 * snapshot.  The Remote adapter maps this domain error to GRAY_CONFLICT.
 */
export class MemoryRevisionConflictError extends Error {
    readonly expectedRevision: string;
    readonly actualRevision: string;

    constructor(expectedRevision: string, actualRevision: string) {
        super('Memory list changed; refresh before editing or deleting.');
        this.name = 'MemoryRevisionConflictError';
        this.expectedRevision = expectedRevision;
        this.actualRevision = actualRevision;
    }
}

export interface MemoryEntriesSnapshot {
    readonly entries: LogEntry[];
    readonly revision: string;
}

export class MemoryLogStore {
    private dir: string;
    private lock: AsyncLock;
    private coordinator: ProcessPathCoordinator;
    private observedRevision = 0;

    /**
     * 配置访问器：updateEntry 需要 entryChars 做写入前校验。
     * 由 MemoryManager 注入，保持单一配置真源。
     */
    private getConfig: () => MemoryConfig;

    /**
     * records.jsonl 缓存（{ mtimeMs, fileSize, records, revision }）：
     * 写路径在锁内更新数组（copy-on-write，快照安全），读路径以 mtime+size
     * 一致性兜底并发窗口（多实例共享目录时可见彼此写入）。
     * records[k] === null 表示该位置是损坏/空行占位；revision 为该数组的内容
     * 寻址摘要（listEntriesSnapshot 复用，见 M6）。
     */
    private recordsCache:
        | { mtimeMs: number; fileSize: number; records: Array<StoredRecord | null>; revision: string }
        | null = null;

    /**
     * summaries.jsonl 缓存（{ mtimeMs, fileSize, map }），键 "lo:hi"。
     * 树是缓存：文件缺失/损坏只导致 pending 重建，不阻断读写。
     */
    private summariesCache: { mtimeMs: number; fileSize: number; map: Map<string, StoredSummary> } | null = null;

    /** meta.json 版本已校验过（每实例一次；导入路径自行置位） */
    private metaChecked = false;

    constructor(dir: string, getConfig: () => MemoryConfig) {
        this.dir = dir;
        this.getConfig = getConfig;
        // Multiple MemoryService instances can address the same store during
        // HMR and migration.  The lock must therefore be shared by path, not
        // owned by this object.
        this.coordinator = getProcessPathCoordinator('memory-store', dir);
        this.lock = this.coordinator.lock;
        this.observedRevision = this.coordinator.revision;
    }

    /** Invalidate local caches after a peer instance commits under the lock. */
    private observeProcessRevision(): void {
        if (this.observedRevision === this.coordinator.revision) return;
        this.recordsCache = null;
        this.summariesCache = null;
        this.observedRevision = this.coordinator.revision;
    }

    /** Publish a successful file mutation to every store instance for this dir. */
    private publishMutation(): void {
        this.coordinator.revision += 1;
        this.observedRevision = this.coordinator.revision;
    }

    /**
     * Content-addressed revision for the exact records snapshot.  It includes
     * null/corrupt placeholders and all persisted metadata, so an id shift,
     * append, edit, delete, or repair invalidates stale mutation requests.
     * Call only while holding {@link lock}.
     */
    private recordsRevisionLocked(recordsArr: ReadonlyArray<StoredRecord | null>): string {
        const hash = createHash('sha256');
        for (const record of recordsArr) {
            hash.update(record === null ? '\n' : encodeRecordLine(record), 'utf8');
        }
        return `sha256:${hash.digest('base64url')}`;
    }

    /** Compare a caller's snapshot revision inside the same lock as mutation. */
    private assertExpectedRevisionLocked(
        recordsArr: ReadonlyArray<StoredRecord | null>,
        expectedRevision: string | undefined,
    ): void {
        if (expectedRevision === undefined) return;
        const actualRevision = this.recordsRevisionLocked(recordsArr);
        if (actualRevision !== expectedRevision) {
            throw new MemoryRevisionConflictError(expectedRevision, actualRevision);
        }
    }

    /** 初始化存储目录结构（新格式只需目录；records.jsonl 在首次访问时创建/导入） */
    async initStorage(): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });
    }

    // ─── 路径工具 ──────────────────────────────

    private recordsPath(): string {
        return path.join(this.dir, 'records.jsonl');
    }

    private summariesPath(): string {
        return path.join(this.dir, 'summaries.jsonl');
    }

    private metaPath(): string {
        return path.join(this.dir, 'meta.json');
    }

    private legacyLogPath(): string {
        return path.join(this.dir, 'LOG.txt');
    }

    private legacyTreeDir(): string {
        return path.join(this.dir, 'TREE');
    }

    // ─── 就绪与旧格式导入 ─────────────────────────

    /**
     * 确保存储就绪（所有公开读写的统一前置入口，内部加锁）：
     * 新格式（records.jsonl）存在则校验 meta 版本后返回；否则执行旧格式只读导入
     * （或建空新格式）。等价于旧实现的 ensureLogMigrated，语义从「宽度迁移」
     * 变为「新格式就绪 + 旧格式一次性导入」。
     */
    async ensureReady(): Promise<void> {
        const release = await this.lock.acquire();
        try {
            await this.ensureReadyLocked();
        } finally {
            release();
        }
    }

    /** 锁内版本（写路径在锁内直接调用） */
    private async ensureReadyLocked(): Promise<void> {
        if (await this.newFormatPresent()) {
            await this.checkMetaLocked();
            return;
        }
        await this.importLegacyLocked();
    }

    /** records.jsonl 是否存在（存在即视为已就绪，无论是否为空） */
    private async newFormatPresent(): Promise<boolean> {
        try {
            await fs.access(this.recordsPath());
            return true;
        } catch (e: unknown) {
            if (errnoCode(e) === 'ENOENT') return false;
            throw e;
        }
    }

    /**
     * 校验 meta.json 版本（每实例一次，宽容策略）：
     * - 缺失/损坏：告警后继续（meta 仅作记录，不阻断读写）；
     * - formatVersion 过新：拒绝（数据由更新版本运行时写入，可能不兼容）。
     */
    private async checkMetaLocked(): Promise<void> {
        if (this.metaChecked) return;
        this.metaChecked = true;
        let content: string;
        try {
            content = await fs.readFile(this.metaPath(), 'utf-8');
        } catch (e: unknown) {
            if (errnoCode(e) === 'ENOENT') return;
            throw e;
        }
        let raw: unknown;
        try {
            raw = JSON.parse(content);
        } catch {
            console.warn('[MemoryManager] meta.json is corrupted; ignoring it.');
            return;
        }
        if (raw !== null && typeof raw === 'object') {
            const formatVersion = (raw as Record<string, unknown>).formatVersion;
            if (typeof formatVersion === 'number' && formatVersion > MEMORY_FORMAT_VERSION) {
                die(`memory meta: formatVersion ${formatVersion} is newer than supported ` +
                    `${MEMORY_FORMAT_VERSION}; upgrade the plugin.`);
            }
        }
    }

    /**
     * 旧格式只读导入（一次性，锁内调用）：
     * 1. LOG.txt：探测记录宽度（前两条 320B 切片 id 0/1 + ISO 日期 → 320，否则
     *    1024；<640B 单条小文件按切片 0 判定），用 records() 只解析完整记录
     *    （损坏行/撕裂尾跳过，与旧解析器同口径）；损坏切片以 null 占位保留位置
     *    （logLen 与旧物理计数一致），合法条目重编号写入并记录 legacyId；
     * 2. TREE/：每个 2 幂 size 文件按 TREE_REC 槽位解析；空槽/损坏槽跳过（隔离），
     *    槽位文本兼容两种形态（纯摘要文本 / "#id date text"）；
     * 3. 提交：records.jsonl → summaries.jsonl → meta.json（每文件 tmp+rename
     *    原子替换）；LOG.txt/TREE 保持只读，永不改写或删除。
     *
     * 幂等：提交前复查 records.jsonl（另一实例可能已完成导入）→ 放弃本次；
     * 崩溃安全：先提交 records 再提交 summaries——中途崩溃最多丢失摘要（可重建
     * 缓存），records 已提交则下次直接使用，不会重复导入。
     */
    private async importLegacyLocked(): Promise<void> {
        const imported: Array<StoredRecord | null> = [];
        let logInfo: { rec: number; imported: number; skipped: number } | null = null;
        let legacySeen = false;

        const logPath = this.legacyLogPath();
        try {
            const stat = await fs.stat(logPath);
            legacySeen = true;
            if (stat.size > 0) {
                const rec = await this.probeLegacyRec(logPath, stat.size);
                const buf = await fs.readFile(logPath);
                const parsed = records(buf, rec);
                const totalSlices = Math.floor(buf.length / rec);
                // 位置保留：合法记录按 id 归位，损坏/空切片 → null 占位。
                // id 与位置不一致的异常记录（人工编辑破坏连续性）不导入（占位跳过）。
                let parsedIdx = 0;
                for (let i = 0; i < totalSlices; i++) {
                    const entry = parsed[parsedIdx];
                    if (entry && entry.id === i) {
                        imported.push(this.toImportedRecord(imported.length, entry));
                        parsedIdx++;
                    } else {
                        imported.push(null);
                    }
                }
                logInfo = {
                    rec,
                    imported: imported.filter(r => r !== null).length,
                    skipped: totalSlices - imported.filter(r => r !== null).length,
                };
            }
        } catch (e: unknown) {
            if (errnoCode(e) !== 'ENOENT') throw e;
        }

        const treeSummaries: StoredSummary[] = [];
        let treeInfo: { imported: number; skipped: number; files: string[] } = {
            imported: 0,
            skipped: 0,
            files: [],
        };
        try {
            const names = await fs.readdir(this.legacyTreeDir());
            legacySeen = true;
            for (const name of names) {
                if (!/^\d+$/.test(name)) continue;
                const size = parseInt(name, 10);
                if (size < 1 || (size & (size - 1)) !== 0) continue; // 只认 2 的幂
                try {
                    const buf = await fs.readFile(path.join(this.legacyTreeDir(), name));
                    const slots = Math.floor(buf.length / TREE_REC);
                    for (let k = 0; k < slots; k++) {
                        const str = buf.subarray(k * TREE_REC, (k + 1) * TREE_REC).toString('utf-8').trimEnd();
                        if (!str) {
                            treeInfo.skipped++; // 空槽（treeDrop 清空/从未压缩）
                            continue;
                        }
                        const entry = parse(str);
                        let text: string;
                        let date: string | undefined;
                        if (entry && ISO_DATE_RE.test(entry.date)) {
                            text = entry.text;
                            date = entry.date;
                        } else {
                            text = str;
                            date = undefined;
                        }
                        treeSummaries.push({ lo: k * size, hi: (k + 1) * size, date, text, source: 'legacy-import' });
                        treeInfo.imported++;
                    }
                    if (slots > 0) treeInfo.files.push(name);
                } catch (e: unknown) {
                    // 单个树文件损坏：隔离跳过，不中断其余文件
                    console.warn(`[MemoryManager] TREE/${name} import skipped ` +
                        `(${e instanceof Error ? e.message : String(e)})`);
                    treeInfo.skipped++;
                }
            }
        } catch (e: unknown) {
            if (errnoCode(e) !== 'ENOENT') throw e;
        }

        // 提交前复查：另一实例可能已完成导入（记录文件已出现）→ 放弃本次
        if (await this.newFormatPresent()) return;

        await this.writeFileAtomic(
            this.recordsPath(),
            imported.map(r => (r ? encodeRecordLine(r) : '\n')).join(''),
        );
        await this.writeFileAtomic(
            this.summariesPath(),
            treeSummaries.map(encodeSummaryLine).join(''),
        );
        const importedFromLegacy: LegacyImportInfo | null = legacySeen ? {
            at: new Date().toISOString(),
            logRec: logInfo?.rec ?? 0,
            logImported: logInfo?.imported ?? 0,
            logSkipped: logInfo?.skipped ?? 0,
            treeImported: treeInfo.imported,
            treeSkipped: treeInfo.skipped,
            files: treeInfo.files,
        } : null;
        const meta: MemoryMeta = {
            formatVersion: MEMORY_FORMAT_VERSION,
            importedFromLegacy,
        };
        await this.writeFileAtomic(this.metaPath(), buildMetaContent(meta));

        // 缓存失效：下次加载按新文件重建；meta 已由本次写入校验
        this.recordsCache = null;
        this.summariesCache = null;
        this.metaChecked = true;
    }

    /** 导入用：把旧格式条目转为新格式记录（重编号 + legacyId 溯源 + 审计来源） */
    private toImportedRecord(id: number, entry: LogEntry): StoredRecord {
        const now = new Date().toISOString();
        return {
            id,
            date: entry.date,
            text: entry.text,
            createdAt: now,
            updatedAt: now,
            version: 1,
            source: 'legacy-import',
            tags: [],
            legacyId: entry.id,
        };
    }

    /**
     * 探测旧 LOG 记录宽度（与旧 probeLegacyFormat 同口径，用于导入判别）：
     * - 前两条 320B 切片均以合法头部开头（id 0/1 + ISO 日期）→ 320（旧格式）；
     * - <640B 单条小文件：整文件按 320 探测一次，切片 0 合法（id 0 + ISO）→ 320；
     * - 其余 → 1024（records() 逐条解析，损坏行跳过）。
     */
    private async probeLegacyRec(logPath: string, fileSize: number): Promise<number> {
        const probeLen = Math.min(OLD_LOG_REC * 2, fileSize);
        const probe = Buffer.alloc(probeLen);
        const handle = await fs.open(logPath, 'r');
        try {
            const { bytesRead } = await handle.read(probe, 0, probeLen, 0);
            const got = probe.subarray(0, bytesRead);
            if (fileSize >= OLD_LOG_REC * 2 && got.length >= OLD_LOG_REC * 2) {
                // L11: 只校验头部（"#id <ISO date>"），容忍第二条记录 text 为空/缺失——
                // 旧格式可写 "#1 <date>" 空文本记录，parse() 会因缺 text 返回 null，
                // 旧判定据此误把 320 格式判为 1024，导致按错宽度解析出垃圾条目。
                const h0 = probeLegacyHead(got.subarray(0, OLD_LOG_REC).toString('utf-8'));
                const h1 = probeLegacyHead(got.subarray(OLD_LOG_REC, OLD_LOG_REC * 2).toString('utf-8'));
                if (h0 && h0.id === 0 && h1 && h1.id === 1) {
                    return OLD_LOG_REC;
                }
                return LOG_REC;
            }
            // 单条小文件（<640B 不可能是 1024 记录）：按 320 整文件探测一次判定
            if (fileSize > 0 && fileSize < OLD_LOG_REC * 2) {
                const h0 = probeLegacyHead(got.toString('utf-8'));
                if (h0 && h0.id === 0) return OLD_LOG_REC;
            }
            return LOG_REC;
        } finally {
            await handle.close();
        }
    }

    // ─── 原子写 ──────────────────────────────

    /**
     * 原子写：先写同目录临时文件再 rename 替换（Windows 上 rename 覆盖已存在
     * 目标可能 EPERM/EEXIST，复用 configFile 的退避重试）。失败清理 tmp 并上抛。
     */
    private async writeFileAtomic(targetPath: string, content: string): Promise<void> {
        const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        try {
            await fs.writeFile(tmpPath, content, 'utf-8');
            await renameConfigOverwrite(tmpPath, targetPath);
            this.publishMutation();
        } catch (e: unknown) {
            try {
                await fs.unlink(tmpPath);
            } catch {
                // 清理失败忽略
            }
            throw e;
        }
    }

    // ─── 底层读取（缓存加载） ──────────────────────

    /**
     * 加载 records.jsonl（锁内调用）：mtime+size 与缓存一致则复用；否则整文件
     * 解析——逐行 JSON，损坏/空行以 null 占位保留位置；撕裂尾部（无换行结尾）
     * 忽略并在本方法内截断修复（与旧 repairLog 同口径）。
     */
    private async loadRecordsLocked(): Promise<void> {
        this.observeProcessRevision();
        const p = this.recordsPath();
        let stat: import('fs').Stats;
        try {
            stat = await fs.stat(p);
        } catch (e: unknown) {
            if (errnoCode(e) !== 'ENOENT') throw e;
            this.recordsCache = { mtimeMs: 0, fileSize: 0, records: [], revision: this.recordsRevisionLocked([]) };
            return;
        }
        const cached = this.recordsCache;
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.fileSize === stat.size) return;

        const buf = await fs.readFile(p);
        const recordsArr: Array<StoredRecord | null> = [];
        let start = 0;
        let validBytes = 0;
        while (start < buf.length) {
            const nl = buf.indexOf(0x0a, start);
            if (nl < 0) break; // 撕裂尾部半行：忽略，下方截断修复
            validBytes = nl + 1;
            const line = buf.subarray(start, nl).toString('utf-8');
            if (line.trim() === '') {
                recordsArr.push(null);
            } else {
                const rec = decodeRecordLine(line);
                // L6: 校验 id 与行号一致——id ≠ 行号的异常记录按损坏占位处理
                // （与旧格式导入跳过异常记录同口径），避免位置寻址
                // （logSlice/deleteRange/zoom）指向带错误 id 的记录。
                recordsArr.push(rec && rec.id === recordsArr.length ? rec : null);
            }
            start = nl + 1;
        }
        let fileSize = stat.size;
        let mtimeMs = stat.mtimeMs;
        if (validBytes < buf.length) {
            const handle = await fs.open(p, 'r+');
            try {
                await handle.truncate(validBytes);
            } finally {
                await handle.close();
            }
            fileSize = validBytes;
            this.publishMutation();
            const repairedStat = await fs.stat(p);
            mtimeMs = repairedStat.mtimeMs;
        }
        // M6: 缓存内容寻址 revision——listEntriesSnapshot 每页直接复用，避免对全量记录
        // 反复 JSON.stringify+sha256（大记忆库分页由每页 O(N) 降为每次加载/变更后的 O(1) 复用）。
        this.recordsCache = { mtimeMs, fileSize, records: recordsArr, revision: this.recordsRevisionLocked(recordsArr) };
    }

    /**
     * 加载 summaries.jsonl（锁内调用）：mtime+size 一致则复用；否则逐行解析，
     * 损坏行跳过（树是缓存，缺失只触发重建）。文件不存在视为空摘要。
     */
    private async loadSummariesLocked(): Promise<void> {
        this.observeProcessRevision();
        const p = this.summariesPath();
        let stat: import('fs').Stats;
        try {
            stat = await fs.stat(p);
        } catch (e: unknown) {
            if (errnoCode(e) !== 'ENOENT') throw e;
            this.summariesCache = { mtimeMs: 0, fileSize: 0, map: new Map() };
            return;
        }
        const cached = this.summariesCache;
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.fileSize === stat.size) return;

        const map = new Map<string, StoredSummary>();
        try {
            const buf = await fs.readFile(p);
            let start = 0;
            while (start < buf.length) {
                const nl = buf.indexOf(0x0a, start);
                if (nl < 0) break;
                const line = buf.subarray(start, nl).toString('utf-8');
                if (line.trim() !== '') {
                    const s = decodeSummaryLine(line);
                    if (s) map.set(summaryKey(s.lo, s.hi), s);
                }
                start = nl + 1;
            }
        } catch (e: unknown) {
            // stat 后文件被删/不可读：按空摘要处理（缓存缺失可重建）
            if (errnoCode(e) !== 'ENOENT') throw e;
        }
        this.summariesCache = { mtimeMs: stat.mtimeMs, fileSize: stat.size, map };
    }

    /** 全量重写 records.jsonl（锁内调用；tmp+rename 原子提交；null 占位写空行） */
    private async rewriteRecordsLocked(recordsArr: Array<StoredRecord | null>): Promise<void> {
        const lines = recordsArr.map(r => (r ? encodeRecordLine(r) : '\n')).join('');
        await this.writeFileAtomic(this.recordsPath(), lines);
        const stat = await fs.stat(this.recordsPath());
        this.recordsCache = {
            mtimeMs: stat.mtimeMs,
            fileSize: stat.size,
            records: recordsArr,
            revision: this.recordsRevisionLocked(recordsArr),
        };
    }

    /** 全量重写 summaries.jsonl（锁内调用；按 lo 升序保证输出确定） */
    private async rewriteSummariesLocked(): Promise<void> {
        const lines = [...this.summariesCache!.map.values()]
            .sort((a, b) => a.lo - b.lo || a.hi - b.hi)
            .map(encodeSummaryLine)
            .join('');
        await this.writeFileAtomic(this.summariesPath(), lines);
        const stat = await fs.stat(this.summariesPath());
        this.summariesCache = { ...this.summariesCache!, mtimeMs: stat.mtimeMs, fileSize: stat.size };
    }

    /**
     * 删除/截断后清理树摘要（锁内调用）：
     * - 尾部删除（区间到达日志末尾 / truncate）：保留 hi <= newT 的块——对齐块
     *   hi <= newT ⟺ 完全位于保留区，与旧实现 keep = floor(newT / size) 一致；
     * - 中间删除：全部清空（重编号使所有块失效）。
     */
    private async clearSummariesLocked(newT: number, keepPrefix: boolean): Promise<void> {
        await this.loadSummariesLocked();
        const map = this.summariesCache!.map;
        const kept = new Map<string, StoredSummary>();
        if (keepPrefix) {
            for (const [key, s] of map) {
                // M1: 校验块边界——越界/损坏块（hi <= lo、lo < 0、lo >= newT、
                // hi > newT）一律不保留（按损坏处理丢弃），避免尾部删除后残留
                // 覆盖已删记忆的陈旧摘要被 wake/zoom 当作权威数据展示。
                if (
                    s.hi > s.lo && s.lo >= 0 &&
                    s.hi <= newT && s.lo < newT
                ) {
                    kept.set(key, s);
                }
            }
        }
        if (kept.size === map.size) return;
        this.summariesCache = { ...this.summariesCache!, map: kept };
        await this.rewriteSummariesLocked();
    }

    // ─── 底层读写（公开 API） ─────────────────────

    /** 获取记录数量（含损坏占位，与旧物理计数口径一致；O(1)，仅 stat + 缓存） */
    async logLen(): Promise<number> {
        const release = await this.lock.acquire();
        try {
            await this.ensureReadyLocked();
            await this.loadRecordsLocked();
            return this.recordsCache!.records.length;
        } finally {
            release();
        }
    }

    /**
     * 追加日志记录，返回起始 ID（追加式：一行一条，崩溃最多撕裂尾部半行）。
     *
     * 已知限制（M2）：本方法只由进程内 AsyncLock（ProcessPathCoordinator）串行化。
     * 多个 Node 进程同时共享同一存储目录时，appendFile 追加与 deleteRange/
     * updateEntry/truncateLog 的 tmp+rename 全量重写之间没有跨进程互斥，可能发生
     * 丢失更新（进程 A 追加 → 进程 B 基于陈旧缓存全量重写覆盖）与 id 重叠/内存磁盘
     * 分叉。插件运行时为单进程（Cordis fiber），跨进程共享目录不受支持；如需多进程
     * 写入，须先在存储层引入跨进程锁（锁文件/flock）。
     */
    async logAppend(items: Array<{ date: string; text: string; source?: string; tags?: string[]; legacyId?: number }>): Promise<number> {
        const release = await this.lock.acquire();
        try {
            await this.ensureReadyLocked();
            await this.loadRecordsLocked();
            const base = this.recordsCache!.records.length;
            const now = new Date().toISOString();
            const added: StoredRecord[] = items.map((item, k) => ({
                id: base + k,
                date: item.date,
                text: item.text,
                createdAt: now,
                updatedAt: now,
                version: 1,
                source: item.source ?? 'note',
                tags: item.tags ?? [],
                legacyId: item.legacyId,
            }));
            await fs.appendFile(this.recordsPath(), added.map(encodeRecordLine).join(''), 'utf-8');
            this.publishMutation();
            const stat = await fs.stat(this.recordsPath());
            const prev = this.recordsCache!;
            // copy-on-write：快照（logScan）持有旧数组引用不受影响
            const nextRecords = [...prev.records, ...added];
            this.recordsCache = {
                mtimeMs: stat.mtimeMs,
                fileSize: stat.size,
                records: nextRecords,
                revision: this.recordsRevisionLocked(nextRecords),
            };
            return base;
        } finally {
            release();
        }
    }

    /** 读取 [lo, hi) 范围内的日志记录（跳过损坏占位） */
    async logSlice(lo: number, hi: number): Promise<LogEntry[]> {
        const release = await this.lock.acquire();
        try {
            await this.ensureReadyLocked();
            await this.loadRecordsLocked();
            const arr = this.recordsCache!.records;
            const out: LogEntry[] = [];
            for (let i = lo; i < hi && i < arr.length; i++) {
                const rec = arr[i];
                if (rec) out.push({ id: rec.id, date: rec.date, text: rec.text });
            }
            return out;
        } finally {
            release();
        }
    }

    /** 读取单条日志 */
    async logGet(i: number): Promise<LogEntry> {
        const entries = await this.logSlice(i, i + 1);
        if (entries.length === 0) die(`No memory at index ${i}`);
        return entries[0]!;
    }

    /**
     * 读取位置 i 的记录 id；位置缺失（日志被截断）或损坏（占位 null）返回 null。
     * 仅用于 wake 末条「缺失 vs 损坏」的错误路径判别，不参与正常读取。
     */
    async rawEntryIdAt(i: number): Promise<number | null> {
        const release = await this.lock.acquire();
        try {
            await this.ensureReadyLocked();
            await this.loadRecordsLocked();
            const arr = this.recordsCache!.records;
            if (i < 0 || i >= arr.length) return null;
            return arr[i]?.id ?? null;
        } finally {
            release();
        }
    }

    /** 流式扫描全部日志（锁内加载快照后释放，逐条 yield） */
    async *logScan(): AsyncGenerator<LogEntry> {
        const release = await this.lock.acquire();
        let arr: Array<StoredRecord | null>;
        try {
            await this.ensureReadyLocked();
            await this.loadRecordsLocked();
            arr = this.recordsCache!.records;
        } finally {
            release();
        }
        for (const rec of arr) {
            if (rec) yield { id: rec.id, date: rec.date, text: rec.text };
        }
    }

    /**
     * Return the complete visible entry list and its CAS revision from one
     * locked snapshot.  Remote list/edit/forget use this revision to prevent
     * a stale positional id from targeting a different record after a delete
     * renumbers the log.
     */
    async listEntriesSnapshot(): Promise<MemoryEntriesSnapshot> {
        const release = await this.lock.acquire();
        try {
            await this.ensureReadyLocked();
            await this.loadRecordsLocked();
            const recordsArr = this.recordsCache!.records;
            const entries: LogEntry[] = [];
            for (const record of recordsArr) {
                if (record) entries.push({ id: record.id, date: record.date, text: record.text });
            }
            return {
                entries,
                // M6: 复用缓存的内容寻址 revision（loadRecordsLocked/各写路径在锁内维护），
                // 每次 list 请求不再对全量记录重新哈希。
                revision: this.recordsCache!.revision,
            };
        } finally {
            release();
        }
    }

    /** 读取树摘要；缺失返回 null */
    async treeGet(lo: number, hi: number): Promise<string | null> {
        const release = await this.lock.acquire();
        try {
            await this.ensureReadyLocked();
            await this.loadSummariesLocked();
            return this.summariesCache!.map.get(summaryKey(lo, hi))?.text ?? null;
        } finally {
            release();
        }
    }

    /**
     * 写入树摘要。
     * - 块已存在（含并行会话已压缩）→ 返回 false，不覆盖；
     * - 目标槽之前的同 size 块缺失（越序压缩/树被并发截断）→ 报可操作错误；
     * - 成功 → 写入并返回 true。
     */
    async treePut(lo: number, hi: number, text: string, source = 'compress'): Promise<boolean> {
        const size = hi - lo;
        const release = await this.lock.acquire();
        try {
            await this.ensureReadyLocked();
            await this.loadSummariesLocked();
            const map = this.summariesCache!.map;
            const key = summaryKey(lo, hi);
            if (map.has(key)) return false;

            // 缺槽原因：目标槽之前的块缺失（树被并发截断/越序压缩）。
            // 不能静默 return false——compress() 会误报「已被其他会话压缩」；
            // 给出可操作提示：按序执行 memory_compress 重建缺失块。
            const targetIndex = lo / size;
            let n = 0;
            while (n < targetIndex && map.has(summaryKey(n * size, (n + 1) * size))) n++;
            if (n < targetIndex) {
                die(`Cannot write #${lo}-${hi - 1}: ${n} of ${targetIndex} tree blocks present, ` +
                    `earlier blocks are missing. Run memory_compress to build pending blocks in order.`);
            }

            const next = new Map(map);
            // L1: 摘要日期取本地自然日（与 note/remote 口径一致），避免 UTC 偏移跨日
            next.set(key, { lo, hi, date: localDateString(), text, source });
            this.summariesCache = { ...this.summariesCache!, map: next };
            await this.rewriteSummariesLocked();
            return true;
        } finally {
            release();
        }
    }

    /** 丢弃树摘要及其上层；返回实际被丢弃的块列表（[lo, hi) 形式） */
    async treeDrop(lo: number, hi: number): Promise<Array<[number, number]>> {
        const gone: Array<[number, number]> = [];
        const release = await this.lock.acquire();
        try {
            await this.ensureReadyLocked();
            await this.loadRecordsLocked();
            const T = this.recordsCache!.records.length;
            await this.loadSummariesLocked();
            const next = new Map(this.summariesCache!.map);
            let size = hi - lo;
            while (size <= T) {
                // 只删除覆盖被删区间 [lo, hi) 的块（索引 kStart..kEnd），
                // 不连带删除其后块（与旧实现一致：树是缓存，缺失只触发重建）。
                const kStart = Math.floor(lo / size);
                const kEnd = Math.floor((hi - 1) / size);
                for (let k = kStart; k <= kEnd; k++) {
                    const key = summaryKey(k * size, (k + 1) * size);
                    if (next.has(key)) {
                        gone.push([k * size, (k + 1) * size]);
                        next.delete(key);
                    }
                }
                size *= 2;
            }
            if (gone.length > 0) {
                this.summariesCache = { ...this.summariesCache!, map: next };
                await this.rewriteSummariesLocked();
            }
            return gone;
        } finally {
            release();
        }
    }

    /** 列出所有待构建的块（最小优先） */
    async pending(T: number, limit?: number): Promise<Array<[number, number]>> {
        const release = await this.lock.acquire();
        try {
            await this.ensureReadyLocked();
            await this.loadSummariesLocked();
            const map = this.summariesCache!.map;
            const todo: Array<[number, number]> = [];
            for (let size = 2; size <= T; size *= 2) {
                const maxK = Math.floor(T / size);
                for (let k = 0; k < maxK; k++) {
                    if (map.has(summaryKey(k * size, (k + 1) * size))) continue;
                    todo.push([k * size, (k + 1) * size]);
                    if (limit && todo.length >= limit) return todo;
                }
            }
            return todo;
        } finally {
            release();
        }
    }

    /** 待构建块的数量 */
    async pendingCount(T: number): Promise<number> {
        const release = await this.lock.acquire();
        try {
            await this.ensureReadyLocked();
            await this.loadSummariesLocked();
            const map = this.summariesCache!.map;
            let n = 0;
            for (let size = 2; size <= T; size *= 2) {
                const maxK = Math.floor(T / size);
                for (let k = 0; k < maxK; k++) {
                    if (!map.has(summaryKey(k * size, (k + 1) * size))) n++;
                }
            }
            return n;
        } finally {
            release();
        }
    }

    /** 锁内：丢弃所有覆盖给定 ID 的树摘要（updateEntry 在记录写入同一锁内调用，见 L2） */
    private async dropSummariesCoveringLocked(id: number): Promise<void> {
        try {
            await this.loadRecordsLocked();
            const T = this.recordsCache!.records.length;
            await this.loadSummariesLocked();
            const next = new Map(this.summariesCache!.map);
            let changed = false;
            // 覆盖 id 的所有对齐块 = 逐层包含 id 的块（含全部祖先）
            for (let size = 2; size <= T; size *= 2) {
                const lo = Math.floor(id / size) * size;
                if (next.delete(summaryKey(lo, lo + size))) changed = true;
            }
            if (changed) {
                this.summariesCache = { ...this.summariesCache!, map: next };
                await this.rewriteSummariesLocked();
            }
        } catch (err) {
            // 与锁外版同口径：丢弃失败至少告警（树是缓存，缺失可重建，但需可观测）
            console.warn(`[MemoryManager] Failed to drop summaries covering #${id}:`, err);
        }
    }

    /**
     * updateEntry: 原地覆写单条原始记忆的文本（保留 id/date/createdAt/legacyId，
     * 更新 version/updatedAt 并记录审计来源）。
     */
    async updateEntry(
        id: number,
        text: string,
        source = 'update',
        expectedRevision?: string,
    ): Promise<LogEntry> {
        const entryChars = this.getConfig().entryChars;
        const trimmed = text.trim();
        if (!trimmed) die('Empty. A memory is one line of text.');
        if (trimmed.includes('\n') || trimmed.includes('\r')) {
            die('A memory is one line.');
        }
        const byteLen = Buffer.byteLength(trimmed, 'utf-8');
        if (byteLen > entryChars) {
            die(`Too long: ${byteLen} bytes, limit ${entryChars}.`);
        }

        // 校验与读取必须放在锁内：并发 truncateLog/logAppend 改变日志长度后，
        // 基于过期 id 的写入会越界（与旧实现同口径）。
        let updatedEntry: LogEntry | undefined;
        const release = await this.lock.acquire();
        try {
            await this.ensureReadyLocked();
            await this.loadRecordsLocked();
            const arr = this.recordsCache!.records;
            this.assertExpectedRevisionLocked(arr, expectedRevision);
            if (id < 0 || id >= arr.length) {
                die(`No memory at index ${id}.`);
            }
            const rec = arr[id];
            if (!rec) {
                // 损坏占位不可编辑（与旧实现 logGet 对损坏行的口径一致）
                die(`No memory at index ${id}.`);
            }
            const now = new Date().toISOString();
            const updated: StoredRecord = {
                ...rec,
                text: trimmed,
                updatedAt: now,
                version: (rec.version ?? 1) + 1,
                source,
            };
            const next = arr.slice();
            next[id] = updated;
            await this.rewriteRecordsLocked(next);
            // L2: 摘要丢弃与记录写入在同一锁内提交——消除「并发 compress 写入基于
            // 旧文本摘要」的竞态窗口；锁外丢弃时，窗口内 wake/zoom 会短暂/持续展示
            // 覆盖已提交新内容的陈旧摘要。
            await this.dropSummariesCoveringLocked(id);
            this.recordsCache = { ...this.recordsCache!, records: next };
            updatedEntry = { id: updated.id, date: updated.date, text: updated.text };
        } finally {
            release();
        }
        return updatedEntry!;
    }

    /**
     * deleteRange: 删除闭区间 [lo, hi] 内的所有原始记忆（真·单条/批量删除，
     * 不连坐 truncateLog）。删除后其余记录重编号，相关树摘要清空
     * （下次 recall/compress 按需重建）。「读全量 → 过滤 → 重编号 → tmp+rename
     * 原子写回」，崩溃安全。
     */
    async deleteRange(lo: number, hi: number, expectedRevision?: string): Promise<{ removed: number }> {
        // 输入校验：非整数/NaN 不得进入，避免 NaN 比较恒 false 导致静默全量重写
        if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
            die(`Invalid delete range: lo=${lo}, hi=${hi}.`);
        }
        const release = await this.lock.acquire();
        try {
            await this.ensureReadyLocked();
            await this.loadRecordsLocked();
            const arr = this.recordsCache!.records;
            this.assertExpectedRevisionLocked(arr, expectedRevision);
            const T = arr.length;
            if (lo < 0 || lo >= T) {
                die(`No memory at index ${lo}.`);
            }
            if (hi < lo || hi >= T) {
                die(`No memory at index ${hi}.`);
            }

            // 区间内空/损坏占位不计入删除数（与旧实现同口径）：
            // 删除条数与 newT 推演必须扣除它们，保证与写回条数一致
            let skippedInRange = 0;
            const kept: Array<StoredRecord | null> = [];
            for (let i = 0; i < T; i++) {
                const rec = arr[i];
                const inRange = i >= lo && i <= hi;
                if (!rec) {
                    if (inRange) skippedInRange++;
                    kept.push(null);
                    continue;
                }
                if (inRange) continue;
                kept.push({ ...rec, id: kept.length });
            }
            const actualRemoved = (hi - lo + 1) - skippedInRange;
            let newT = T - actualRemoved;

            // M1: 尾部删除（区间到达日志末尾）时，删除区间内的损坏占位（null）会被
            // 原样保留进 kept 数组，抬高 newT 使覆盖已删记忆的越界摘要块（hi <= newT）
            // 被 clearSummariesLocked 保留。截除保留区末尾的占位后，这些块 hi > newT
            // 自然被丢弃。
            if (hi === T - 1) {
                while (kept.length > 0 && kept[kept.length - 1] === null) kept.pop();
                newT = kept.length;
            }

            // 先清树摘要、后原子换记录：树是缓存，缺失只触发重建（安全）；
            // 陈旧摘要会被 wake/zoom 当作权威数据展示（危险）。
            await this.clearSummariesLocked(newT, hi === T - 1);
            await this.rewriteRecordsLocked(kept);
            this.recordsCache = { ...this.recordsCache!, records: kept };
            return { removed: actualRemoved };
        } finally {
            release();
        }
    }

    /**
     * deleteEntries: 批量删除多条原始记忆（可乱序、可重复），内部排序去重后
     * 单次扫描重编号写回，返回实际删除条数。删除后相关树摘要清空。
     */
    async deleteEntries(ids: number[]): Promise<{ removed: number }> {
        if (!Array.isArray(ids)) {
            die('deleteEntries: ids must be an array.');
        }
        const sorted = Array.from(new Set(ids)).sort((a, b) => a - b);
        if (sorted.length === 0) {
            return { removed: 0 };
        }
        // 防御：非负整数校验（调用方已校验，这里是 API 层兜底）
        if (sorted.some(id => !Number.isInteger(id) || id < 0)) {
            die('deleteEntries: ids must be non-negative integers.');
        }

        const release = await this.lock.acquire();
        try {
            await this.ensureReadyLocked();
            await this.loadRecordsLocked();
            const arr = this.recordsCache!.records;
            const T = arr.length;
            const maxId = sorted[sorted.length - 1]!;
            if (maxId >= T) {
                die(`No memory at index ${maxId}.`);
            }

            // 合并相邻 id 为闭区间（仅用于尾部判定，删除本身按 id 集合单次扫描）
            const ranges: Array<[number, number]> = [];
            for (const id of sorted) {
                const last = ranges[ranges.length - 1];
                if (last && id === last[1] + 1) {
                    last[1] = id;
                } else {
                    ranges.push([id, id]);
                }
            }
            const toDelete = new Set(sorted);

            let skippedInRange = 0;
            const kept: Array<StoredRecord | null> = [];
            for (let i = 0; i < T; i++) {
                const rec = arr[i];
                const inTarget = toDelete.has(i);
                if (!rec) {
                    if (inTarget) skippedInRange++;
                    kept.push(null);
                    continue;
                }
                if (inTarget) continue;
                kept.push({ ...rec, id: kept.length });
            }
            const actualRemoved = sorted.length - skippedInRange;
            let newT = T - actualRemoved;
            const tailSingleRange = ranges.length === 1 && ranges[0]![1] === T - 1;

            // M1: 与 deleteRange 同口径——尾部单区间删除时截除保留区末尾的损坏占位，
            // 使覆盖已删记忆的越界摘要块在 clearSummariesLocked 中被丢弃。
            if (tailSingleRange) {
                while (kept.length > 0 && kept[kept.length - 1] === null) kept.pop();
                newT = kept.length;
            }

            // 树摘要清理（与 deleteRange 多区间聚合后的最终语义一致）：
            // 仅当删除恰好构成一个覆盖日志尾部的单区间时保留其前缀块，否则全清。
            await this.clearSummariesLocked(newT, tailSingleRange);
            await this.rewriteRecordsLocked(kept);
            this.recordsCache = { ...this.recordsCache!, records: kept };
            return { removed: actualRemoved };
        } finally {
            release();
        }
    }

    /** 丢弃所有覆盖给定 ID 的树摘要（编辑记忆后调用；锁外使用，内部重新加锁） */
    async dropSummariesCovering(id: number): Promise<void> {
        const release = await this.lock.acquire();
        try {
            await this.ensureReadyLocked();
            await this.loadRecordsLocked();
            const T = this.recordsCache!.records.length;
            await this.loadSummariesLocked();
            const next = new Map(this.summariesCache!.map);
            let changed = false;
            // 覆盖 id 的所有对齐块 = 逐层包含 id 的块（含全部祖先）
            for (let size = 2; size <= T; size *= 2) {
                const lo = Math.floor(id / size) * size;
                if (next.delete(summaryKey(lo, lo + size))) changed = true;
            }
            if (changed) {
                this.summariesCache = { ...this.summariesCache!, map: next };
                await this.rewriteSummariesLocked();
            }
        } catch (err) {
            // B-3: 丢弃失败至少告警，不再静默吞掉（树是缓存，缺失可重建，但需可观测）
            console.warn(`[MemoryManager] Failed to drop summaries covering #${id}:`, err);
        } finally {
            release();
        }
    }

    /**
     * truncateLog: 截断原始 LOG，删除 ID >= keepId 的所有记忆及其相关树摘要。
     * keepId=0 表示清空全部记忆。物理截断语义：保留前 keepId 个位置（含占位），
     * 不重编号。
     */
    async truncateLog(keepId: number): Promise<{ removed: number }> {
        // Number.isInteger 校验——NaN 绕过 keepId<0 检查后会产生晦涩行为
        if (!Number.isInteger(keepId) || keepId < 0) {
            die(`Invalid keepId: ${keepId}.`);
        }

        // T 必须在锁内读取并与截断原子化：若在锁外读取 logLen，期间并发 note
        // 追加的新记录会在 truncate 时被一并截断，removed 数也不准确。
        const release = await this.lock.acquire();
        try {
            await this.ensureReadyLocked();
            await this.loadRecordsLocked();
            const arr = this.recordsCache!.records;
            const T = arr.length;
            if (keepId >= T) {
                return { removed: 0 };
            }
            const kept = arr.slice(0, keepId);
            await this.clearSummariesLocked(keepId, true);
            await this.rewriteRecordsLocked(kept);
            this.recordsCache = { ...this.recordsCache!, records: kept };
            return { removed: T - keepId };
        } finally {
            release();
        }
    }
}
