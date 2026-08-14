/**
 * Workflow event-window stream updates (P4-01).
 *
 * PLAN_V2 §5.6 requires testing `replace/prepend/append` — the three stream
 * update shapes the DSH client session window accepts. The engine owns the
 * real window (`ConversationNodeAssembler.replaceWindow/append/prepend` in
 * dsh-client-runtime); this module mirrors the same three-state contract as a
 * small pure accumulator so the merge semantics are unit-testable and reusable
 * by any client-side projection that needs its own ordered window.
 *
 * Merge rules (mirroring the engine's seq-guarded behaviour):
 *
 * - `replace` — install a complete window; duplicates (same seq) collapse to
 *   the first occurrence; entries are kept in ascending seq order.
 * - `append` — add one contiguous tail event; an event whose seq is not
 *   strictly greater than the current tail is dropped (duplicate / overlap),
 *   matching the session window's "overlapping seq -> drop" rule.
 * - `prepend` — add an older page; only events with seq strictly below the
 *   current head are accepted (boundary overlap is dropped), existing Context
 *   identities stay untouched, and `hasMore` is refreshed.
 *
 * No operation ever rescans or reorders the existing window (the plan's
 * "禁止每来一个分片就全量扫描会话窗口" rule).
 */
import type { WorkflowEventLike } from './types.ts'

/** The three stream update shapes (replace / prepend / append). */
export type WorkflowStreamUpdate =
  | { readonly kind: 'replace'; readonly entries: readonly WorkflowEventLike[]; readonly hasMore: boolean }
  | { readonly kind: 'prepend'; readonly entries: readonly WorkflowEventLike[]; readonly hasMore: boolean }
  | { readonly kind: 'append'; readonly entry: WorkflowEventLike }

/** Immutable accumulated window (ascending seq, deduplicated). */
export interface WorkflowStreamWindow {
  readonly entries: readonly WorkflowEventLike[]
  /** Whether older history remains outside the window (drives paging affordances). */
  readonly hasMore: boolean
  /** Monotonic mutation counter (uSES-friendly). */
  readonly revision: number
}

/** Empty window (cold start). */
export const EMPTY_WORKFLOW_STREAM: WorkflowStreamWindow = {
  entries: [],
  hasMore: false,
  revision: 0,
}

/**
 * Sort by seq (stable) and drop duplicate seqs keeping the first occurrence.
 * @param entries - input events (may be unordered or duplicated).
 */
export function dedupeWorkflowEvents(entries: readonly WorkflowEventLike[]): readonly WorkflowEventLike[] {
  const sorted = [...entries].sort((left, right) => left.seq - right.seq)
  const result: WorkflowEventLike[] = []
  let lastSeq = Number.NEGATIVE_INFINITY
  for (const event of sorted) {
    if (event.seq === lastSeq) continue
    result.push(event)
    lastSeq = event.seq
  }
  return result
}

/**
 * Apply one stream update to a window.
 * @param window - current window.
 * @param update - replace / prepend / append.
 * @returns the next window (the same reference when nothing changed).
 */
export function applyWorkflowStreamUpdate(
  window: WorkflowStreamWindow,
  update: WorkflowStreamUpdate,
): WorkflowStreamWindow {
  switch (update.kind) {
    case 'replace': {
      const entries = dedupeWorkflowEvents(update.entries)
      return { entries, hasMore: update.hasMore, revision: window.revision + 1 }
    }
    case 'prepend': {
      const head = window.entries[0]
      const incoming = dedupeWorkflowEvents(update.entries).filter(
        (event) => head === undefined || event.seq < head.seq,
      )
      if (incoming.length === 0 && update.hasMore === window.hasMore) return window
      return {
        entries: [...incoming, ...window.entries],
        hasMore: update.hasMore,
        revision: window.revision + 1,
      }
    }
    case 'append': {
      const tail = window.entries.at(-1)
      if (tail !== undefined && update.entry.seq <= tail.seq) return window
      return {
        entries: [...window.entries, update.entry],
        hasMore: window.hasMore,
        revision: window.revision + 1,
      }
    }
  }
}
