/**
 * Staged-entry status → badge/action mapping (P4-06).
 *
 * Pure, replay-safe derivation of what a card may offer for each
 * `StagedEntryStatus`. Mirrors the host decision surface
 * (`packages/plugin/src/stagedDiff/domain/stateMachine.ts`):
 * - `pending` / `reviewing` / `needs-reapply` are decidable (accept/reject);
 * - `accepted` is mid-flight (accepted but not yet written to disk) — no
 *   actions until the host projects `done`;
 * - `rejected` / `done` are terminal — no actions.
 */
import type { StagedEntryStatus } from './contract.ts'

/** A decision a card can offer for one entry. */
export type StagedEntryAction = 'accept' | 'reject'

/** Whether an entry status offers accept/reject decisions. */
export interface StagedEntryActionability {
  readonly canAccept: boolean
  readonly canReject: boolean
  /** Any decision available (not mid-flight, not terminal). */
  readonly actionable: boolean
}

/** Badge tones per status (kept in the card surface; no CSS module in the skeleton). */
export const STAGED_STATUS_TONE: Readonly<Record<StagedEntryStatus, string>> = {
  pending: '#8b949e',
  reviewing: '#58a6ff',
  accepted: '#d29922',
  rejected: '#f85149',
  done: '#3fb950',
  'needs-reapply': '#d29922',
}

/**
 * Decision availability by status.
 *
 * `needs-reapply` (crash recovery: accepted but never written to disk) is
 * decidable again — the host transition table allows `needs-reapply →
 * accepted | rejected` — and the card surfaces the recovery hint on top.
 */
export function stagedEntryActionability(status: StagedEntryStatus): StagedEntryActionability {
  const decidable = status === 'pending' || status === 'reviewing' || status === 'needs-reapply'
  return {
    canAccept: decidable,
    canReject: decidable,
    actionable: decidable,
  }
}

/** Whether the entry is a crash-recovery residue (`accepted` but unwritten). */
export function isStagedReapplyStatus(status: StagedEntryStatus): boolean {
  return status === 'needs-reapply'
}

/** Badge locale keys — `needs-reapply` maps to the camelCase key. */
export type StagedStatusBadgeKey =
  | 'status.pending'
  | 'status.reviewing'
  | 'status.accepted'
  | 'status.rejected'
  | 'status.done'
  | 'status.needsReapply'

/** Locale key for a status badge label. */
export function stagedStatusLocaleKey(status: StagedEntryStatus): StagedStatusBadgeKey {
  switch (status) {
    case 'pending': return 'status.pending'
    case 'reviewing': return 'status.reviewing'
    case 'accepted': return 'status.accepted'
    case 'rejected': return 'status.rejected'
    case 'done': return 'status.done'
    case 'needs-reapply': return 'status.needsReapply'
  }
}
