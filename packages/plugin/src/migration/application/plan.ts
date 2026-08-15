/**
 * GrayCode - migration 计划器（纯函数，§7.5 冲突策略落点）
 *
 * 每个有效对象按 objectType 走冲突判定：
 * - conversation / snapshot / checkpoint / memory-* / settings：台账判定
 *   （import / already-imported / conflict）；
 * - memory-workspace scope.json 缺失/损坏：unmapped（无法映射工作区）；
 * - 源对象损坏：outcome=error（errorCode 保留）。
 *
 * snapshots 目标（B3）已由 adapters/storage/snapshotTarget.ts 接线为 DSH session
 * （seed 快照历史 + header lineage parentSession/seedLength），不再 unmapped。
 */

import {
  buildIdempotencyKey,
} from '../domain/idempotency.ts'
import {
  decideLedgerOutcome,
  findLedgerEntry,
} from '../domain/conflict.ts'
import type { PlanOutput, PlanPort } from './ports.ts'
import type { PlanInput } from './ports.ts'
import { domainOfObjectType, type PlannedObject } from '../domain/types.ts'

export class DefaultPlanner implements PlanPort {
  async plan(input: PlanInput): Promise<PlanOutput> {
    const objects: PlannedObject[] = []
    const skips: PlanOutput['skips'] = []

    for (const validated of input.validated) {
      const domain = domainOfObjectType(validated.objectType)
      const base = {
        domain,
        objectType: validated.objectType,
        legacyId: validated.legacyId,
        sourceHash: validated.sourceHash,
      }

      if (!validated.valid) {
        objects.push({
          ...base,
          outcome: 'error',
          errorCode: validated.errorCode,
          data: validated.data,
        })
        continue
      }

      // memory-workspace：scope.json 缺失/损坏，或可解析但无可用工作区路径
      // （fsPath/cwd 均缺失）→ 无法映射到 DSH workspace（3.14-M1：无路径与损坏
      // 同语义——plan 输出 unmapped，与 scopeMap 报告的 unmapped 判定一致，
      // 用户可在 apply 用 scopeOverrides 显式恢复）。
      if (validated.objectType === 'memory-workspace') {
        const data = validated.data as
          | { scopeValid?: boolean; scopeMeta?: { fsPath?: string; cwd?: string } }
          | undefined
        const scopeMeta = data?.scopeMeta
        const hasUsablePath =
          (typeof scopeMeta?.fsPath === 'string' && scopeMeta.fsPath.length > 0)
          || (typeof scopeMeta?.cwd === 'string' && scopeMeta.cwd.length > 0)
        if (data?.scopeValid === false || !hasUsablePath) {
          const noPath = data?.scopeValid !== false
          objects.push({
            ...base,
            outcome: 'unmapped',
            skipReason: noPath
              ? 'scope.json 无可用工作区路径（fsPath/cwd 缺失），无法映射到 DSH workspace'
              : 'scope.json 缺失/损坏，无法映射到 DSH workspace',
            data: validated.data,
          })
          skips.push({
            objectType: validated.objectType,
            legacyId: validated.legacyId,
            reason: noPath
              ? 'scope.json 无可用工作区路径（不视为工作区记忆 scope）'
              : 'scope.json 缺失/损坏（不视为工作区记忆 scope）',
          })
          continue
        }
      }

      const key = buildIdempotencyKey(input.inventory.sourceFingerprint, validated.objectType, validated.legacyId)
      const ledgerEntry = findLedgerEntry(input.ledger, key)
      const outcome = decideLedgerOutcome(ledgerEntry, validated.sourceHash)
      objects.push({ ...base, outcome, data: validated.data })
    }

    return { objects, skips }
  }
}
