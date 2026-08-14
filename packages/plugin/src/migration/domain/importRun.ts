/**
 * GrayCode - ImportRun 状态机（纯函数）
 *
 * 状态（§7.4）：scanned → planned → applying → partial / complete / failed。
 * - scanned   ：run 创建（源目录待发现/正在发现）；
 * - planned   ：inventory/validate/plan 全部完成，产出 dry-run 报告；
 * - applying  ：用户确认（confirmToken）后逐域提交；
 * - complete  ：所有域步 + verify 步完成；
 * - partial   ：至少一个域步失败（成功部分已落盘，可安全重跑）；
 * - failed    ：致命错误（源不可达/清单失败），无任何提交。
 */

import {
  IMPORT_STEP_NAMES,
  MIGRATION_ERROR_CODES,
  MigrationError,
  type ImportRun,
  type ImportRunStatus,
  type ImportStepName,
  type ImportStepState,
} from './types.ts'

export interface CreateImportRunInput {
  id: string
  sourceDir: string
  sourceFingerprint: string
  sourceVersion: string
  targetProfile: string
  startedAt: string
}

export function createImportRun(input: CreateImportRunInput): ImportRun {
  const steps = Object.fromEntries(
    IMPORT_STEP_NAMES.map(name => [name, { status: 'pending', sourceCount: 0, targetCount: 0 } as ImportStepState]),
  ) as Record<ImportStepName, ImportStepState>
  return {
    id: input.id,
    sourceDir: input.sourceDir,
    sourceFingerprint: input.sourceFingerprint,
    sourceVersion: input.sourceVersion,
    targetProfile: input.targetProfile,
    status: 'scanned',
    startedAt: input.startedAt,
    steps,
    notes: [],
  }
}

export type ImportRunEvent =
  | { type: 'plan-complete' } // scanned → planned
  | { type: 'apply-begin' } // planned → applying
  | { type: 'apply-finish'; outcome: 'complete' | 'partial' | 'failed' } // applying → 终态
  | { type: 'fatal' } // 任意 → failed（致命错误）

const ALLOWED: Record<ImportRunStatus, ReadonlyArray<ImportRunEvent['type']>> = {
  scanned: ['plan-complete', 'fatal'],
  planned: ['apply-begin', 'fatal'],
  applying: ['apply-finish', 'fatal'],
  partial: ['fatal'],
  complete: [],
  failed: [],
}

/** 状态转移（非法转移抛 ILLEGAL_TRANSITION） */
export function transitionImportRun(run: ImportRun, event: ImportRunEvent): ImportRun {
  if (!ALLOWED[run.status].includes(event.type)) {
    throw new MigrationError(
      MIGRATION_ERROR_CODES.ILLEGAL_TRANSITION,
      `Illegal import run transition: ${run.status} + ${event.type}`,
    )
  }
  switch (event.type) {
    case 'plan-complete':
      return { ...run, status: 'planned' }
    case 'apply-begin':
      return { ...run, status: 'applying' }
    case 'apply-finish': {
      const completedAt = new Date().toISOString()
      if (event.outcome === 'failed') return { ...run, status: 'failed', completedAt }
      return { ...run, status: event.outcome, completedAt }
    }
    case 'fatal':
      return { ...run, status: 'failed', completedAt: new Date().toISOString() }
  }
}

/** 更新单步状态（不可变；步骤名必须合法） */
export function updateStep(
  run: ImportRun,
  step: ImportStepName,
  patch: Partial<ImportStepState> & { status: ImportStepState['status'] },
): ImportRun {
  return {
    ...run,
    steps: {
      ...run.steps,
      [step]: { ...run.steps[step], ...patch },
    },
  }
}

/** 追加审计备注 */
export function appendNote(run: ImportRun, note: string): ImportRun {
  return { ...run, notes: [...run.notes, note] }
}

/**
 * 依据各步状态推导 apply 终态（纯函数）：
 * - 任何 write/verify 步 failed → partial（成功部分保留，可重跑）；
 * - 全部完成 → complete。
 */
export function deriveApplyOutcome(run: ImportRun): 'complete' | 'partial' {
  const writeSteps: readonly ImportStepName[] = [
    'conversations',
    'snapshots',
    'checkpoints',
    'memory',
    'settings',
    'verify',
  ]
  const hasFailure = writeSteps.some(step => run.steps[step].status === 'failed')
  return hasFailure ? 'partial' : 'complete'
}
