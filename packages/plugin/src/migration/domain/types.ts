/**
 * GrayCode - migration 领域契约（PLAN_V2 §7.2/§7.4/§7.5）
 *
 * 本文件为纯 TypeScript 领域层：不得导入 cordis / DSH / node fs / 数据库。
 * 旧数据导入器的核心概念：
 * - ImportRun 状态机（scanned → planned → applying → partial → complete → failed）；
 * - 幂等键 = sourceFingerprint + objectType + legacyId（§7.2.5）；
 * - 冲突策略（§7.5）：already-imported / conflict(GRAY_CONFLICT) / unmapped /
 *   duplicate / disabled-draft；
 * - 迁移报告 DTO：人类可读 Markdown + 机器可读 JSON 两部分（§7.2.9）。
 */

/** 旧数据对象类型（= 幂等键的 objectType 维度） */
export type ObjectType =
  | 'conversation'
  | 'snapshot'
  | 'checkpoint'
  | 'memory-global'
  | 'memory-workspace'
  | 'settings'

/** 目标写入域（按此顺序逐域提交，每域一个提交点） */
export type TargetDomain = 'conversations' | 'snapshots' | 'checkpoints' | 'memory' | 'settings'

export const DOMAIN_ORDER: readonly TargetDomain[] = [
  'conversations',
  'snapshots',
  'checkpoints',
  'memory',
  'settings',
]

/** ImportRun 状态机状态（§7.4 ImportRun.status） */
export type ImportRunStatus = 'scanned' | 'planned' | 'applying' | 'partial' | 'complete' | 'failed'

/** 单步状态（§7.4 ImportRun.steps[].status） */
export type StepStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped'

export type ImportStepName = 'inventory' | 'validate' | 'plan' | TargetDomain | 'verify'

export const IMPORT_STEP_NAMES: readonly ImportStepName[] = [
  'inventory',
  'validate',
  'plan',
  'conversations',
  'snapshots',
  'checkpoints',
  'memory',
  'settings',
  'verify',
]

export interface ImportStepState {
  status: StepStatus
  sourceCount: number
  targetCount: number
  errorCode?: string
}

/** Import run（§7.4 领域契约草案 + 版本化存储的持久化形态） */
export interface ImportRun {
  id: string
  sourceDir: string
  sourceFingerprint: string
  sourceVersion: string
  targetProfile: string
  status: ImportRunStatus
  startedAt: string
  completedAt?: string
  steps: Record<ImportStepName, ImportStepState>
  /** 人类可读的审计备注（提交点/跳过原因） */
  notes: string[]
}

/** 冲突策略（§7.5）：对象级处置结果 */
export type ConflictKind = 'already-imported' | 'conflict' | 'unmapped' | 'duplicate' | 'disabled-draft'

/** 计划结果：import = 本次将写入；其余为 §7.5 冲突/跳过；error = 源对象损坏 */
export type PlanOutcome = 'import' | ConflictKind | 'error'

export interface PlannedObject {
  /** 目标写入域 */
  domain: TargetDomain
  objectType: ObjectType
  legacyId: string
  /** 对象内容哈希（sha256 hex；冲突判定依据，§7.5 同 id 不同 hash → GRAY_CONFLICT） */
  sourceHash: string
  outcome: PlanOutcome
  errorCode?: string
  /** 解析后的负载（writer 消费；settings 摘要等）；机器报告不整体导出该字段 */
  data?: unknown
  /** unmapped / duplicate / disabled-draft 的人类可读原因 */
  skipReason?: string
}

export interface ReportObject {
  /** 目标写入域（apply 分组/提交点依据） */
  domain: TargetDomain
  objectType: ObjectType
  legacyId: string
  outcome: PlanOutcome
  sourceHash: string
  errorCode?: string
  targetRef?: string
  skipReason?: string
}

/** 迁移报告（机器可读部分；settingsSummary 已脱敏） */
export interface MigrationReport {
  run: ImportRun
  source: { sourceDir: string; sourceFingerprint: string; sourceVersion: string }
  /** apply 二次确认令牌（hash(sourceFingerprint + 计划)；源变更后失效） */
  planToken: string
  counts: Record<PlanOutcome, number>
  objects: ReportObject[]
  skips: Array<{ objectType: ObjectType; legacyId: string; reason: string }>
  /** settings 摘要（脱敏后）；无 settings 对象时为 undefined */
  settingsSummary?: unknown
}

/** 幂等台账条目（持久化于 <dataRoot>/migration/ledger.json） */
export interface LedgerEntry {
  /** 幂等键 = buildIdempotencyKey(sourceFingerprint, objectType, legacyId) */
  key: string
  sourceFingerprint: string
  objectType: ObjectType
  legacyId: string
  sourceHash: string
  targetRef: string
  importedAt: string
}

export interface VerifyResult {
  ok: boolean
  checked: number
  mismatches: number
  missingTargets: number
  issues: string[]
}

/** 机器可读错误码（稳定契约） */
export const MIGRATION_ERROR_CODES = {
  SOURCE_NOT_FOUND: 'SOURCE_NOT_FOUND',
  INVENTORY_FAILED: 'INVENTORY_FAILED',
  CONFIRM_TOKEN_MISMATCH: 'CONFIRM_TOKEN_MISMATCH',
  SOURCE_CHANGED: 'SOURCE_CHANGED',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  // 对象级（损坏隔离，不中断整体导入）
  META_CORRUPT: 'META_CORRUPT',
  HISTORY_NOT_ARRAY: 'HISTORY_NOT_ARRAY',
  SEGMENT_MISSING: 'SEGMENT_MISSING',
  INDEX_INCONSISTENT: 'INDEX_INCONSISTENT',
  CHECKPOINT_MANIFEST_CORRUPT: 'CHECKPOINT_MANIFEST_CORRUPT',
  CHECKPOINT_FILES_REVISION_MISMATCH: 'CHECKPOINT_FILES_REVISION_MISMATCH',
  CHECKPOINT_FILES_ARRAY_SHAPE: 'CHECKPOINT_FILES_ARRAY_SHAPE',
  CHECKPOINT_UNSAFE_DIR: 'CHECKPOINT_UNSAFE_DIR',
  SETTINGS_PARSE_ERROR: 'SETTINGS_PARSE_ERROR',
  SETTINGS_UNSUPPORTED_VERSION: 'SETTINGS_UNSUPPORTED_VERSION',
  MEMORY_SCOPE_INVALID: 'MEMORY_SCOPE_INVALID',
  SNAPSHOT_CORRUPT: 'SNAPSHOT_CORRUPT',
  SOURCE_READ_ERROR: 'SOURCE_READ_ERROR',
  // 存储层（拒绝服务而非静默重判，H1）
  LEDGER_CORRUPT: 'LEDGER_CORRUPT',
  STORAGE_CORRUPT: 'STORAGE_CORRUPT',
  // 并发/取消（H1c / M4）
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',
  OPERATION_CANCELLED: 'OPERATION_CANCELLED',
  // 输入规模上限（对象级隔离，M3）
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  HISTORY_LIMIT_EXCEEDED: 'HISTORY_LIMIT_EXCEEDED',
} as const

export type MigrationErrorCode = (typeof MIGRATION_ERROR_CODES)[keyof typeof MIGRATION_ERROR_CODES]

export class MigrationError extends Error {
  constructor(
    readonly code: MigrationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MigrationError'
  }
}
