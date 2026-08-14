/**
 * GrayCode - staged-diff 审阅批视图（ADR-0003 §4 跨工具累计）
 *
 * 同一 workspace+session 下的 pending/reviewing 条目构成一个审阅批；批不是独立
 * 实体，是条目集合的派生视图。排序：createdAt 升序、id 升序（稳定、确定性）。
 */
import type { StagedEntry } from './types.ts';

/** 审阅批派生视图（不含 accepted/rejected/done/needs-reapply 条目） */
export interface ReviewBatchView {
  workspaceId: string;
  sessionId: string;
  /** 待审条目（pending/reviewing），按 createdAt 升序、id 升序 */
  entries: StagedEntry[];
  pendingCount: number;
  reviewingCount: number;
  totalCount: number;
}

/** 聚合给定条目集合为审阅批视图（不修改入参；返回副本） */
export function buildReviewBatch(
  entries: readonly StagedEntry[],
  workspaceId: string,
  sessionId: string
): ReviewBatchView {
  const scoped = entries
    .filter(
      entry =>
        entry.workspaceId === workspaceId &&
        entry.sessionId === sessionId &&
        (entry.status === 'pending' || entry.status === 'reviewing')
    )
    .map(entry => ({ ...entry }))
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  let pendingCount = 0;
  let reviewingCount = 0;
  for (const entry of scoped) {
    if (entry.status === 'pending') pendingCount += 1;
    else reviewingCount += 1;
  }
  return {
    workspaceId,
    sessionId,
    entries: scoped,
    pendingCount,
    reviewingCount,
    totalCount: scoped.length,
  };
}
