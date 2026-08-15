/**
 * GrayCode - MemoryManager
 *
 * OptMem 风格永久记忆系统的核心引擎。
 * 负责记录（追加式 JSONL 日志）和摘要（二叉树摘要缓存）的读写编排、
 * cover 算法、压缩管理等。
 *
 * 底层文件读写（records.jsonl / summaries.jsonl、旧 LOG.txt/TREE 只读导入、
 * 删除/截断）已抽离到 MemoryLogStore，记录格式工具抽离到 logFormat（旧格式
 * 解析）与 memoryFormat（新格式 schema），cover 算法抽离到 cover，
 * config 文件读写抽离到 configFile。本类保持原有对外 API 完全不变。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
    RAW_MAX, TREE_REC, DEFAULT_MEMORY_CONFIG,
    type LogEntry, type WakeBlock, type WakeResult,
    type NoteResult, type RecallResult, type CompressResult,
    type ZoomResult, type NapPrompt, type MemoryConfig,
} from './types.ts';
import { validateRegexPattern } from '../../shared/regexGuard.ts';
import { MemoryLogStore, type MemoryEntriesSnapshot } from './MemoryLogStore.ts';
import { computeCover } from './cover.ts';
import { die, plural, MEMORY_CONFIG_BOUNDS, ZOOM_RAW_FALLBACK_MAX } from './logFormat.ts';
import {
    buildConfigContent as buildConfigFileContent,
    parseConfigContent as parseConfigFileContent,
    renameConfigOverwrite as renameConfigFileOverwrite,
    writeConfigAtomic as writeConfigFileAtomic,
} from './configFile.ts';
import { getProcessPathLock } from './processLock.ts';

interface SharedConfigState {
    lock: ReturnType<typeof getProcessPathLock>;
    value?: MemoryConfig;
    /** Last plugin settings seed seen in this process (not memory_config). */
    pluginSeed?: Partial<MemoryConfig>;
    /** Settings keys changed after the first seed and not yet persisted. */
    pendingPluginSeed?: Partial<MemoryConfig>;
}

const SHARED_CONFIG_STATES = new Map<string, SharedConfigState>();

function configStateKey(configPath: string): string {
    const absolute = path.resolve(configPath).replace(/\\/g, '/');
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function sharedConfigState(configPath: string): SharedConfigState {
    const key = configStateKey(configPath);
    let state = SHARED_CONFIG_STATES.get(key);
    if (!state) {
        state = { lock: getProcessPathLock('memory-config', configPath) };
        SHARED_CONFIG_STATES.set(key, state);
    }
    return state;
}

/**
 * Record a fiber's native-settings values synchronously at construction time.
 * This matters when settings HMR occurs before any lazy MemoryManager is opened:
 * the later manager must still observe that the seed changed in-process.
 */
export function recordPluginConfigSeed(configPath: string, seed: Partial<MemoryConfig>): void {
    if (Object.keys(seed).length === 0) return;
    const state = sharedConfigState(configPath);
    const previous = state.pluginSeed;
    if (!previous) {
        state.pluginSeed = { ...seed };
        return;
    }
    const pending = { ...(state.pendingPluginSeed ?? {}) };
    for (const key of Object.keys(seed) as Array<keyof MemoryConfig>) {
        if (seed[key] !== previous[key]) pending[key] = seed[key];
    }
    state.pluginSeed = { ...previous, ...seed };
    state.pendingPluginSeed = pending;
}

export class MemoryManager {
    private dir: string;
    /**
     * config 文件路径：默认 <dir>/config（各实例独立）；传入 sharedConfigPath
     * （全局共享配置 <dataPath>/memory/config）时使用共享路径——全局与所有工作区
     * 实例读写同一份 config，配置全局统一（记忆数据 LOG/TREE 仍按作用域隔离）。
     */
    private configPath: string;
    private config: MemoryConfig;
    private configState: SharedConfigState;
    /** LOG/TREE 底层存储（锁、记录宽度、槽位位图缓存均在其内部） */
    private store: MemoryLogStore;

    constructor(storagePath: string, config?: Partial<MemoryConfig>, sharedConfigPath?: string) {
        this.dir = storagePath;
        this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
        this.configPath = sharedConfigPath ?? path.join(this.dir, 'config');
        this.configState = sharedConfigState(this.configPath);
        this.store = new MemoryLogStore(this.dir, () => this.currentConfig());
    }

    private currentConfig(): MemoryConfig {
        return this.configState.value ?? this.config;
    }

    /** 初始化存储目录结构 */
    async init(): Promise<void> {
        await this.store.initStorage();
        // 写入默认 config（仅当文件不存在时）。共享全局 config 的工作区实例
        // （configPath 指向已存在的全局配置）绝不可覆盖重写——否则工作区初始化会
        // 把用户已改好的全局配置重置为默认值；只有首次初始化（文件不存在）才写默认。
        // 目标不存在时直接写：无旧内容可保护，原子 tmp+rename 无收益，且避免迁移类
        // 测试对 fs.rename 的计数把默认 config 写入误计入；updateConfig 改写才走原子写。
        const release = await this.configState.lock.acquire();
        try {
            try {
                const content = await fs.readFile(this.configPath, 'utf-8');
                this.configState.value = parseConfigFileContent(content);
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
                await fs.mkdir(path.dirname(this.configPath), { recursive: true });
                await fs.writeFile(this.configPath, buildConfigFileContent(this.config), 'utf-8');
                this.configState.value = { ...this.config };
            }
        } finally {
            release();
        }
    }

    // ─── 底层读写委托（方法体已抽离到 MemoryLogStore） ──────────────

    /** 确保存储就绪（新格式存在或旧格式已只读导入；等价旧 ensureLogMigrated） */
    private async ensureReady(): Promise<void> {
        await this.store.ensureReady();
    }

    private async logLen(): Promise<number> {
        return this.store.logLen();
    }

    private async logAppend(items: Array<{ date: string; text: string }>): Promise<number> {
        return this.store.logAppend(items);
    }

    private async logSlice(lo: number, hi: number): Promise<LogEntry[]> {
        return this.store.logSlice(lo, hi);
    }

    private async logGet(i: number): Promise<LogEntry> {
        return this.store.logGet(i);
    }

    private async rawEntryIdAt(i: number): Promise<number | null> {
        return this.store.rawEntryIdAt(i);
    }

    private logScan(): AsyncGenerator<LogEntry> {
        return this.store.logScan();
    }

    private async treeGet(lo: number, hi: number): Promise<string | null> {
        return this.store.treeGet(lo, hi);
    }

    private async treePut(lo: number, hi: number, text: string): Promise<boolean> {
        return this.store.treePut(lo, hi, text);
    }

    /** 丢弃树摘要及其上层 */
    async treeDrop(lo: number, hi: number): Promise<Array<[number, number]>> {
        return this.store.treeDrop(lo, hi);
    }

    private async dropSummariesCovering(id: number): Promise<void> {
        await this.store.dropSummariesCovering(id);
    }

    // ─── cover 算法 ─────────────────────────────

    /**
     * 生成 wake 应该展示的块列表。
     * 最多 `budget` 个块，细节向现在递增。
     */
    cover(T: number, budget: number): Array<[number, number]> {
        return computeCover(T, budget);
    }

    // ─── 压缩管理 ──────────────────────────────

    /** 列出所有待构建的块（最小优先） */
    async pending(T: number, limit?: number): Promise<Array<[number, number]>> {
        return this.store.pending(T, limit);
    }

    /** 待构建块的数量 */
    async pendingCount(T: number): Promise<number> {
        return this.store.pendingCount(T);
    }

    /** 生成压缩提示 */
    private async napPrompt(lo: number, hi: number, remaining: number): Promise<NapPrompt> {
        let body: string;
        if (hi - lo <= RAW_MAX) {
            const entries = await this.logSlice(lo, hi);
            body = entries.map(e => `  #${e.id} ${e.date} ${e.text}`).join('\n');
        } else {
            const mid = (lo + hi) >> 1;
            const halves: string[] = [];
            for (const [a, b] of [[lo, mid], [mid, hi]] as Array<[number, number]>) {
                const s = await this.treeGet(a, b);
                if (s === null) {
                    die(`The summary of #${a}-${b - 1} is blank. Run: memory_forget ${a}-${b - 1}`);
                }
                halves.push(`  #${a}-${b - 1} ${s}`);
            }
            body = halves.join('\n');
        }
        const tail = remaining === 0 ? '' :
            remaining === 1 ? '\n1 compression remains after this one.' :
            `\n${remaining} compressions remain after this one.`;

        const blockId = `${lo}-${hi - 1}`;
        // 修改原因：compress 的摘要预算已按树记录宽度钳制（min(entryChars, TREE_REC-1)，见 compress），
        //          提示语必须使用同一预算并按字节计，否则模型按 entryChars 生成超长摘要必然被拒。
        const summaryLimit = Math.min(this.currentConfig().entryChars, TREE_REC - 1);
        const prompt = `Compress memories #${lo}-${hi - 1} into one line of at most ${summaryLimit} bytes.\n` +
            `Keep what has lasting effect, drop what does not. Invent nothing.\n\n${body}${tail}\n` +
            `Run: memory_compress "${blockId}" "<your line>"`;

        return { blockId, lo, hi, prompt, remaining };
    }

    /** 获取下一个待压缩的提示 */
    async nextNap(T: number): Promise<NapPrompt | null> {
        const todo = await this.pending(T, 1);
        if (todo.length === 0) return null;
        const [lo, hi] = todo[0]!;
        return this.napPrompt(lo, hi, await this.pendingCount(T) - 1);
    }

    // ─── 分页 ──────────────────────────────────

    /** 将行列表按 PART_CHARS / PART_LINES 分页 */
    paginate(lines: string[]): string[][] {
        const parts: string[][] = [];
        let cur: string[] = [];
        let size = 0;
        for (const line of lines) {
            const n = Buffer.byteLength(line, 'utf-8') + 1;
            const cfg = this.currentConfig();
            if (cur.length > 0 && (cur.length >= cfg.partLines || size + n > cfg.partChars)) {
                parts.push(cur);
                cur = [];
                size = 0;
            }
            cur.push(line);
            size += n;
        }
        if (cur.length > 0) parts.push(cur);
        return parts;
    }

    // ─── 公共 API ─────────────────────────────

    /**
     * wake: 读取记忆。
     * @param part 要读取的部分号（1-based），不传则读第 1 部分
     * @param T 快照时的记忆总数（不传则用当前总数）
     */
    async wake(part?: number, T?: number): Promise<WakeResult> {
        await this.ensureReady();
        const now = await this.logLen();
        const snapshotT = T ?? now;
        if (snapshotT > now) {
            die(`T=${snapshotT}, but the log holds ${plural(now, 'memory')}. Run memory_wake.`);
        }

        if (snapshotT === 0) {
            return {
                blocks: [],
                part: 1,
                totalParts: 1,
                totalMemories: 0,
                awake: true,
            };
        }

        const lines: string[] = [];
        // 连续原始块（cover 输出按 lo 升序）合并为一次 logSlice 读取：
        // 此前逐块 logGet → logSlice 各做一次 open/read/close，记忆量大
        // （T ≤ wakeLines 可达 10000 条）时一次 wake 产生上万次文件句柄循环。
        let runLo = -1;
        let runHi = -1;
        const flushRawRun = async (lo: number, hi: number): Promise<void> => {
            const entries = await this.logSlice(lo, hi);
            // 按末条 id 校验日志未在读取期间被并发截断/改写：records() 会跳过损坏行，
            // 中间条目不要求严格连续（损坏行跳过而非误报「日志变化」）。
            // 末条 id !== hi-1 时区分「末条缺失」与「末条损坏」：
            // - 末条缺失（并发截断，或 deleteRange 重编号使位置 hi-1 的记录 id 已变）
            //   → 报「日志变化」；
            // - 末条损坏（位置 hi-1 的记录仍在但无法解析）→ 日志并未变化，重跑 wake
            //   仍会读到同一损坏记录，报「记录损坏」而非误报并发修改。
            if (entries.length === 0 || entries[entries.length - 1]!.id !== hi - 1) {
                const lastId = await this.rawEntryIdAt(hi - 1);
                const truncated = lastId === null && (await this.logLen()) <= hi - 1;
                if (lastId !== null || truncated) {
                    die(`The log changed while reading #${lo}-${hi - 1}. Run memory_wake again.`);
                }
                die(`Record #${hi - 1} is corrupted. Run memory_wake again.`);
            }
            for (const e of entries) {
                lines.push(`#${e.id} ${e.date} ${e.text}`);
            }
        };
        for (const [lo, hi] of this.cover(snapshotT, this.currentConfig().wakeLines)) {
            if (hi - lo === 1) {
                if (runLo < 0) runLo = lo;
                runHi = hi;
                continue;
            }
            if (runLo >= 0) {
                await flushRawRun(runLo, runHi);
                runLo = -1;
            }
            let s = await this.treeGet(lo, hi);
            if (s === null) {
                const pc = await this.pendingCount(snapshotT);
                if (pc > 0) {
                    // 直接用实际缺失的块构造提示，而不是 nextNap 返回的
                    // "第一个待压缩块"（可能不是 wake 实际缺失的那个块）。
                    const nap = await this.napPrompt(lo, hi, pc - 1);
                    throw new Error(
                        `Cannot wake: the memory context needs #${lo}-${hi - 1}, ` +
                        `which is not compressed yet.\nDo the ${plural(pc, 'compression')} below, ` +
                        `then run memory_wake again.\n\n${nap.prompt}`
                    );
                }
                s = await this.treeGet(lo, hi); // 并行会话可能已完成
            }
            if (s === null) {
                die(`The summary of #${lo}-${hi - 1} is blank. Run: memory_forget ${lo}-${hi - 1}`);
            }
            lines.push(`#${lo}-${hi - 1} ${s}`);
        }
        if (runLo >= 0) {
            await flushRawRun(runLo, runHi);
        }

        const parts = this.paginate(lines);
        const k = part ?? 1;
        // 非整数 part（如 1.5）会绕过区间校验后以 parts[1.5] 取 undefined 抛裸 TypeError
        if (!Number.isInteger(k) || k < 1 || k > parts.length) {
            die(`No part ${k}: the memory has ${plural(parts.length, 'part')}. Run memory_wake.`);
        }

        const awake = k >= parts.length;
        const blocks = this.parseWakeBlocks(parts[k - 1]!);

        let pendingCompression: NapPrompt | undefined;
        if (awake) {
            const nap = await this.nextNap(snapshotT);
            if (nap) pendingCompression = nap;
        }

        return {
            blocks,
            part: k,
            totalParts: parts.length,
            totalMemories: snapshotT,
            awake,
            pendingCompression,
        };
    }

    /** 解析 wake 输出行转为 WakeBlock[] */
    private parseWakeBlocks(lines: string[]): WakeBlock[] {
        const blocks: WakeBlock[] = [];
        for (const line of lines) {
            const m = line.match(/^#(\d+)(?:-(\d+))?\s(.+)$/);
            if (!m) continue;
            const lo = parseInt(m[1]!, 10);
            const hi = m[2] !== undefined ? parseInt(m[2], 10) : lo;
            blocks.push({ lo, hi, text: m[3]!, isRaw: lo === hi });
        }
        return blocks;
    }

    /**
     * note: 记录一条记忆。
     */
    async note(text: string): Promise<NoteResult> {
        const trimmed = text.trim();
        if (!trimmed) die('Empty. A memory is one line of text.');
        if (trimmed.includes('\n') || trimmed.includes('\r')) {
            die(`${trimmed.split(/\r?\n/).length} lines. A memory is one line.`);
        }
        const byteLen = Buffer.byteLength(trimmed, 'utf-8');
        const entryChars = this.currentConfig().entryChars;
        if (byteLen > entryChars) {
            die(`Too long: ${byteLen} bytes, limit ${entryChars}.`);
        }

        const today = new Date().toISOString().slice(0, 10);
        // 长度校验在 note 入口按 entryChars 执行（新格式 JSONL 无固定宽度容量限制）
        const id = await this.logAppend([{ date: today, text: trimmed }]);

        const nap = await this.nextNap(id + 1);
        return { id, pendingCompression: nap ?? undefined };
    }

    /**
     * recall: 正则搜索全部记忆。
     */
    async recall(regex: string): Promise<RecallResult> {
        await this.ensureReady();
        // ReDoS 防护：长度上限 + 危险模式检测 + 构造异常捕获（共享 regexGuard）
        const guarded = validateRegexPattern(regex, 'i');
        if (!guarded.ok) {
            die(`bad regex: ${guarded.error}`);
        }
        const pat = guarded.regex;

        // 用 head 指针代替 shift() 淘汰旧匹配：shift 是 O(n)，命中量大时整体退化为 O(n²)。
        // head 记录已被淘汰的窗口起点；淘汰数超过存活数一半时 splice 压缩数组（摊还 O(1)），
        // 数组容量始终约为存活窗口的 2 倍，不会随总命中数无限增长。
        const matches: string[] = [];
        let head = 0;
        let totalHits = 0;
        let size = 0;

        for await (const e of this.logScan()) {
            const line = `#${e.id} ${e.date} ${e.text}`;
            if (!pat.test(line)) continue;
            totalHits++;
            matches.push(line);
            size += Buffer.byteLength(line, 'utf-8') + 1;
            // 保持最新的匹配，丢弃最旧的
            while (size > this.currentConfig().partChars && head < matches.length) {
                size -= Buffer.byteLength(matches[head]!, 'utf-8') + 1;
                head++;
            }
            // 淘汰超过一半时压缩，防止 head 无界增长
            if (head > 0 && head * 2 >= matches.length) {
                matches.splice(0, head);
                head = 0;
            }
        }

        if (totalHits === 0) {
            return { lines: [], totalHits: 0, truncated: false };
        }

        const lines = head === 0 ? matches : matches.slice(head);
        const truncated = lines.length < totalHits;
        return { lines, totalHits, truncated };
    }

    /**
     * compress: 执行压缩合并（OptMem 的 nap）。
     * @param blockId 块 ID（如 "0-1"），不传则自动处理下一个
     * @param summary 压缩后的摘要文本
     */
    async compress(blockId?: string, summary?: string): Promise<CompressResult> {
        await this.ensureReady();
        const T = await this.logLen();
        let said = false;

        if (blockId && summary === undefined) {
            die('summary is required when blockId is provided.');
        }

        // 反向缺参校验：提供了 summary 却没有 blockId（含空串——调用方按 truthy 归一化，
        // 直接传 '' 与未传同口径）时，静默丢弃摘要等同数据丢失，明确报错。
        if (!blockId && summary !== undefined) {
            die('blockId is required when summary is provided.');
        }

        if (blockId && summary !== undefined) {
            const [lo, hi] = this.parseBlockId(blockId);
            const todo = await this.pending(T, 1);
            if (todo.length === 0) {
                // B-7: 无待压缩块时也要校验请求块——越界/未压缩的块给出明确错误，
                // 而不是静默返回 done:0（已压缩的块重复提交仍幂等返回 done:0）。
                const existing = await this.treeGet(lo, hi);
                if (existing === null) {
                    die(`Wrong block: ${blockId}. Nothing is pending for compression. Run memory_compress.`);
                }
                return { done: 0 };
            }
            if (lo !== todo[0]![0] || hi !== todo[0]![1]) {
                const existing = await this.treeGet(lo, hi);
                if (existing === null) {
                    die(`Wrong block: ${blockId}. Blocks are built in order; the next is ` +
                        `${todo[0]![0]}-${todo[0]![1] - 1}. Run memory_compress.`);
                }
            } else {
                const trimmed = (summary || '').trim();
                if (!trimmed) die('Empty summary.');
                if (trimmed.includes('\n') || trimmed.includes('\r')) {
                    // 摘要含换行会破坏「一行摘要」不变量；与 note/updateEntry 对记忆文本的校验口径一致。
                    die('A summary is one line.');
                }
                const byteLen = Buffer.byteLength(trimmed, 'utf-8');
                // 摘要预算钳制为 min(entryChars, TREE_REC-1)：TREE_REC-1=287 是旧固定宽度树记录
                // 的容量上限，新格式 summaries.jsonl 无此限制，但保留该钳制以维持工具语义不变
                //（napPrompt 提示语与 compress 校验使用同一预算，模型不会生成必然被拒的超长摘要）。
                const summaryLimit = Math.min(this.currentConfig().entryChars, TREE_REC - 1);
                if (byteLen > summaryLimit) {
                    die(`Too long: ${byteLen} bytes, limit ${summaryLimit}.`);
                }
                const ok = await this.treePut(lo, hi, trimmed);
                if (ok) {
                    // 只有真正写入成功才置 said=true：
                    // 块已存在或 treePut 返回 false（并行会话已处理）时保持 said=false，
                    // 避免上报 done:1 与实际写入不符。
                    said = true;
                } else {
                    // B-7: treePut 返回 false（并行会话已压缩该块）时明确告警，不再静默丢弃摘要；
                    // 保持 said=false（done:0），与并行会话幂等语义一致。
                    console.warn(`[MemoryManager] Block ${blockId} was already compressed by another session; summary not written.`);
                }
            }
        }

        const nap = await this.nextNap(T);
        return { done: said ? 1 : 0, pendingCompression: nap ?? undefined };
    }

    /**
     * zoom: 展开树节点查看两半。
     */
    async zoom(blockId: string): Promise<ZoomResult> {
        await this.ensureReady();
        const [lo, hi] = this.parseBlockId(blockId);
        const T = await this.logLen();
        if (lo >= T) {
            die(`#${blockId} is beyond the memory: it holds ${plural(T, 'memory')}. Run memory_wake.`);
        }
        const mid = (lo + hi) >> 1;
        const halves: WakeBlock[] = [];
        for (const [a0, b0] of [[lo, mid], [mid, hi]] as Array<[number, number]>) {
            if (a0 >= T) continue;
            // 钳制上界：旧 blockId 的半区可能越过当前 T（如块 0-7、T=5 时右半 [4,8)），
            // 不钳制则 treeGet(4,8) 返回 {lo:4, hi:7}——hi 越出 T-1=4 的幻影摘要块。
            // b = min(b0, T) 后摘要/原始块只覆盖真实存在的记忆；钳制后 b - a0 === 1
            // 时降级为单条原始块，非 2 幂宽度（>1）时降级为原始条目（见下方分支）。
            const b = Math.min(b0, T);
            if (b - a0 === 1) {
                const e = await this.logGet(a0);
                halves.push({ lo: a0, hi: a0, text: `${e.date} ${e.text}`, isRaw: true });
            } else if ((b - a0 & (b - a0 - 1)) !== 0 && b - a0 <= ZOOM_RAW_FALLBACK_MAX) {
                // 钳制后的宽度非 2 的幂（如旧 blockId 的右半 [mid, T) 只剩 T-mid 条，
                // 或 T < mid 时左半宽度 T-lo）：压缩只写 2 幂对齐块，该区间从未也不可能
                // 作为整体被压缩，treeGet 必 null——显示 "not compressed yet" 会误导
                // （再跑 memory_compress 也不会产出该块）。降级为原始条目展示真实内容
                //（与 wake 的原始块同语义）；宽度超过 ZOOM_RAW_FALLBACK_MAX 时仍回退
                // 摘要占位，避免超大缓冲一次性读入。
                const entries = await this.logSlice(a0, b);
                if (entries.length > 0) {
                    halves.push({
                        lo: a0,
                        hi: b - 1,
                        text: entries.map(e => `${e.date} ${e.text}`).join('\n'),
                        isRaw: true,
                    });
                } else {
                    halves.push({ lo: a0, hi: b - 1, text: 'not compressed yet', isRaw: false });
                }
            } else {
                const s = await this.treeGet(a0, b);
                halves.push({ lo: a0, hi: b - 1, text: s || 'not compressed yet', isRaw: false });
            }
        }
        // 右半完全超出当前 T（mid >= T）时不返回幻影原始块（isRaw:true 的空块会被
        // 当作真实原始记忆展示）：回退为空摘要块（isRaw:false），lo/hi 标注为
        // [mid, T-1]（T 已知：右半未覆盖任何真实记忆，lo > hi 表示空区间，
        // hi 取日志末索引 T-1 而非幻影索引 mid）。
        return { left: halves[0]!, right: halves[1] || { lo: mid, hi: T - 1, text: '', isRaw: false } };
    }

    /**
     * forget: 丢弃树摘要。
     */
    async forget(blockId: string): Promise<{ gone: number; firstId: string }> {
        const [lo, hi] = this.parseBlockId(blockId);
        const gone = await this.treeDrop(lo, hi);
        if (gone.length === 0) {
            die(`No summary at ${blockId}.`);
        }
        return {
            gone: gone.length,
            firstId: `${gone[0]![0]}-${gone[0]![1] - 1}`,
        };
    }

    /**
     * listEntries: 返回所有原始记忆条目。
     *
     * 新格式存储把 records.jsonl 全量缓存在内存（mtime+size 一致性校验），
     * logScan 在锁内取快照后逐条 yield，不再做逐块文件 IO。
     *
     * @param limit 可选：最多返回的条目数（不传则返回全部）
     */
    async listEntries(limit?: number): Promise<LogEntry[]> {
        const snapshot = await this.listEntriesSnapshot();
        return limit === undefined ? snapshot.entries : snapshot.entries.slice(0, limit);
    }

    /** Complete entry snapshot plus the revision used by Remote CAS writes. */
    async listEntriesSnapshot(): Promise<MemoryEntriesSnapshot> {
        await this.ensureReady();
        return this.store.listEntriesSnapshot();
    }

    /** 当前原始记忆总数（O(1)，仅一次 stat；供设置页列表分页/截断展示） */
    async totalEntries(): Promise<number> {
        await this.ensureReady();
        return this.logLen();
    }

    /**
     * updateEntry: 原地覆写单条原始记忆的文本（保留 id/日期，更新版本与时间戳）。
     * 新文本不得超过 entryChars（默认 280，上限 1000）。
     */
    async updateEntry(id: number, text: string, expectedRevision?: string): Promise<LogEntry> {
        return this.store.updateEntry(id, text, 'update', expectedRevision);
    }

    /**
     * deleteRange: 删除闭区间 [lo, hi] 内的所有原始记忆（真·单条/批量删除，不连坐 truncateLog）。
     * 实现已抽离到 MemoryLogStore（行为不变）。
     */
    async deleteRange(lo: number, hi: number, expectedRevision?: string): Promise<{ removed: number }> {
        return this.store.deleteRange(lo, hi, expectedRevision);
    }

    /**
     * deleteEntry: 删除单条原始记忆（真·单条删除，不连坐 truncateLog）。
     */
    async deleteEntry(id: number, expectedRevision?: string): Promise<{ removed: number }> {
        return this.deleteRange(id, id, expectedRevision);
    }

    /**
     * deleteEntries: 批量删除多条原始记忆。
     * 实现已抽离到 MemoryLogStore（行为不变）。
     */
    async deleteEntries(ids: number[]): Promise<{ removed: number }> {
        return this.store.deleteEntries(ids);
    }

    /**
     * truncateLog: 截断原始 LOG，删除 ID >= keepId 的所有记忆及其相关树摘要。
     * keepId=0 表示清空全部记忆。
     */
    async truncateLog(keepId: number): Promise<{ removed: number }> {
        return this.store.truncateLog(keepId);
    }

    /**
     * 获取/设置配置。
     */
    getConfig(): MemoryConfig {
        return { ...this.currentConfig() };
    }

    async updateConfig(updates: Partial<MemoryConfig>): Promise<MemoryConfig> {
        // 逐项校验：非法值直接抛错（与模块内 die() 的错误风格一致，工具层会转成失败结果），
        // 避免 entryChars 被设为 >1000 后所有 note/compress 在长度校验处抛晦涩错误。
        const validated: Partial<MemoryConfig> = {};
        for (const [key, min, max] of MEMORY_CONFIG_BOUNDS) {
            const value = updates[key];
            if (value === undefined) continue;
            if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
                die(`Invalid ${key}: ${String(value)}. Must be an integer between ${min} and ${max}.`);
            }
            validated[key] = value;
        }
        // BUG-08: 先写盘成功再提交内存——写盘失败（磁盘满/权限/rename 重试耗尽）时
        // 抛错且内存保持旧值，避免「工具报失败但进程内配置已生效」的内存/磁盘分叉。
        const release = await this.configState.lock.acquire();
        try {
            // Always merge over the latest file while holding the shared lock:
            // independent services updating different keys cannot clobber one
            // another with a stale whole-file snapshot.
            const base = await this.readConfigUnlocked();
            const next: MemoryConfig = { ...base, ...validated };
            await this.writeConfig(next);
            this.configState.value = next;
            return { ...next };
        } finally {
            release();
        }
    }

    /**
     * Reconcile native plugin settings with the persisted memory_config.
     *
     * The first seed observed in a process is only a baseline, so a process
     * restart preserves explicit memory_config overrides. A later fiber with
     * changed settings applies only the keys that changed from that baseline;
     * this is the settings live-update signal and preserves unrelated tool
     * updates.
     */
    async applyPluginSeed(seed: Partial<MemoryConfig>): Promise<MemoryConfig> {
        const keys = Object.keys(seed) as Array<keyof MemoryConfig>;
        if (keys.length === 0) return this.loadConfig();
        if (!this.configState.pluginSeed) recordPluginConfigSeed(this.configPath, seed);
        const release = await this.configState.lock.acquire();
        try {
            const base = await this.readConfigUnlocked();
            const changed = { ...(this.configState.pendingPluginSeed ?? {}) };
            if (Object.keys(changed).length === 0) {
                this.configState.value = base;
                return { ...base };
            }
            const next = { ...base, ...changed };
            await this.writeConfig(next);
            this.configState.value = next;
            // A newer fiber may have changed a key while the file write was in
            // flight. Clear only values that still equal this applied batch.
            const pending = { ...(this.configState.pendingPluginSeed ?? {}) };
            for (const key of Object.keys(changed) as Array<keyof MemoryConfig>) {
                if (pending[key] === changed[key]) delete pending[key];
            }
            this.configState.pendingPluginSeed = pending;
            return { ...next };
        } finally {
            release();
        }
    }

    /** 构造 config 文件内容（注释头 + 各配置行；与 OptMem 的 memo config 格式一致） */
    private buildConfigContent(cfg: MemoryConfig): string {
        return buildConfigFileContent(cfg);
    }

    /**
     * Windows 上 rename 到已存在目标偶发 EPERM/EEXIST（文件锁/杀软竞态）：
     * 短暂退避重试；重试耗尽后先删旧目标再 rename。实现已抽离到 configFile（行为不变）。
     */
    private async renameConfigOverwrite(tmpPath: string, configPath: string): Promise<void> {
        await renameConfigFileOverwrite(tmpPath, configPath);
    }

    /** 原子写配置：先写同目录临时文件再 rename 替换。实现已抽离到 configFile（行为不变）。 */
    private async writeConfig(cfg: MemoryConfig): Promise<void> {
        await writeConfigFileAtomic(this.configPath, buildConfigFileContent(cfg));
    }

    /** Read the latest on-disk config. Caller must hold configState.lock. */
    private async readConfigUnlocked(): Promise<MemoryConfig> {
        try {
            const content = await fs.readFile(this.configPath, 'utf-8');
            return parseConfigFileContent(content);
        } catch {
            return { ...(this.configState.value ?? this.config) };
        }
    }

    /**
     * 从存储目录读取已有配置。
     */
    async loadConfig(): Promise<MemoryConfig> {
        const release = await this.configState.lock.acquire();
        try {
            const cfg = await this.readConfigUnlocked();
            this.configState.value = cfg;
            return { ...cfg };
        } finally {
            release();
        }
    }

    /** 解析块 ID 字符串 "lo-hi" → [lo, hi) */
    parseBlockId(s: string): [number, number] {
        const m = s.match(/^(\d+)-(\d+)$/);
        if (!m) die(`'${s}' is not a block id. Copy it from the prompt.`);
        const lo = parseInt(m[1]!, 10);
        const hi = parseInt(m[2]!, 10) + 1;
        const n = hi - lo;
        if (n < 2 || (n & (n - 1)) !== 0 || lo % n !== 0) {
            die(`${s} is not a block. Copy the id printed by wake, like 16-31.`);
        }
        return [lo, hi];
    }

}
