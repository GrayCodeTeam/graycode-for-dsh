/**
 * Staged-diff decision actions assembly (P4-06).
 *
 * `createStagedDiffActions` wraps a `StagedDiffDataSource` into the
 * interaction layer the batch list component consumes:
 * - operation-id idempotency (idempotency.ts) — concurrent duplicate clicks
 *   never re-invoke the data source, and successful outcomes are replayed
 *   for repeated ids; failed outcomes are never cached, so retryable
 *   failures (GRAY_STAGED_APPLY_FAILED etc.) stay retryable and a refreshed
 *   projection never replays a stale error;
 * - envelope → outcome mapping (`StagedDiffDecisionOutcome`), with failures
 *   classified by `mapStagedDiffFailure`;
 * - the entry `revision` read at click time is passed as the CAS
 *   `expectedRevision` (the host rejects stale calls with GRAY_CONFLICT);
 * - every decision carries an explicit absolute workspace root. Browser
 *   remotes have no safe host-cwd fallback.
 */
import type { GrayRemoteFailure, StagedEntry } from './contract.ts'
import type { StagedDiffDataSource } from './dataSource.ts'
import { mapStagedDiffFailure, type StagedDiffCardError } from './errors.ts'
import {
  createStagedDiffOperationTracker,
  type StagedDiffOperationKind,
  type StagedDiffOperationTracker,
} from './idempotency.ts'

/** Outcome of one accept/reject decision. */
export type StagedDiffDecisionOutcome =
  | { readonly ok: true; readonly entry: StagedEntry }
  | { readonly ok: false; readonly error: StagedDiffCardError }

/** Interaction layer the batch list consumes. */
export interface StagedDiffActions {
  /** Accept an entry (derived operation id — same-entry clicks dedupe). */
  accept(entry: StagedEntry): Promise<StagedDiffDecisionOutcome>
  /** Reject an entry (derived operation id). */
  reject(entry: StagedEntry): Promise<StagedDiffDecisionOutcome>
  /**
   * Accept with an explicit operation id (host wiring may reuse a stable
   * id, e.g. the tool call id); repeating the id returns the recorded
   * outcome instead of re-invoking the data source.
   */
  acceptWithOperationId(entry: StagedEntry, operationId: string): Promise<StagedDiffDecisionOutcome>
  /** Reject with an explicit operation id. */
  rejectWithOperationId(entry: StagedEntry, operationId: string): Promise<StagedDiffDecisionOutcome>
  /** Whether any decision for the entry is still in flight. */
  isInFlight(entryId: string): boolean
}

/** Defensive fallback when the data source violates the never-throw envelope. */
function internalOutcome(): StagedDiffDecisionOutcome {
  return {
    ok: false,
    error: {
      kind: 'internal',
      code: 'GRAY_INTERNAL',
      retryable: false,
      refreshRequired: false,
    },
  }
}

/** Wrap a data source into idempotent, error-mapped decision actions. */
export function createStagedDiffActions(dataSource: StagedDiffDataSource, workspace: string): StagedDiffActions {
  const workspaceRoot = workspace.trim()
  if (workspaceRoot.length === 0) throw new Error('stagedDiff: workspace is required')
  const tracker: StagedDiffOperationTracker<StagedDiffDecisionOutcome> =
    createStagedDiffOperationTracker<StagedDiffDecisionOutcome>()
  const inFlight = new Map<string, Promise<StagedDiffDecisionOutcome>>()

  function decide(
    kind: StagedDiffOperationKind,
    entry: StagedEntry,
    explicitOperationId?: string,
  ): Promise<StagedDiffDecisionOutcome> {
    const { operationId, duplicate, record } = tracker.begin(kind, entry.id, explicitOperationId)
    if (duplicate) {
      if (record.state === 'resolved' && record.result !== undefined) {
        return Promise.resolve(record.result)
      }
      const existing = inFlight.get(operationId)
      if (existing !== undefined) return existing
    }

    const call = kind === 'accept'
      ? dataSource.accept({ entryId: entry.id, expectedRevision: entry.revision, workspace: workspaceRoot })
      : dataSource.reject({ entryId: entry.id, expectedRevision: entry.revision, workspace: workspaceRoot })

    /**
     * Record a settled outcome. Only successes are cached: a failed decision
     * must never be replayed from the tracker — a retryable failure
     * (GRAY_STAGED_APPLY_FAILED etc., errors.ts) is meant to be re-attempted
     * as-is, and a refreshRequired failure would replay a stale error after
     * the host refreshes the projection. The in-flight dedupe (inFlight map)
     * still prevents double submissions while a call is pending.
     */
    const commitOutcome = (operationIdToCommit: string, outcome: StagedDiffDecisionOutcome): void => {
      if (outcome.ok) {
        tracker.resolve(operationIdToCommit, outcome)
      } else {
        tracker.forget(operationIdToCommit)
      }
    }

    const promise = call.then((result): StagedDiffDecisionOutcome => {
      const outcome: StagedDiffDecisionOutcome = result.ok
        ? { ok: true, entry: result.value }
        : { ok: false, error: mapStagedDiffFailure(result.error) }
      commitOutcome(operationId, outcome)
      return outcome
    }).catch((): StagedDiffDecisionOutcome => {
      const outcome = internalOutcome()
      commitOutcome(operationId, outcome)
      return outcome
    })

    inFlight.set(operationId, promise)
    promise.then(
      () => { inFlight.delete(operationId) },
      () => { inFlight.delete(operationId) },
    )
    return promise
  }

  return {
    accept: entry => decide('accept', entry),
    reject: entry => decide('reject', entry),
    acceptWithOperationId: (entry, operationId) => decide('accept', entry, operationId),
    rejectWithOperationId: (entry, operationId) => decide('reject', entry, operationId),
    isInFlight: entryId => tracker.isInFlight(entryId),
  }
}
