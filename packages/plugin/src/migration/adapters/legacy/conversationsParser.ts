/**
 * GrayCode - migration legacy conversations 只读解析器
 *
 * 会话存储规范见 docs/legacy-format.md §1：
 * - legacy 单文件历史：`conversations/{convId}.json` = Content[] JSON 数组；
 * - segmented 历史：`conversations/{convId}/history/*.ndjson`（每行一条 JSON
 *   Content）+ `history.index.json`（段索引，提交点）；读取前校验一致性
 *   （Σcount === totalMessages 且段区间连续不重叠）；段缺失 → SEGMENT_MISSING；
 * - 元数据：`{convId}.meta.json`（损坏 → META_CORRUPT，隔离）；
 * - 子代理 transcript：`subagents/{runId}.json`（best-effort，损坏不致命）；
 * - 分支图：`branches.json`（best-effort）。
 *
 * 全部解析为「读侧视图」：迁移器不写回旧目录。
 */

import { MIGRATION_ERROR_CODES } from '../../domain/types.ts'

export interface ParsedSubAgent {
  runId: string
  valid: boolean
  contents: unknown[]
}

export interface ParsedConversation {
  conversationId: string
  metaValid: boolean
  title?: string
  createdAt?: number
  updatedAt?: number
  workspaceUri?: string
  custom?: Record<string, unknown>
  /** history 解析出的 Content[]（legacy 数组原样保留条目） */
  history: unknown[]
  historyFormat: 'legacy' | 'segmented' | 'none'
  historyValid: boolean
  historyErrorCode?: string
  subagents: ParsedSubAgent[]
  branchesValid: boolean
  branches?: unknown
  usageIndexPresent: boolean
}

export interface FileHistoryIndex {
  version?: number
  segmentSize?: number
  totalMessages?: number
  segments?: Array<{ file?: string; startIndex?: number; endIndex?: number; count?: number }>
}

export function parseConversationMeta(raw: string): {
  valid: boolean
  title?: string
  createdAt?: number
  updatedAt?: number
  workspaceUri?: string
  custom?: Record<string, unknown>
} {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { valid: false }
    const meta = parsed as Record<string, unknown>
    return {
      valid: true,
      ...(typeof meta.title === 'string' ? { title: meta.title } : {}),
      ...(typeof meta.createdAt === 'number' ? { createdAt: meta.createdAt } : {}),
      ...(typeof meta.updatedAt === 'number' ? { updatedAt: meta.updatedAt } : {}),
      ...(typeof meta.workspaceUri === 'string' ? { workspaceUri: meta.workspaceUri } : {}),
      ...(meta.custom && typeof meta.custom === 'object' && !Array.isArray(meta.custom)
        ? { custom: meta.custom as Record<string, unknown> }
        : {}),
    }
  } catch {
    return { valid: false }
  }
}

/** legacy 单文件历史：必须是 Content[] 数组（F14b：非数组 → HISTORY_NOT_ARRAY） */
export function parseLegacyHistory(raw: string): { valid: boolean; history: unknown[]; errorCode?: string } {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return { valid: false, history: [], errorCode: MIGRATION_ERROR_CODES.HISTORY_NOT_ARRAY }
    }
    return { valid: true, history: parsed }
  } catch {
    return { valid: false, history: [], errorCode: MIGRATION_ERROR_CODES.HISTORY_NOT_ARRAY }
  }
}

/**
 * segmented 历史：解析索引 + 按序拼接段文件。
 * 一致性校验（legacy-format.md §1.4）：Σcount === totalMessages 且段区间连续不重叠；
 * 单段不可读 → 整历史报 SEGMENT_MISSING。
 */
export function parseSegmentedHistory(
  indexRaw: string,
  readSegment: (fileName: string) => Promise<string>,
): Promise<{ valid: boolean; history: unknown[]; errorCode?: string }> {
  return (async () => {
    let index: FileHistoryIndex
    try {
      index = JSON.parse(indexRaw) as FileHistoryIndex
    } catch {
      return { valid: false, history: [], errorCode: MIGRATION_ERROR_CODES.INDEX_INCONSISTENT }
    }
    const segments = Array.isArray(index.segments) ? index.segments : []
    if (segments.length === 0) {
      return { valid: false, history: [], errorCode: MIGRATION_ERROR_CODES.INDEX_INCONSISTENT }
    }
    const total = typeof index.totalMessages === 'number' ? index.totalMessages : -1
    let sum = 0
    let expectStart = 0
    for (const segment of segments) {
      const file = typeof segment.file === 'string' ? segment.file : ''
      const start = typeof segment.startIndex === 'number' ? segment.startIndex : -1
      const end = typeof segment.endIndex === 'number' ? segment.endIndex : -1
      const count = typeof segment.count === 'number' ? segment.count : -1
      if (!file || start < 0 || end < start || count < 0 || start !== expectStart) {
        return { valid: false, history: [], errorCode: MIGRATION_ERROR_CODES.INDEX_INCONSISTENT }
      }
      if (end - start + 1 !== count) {
        return { valid: false, history: [], errorCode: MIGRATION_ERROR_CODES.INDEX_INCONSISTENT }
      }
      sum += count
      expectStart = end + 1
    }
    if (total >= 0 && sum !== total) {
      // F14d：totalMessages ≠ Σcount → 会话级降级
      return { valid: false, history: [], errorCode: MIGRATION_ERROR_CODES.INDEX_INCONSISTENT }
    }

    const history: unknown[] = []
    for (const segment of segments) {
      let content: string
      try {
        content = await readSegment(segment.file ?? '')
      } catch {
        // F14c：段文件缺失 → 整历史报 segment_missing，其余会话照常
        return { valid: false, history: [], errorCode: MIGRATION_ERROR_CODES.SEGMENT_MISSING }
      }
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          history.push(JSON.parse(trimmed))
        } catch {
          // 段内单行损坏：跳过该行（记录级隔离），不中断会话
        }
      }
    }
    return { valid: true, history }
  })()
}

/** 子代理 transcript（legacy-format.md §1.5）；损坏 → valid=false 不致命 */
export function parseSubAgentTranscript(raw: string): { valid: boolean; contents: unknown[] } {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { valid: false, contents: [] }
    const contents = (parsed as Record<string, unknown>).contents
    return {
      valid: Array.isArray(contents),
      contents: Array.isArray(contents) ? contents : [],
    }
  } catch {
    return { valid: false, contents: [] }
  }
}

/** branches.json（legacy-format.md §1.7）；损坏返回 null */
export function parseBranchesGraph(raw: string): { valid: boolean; graph?: unknown } {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { valid: false }
    return { valid: true, graph: parsed }
  } catch {
    return { valid: false }
  }
}

/** 快照（legacy-format.md §1.6） */
export function parseSnapshot(raw: string): { valid: boolean; snapshot?: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { valid: false }
    const snapshot = parsed as Record<string, unknown>
    if (typeof snapshot.id !== 'string' || !Array.isArray(snapshot.history)) return { valid: false }
    return { valid: true, snapshot }
  } catch {
    return { valid: false }
  }
}
