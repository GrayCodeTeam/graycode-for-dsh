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
 *   remotes have no safe host-cwd fallback;
 * - a decision timeout (3.8-M1): a hanging remote settles as a `timeout`
 *   outcome and releases the busy state, so the entry stays operable;
 * - a synchronous data-source throw is trapped (4.8-L3) instead of escaping
 *   `decide` (`.catch` only observes rejections) — busy can never freeze;
 * - optional pre-decision workspace parity check (3.8-M4): when a
 *   `workspaceIdOf` resolver is supplied, an entry whose workspace differs
 *   from the actions' workspace is refused before the wire is touched.
 */
import type { GrayRemoteResult, StagedEntry } from './contract.ts'
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

/** Options for the decision assembly. */
export interface StagedDiffActionsOptions {
  /**
   * Decision timeout in ms (3.8-M1). A decision that does not settle within
   * the budget resolves with a `timeout` outcome and releases both the
   * tracker and the in-flight dedupe, leaving the entry operable again.
   * `0` disables the timeout. Default `STAGED_DECISION_TIMEOUT_MS` (30s).
   */
  readonly timeoutMs?: number
  /**
   * Derive the stable workspace id from a workspace root (host parity with
   * `createStagedWorkspaceId`, service.ts). When provided, every decision is
   * validated against the entry's workspace id BEFORE invoking the data
   * source; a mismatch is refused with a `workspaceConflict` outcome
   * (3.8-M4). The host enforces the same check on its side — this keeps a
   * stale multi-workspace projection from ever reaching the wire.
   */
  readonly workspaceIdOf?: (workspaceRoot: string) => string
}

/** Default decision timeout (ms). */
export const STAGED_DECISION_TIMEOUT_MS = 30_000

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

/** Client-side decision timeout outcome (the host never reports timeouts). */
function timeoutOutcome(): StagedDiffDecisionOutcome {
  return {
    ok: false,
    error: {
      kind: 'timeout',
      code: 'GRAY_TIMEOUT',
      retryable: true,
      refreshRequired: false,
    },
  }
}

/** Pre-decision workspace mismatch outcome (3.8-M4). */
function workspaceConflictOutcome(): StagedDiffDecisionOutcome {
  return {
    ok: false,
    error: {
      kind: 'workspaceConflict',
      code: 'GRAY_STAGED_WORKSPACE_CONFLICT',
      retryable: false,
      refreshRequired: false,
    },
  }
}

/** Wrap a data source into idempotent, error-mapped decision actions. */
export function createStagedDiffActions(
  dataSource: StagedDiffDataSource,
  workspace: string,
  options: StagedDiffActionsOptions = {},
): StagedDiffActions {
  const workspaceRoot = workspace.trim()
  if (workspaceRoot.length === 0) throw new Error('stagedDiff: workspace is required')
  const timeoutMs = options.timeoutMs ?? STAGED_DECISION_TIMEOUT_MS
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

    /**
     * Record a settled outcome. Only successes are cached: a failed decision
     * must never be replayed from the tracker — a retryable failure
     * (GRAY_STAGED_APPLY_FAILED etc., errors.ts) is meant to be re-attempted
     * as-is, and a refreshRequired failure would replay a stale error after
     * the host refreshes the projection. The in-flight dedupe (inFlight map)
     * still prevents double submissions while a call is pending.
     *
     * The record-identity guard stops a late settlement from an abandoned
     * call (after a timeout the caller may retry the same derived id, which
     * re-begins a fresh record) from clobbering the retried operation.
     */
    const commitOutcome = (operationIdToCommit: string, outcome: StagedDiffDecisionOutcome): void => {
      if (tracker.get(operationIdToCommit) !== record) return
      if (outcome.ok) {
        tracker.resolve(operationIdToCommit, outcome)
      } else {
        tracker.forget(operationIdToCommit)
      }
    }
    const settle = (outcome: StagedDiffDecisionOutcome): StagedDiffDecisionOutcome => {
      commitOutcome(operationId, outcome)
      return outcome
    }

    // 3.8-M4: refuse to decide an entry that belongs to another workspace.
    // A throwing resolver is treated as "cannot verify" → refuse, so `decide`
    // can never throw synchronously (4.8-L3).
    if (options.workspaceIdOf !== undefined) {
      let matches = true
      try {
        matches = entry.workspaceId === options.workspaceIdOf(workspaceRoot)
      } catch {
        matches = false
      }
      if (!matches) {
        return Promise.resolve(settle(workspaceConflictOutcome()))
      }
    }

    let call: Promise<GrayRemoteResult<StagedEntry>>
    try {
      call = kind === 'accept'
        ? dataSource.accept({ entryId: entry.id, expectedRevision: entry.revision, workspace: workspaceRoot })
        : dataSource.reject({ entryId: entry.id, expectedRevision: entry.revision, workspace: workspaceRoot })
    } catch {
      // 4.8-L3: a synchronous throw from the data source must not escape
      // `decide` (the `.catch` below only observes rejections) — it becomes
      // an internal outcome so the busy state is always released.
      return Promise.resolve(settle(internalOutcome()))
    }

    let promise: Promise<StagedDiffDecisionOutcome>
    if (timeoutMs > 0) {
      // 3.8-M1: race the call against a timeout so a hanging remote cannot
      // freeze the busy state forever; the timeout outcome releases both the
      // tracker and the in-flight dedupe, leaving the entry operable.
      promise = new Promise<StagedDiffDecisionOutcome>(resolve => {
        const timer = setTimeout(() => resolve(settle(timeoutOutcome())), timeoutMs)
        void call.then(
          result => {
            clearTimeout(timer)
            const outcome: StagedDiffDecisionOutcome = result.ok
              ? { ok: true, entry: result.value }
              : { ok: false, error: mapStagedDiffFailure(result.error) }
            resolve(settle(outcome))
          },
          () => {
            clearTimeout(timer)
            resolve(settle(internalOutcome()))
          },
        )
      })
    } else {
      promise = call.then((result): StagedDiffDecisionOutcome => {
        const outcome: StagedDiffDecisionOutcome = result.ok
          ? { ok: true, entry: result.value }
          : { ok: false, error: mapStagedDiffFailure(result.error) }
        return settle(outcome)
      }).catch((): StagedDiffDecisionOutcome => settle(internalOutcome()))
    }

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
