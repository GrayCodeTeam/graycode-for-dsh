/**
 * GrayCode - migration 导入用例编排（application 层）
 *
 * 用例：scan（dry-run，不写盘）/ apply（confirmToken 二次确认，逐域提交点提交，
 * 幂等可重跑）/ verify（计数/哈希/目标存在性）/ rerun（= 幂等重跑 apply）。
 *
 * 契约（§7.2.2/7.2.7）：
 * - 默认动作永远是 scan/dry-run；apply 需再次确认（planToken）；
 * - 每个源对象用幂等键去重，重复运行不生成副本；
 * - 源目录只读；单对象失败不全局回滚——按域提交点记录，成功部分可校验、
 *   失败部分可安全重跑。
 */

import { buildIdempotencyKey, computePlanToken } from '../domain/idempotency.ts'
import {
  appendNote,
  createImportRun,
  deriveApplyOutcome,
  transitionImportRun,
  updateStep,
} from '../domain/importRun.ts'
import { summarizeCounts } from '../domain/report.ts'
import {
  DOMAIN_ORDER,
  MIGRATION_ERROR_CODES,
  MigrationError,
  type ImportRun,
  type ImportStepName,
  type LedgerEntry,
  type MigrationReport,
  type PlannedObject,
  type TargetDomain,
  type VerifyResult,
} from '../domain/types.ts'
import type {
  ImportServiceDeps,
  PlanOutput,
  SourceInventory,
  TargetWriterPort,
  ValidatedObject,
} from './ports.ts'

export interface ScanResult {
  run: ImportRun
  report: MigrationReport
}

export interface ImportServiceOptions {
  runIdFactory?: () => string
  now?: () => string
}

const WRITE_STEPS: readonly TargetDomain[] = DOMAIN_ORDER

export class LegacyImportService {
  constructor(
    private readonly deps: ImportServiceDeps,
    private readonly options: ImportServiceOptions = {},
  ) {}

  private runId(): string {
    return this.options.runIdFactory
      ? this.options.runIdFactory()
      : `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  private now(): string {
    return this.options.now ? this.options.now() : new Date().toISOString()
  }

  // ─── 用例 1：scan（dry-run） ─────────────────────────

  async scan(sourceDir: string): Promise<ScanResult> {
    const { run, report } = await this.scanWithPlan(sourceDir)
    return { run, report }
  }

  /** scan 内部实现：额外返回完整计划（含 data 负载，apply 消费） */
  private async scanWithPlan(
    sourceDir: string,
  ): Promise<{ run: ImportRun; report: MigrationReport; plan: PlanOutput }> {
    let run = createImportRun({
      id: this.runId(),
      sourceDir,
      sourceFingerprint: '',
      sourceVersion: 'unknown',
      targetProfile: this.deps.targetProfile,
      startedAt: this.now(),
    })

    // Discover + Inventory（清单与哈希）
    run = updateStep(run, 'inventory', { status: 'running' })
    let inventory: SourceInventory
    try {
      inventory = await this.deps.inventory.inventory(sourceDir)
    } catch (err) {
      run = transitionImportRun(
        updateStep(run, 'inventory', { status: 'failed', errorCode: MIGRATION_ERROR_CODES.INVENTORY_FAILED }),
        { type: 'fatal' },
      )
      await this.deps.runStore.save(run)
      throw new MigrationError(
        MIGRATION_ERROR_CODES.INVENTORY_FAILED,
        `Inventory failed for ${sourceDir}: ${(err as Error).message}`,
      )
    }
    run = {
      ...run,
      sourceFingerprint: inventory.sourceFingerprint,
      sourceVersion: inventory.sourceVersion,
    }
    run = updateStep(run, 'inventory', {
      status: 'complete',
      sourceCount: inventory.entries.length,
      targetCount: 0,
    })

    // Validate（版本/路径/完整性；单对象损坏隔离）
    run = updateStep(run, 'validate', { status: 'running' })
    const validated = await this.deps.validator.validateAll(sourceDir, inventory.entries)
    const validCount = validated.filter(v => v.valid).length
    run = updateStep(run, 'validate', {
      status: 'complete',
      sourceCount: validated.length,
      targetCount: validCount,
    })

    // Plan（workspace/冲突映射）
    run = updateStep(run, 'plan', { status: 'running' })
    const ledger = await this.deps.ledger.getAll()
    const plan = await this.deps.planner.plan({ inventory, validated, ledger })
    run = updateStep(run, 'plan', {
      status: 'complete',
      sourceCount: plan.objects.length,
      targetCount: plan.objects.filter(o => o.outcome === 'import').length,
    })
    run = transitionImportRun(run, { type: 'plan-complete' })
    await this.deps.runStore.save(run)

    return { run, report: this.buildReport(sourceDir, run, plan, validated), plan }
  }

  // ─── 用例 2：apply（二次确认 + 逐域提交点） ─────────────────────────

  async apply(sourceDir: string, confirmToken: string): Promise<ScanResult> {
    const { run: plannedRun, report: scanReport, plan } = await this.scanWithPlan(sourceDir)
    if (scanReport.planToken !== confirmToken) {
      throw new MigrationError(
        MIGRATION_ERROR_CODES.CONFIRM_TOKEN_MISMATCH,
        'confirmToken 与最近一次 scan 的 planToken 不一致：请先运行 migration_scan 审阅 dry-run 报告，再原样传入其 planToken。',
      )
    }

    let run = transitionImportRun(plannedRun, { type: 'apply-begin' })
    run = appendNote(run, `apply 开始（confirmToken 校验通过，${this.now()}）`)
    // 重置写步（scan 阶段它们都是 pending/skipped）
    for (const step of WRITE_STEPS) {
      run = updateStep(run, step, { status: 'pending', sourceCount: 0, targetCount: 0 })
    }
    await this.deps.runStore.save(run)

    const objects = plan.objects
    let anyCommitted = false

    for (const domain of WRITE_STEPS) {
      const writer: TargetWriterPort = this.deps.writers[domain]
      const domainObjects = objects.filter(o => o.domain === domain && o.outcome !== 'unmapped')
      const allDomainObjects = objects.filter(o => o.domain === domain)
      if (allDomainObjects.length === 0) {
        run = updateStep(run, domain, { status: 'skipped', sourceCount: 0, targetCount: 0 })
        continue
      }
      run = updateStep(run, domain, { status: 'running', sourceCount: allDomainObjects.length, targetCount: 0 })

      let committed = 0
      let failed = 0
      const domainNotes: string[] = []
      for (const obj of domainObjects) {
        const key = buildIdempotencyKey(run.sourceFingerprint, obj.objectType, obj.legacyId)
        if (obj.outcome === 'already-imported') {
          domainNotes.push(`already-imported: ${obj.objectType}:${obj.legacyId}`)
          continue
        }
        if (obj.outcome === 'conflict') {
          domainNotes.push(`GRAY_CONFLICT: ${obj.objectType}:${obj.legacyId}（源哈希与已导入不同，不覆盖）`)
          continue
        }
        if (obj.outcome === 'error') {
          failed += 1
          domainNotes.push(`error: ${obj.objectType}:${obj.legacyId} [${obj.errorCode ?? 'UNKNOWN'}]`)
          continue
        }
        if (obj.outcome === 'duplicate') {
          domainNotes.push(`duplicate 去重: ${obj.objectType}:${obj.legacyId}`)
          continue
        }
        // outcome === 'import'（含 disabled-draft 对象：以草稿形态导入）
        try {
          const result = await writer.write({ runId: run.id, object: obj, sourceDir })
          const entry: LedgerEntry = {
            key,
            sourceFingerprint: run.sourceFingerprint,
            objectType: obj.objectType,
            legacyId: obj.legacyId,
            sourceHash: obj.sourceHash,
            targetRef: result.targetRef,
            importedAt: this.now(),
          }
          await this.deps.ledger.put(entry)
          committed += 1
          anyCommitted = true
          if (result.notes?.length) domainNotes.push(...result.notes)
        } catch (err) {
          failed += 1
          domainNotes.push(`write failed: ${obj.objectType}:${obj.legacyId} — ${(err as Error).message}`)
        }
      }

      const stepStatus = failed > 0 ? 'failed' : 'complete'
      run = updateStep(run, domain, {
        status: stepStatus,
        sourceCount: allDomainObjects.length,
        targetCount: committed,
        ...(failed > 0 ? { errorCode: 'PARTIAL_DOMAIN_FAILURES' } : {}),
      })
      // 审计备注并入 run.notes（already-imported / conflict / error / duplicate /
      // writer 备注，如增量链回溯），随提交点一起持久化；空数组不产生任何 note
      for (const note of domainNotes) run = appendNote(run, note)
      run = appendNote(run, `[提交点] ${domain}: ${committed} 导入 / ${failed} 失败`)
      // 提交点：域完成后持久化 run（成功部分可校验、失败部分可重跑）
      await this.deps.runStore.save(run)
    }

    // Verify（计数/链接/哈希）
    run = updateStep(run, 'verify', { status: 'running' })
    let verify: VerifyResult
    try {
      verify = await this.verify(sourceDir)
    } catch (err) {
      verify = { ok: false, checked: 0, mismatches: 0, missingTargets: 0, issues: [(err as Error).message] }
    }
    run = updateStep(run, 'verify', {
      status: verify.ok ? 'complete' : 'failed',
      sourceCount: verify.checked,
      targetCount: verify.checked - verify.mismatches,
      ...(verify.ok ? {} : { errorCode: 'VERIFY_MISMATCH' }),
    })

    const outcome = deriveApplyOutcome(run)
    run = transitionImportRun(run, { type: 'apply-finish', outcome })
    run = appendNote(run, `apply 结束：${outcome}（${this.now()}）`)
    await this.deps.runStore.save(run)

    const report: MigrationReport = {
      ...scanReport,
      run,
      counts: summarizeCounts(objects),
    }
    return { run, report }
  }

  // ─── 用例 3：verify ─────────────────────────

  async verify(sourceDir: string): Promise<VerifyResult> {
    const ledger = await this.deps.ledger.getAll()
    if (ledger.length === 0) {
      return { ok: true, checked: 0, mismatches: 0, missingTargets: 0, issues: ['台账为空（尚无导入记录）'] }
    }
    const inventory = await this.deps.inventory.inventory(sourceDir)
    const validated = await this.deps.validator.validateAll(sourceDir, inventory.entries)
    const byKey = new Map<string, ValidatedObject>()
    for (const v of validated) {
      byKey.set(buildIdempotencyKey(inventory.sourceFingerprint, v.objectType, v.legacyId), v)
    }

    const issues: string[] = []
    let mismatches = 0
    let missingTargets = 0
    for (const entry of ledger) {
      if (entry.sourceFingerprint !== inventory.sourceFingerprint) {
        issues.push(`台账条目 ${entry.legacyId} 的源指纹与当前源目录不一致（源已更换？）`)
        continue
      }
      const current = byKey.get(entry.key)
      if (!current) {
        issues.push(`台账条目 ${entry.legacyId} 在源目录中已不存在`)
        continue
      }
      if (current.sourceHash !== entry.sourceHash) {
        mismatches += 1
        issues.push(`源对象 ${entry.legacyId} 哈希已变化（期望 ${entry.sourceHash.slice(0, 10)}，当前 ${current.sourceHash.slice(0, 10)}）`)
      }
      const writer = this.deps.writers[domainOfObjectType(entry.objectType)]
      if (writer.probe) {
        try {
          const exists = await writer.probe(entry.targetRef)
          if (!exists) {
            missingTargets += 1
            issues.push(`目标缺失: ${entry.targetRef}`)
          }
        } catch {
          // probe 失败按缺失处理
          missingTargets += 1
          issues.push(`目标不可达: ${entry.targetRef}`)
        }
      }
    }

    return {
      ok: mismatches === 0 && missingTargets === 0,
      checked: ledger.length,
      mismatches,
      missingTargets,
      issues,
    }
  }

  // ─── 用例 4：rerun（幂等重跑，语义与 apply 相同） ─────────────────────────

  async rerun(sourceDir: string, confirmToken: string): Promise<ScanResult> {
    return this.apply(sourceDir, confirmToken)
  }

  // ─── 报告构造 ─────────────────────────

  private buildReport(
    sourceDir: string,
    run: ImportRun,
    plan: PlanOutput,
    validated: readonly ValidatedObject[],
  ): MigrationReport {
    const settingsObject = plan.objects.find(o => o.objectType === 'settings')
    return {
      run,
      source: {
        sourceDir,
        sourceFingerprint: run.sourceFingerprint,
        sourceVersion: run.sourceVersion,
      },
      planToken: computePlanToken(run.sourceFingerprint, plan.objects),
      counts: summarizeCounts(plan.objects),
      objects: plan.objects.map(o => ({
        domain: o.domain,
        objectType: o.objectType,
        legacyId: o.legacyId,
        outcome: o.outcome,
        sourceHash: o.sourceHash,
        ...(o.errorCode ? { errorCode: o.errorCode } : {}),
        ...(o.skipReason ? { skipReason: o.skipReason } : {}),
      })),
      skips: plan.skips,
      ...(settingsObject?.data ? { settingsSummary: settingsObject.data } : {}),
    }
  }
}

function domainOfObjectType(objectType: string): TargetDomain {
  switch (objectType) {
    case 'conversation':
      return 'conversations'
    case 'snapshot':
      return 'snapshots'
    case 'checkpoint':
      return 'checkpoints'
    case 'memory-global':
    case 'memory-workspace':
      return 'memory'
    case 'settings':
      return 'settings'
    default:
      return 'conversations'
  }
}
