/**
 * Operation-id idempotency for staged-diff decisions (P4-06).
 *
 * Every accept/reject mutation carries an operation id:
 * - an explicit id supplied by the caller (host wiring may reuse a stable
 *   id, e.g. the tool call id that produced the entry), or
 * - a derived id `<kind>:<entryId>` for same-entry double-click dedupe.
 *
 * A tracker records in-flight and resolved operations; repeating an
 * operation id returns the recorded outcome instead of re-invoking the data
 * source. The host additionally guards with the entry `revision` CAS —
 * client-side idempotency is a UI-layer dedupe, not a substitute for it.
 */
export type StagedDiffOperationKind = 'accept' | 'reject'

/** One tracked decision operation. */
export interface StagedDiffOperationRecord<TResult> {
  readonly operationId: string
  readonly kind: StagedDiffOperationKind
  readonly entryId: string
  readonly state: 'in-flight' | 'resolved'
  /** Present once resolved. */
  readonly result?: TResult
}

/** Result of `begin`: a fresh operation or a duplicate of an existing one. */
export interface StagedDiffOperationBegin<TResult> {
  readonly operationId: string
  /** True when the id was already tracked (in-flight or resolved). */
  readonly duplicate: boolean
  readonly record: StagedDiffOperationRecord<TResult>
}

/** Operation-id registry. */
export interface StagedDiffOperationTracker<TResult> {
  /**
   * Begin an operation. `explicitOperationId` defaults to
   * `<kind>:<entryId>`; repeating an id returns the existing record
   * (`duplicate: true`) without creating a second one.
   */
  begin(
    kind: StagedDiffOperationKind,
    entryId: string,
    explicitOperationId?: string,
  ): StagedDiffOperationBegin<TResult>
  /** Mark an operation resolved with its outcome. */
  resolve(operationId: string, result: TResult): void
  get(operationId: string): StagedDiffOperationRecord<TResult> | undefined
  /** Whether any operation for the entry is still in flight. */
  isInFlight(entryId: string): boolean
  /** Forget operations; with `entryId` only that entry's operations. */
  reset(entryId?: string): void
}

/** Create an empty operation tracker. */
export function createStagedDiffOperationTracker<TResult>(): StagedDiffOperationTracker<TResult> {
  const records = new Map<string, StagedDiffOperationRecord<TResult>>()
  return {
    begin(kind, entryId, explicitOperationId) {
      const operationId = explicitOperationId ?? `${kind}:${entryId}`
      const existing = records.get(operationId)
      if (existing !== undefined) {
        return { operationId, duplicate: true, record: existing }
      }
      const record: StagedDiffOperationRecord<TResult> = {
        operationId,
        kind,
        entryId,
        state: 'in-flight',
      }
      records.set(operationId, record)
      return { operationId, duplicate: false, record }
    },
    resolve(operationId, result) {
      const record = records.get(operationId)
      if (record === undefined) return
      records.set(operationId, { ...record, state: 'resolved', result })
    },
    get(operationId) {
      return records.get(operationId)
    },
    isInFlight(entryId) {
      for (const record of records.values()) {
        if (record.entryId === entryId && record.state === 'in-flight') return true
      }
      return false
    },
    reset(entryId) {
      if (entryId === undefined) {
        records.clear()
        return
      }
      for (const [id, record] of records) {
        if (record.entryId === entryId) records.delete(id)
      }
    },
  }
}
