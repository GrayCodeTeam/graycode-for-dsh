/**
 * GrayCode - migration 计划器（纯函数，§7.5 冲突策略落点）
 *
 * 每个有效对象按 objectType 走冲突判定：
 * - conversation / checkpoint / memory-* / settings：台账判定
 *   （import / already-imported / conflict）；
 * - snapshot：目标（DSH lineage）未接线 → unmapped（显式跳过并记录原因）；
 * - memory-workspace scope.json 缺失/损坏：unmapped（无法映射工作区）；
 * - 源对象损坏：outcome=error（errorCode 保留）。
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
import type { PlannedObject, TargetDomain } from '../domain/types.ts'

export function domainOf(objectType: string): TargetDomain {
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

export class DefaultPlanner implements PlanPort {
  async plan(input: PlanInput): Promise<PlanOutput> {
    const objects: PlannedObject[] = []
    const skips: PlanOutput['skips'] = []

    for (const validated of input.validated) {
      const domain = domainOf(validated.objectType)
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

      // snapshot：目标（DSH lineage/legacy artifact 归属）未接线 → 显式跳过
      if (validated.objectType === 'snapshot') {
        objects.push({
          ...base,
          outcome: 'unmapped',
          skipReason: '快照目标（DSH lineage）尚未接线，记为 intentional skip；可重建数据不迁移',
        })
        skips.push({
          objectType: validated.objectType,
          legacyId: validated.legacyId,
          reason: 'snapshots 目标未接线（DSH lineage），暂不导入',
        })
        continue
      }

      // memory-workspace：scope.json 缺失/损坏 → 无法映射到 DSH workspace
      if (validated.objectType === 'memory-workspace') {
        const data = validated.data as { scopeValid?: boolean } | undefined
        if (data?.scopeValid === false) {
          objects.push({
            ...base,
            outcome: 'unmapped',
            skipReason: 'scope.json 缺失/损坏，无法映射到 DSH workspace',
            data: validated.data,
          })
          skips.push({
            objectType: validated.objectType,
            legacyId: validated.legacyId,
            reason: 'scope.json 缺失/损坏（不视为工作区记忆 scope）',
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
