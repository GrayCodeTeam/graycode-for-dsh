/**
 * GrayCode - migration 冲突策略判定（纯函数，§7.5）
 *
 * | 冲突 | 判定 | 默认行为 |
 * | --- | --- | --- |
 * | 同 legacy id 且源哈希相同 | already-imported | 跳过 |
 * | 同 legacy id 但源哈希不同 | conflict（GRAY_CONFLICT） | 不覆盖，报告列出 |
 * | workspace 路径不存在 | unmapped | 保留状态，等待用户映射 |
 * | Skill 同名同 hash | duplicate | 去重 |
 * | provider 不受支持 | disabled-draft | 导入为 disabled 配置草稿 |
 */

import type { ConflictKind, LedgerEntry } from './types.ts'

/** 台账判定：无记录 → import；同哈希 → already-imported；异哈希 → conflict */
export function decideLedgerOutcome(
  ledgerEntry: LedgerEntry | undefined,
  sourceHash: string,
): 'import' | ConflictKind {
  if (!ledgerEntry) return 'import'
  if (ledgerEntry.sourceHash === sourceHash) return 'already-imported'
  return 'conflict'
}

/** 台账是否已包含某幂等键 */
export function hasLedgerEntry(ledger: readonly LedgerEntry[], key: string): boolean {
  return ledger.some(entry => entry.key === key)
}

export function findLedgerEntry(
  ledger: readonly LedgerEntry[],
  key: string,
): LedgerEntry | undefined {
  return ledger.find(entry => entry.key === key)
}
