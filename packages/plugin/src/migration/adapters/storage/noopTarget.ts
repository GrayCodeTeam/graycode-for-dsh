/**
 * GrayCode - migration 空写入适配（snapshots 域占位）
 *
 * snapshots 目标（DSH lineage）未接线：计划层恒为 unmapped，write 不应被调用；
 * 本占位满足 writers: Record<TargetDomain, TargetWriterPort> 的类型契约，
 * 若被调用则抛错（fail-closed）。
 */

import type { TargetWriterPort, WriteTargetInput, WriteTargetResult } from '../../application/ports.ts'

export function createNoopWriter(kind: 'snapshots'): TargetWriterPort {
  return {
    kind,
    async write(_input: WriteTargetInput): Promise<WriteTargetResult> {
      throw new Error(`snapshots 目标未接线（DSH lineage）：不应发生写入`)
    },
    async probe(): Promise<boolean> {
      return false
    },
  }
}
