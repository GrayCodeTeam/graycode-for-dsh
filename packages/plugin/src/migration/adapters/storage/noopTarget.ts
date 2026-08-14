/**
 * GrayCode - migration 空写入适配（fail-closed 占位；测试/兼容用）
 *
 * snapshots 域已由 snapshotTarget.ts 接线（B3），生产 compose 不再使用本占位；
 * 保留作为通用 fail-closed 占位（测试中 writers 映射的缺省槽位使用）：
 * write 被调用即抛错，probe 恒 false。
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
