/**
 * GrayCode - staged-diff 状态机（ADR-0003 §4 权威转换表）
 *
 * ```text
 *  tool 写请求 ──► pending ──► reviewing ──┬─► accepted ──► 经 ctx.fs 落盘 ──► done
 *                                         └─► rejected ──► 不落盘 ──► done（拒绝结算）
 *  崩溃恢复：accepted 未落盘 ──(restoreFromSidecar)──► needs-reapply ──► accepted/rejected
 * ```
 *
 * 说明：
 * - `rejected -> done` 是 ADR §4 图中的「拒绝结算」终态（拒绝处理完成后落定）；
 *   本期 service 的 rejectEntry 先落到 rejected 供 UI 展示，结算由后续批次消费。
 * - `accepted -> done` 由 service.acceptEntry 在**落盘成功后**执行（写盘失败保持
 *   accepted 并允许重试，不向 UI 假报完成）。
 * - `accepted -> needs-reapply` 不属于用户可见转换表，是恢复专用变换
 *   （markAcceptedForReapply），仅由 restoreFromSidecar 使用。
 */
import {
  StagedDiffError,
  StagedDiffErrorCode,
  type StagedEntry,
  type StagedEntryStatus,
} from './types.ts';

/** 合法转换表（ADR-0003 §4；key = 当前状态，value = 可达状态） */
export const STAGED_ENTRY_TRANSITIONS: Readonly<Record<StagedEntryStatus, readonly StagedEntryStatus[]>> = {
  pending: ['reviewing', 'accepted', 'rejected'],
  reviewing: ['accepted', 'rejected'],
  accepted: ['done'],
  rejected: ['done'],
  done: [],
  'needs-reapply': ['accepted', 'rejected'],
};

/** 是否允许 from -> to 转换 */
export function canTransition(from: StagedEntryStatus, to: StagedEntryStatus): boolean {
  return STAGED_ENTRY_TRANSITIONS[from].includes(to);
}

/**
 * 执行状态转换并产生新条目（不修改原对象）：
 * status 更新、updatedAt = now、revision + 1。非法转换抛稳定错误码
 * GRAY_STAGED_ILLEGAL_TRANSITION。
 */
export function transitionEntry(entry: StagedEntry, to: StagedEntryStatus, now: number): StagedEntry {
  if (!canTransition(entry.status, to)) {
    throw new StagedDiffError(
      `illegal staged entry transition "${entry.status}" -> "${to}" (entry "${entry.id}")`,
      StagedDiffErrorCode.ILLEGAL_TRANSITION,
      { entry }
    );
  }
  return {
    ...entry,
    status: to,
    updatedAt: now,
    revision: entry.revision + 1,
  };
}

/**
 * 崩溃恢复专用变换（不属于用户可见转换表）：accepted 但未落盘（崩溃窗口）→
 * needs-reapply。仅由 restoreFromSidecar 在启动重建时调用；非 accepted 条目调用抛错。
 */
export function markAcceptedForReapply(entry: StagedEntry, now: number): StagedEntry {
  if (entry.status !== 'accepted') {
    throw new StagedDiffError(
      `markAcceptedForReapply requires an accepted entry, got "${entry.status}" (entry "${entry.id}")`,
      StagedDiffErrorCode.ILLEGAL_TRANSITION,
      { entry }
    );
  }
  return {
    ...entry,
    status: 'needs-reapply',
    updatedAt: now,
    revision: entry.revision + 1,
  };
}
