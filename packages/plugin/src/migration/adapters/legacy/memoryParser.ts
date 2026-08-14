/**
 * GrayCode - migration legacy memory 只读解析器
 *
 * 复用现有 memory/domain/logFormat.ts 的解析能力（records/parse/OLD_LOG_REC），
 * 不重写字节解析；本文件只做：格式探测（320 vs 1024 vs 撕裂）、TREE 槽位映射、
 * scope.json 读取。
 *
 * 格式规范见 docs/legacy-format.md §3.2/§3.3/§3.6：
 * - LOG_REC=1024（新）/ OLD_LOG_REC=320（旧）；记录 "#<id> <date> <text>"；
 * - 探测：先看 320 对齐且全部切片合法（id 连续 + ISO 日期）→ 旧格式；
 *   再试 1024 全合法 → 新格式；都不满足 → 撕裂（只解析完整记录）；
 * - 损坏行跳过而非报错（记录级隔离，不中断整体导入）；
 * - TREE 文件：文件名 = 块大小，槽位 index = lo / size，记录宽 TREE_REC=288。
 */

import {
  OLD_LOG_REC,
  parse as parseRecord,
  records as parseRecords,
} from '../../../memory/domain/logFormat.ts'
import { LOG_REC, TREE_REC, type LogEntry } from '../../../memory/domain/types.ts'

export type MemoryLogFormat = 'new' | 'old' | 'torn' | 'empty'

export interface ParsedMemoryLog {
  format: MemoryLogFormat
  entries: LogEntry[]
}

export interface ParsedMemoryTree {
  blockSize: number
  summaries: Array<LogEntry & { lo: number; hi: number }>
}

export interface MemoryScopeMeta {
  fsPath?: string
  name?: string
  uri?: string
  cwd?: string
}

/** 320 对齐下全部切片是否合法（id 从 0 连续 + ISO 日期） */
function isStrictFormat(buf: Buffer, rec: number): boolean {
  const count = buf.length / rec
  if (!Number.isInteger(count) || count === 0) return false
  const entries = parseRecords(buf, rec)
  if (entries.length !== count) return false
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (!entry) return false
    if (entry.id !== i) return false
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return false
  }
  return true
}

/**
 * 解析 LOG.txt（只读，不迁移/不修复文件）。
 * 判定顺序：旧 320 全合法 → 新 1024 全合法 → 320 对齐（降级 320 读，跳过损坏行）
 * → 撕裂（按 1024 解析完整记录，忽略残尾）。
 */
export function parseMemoryLog(buf: Buffer): ParsedMemoryLog {
  if (buf.length === 0) return { format: 'empty', entries: [] }
  const oldAligned = buf.length % OLD_LOG_REC === 0
  const newAligned = buf.length % LOG_REC === 0

  if (oldAligned && isStrictFormat(buf, OLD_LOG_REC)) {
    return { format: 'old', entries: parseRecords(buf, OLD_LOG_REC) }
  }
  if (newAligned && isStrictFormat(buf, LOG_REC)) {
    return { format: 'new', entries: parseRecords(buf, LOG_REC) }
  }
  if (oldAligned) {
    // 320 对齐但内容不合法（F10b：id 不连续等）：降级 320 宽度读取并跳过损坏行
    return { format: 'old', entries: parseRecords(buf, OLD_LOG_REC) }
  }
  // 撕裂（F14h）：只解析完整 1024 记录，残尾忽略（不修复源文件）
  return { format: 'torn', entries: parseRecords(buf, LOG_REC) }
}

/** 解析 TREE/<blockSize> 摘要文件（每条 TREE_REC 字节；损坏行跳过） */
export function parseMemoryTree(buf: Buffer, blockSize: number): ParsedMemoryTree {
  const raw = parseRecords(buf, TREE_REC)
  const summaries = raw.map((entry, slot) => ({
    ...entry,
    lo: slot * blockSize,
    hi: (slot + 1) * blockSize,
  }))
  return { blockSize, summaries }
}

/** 解析 scope.json（memory-workspaces/<hash>/scope.json）；损坏返回 null */
export function parseMemoryScope(raw: string): MemoryScopeMeta | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const candidate = parsed as Partial<MemoryScopeMeta>
    return {
      ...(typeof candidate.fsPath === 'string' ? { fsPath: candidate.fsPath } : {}),
      ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
      ...(typeof candidate.uri === 'string' ? { uri: candidate.uri } : {}),
      ...(typeof candidate.cwd === 'string' ? { cwd: candidate.cwd } : {}),
    }
  } catch {
    return null
  }
}

export { parseRecord, parseRecords, LOG_REC, OLD_LOG_REC, TREE_REC }
