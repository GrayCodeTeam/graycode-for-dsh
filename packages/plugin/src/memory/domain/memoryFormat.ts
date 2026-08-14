/**
 * GrayCode - Memory 新格式（JSONL）schema 与编解码
 *
 * 新运行时写入格式（详见 docs/memory-format.md）：
 * - records.jsonl    追加式条目日志：一行一条 StoredRecord；损坏行/空行以 null
 *                    占位保留位置（logLen 口径与旧固定宽度物理计数一致）；
 * - summaries.jsonl  二叉树摘要：一行一条 StoredSummary（键 "lo:hi"，hi 不包含）；
 * - meta.json        schema 版本 + 旧格式导入标记（formatVersion 版本化，
 *                    未来格式升级经 upgradeMemoryMeta 逐级迁移）。
 *
 * 旧 LOG.txt（320/1024B 固定宽度）与 TREE/（288B 摘要槽位）只由 legacy reader
 * 解析（logFormat.ts），用于一次性只读导入（MemoryLogStore.importLegacyLocked），
 * 新运行时不再暴露旧二进制布局给业务层。
 */

import { die } from './logFormat.ts';

/** 当前存储格式版本（meta.json 的 formatVersion）。 */
export const MEMORY_FORMAT_VERSION = 1;

/**
 * 单条记忆条目（records.jsonl 的一行）。
 * 必填：id / date / text；其余字段可选（P3B 契约：标签、来源、创建/更新时间、
 * 版本、legacy id）。
 */
export interface StoredRecord {
    /** 条目 ID：真实记录在文件中的序号（连续）；损坏行占位为 null 不计 ID */
    id: number;
    /** 展示/检索日期，ISO YYYY-MM-DD（与旧格式 "#id date text" 的 date 同语义） */
    date: string;
    /** 记忆文本（单行） */
    text: string;
    /** 创建时间（完整 ISO 时间戳） */
    createdAt?: string;
    /** 最后更新时间（完整 ISO 时间戳） */
    updatedAt?: string;
    /** 并发版本：每次原地更新 +1（缺失按 1 计） */
    version?: number;
    /** 审计来源：note / update / compress / legacy-import 等 */
    source?: string;
    /** 标签 */
    tags?: string[];
    /** 旧格式导入前的原始 id（新格式重编号后用于溯源） */
    legacyId?: number;
}

/** 树摘要（summaries.jsonl 的一行；[lo, hi)，块宽为 2 的幂） */
export interface StoredSummary {
    /** 块起始 id（包含） */
    lo: number;
    /** 块结束 id（不包含） */
    hi: number;
    /** 压缩执行日（ISO YYYY-MM-DD；旧 TREE 纯文本槽位无日期时缺省） */
    date?: string;
    /** 摘要文本（单行） */
    text: string;
    /** 审计来源 */
    source?: string;
}

/** 旧格式导入统计（meta.json 的 importedFromLegacy） */
export interface LegacyImportInfo {
    /** 导入时间（完整 ISO 时间戳） */
    at: string;
    /** 旧 LOG 记录宽度（320 或 1024；无 LOG 时为 0） */
    logRec: number;
    /** 导入的条目数（不含损坏占位） */
    logImported: number;
    /** 跳过的条目数（损坏/空切片/异常 id） */
    logSkipped: number;
    /** 导入的树摘要数 */
    treeImported: number;
    /** 跳过的树槽位数（空槽/损坏槽）+ 整文件损坏跳过的文件数 */
    treeSkipped: number;
    /** 成功解析的 TREE 文件名（2 的幂 size） */
    files: string[];
}

/** meta.json 内容 */
export interface MemoryMeta {
    /** 存储格式版本（当前 MEMORY_FORMAT_VERSION=1） */
    formatVersion: number;
    /** 旧格式导入标记；全新存储为 null */
    importedFromLegacy: LegacyImportInfo | null;
}

/** 摘要键："lo:hi" */
export function summaryKey(lo: number, hi: number): string {
    return `${lo}:${hi}`;
}

// ─── 条目编解码 ──────────────────────────────

/** 序列化一条记录（含结尾换行） */
export function encodeRecordLine(rec: StoredRecord): string {
    return JSON.stringify(rec) + '\n';
}

/**
 * 解析一行记录；任何结构非法（非 JSON、字段缺失/类型错误）返回 null，
 * 由调用方以占位（位置保留）隔离，不中断整体读取（损坏隔离）。
 */
export function decodeRecordLine(line: string): StoredRecord | null {
    let obj: unknown;
    try {
        obj = JSON.parse(line);
    } catch {
        return null;
    }
    if (typeof obj !== 'object' || obj === null) return null;
    const o = obj as Record<string, unknown>;
    if (typeof o.id !== 'number' || !Number.isInteger(o.id) || o.id < 0) return null;
    if (typeof o.date !== 'string' || typeof o.text !== 'string') return null;
    const rec: StoredRecord = { id: o.id, date: o.date, text: o.text };
    if (typeof o.createdAt === 'string') rec.createdAt = o.createdAt;
    if (typeof o.updatedAt === 'string') rec.updatedAt = o.updatedAt;
    if (typeof o.version === 'number' && Number.isInteger(o.version) && o.version > 0) {
        rec.version = o.version;
    }
    if (typeof o.source === 'string') rec.source = o.source;
    if (Array.isArray(o.tags) && o.tags.every(t => typeof t === 'string')) {
        rec.tags = o.tags as string[];
    }
    if (typeof o.legacyId === 'number' && Number.isInteger(o.legacyId) && o.legacyId >= 0) {
        rec.legacyId = o.legacyId;
    }
    return rec;
}

// ─── 摘要编解码 ──────────────────────────────

/** 序列化一条摘要（含结尾换行） */
export function encodeSummaryLine(s: StoredSummary): string {
    return JSON.stringify(s) + '\n';
}

/** 解析一行摘要；结构非法返回 null（调用方跳过，损坏隔离） */
export function decodeSummaryLine(line: string): StoredSummary | null {
    let obj: unknown;
    try {
        obj = JSON.parse(line);
    } catch {
        return null;
    }
    if (typeof obj !== 'object' || obj === null) return null;
    const o = obj as Record<string, unknown>;
    if (typeof o.lo !== 'number' || !Number.isInteger(o.lo) || o.lo < 0) return null;
    if (typeof o.hi !== 'number' || !Number.isInteger(o.hi) || o.hi <= o.lo) return null;
    if (typeof o.text !== 'string') return null;
    const s: StoredSummary = { lo: o.lo, hi: o.hi, text: o.text };
    if (typeof o.date === 'string') s.date = o.date;
    if (typeof o.source === 'string') s.source = o.source;
    return s;
}

// ─── meta 编解码与版本升级 ─────────────────────

/** 序列化 meta.json（美化 + 结尾换行） */
export function buildMetaContent(meta: MemoryMeta): string {
    return JSON.stringify(meta, null, 2) + '\n';
}

/** 解析 meta.json 并升级到当前版本；结构非法抛错（调用方决定宽容策略） */
export function parseMetaContent(content: string): MemoryMeta {
    let raw: unknown;
    try {
        raw = JSON.parse(content);
    } catch (e) {
        die(`memory meta: not valid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
    return upgradeMemoryMeta(raw);
}

function isValidLegacyImportInfo(v: unknown): v is LegacyImportInfo {
    if (typeof v !== 'object' || v === null) return false;
    const o = v as Record<string, unknown>;
    return typeof o.at === 'string' &&
        typeof o.logRec === 'number' &&
        typeof o.logImported === 'number' &&
        typeof o.logSkipped === 'number' &&
        typeof o.treeImported === 'number' &&
        typeof o.treeSkipped === 'number' &&
        Array.isArray(o.files) && o.files.every(f => typeof f === 'string');
}

/**
 * meta 版本升级入口（预留）：
 * - null / undefined / formatVersion < 1 → 全新存储（v1）；
 * - formatVersion === 1 → 校验并透传（v1 为初始版本，无迁移动作）；
 * - formatVersion > 当前 → 拒绝（数据由更新版本运行时写入，可能不兼容）；
 * - 未来格式在此按版本逐级升级，例如：if (version === 2) { ... }。
 */
export function upgradeMemoryMeta(raw: unknown): MemoryMeta {
    if (raw === null || raw === undefined) {
        return { formatVersion: MEMORY_FORMAT_VERSION, importedFromLegacy: null };
    }
    if (typeof raw !== 'object') {
        die('memory meta: not an object');
    }
    const o = raw as Record<string, unknown>;
    if (typeof o.formatVersion !== 'number' || !Number.isInteger(o.formatVersion)) {
        die('memory meta: missing or invalid formatVersion');
    }
    if (o.formatVersion > MEMORY_FORMAT_VERSION) {
        die(`memory meta: formatVersion ${o.formatVersion} is newer than supported ` +
            `${MEMORY_FORMAT_VERSION}; upgrade the plugin.`);
    }
    if (o.formatVersion < 1) {
        // v0 不存在：视作全新存储
        return { formatVersion: MEMORY_FORMAT_VERSION, importedFromLegacy: null };
    }
    // version === 1（当前）
    const imported = o.importedFromLegacy;
    return {
        formatVersion: MEMORY_FORMAT_VERSION,
        importedFromLegacy: isValidLegacyImportInfo(imported) ? imported : null,
    };
}
