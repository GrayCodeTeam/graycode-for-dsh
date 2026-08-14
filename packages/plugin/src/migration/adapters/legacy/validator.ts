/**
 * GrayCode - migration legacy 校验器（Validate 步骤，§7.4）
 *
 * 对每个清单对象：读取构成文件 → 计算对象内容哈希（幂等/冲突判定依据）→
 * 按对象类型解析（复用 adapters/legacy/*Parser）。
 *
 * 损坏隔离原则（docs/legacy-format.md §7.4）：单文件损坏不影响整体——
 * 对象级 valid=false + errorCode，其余对象照常。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { sha256Hex, sha256HexParts } from '../../domain/idempotency.ts'
import type { ValidatePort, ValidatedObject } from '../../application/ports.ts'
import type { InventoryEntry } from '../../application/ports.ts'
import { MIGRATION_ERROR_CODES, type ObjectType } from '../../domain/types.ts'
import { MAX_SOURCE_FILE_BYTES } from './inventory.ts'
import {
  parseConversationMeta,
  parseLegacyHistory,
  parseSegmentedHistory,
  parseSubAgentTranscript,
  parseBranchesGraph,
  parseSnapshot,
} from './conversationsParser.ts'
import { parseLegacyCheckpointManifest } from './checkpointManifestParser.ts'
import { parseMemoryLog, parseMemoryTree, parseMemoryScope } from './memoryParser.ts'
import { parseSettingsExport } from './settingsParser.ts'

export interface DefaultValidatorOptions {
  /** 单文件读取规模上限（M3；测试可注入小值） */
  maxFileBytes?: number
}

export class DefaultValidator implements ValidatePort {
  private readonly maxFileBytes: number

  constructor(options: DefaultValidatorOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? MAX_SOURCE_FILE_BYTES
  }

  async validateAll(sourceDir: string, entries: readonly InventoryEntry[]): Promise<ValidatedObject[]> {
    const out: ValidatedObject[] = []
    for (const entry of entries) {
      out.push(await this.validateOne(sourceDir, entry))
    }
    return out
  }

  private async validateOne(sourceDir: string, entry: InventoryEntry): Promise<ValidatedObject> {
    const base = { objectType: entry.objectType, legacyId: entry.legacyId, sourceHash: '' }

    // 读取构成文件（确定性顺序：文件路径排序）；缺失/超限 → 对象级错误（M3）
    const contents = new Map<string, Buffer>()
    const readFailures: string[] = []
    const overLimit: string[] = []
    for (const rel of entry.files) {
      try {
        const abs = path.join(sourceDir, ...rel.split('/'))
        const st = await fs.stat(abs)
        if (st.size > this.maxFileBytes) {
          overLimit.push(rel)
          continue
        }
        const buf = await fs.readFile(abs)
        contents.set(rel, buf)
      } catch {
        readFailures.push(rel)
      }
    }
    if (readFailures.length > 0 || overLimit.length > 0) {
      return {
        ...base,
        sourceHash: sha256Hex(`missing:${[...readFailures, ...overLimit].join(',')}`),
        valid: false,
        errorCode: overLimit.length > 0 ? MIGRATION_ERROR_CODES.FILE_TOO_LARGE : MIGRATION_ERROR_CODES.SOURCE_READ_ERROR,
        errorMessage:
          overLimit.length > 0
            ? `源文件超过 ${this.maxFileBytes} 字节上限: ${overLimit.join(', ')}`
            : `源文件读取失败: ${readFailures.join(', ')}`,
      }
    }

    // 对象内容哈希：按文件路径排序拼接（路径前缀 + 原始字节，M2：二进制不经过
    // utf-8 有损转换，直接喂 sha256 流）
    const hash = sha256HexParts(
      [...contents.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([rel, buf]) => [`\n--- ${rel} ---\n`, buf]),
    )

    switch (entry.objectType) {
      case 'conversation':
        return this.validateConversation(entry, contents, hash)
      case 'snapshot':
        return this.validateSnapshot(entry, contents, hash)
      case 'checkpoint':
        return this.validateCheckpoint(entry, contents, hash)
      case 'memory-global':
        return this.validateMemory(entry, contents, hash, 'global')
      case 'memory-workspace':
        return this.validateMemory(entry, contents, hash, 'workspace')
      case 'settings':
        return this.validateSettings(entry, contents, hash)
      default:
        return { ...base, sourceHash: hash, valid: false, errorCode: 'UNKNOWN_OBJECT_TYPE' }
    }
  }

  private async validateConversation(
    entry: InventoryEntry,
    contents: Map<string, Buffer>,
    sourceHash: string,
  ): Promise<ValidatedObject> {
    const base = { objectType: entry.objectType as ObjectType, legacyId: entry.legacyId, sourceHash }

    const metaRel = entry.files.find(f => f.endsWith('.meta.json'))
    const meta = metaRel ? parseConversationMeta(contents.get(metaRel)?.toString('utf-8') ?? '') : { valid: true }
    if (metaRel && !meta.valid) {
      // F14a：meta.json 损坏 → 跳过该会话并告警（不改名原文件）
      return {
        ...base,
        valid: false,
        errorCode: MIGRATION_ERROR_CODES.META_CORRUPT,
        errorMessage: `meta.json 损坏: ${metaRel}`,
      }
    }

    // 历史：segmented 优先，legacy 兜底（F3 变体语义）
    const indexRel = entry.files.find(f => f.endsWith('/history.index.json'))
    const legacyRel = entry.files.find(f => f.endsWith('.json') && !f.endsWith('.meta.json') && !f.endsWith('.usage.json'))
    let history: unknown[] = []
    let historyFormat: 'legacy' | 'segmented' | 'none' = 'none'
    let historyValid = true
    let historyErrorCode: string | undefined

    if (indexRel) {
      const indexRaw = contents.get(indexRel)?.toString('utf-8') ?? ''
      const segmentFiles = entry.files.filter(f => f.includes('/history/') && f.endsWith('.ndjson'))
      const readSegment = async (fileName: string): Promise<string> => {
        const rel = segmentFiles.find(f => f.endsWith(`/${fileName}`))
        if (!rel) throw new Error(`segment missing: ${fileName}`)
        const buf = contents.get(rel)
        if (!buf) throw new Error(`segment missing: ${fileName}`)
        return buf.toString('utf-8')
      }
      const segmented = await parseSegmentedHistory(indexRaw, readSegment)
      if (segmented.valid) {
        history = segmented.history
        historyFormat = 'segmented'
      } else if (legacyRel) {
        // segmented 损坏 → legacy 单文件兜底
        const legacy = parseLegacyHistory(contents.get(legacyRel)?.toString('utf-8') ?? '')
        if (legacy.valid) {
          history = legacy.history
          historyFormat = 'legacy'
        } else {
          historyValid = false
          historyErrorCode = segmented.errorCode
        }
      } else {
        historyValid = false
        historyErrorCode = segmented.errorCode
      }
    } else if (legacyRel) {
      const legacy = parseLegacyHistory(contents.get(legacyRel)?.toString('utf-8') ?? '')
      if (legacy.valid) {
        history = legacy.history
        historyFormat = 'legacy'
      } else {
        historyValid = false
        historyErrorCode = legacy.errorCode
      }
    }

    if (!historyValid) {
      return {
        ...base,
        valid: false,
        errorCode: historyErrorCode ?? MIGRATION_ERROR_CODES.HISTORY_NOT_ARRAY,
        errorMessage: `会话历史不可用 (${historyFormat})`,
      }
    }

    // subagents / branches：best-effort，损坏不致命
    const subagents = entry.files
      .filter(f => f.includes('/subagents/') && f.endsWith('.json'))
      .map(f => {
        // M1：文件名可能是非法百分号编码（URIError 单点崩溃）——隔离为 valid:false
        let runId = ''
        let runIdError: string | undefined
        try {
          runId = decodeURIComponent(path.basename(f).replace(/\.json$/, ''))
        } catch {
          runIdError = 'runId 文件名非法百分号编码'
        }
        const parsed = parseSubAgentTranscript(contents.get(f)?.toString('utf-8') ?? '')
        return {
          runId,
          valid: parsed.valid && runIdError === undefined,
          contents: parsed.contents,
          ...(runIdError ? { errorMessage: runIdError } : {}),
        }
      })
    const branchesRel = entry.files.find(f => f.endsWith('/branches.json'))
    const branches = branchesRel
      ? parseBranchesGraph(contents.get(branchesRel)?.toString('utf-8') ?? '')
      : { valid: true }

    return {
      ...base,
      valid: true,
      data: {
        conversationId: entry.legacyId,
        metaValid: true,
        ...(meta.title !== undefined ? { title: meta.title } : {}),
        ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
        ...(meta.updatedAt !== undefined ? { updatedAt: meta.updatedAt } : {}),
        ...(meta.workspaceUri !== undefined ? { workspaceUri: meta.workspaceUri } : {}),
        ...(meta.custom !== undefined ? { custom: meta.custom } : {}),
        history,
        historyFormat,
        historyValid: true,
        subagents,
        branchesValid: branches.valid,
        ...(branches.graph !== undefined ? { branches: branches.graph } : {}),
        usageIndexPresent: entry.files.some(f => f.endsWith('.usage.json')),
      },
    }
  }

  private validateSnapshot(
    entry: InventoryEntry,
    contents: Map<string, Buffer>,
    sourceHash: string,
  ): ValidatedObject {
    const raw = contents.get(entry.files[0] ?? '')?.toString('utf-8') ?? ''
    const parsed = parseSnapshot(raw)
    if (!parsed.valid) {
      return {
        objectType: entry.objectType,
        legacyId: entry.legacyId,
        sourceHash,
        valid: false,
        errorCode: MIGRATION_ERROR_CODES.SNAPSHOT_CORRUPT,
        errorMessage: `快照 JSON 损坏: ${entry.files[0] ?? ''}`,
      }
    }
    return {
      objectType: entry.objectType,
      legacyId: entry.legacyId,
      sourceHash,
      valid: true,
      data: parsed.snapshot,
    }
  }

  private validateCheckpoint(
    entry: InventoryEntry,
    contents: Map<string, Buffer>,
    sourceHash: string,
  ): ValidatedObject {
    const manifestRel = entry.files.find(f => f.endsWith('/manifest.json'))
    const filesJsonRel = entry.files.find(f => f.endsWith('/files.json'))
    if (!manifestRel) {
      return {
        objectType: entry.objectType,
        legacyId: entry.legacyId,
        sourceHash,
        valid: false,
        errorCode: MIGRATION_ERROR_CODES.CHECKPOINT_MANIFEST_CORRUPT,
        errorMessage: '缺少 manifest.json',
      }
    }
    const parsed = parseLegacyCheckpointManifest(entry.legacyId, contents.get(manifestRel)?.toString('utf-8') ?? '', {
      filesJsonRaw: filesJsonRel ? contents.get(filesJsonRel)?.toString('utf-8') : undefined,
    })
    if (parsed.corrupt) {
      // F14e/F14f/F14g：存档跳过，记录仍在列表（轻量元数据保留在 data 中）
      return {
        objectType: entry.objectType,
        legacyId: entry.legacyId,
        sourceHash,
        valid: false,
        errorCode: parsed.errorCode ?? MIGRATION_ERROR_CODES.CHECKPOINT_MANIFEST_CORRUPT,
        errorMessage: parsed.errorMessage ?? 'manifest 损坏',
        data: parsed,
      }
    }
    return {
      objectType: entry.objectType,
      legacyId: entry.legacyId,
      sourceHash,
      valid: true,
      data: parsed,
    }
  }

  private validateMemory(
    entry: InventoryEntry,
    contents: Map<string, Buffer>,
    sourceHash: string,
    scope: 'global' | 'workspace',
  ): ValidatedObject {
    const logRel = entry.files.find(f => f.endsWith('/LOG.txt'))
    const log = parseMemoryLog(logRel ? (contents.get(logRel) ?? Buffer.alloc(0)) : Buffer.alloc(0))
    // M7：TREE 块大小必须为 ≥1 的 2 的幂（文件名 = 块大小）；非法（0/NaN/非 2 幂）
    // 跳过该文件并记 issue，避免 blockSize=0 → lo=hi=0 的幻影摘要块。
    const treeIssues: string[] = []
    const tree = entry.files
      .filter(f => f.includes('/TREE/'))
      .flatMap(f => {
        const blockSize = Number.parseInt(path.basename(f), 10)
        if (!Number.isInteger(blockSize) || blockSize < 1 || (blockSize & (blockSize - 1)) !== 0) {
          treeIssues.push(`TREE 块大小非法（需为 ≥1 的 2 的幂，实际 ${path.basename(f)}），跳过: ${f}`)
          return []
        }
        return [parseMemoryTree(contents.get(f) ?? Buffer.alloc(0), blockSize)]
      })

    if (scope === 'global') {
      return {
        objectType: entry.objectType,
        legacyId: entry.legacyId,
        sourceHash,
        valid: true,
        data: {
          scope: 'global',
          logFormat: log.format,
          entries: log.entries,
          tree,
          treeIssues,
          configText: entry.files.includes('memory/config')
            ? contents.get('memory/config')?.toString('utf-8') ?? ''
            : undefined,
        },
      }
    }

    // workspace：scope.json 缺失/损坏 → scopeValid=false（plan 层 → unmapped，F14k）
    const scopeRel = entry.files.find(f => f.endsWith('/scope.json'))
    const scopeMeta = scopeRel ? parseMemoryScope(contents.get(scopeRel)?.toString('utf-8') ?? '') : null
    return {
      objectType: entry.objectType,
      legacyId: entry.legacyId,
      sourceHash,
      valid: true,
      data: {
        scope: 'workspace',
        scopeValid: scopeMeta !== null,
        ...(scopeMeta ? { scopeMeta } : {}),
        logFormat: log.format,
        entries: log.entries,
        tree,
        treeIssues,
      },
    }
  }

  private validateSettings(
    entry: InventoryEntry,
    contents: Map<string, Buffer>,
    sourceHash: string,
  ): ValidatedObject {
    const raw = contents.get(entry.files[0] ?? '')?.toString('utf-8') ?? ''
    const parsed = parseSettingsExport(raw, entry.files[0] ?? '')
    if (!parsed.ok) {
      return {
        objectType: entry.objectType,
        legacyId: entry.legacyId,
        sourceHash,
        valid: false,
        errorCode: parsed.errorCode ?? MIGRATION_ERROR_CODES.SETTINGS_PARSE_ERROR,
        errorMessage: parsed.errorMessage ?? 'settings 解析失败',
      }
    }
    return {
      objectType: entry.objectType,
      legacyId: entry.legacyId,
      sourceHash,
      valid: true,
      data: parsed,
    }
  }
}
