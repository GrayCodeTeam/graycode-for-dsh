/**
 * GrayCode - migration 端口接口（application 层只依赖这些接口与领域层）
 *
 * 流水线（§7.4）：Discover → Inventory → Validate → Plan → Dry-run →
 * Apply（逐域提交）→ Verify → Finalize。
 */

import type {
  ImportRun,
  LedgerEntry,
  ObjectType,
  PlannedObject,
  TargetDomain,
} from '../domain/types.ts'
import type { ScopeOverrideMap } from '../domain/scopeMap.ts'

// ─── Inventory（清单与哈希） ─────────────────────────────

export interface InventoryEntry {
  objectType: ObjectType
  legacyId: string
  /** 构成该对象的源文件（相对 sourceDir，排序后用于内容哈希） */
  files: string[]
}

export interface InventoryIssue {
  path: string
  message: string
}

export interface SourceInventory {
  /** 源目录稳定指纹（相对路径 + 字节数清单的 sha256） */
  sourceFingerprint: string
  /** 探测到的源版本（如 '1.5.4'；未知为 'unknown'） */
  sourceVersion: string
  entries: InventoryEntry[]
  issues: InventoryIssue[]
}

export interface InventoryPort {
  inventory(sourceDir: string): Promise<SourceInventory>
}

// ─── Validate（版本/路径/完整性；单对象损坏隔离） ─────────────

export interface ValidatedObject {
  objectType: ObjectType
  legacyId: string
  /** 对象内容哈希（sha256 hex；源对象文件的确定性拼接） */
  sourceHash: string
  valid: boolean
  errorCode?: string
  errorMessage?: string
  /** 解析后的负载（writer 消费） */
  data?: unknown
}

export interface ValidateOptions {
  /** apply 授权模式：settings 解析时在内存中保留渠道明文 apiKey（仅供凭据迁移写入） */
  collectSecrets?: boolean
}

export interface ValidatePort {
  validateAll(
    sourceDir: string,
    entries: readonly InventoryEntry[],
    options?: ValidateOptions,
  ): Promise<ValidatedObject[]>
}

// ─── Plan（workspace/冲突映射） ─────────────────────────

export interface PlanInput {
  inventory: SourceInventory
  validated: readonly ValidatedObject[]
  ledger: readonly LedgerEntry[]
}

export interface PlanOutput {
  objects: PlannedObject[]
  skips: Array<{ objectType: ObjectType; legacyId: string; reason: string }>
}

export interface PlanPort {
  plan(input: PlanInput): Promise<PlanOutput>
}

// ─── Target writer（写入侧适配；每域一个） ────────────────

export interface WriteTargetInput {
  runId: string
  object: PlannedObject
  sourceDir: string
  /** D-1：工作区记忆 scope 覆盖表（memory writer 消费；可选，未覆盖走自动映射） */
  scopeOverrides?: ScopeOverrideMap
}

export interface WriteTargetResult {
  targetRef: string
  notes?: string[]
  /**
   * 写时结果摘要（机器可读、已脱敏）：供最终报告合流到对应域的 summary
   * （B2：settings 直写结果进入 report.settingsSummary.writeResult）。
   */
  summary?: Record<string, unknown>
}

export interface TargetWriterPort {
  readonly kind: TargetDomain
  write(input: WriteTargetInput): Promise<WriteTargetResult>
  /** 可选：校验 targetRef 指向的目标是否仍存在（verify 用） */
  probe?(targetRef: string): Promise<boolean>
}

// ─── 幂等台账 ─────────────────────────────

export interface LedgerPort {
  get(key: string): Promise<LedgerEntry | undefined>
  getAll(): Promise<LedgerEntry[]>
  put(entry: LedgerEntry): Promise<void>
}

// ─── ImportRun 持久化（提交点记录） ─────────────────────────

export interface RunStorePort {
  save(run: ImportRun): Promise<void>
  load(id: string): Promise<ImportRun | undefined>
}

// ─── 依赖聚合 ─────────────────────────

export interface ImportServiceDeps {
  inventory: InventoryPort
  validator: ValidatePort
  planner: PlanPort
  writers: Record<TargetDomain, TargetWriterPort>
  ledger: LedgerPort
  runStore: RunStorePort
  targetProfile: string
}
