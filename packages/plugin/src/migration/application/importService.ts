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
import { decideLedgerOutcome } from '../domain/conflict.ts'
import {
  appendNote,
  createImportRun,
  deriveApplyOutcome,
  transitionImportRun,
  updateStep,
} from '../domain/importRun.ts'
import { summarizeCounts } from '../domain/report.ts'
import {
  buildConversationCheckpointLists,
  buildConversationCwdIssues,
  buildScopeMap,
  hasScopeOverride,
  parseScopeOverrideMap,
  ScopeOverrideValidationError,
  type ScopeOverrideMap,
} from '../domain/scopeMap.ts'
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
import * as fs from 'fs/promises'
import * as path from 'path'
import type {
  ImportServiceDeps,
  PlanOutput,
  SourceInventory,
  TargetWriterPort,
  ValidateOptions,
  ValidatedObject,
} from './ports.ts'

export interface ScanResult {
  run: ImportRun
  report: MigrationReport
}

export interface ImportServiceOptions {
  runIdFactory?: () => string
  now?: () => string
  /** apply 跨进程文件锁路径（<dataRoot>/migration/.locks/apply.lock）；缺省 = 不加文件锁 */
  lockFile?: string
  /** 锁获取总超时（毫秒；缺省 5 分钟） */
  lockTimeoutMs?: number
  /** 锁轮询间隔（毫秒；缺省 100） */
  lockPollMs?: number
  /** 陈旧锁判定（毫秒；缺省 60 秒） */
  lockStaleMs?: number
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

  async scan(sourceDir: string, options: { signal?: AbortSignal } = {}): Promise<ScanResult> {
    const { run, report } = await this.scanWithPlan(sourceDir, options.signal)
    return { run, report }
  }

  /** scan 内部实现：额外返回完整计划（含 data 负载，apply 消费） */
  private async scanWithPlan(
    sourceDir: string,
    signal?: AbortSignal,
    parseOptions?: ValidateOptions,
  ): Promise<{ run: ImportRun; report: MigrationReport; plan: PlanOutput }> {
    this.assertNotCancelled(signal)
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
    this.assertNotCancelled(signal)

    // Validate（版本/路径/完整性；单对象损坏隔离）
    run = updateStep(run, 'validate', { status: 'running' })
    const validated = await this.deps.validator.validateAll(sourceDir, inventory.entries, parseOptions)
    const validCount = validated.filter(v => v.valid).length
    run = updateStep(run, 'validate', {
      status: 'complete',
      sourceCount: validated.length,
      targetCount: validCount,
    })
    this.assertNotCancelled(signal)

    // Plan（workspace/冲突映射）
    run = updateStep(run, 'plan', { status: 'running' })
    this.assertNotCancelled(signal)
    const ledger = await this.deps.ledger.getAll()
    const plan = await this.deps.planner.plan({ inventory, validated, ledger })
    run = updateStep(run, 'plan', {
      status: 'complete',
      sourceCount: plan.objects.length,
      targetCount: plan.objects.filter(o => o.outcome === 'import').length,
    })
    run = transitionImportRun(run, { type: 'plan-complete' })
    this.assertNotCancelled(signal)
    await this.deps.runStore.save(run)

    return { run, report: this.buildReport(sourceDir, run, plan, validated), plan }
  }

  // ─── 用例 2：apply（二次确认 + 逐域提交点） ─────────────────────────

  async apply(
    sourceDir: string,
    confirmToken: string,
    options: { signal?: AbortSignal; credentialsAuthorized?: boolean; scopeOverrides?: ScopeOverrideMap } = {},
  ): Promise<ScanResult> {
    this.assertNotCancelled(options.signal)
    let scopeOverrides: ScopeOverrideMap | undefined
    try {
      scopeOverrides = parseScopeOverrideMap(options.scopeOverrides)
    } catch (err) {
      if (err instanceof ScopeOverrideValidationError) {
        throw new MigrationError(MIGRATION_ERROR_CODES.MEMORY_SCOPE_INVALID, err.message)
      }
      throw err
    }
    // H1c：apply 全程持跨进程文件锁（防并发 apply 重复写目标）；finally 保证释放
    const release = await this.acquireApplyLock(options.signal)
    try {
      return await this.applyInner(sourceDir, confirmToken, options.signal, options.credentialsAuthorized, scopeOverrides)
    } finally {
      await release()
    }
  }

  private async applyInner(
    sourceDir: string,
    confirmToken: string,
    signal?: AbortSignal,
    credentialsAuthorized = false,
    scopeOverrides?: ScopeOverrideMap,
  ): Promise<ScanResult> {
    const { run: plannedRun, report: scanReport, plan } = await this.scanWithPlan(sourceDir, signal, {
      // B1：apply 授权模式才在内存中收集明文 apiKey（默认 false = 脱敏，现状不变）
      collectSecrets: credentialsAuthorized,
    })
    if (scanReport.planToken !== confirmToken) {
      throw new MigrationError(
        MIGRATION_ERROR_CODES.CONFIRM_TOKEN_MISMATCH,
        'confirmToken 与最近一次 scan 的 planToken 不一致：请先运行 migration_scan 审阅 dry-run 报告，再原样传入其 planToken。',
      )
    }
    this.assertNotCancelled(signal)

    let run = transitionImportRun(plannedRun, { type: 'apply-begin' })
    run = appendNote(run, `apply 开始（confirmToken 校验通过，${this.now()}）`)
    // 重置写步（scan 阶段它们都是 pending/skipped）
    for (const step of WRITE_STEPS) {
      run = updateStep(run, step, { status: 'pending', sourceCount: 0, targetCount: 0 })
    }
    await this.deps.runStore.save(run)

    // D-1：scan 时无法定位的 workspace memory 默认仍是 unmapped；只有用户在
    // apply 显式给出合法覆盖时才恢复为可写对象。恢复后重新查询幂等台账，确保
    // 二次 apply 得到 already-imported/conflict，而不是重复写入。
    const rescuedScopeIds = new Set(
      plan.objects
        .filter(obj =>
          obj.outcome === 'unmapped'
          && obj.objectType === 'memory-workspace'
          && hasScopeOverride(scopeOverrides, obj.legacyId))
        .map(obj => obj.legacyId),
    )
    const objects = await Promise.all(plan.objects.map(async obj => {
      if (!rescuedScopeIds.has(obj.legacyId) || obj.objectType !== 'memory-workspace') return obj
      const key = buildIdempotencyKey(plannedRun.sourceFingerprint, obj.objectType, obj.legacyId)
      const outcome = decideLedgerOutcome(await this.deps.ledger.get(key), obj.sourceHash)
      return { ...obj, outcome, skipReason: undefined }
    }))
    let anyCommitted = false
    // B2：settings 域写时结果（脱敏）收集，最终合流进 report.settingsSummary.writeResult
    const settingsWriteSummaries: Record<string, unknown>[] = []

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
        if (obj.objectType === 'memory-workspace' && rescuedScopeIds.has(obj.legacyId)) {
          domainNotes.push(`scope override 恢复映射: ${obj.objectType}:${obj.legacyId}`)
        }
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
        this.assertNotCancelled(signal)
        try {
          const result = await writer.write({
            runId: run.id,
            sourceFingerprint: run.sourceFingerprint,
            object: obj,
            sourceDir,
            scopeOverrides,
          })
          if (domain === 'settings' && result.summary) settingsWriteSummaries.push(result.summary)
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
      verify = await this.verify(sourceDir, signal)
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
    this.assertNotCancelled(signal)
    await this.deps.runStore.save(run)

    const report: MigrationReport = {
      ...scanReport,
      run,
      counts: summarizeCounts(objects),
      objects: scanReport.objects.map(reportObject => {
        if (reportObject.objectType !== 'memory-workspace' || !rescuedScopeIds.has(reportObject.legacyId)) {
          return reportObject
        }
        const effective = objects.find(obj =>
          obj.objectType === reportObject.objectType && obj.legacyId === reportObject.legacyId)
        const { skipReason: _skipReason, ...rest } = reportObject
        return { ...rest, outcome: effective?.outcome ?? reportObject.outcome }
      }),
      skips: scanReport.skips.filter(skip =>
        skip.objectType !== 'memory-workspace' || !rescuedScopeIds.has(skip.legacyId)),
      ...(settingsWriteSummaries.length > 0
        ? {
            settingsSummary: {
              // scanReport.settingsSummary 是 scan 阶段的脱敏解析摘要；writeResult 补写时结果
              ...(scanReport.settingsSummary !== undefined
                ? (scanReport.settingsSummary as Record<string, unknown>)
                : {}),
              writeResult:
                settingsWriteSummaries.length === 1
                  ? settingsWriteSummaries[0]
                  : { results: settingsWriteSummaries },
            },
          }
        : {}),
    }
    return { run, report }
  }

  // ─── 用例 3：verify ─────────────────────────

  async verify(sourceDir: string, signal?: AbortSignal): Promise<VerifyResult> {
    this.assertNotCancelled(signal)
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

  // ─── 跨进程文件锁（H1c） ─────────────────────────

  /**
   * apply 全程文件锁：`wx` 原子创建锁文件即持有（跨进程互斥）；
   * 陈旧锁检测（createdAt/mtime 超时即打破）+ 获取超时 + 取消支持。
   * 未配置 lockFile 时返回空 release（不加锁）。
   */
  private async acquireApplyLock(signal?: AbortSignal): Promise<() => Promise<void>> {
    const lockFile = this.options.lockFile
    if (!lockFile) return async () => {}
    const timeoutMs = this.options.lockTimeoutMs ?? 5 * 60 * 1000
    const pollMs = this.options.lockPollMs ?? 100
    const staleMs = this.options.lockStaleMs ?? 60 * 1000
    await fs.mkdir(path.dirname(lockFile), { recursive: true })
    const deadline = Date.now() + timeoutMs
    for (;;) {
      this.assertNotCancelled(signal)
      let handle
      try {
        handle = await fs.open(lockFile, 'wx')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EEXIST') {
          if (await this.tryBreakStaleApplyLock(lockFile, staleMs)) continue
        } else if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOENT') {
          throw err
        }
        if (Date.now() >= deadline) {
          throw new MigrationError(
            MIGRATION_ERROR_CODES.LOCK_TIMEOUT,
            `等待迁移 apply 文件锁超时（${timeoutMs}ms，另一进程/实例正在 apply）: ${lockFile}`,
          )
        }
        await this.sleep(pollMs, signal)
        continue
      }
      try {
        await handle.writeFile(this.lockPayload(Date.now(), Date.now()), 'utf-8')
      } catch {
        await handle.close().catch(() => {})
        await fs.unlink(lockFile).catch(() => {})
        continue
      }
      // 心跳：周期重写 updatedAt，防止长 apply（大目录导入可能超过 staleMs）被
      // 其他进程的陈旧锁判定误破（镜像 checkpoints 跨进程锁的心跳设计）。
      const createdAt = Date.now()
      const heartbeatMs = Math.max(1000, Math.floor(staleMs / 3))
      const heartbeat = setInterval(() => {
        handle.truncate(0)
          .then(() => handle.writeFile(this.lockPayload(createdAt, Date.now()), 'utf-8'))
          .catch(() => {})
      }, heartbeatMs)
      let released = false
      return async () => {
        if (released) return
        released = true
        clearInterval(heartbeat)
        // Windows：先 close 句柄再 unlink（句柄未释放时 unlink 可能 EPERM）
        await handle.close().catch(() => {})
        await fs.unlink(lockFile).catch(() => {})
      }
    }
  }

  /** 锁文件载荷：pid + 创建时间 + 心跳更新时间（陈旧判定优先用 updatedAt） */
  private lockPayload(createdAt: number, updatedAt: number): string {
    return `${JSON.stringify({ pid: process.pid, createdAt, updatedAt })}\n`
  }

  /** 陈旧锁检测与打破（updatedAt 心跳优先，回退 createdAt，再回退 mtime） */
  private async tryBreakStaleApplyLock(lockFile: string, staleMs: number): Promise<boolean> {
    let stale = false
    try {
      const raw = await fs.readFile(lockFile, 'utf-8')
      const parsed = JSON.parse(raw) as { createdAt?: number; updatedAt?: number }
      if (typeof parsed.updatedAt === 'number') {
        stale = Date.now() - parsed.updatedAt > staleMs
      } else if (typeof parsed.createdAt === 'number') {
        stale = Date.now() - parsed.createdAt > staleMs
      } else {
        const stat = await fs.stat(lockFile)
        stale = Date.now() - stat.mtimeMs > staleMs
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true
      return false
    }
    if (!stale) return false
    try {
      await fs.unlink(lockFile)
      return true
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT'
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      if (signal?.aborted) {
        resolve()
        return
      }
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** M4：exec.signal 取消检查（scan/apply 各阶段与每个对象写入前） */
  private assertNotCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new MigrationError(MIGRATION_ERROR_CODES.OPERATION_CANCELLED, 'migration 操作已取消（exec.signal aborted）')
    }
  }

  // ─── 报告构造 ─────────────────────────

  private buildReport(
    sourceDir: string,
    run: ImportRun,
    plan: PlanOutput,
    validated: readonly ValidatedObject[],
  ): MigrationReport {
    const settingsObject = plan.objects.find(o => o.objectType === 'settings')
    const settingsSummary = settingsObject?.data ? sanitizeSettingsSummary(settingsObject.data) : undefined
    const scopeMap = buildScopeMap(plan.objects)
    const cwdIssues = buildConversationCwdIssues(plan.objects)
    const checkpointLists = buildConversationCheckpointLists(plan.objects)
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
      ...(settingsSummary !== undefined ? { settingsSummary } : {}),
      // D-1/D-4a/D-5b：scope 与归属事实（无相关对象时不输出字段）
      ...(scopeMap.length > 0 ? { scopeMap } : {}),
      ...(cwdIssues.length > 0 ? { conversationCwdIssues: cwdIssues } : {}),
      ...(checkpointLists.length > 0 ? { conversationCheckpointLists: checkpointLists } : {}),
    }
  }
}

/**
 * settings 摘要净化：剥掉授权模式下可能携带的明文凭据负载
 * （credentialSecrets 只允许在 apply 写路径的内存中短暂存在，
 * 绝不进入机器报告；防御性剥离，即使未来有调用方误传也不泄漏）。
 */
function sanitizeSettingsSummary(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) }
  delete out.credentialSecrets
  return out
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


