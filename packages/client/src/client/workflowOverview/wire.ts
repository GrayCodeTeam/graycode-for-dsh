/**
 * Workflow overview (P4-02) — contract-driven envelope readers (pure).
 *
 * The host returns every remote call as a `GrayRemoteResult<T>` envelope
 * (`{ ok: true, value }` | `{ ok: false, error: { code, message, details } }`,
 * see packages/plugin/src/remote/types.ts). Business errors never reject —
 * only assembly faults surface as an `GRAY_ENDPOINT_NOT_FOUND` envelope. These
 * readers narrow the raw `unknown` envelope defensively: the client never
 * trusts the wire (same posture as `workflowNode/types.ts`), malformed items
 * are dropped instead of crashing the list, and unknown shapes degrade to a
 * stable `GRAY_INTERNAL` failure.
 */
import type {
  WorkflowOverviewError,
  WorkflowOverviewListResult,
  WorkflowRunDetailLike,
  WorkflowRunKind,
  WorkflowRunSummaryLike,
} from './types.ts'

/** Narrowed `ok` half of the remote envelope. */
export interface WorkflowEnvelopeOk {
  readonly ok: true
  readonly value: unknown
}

/** Narrowed failure half of the remote envelope. */
export interface WorkflowEnvelopeErr {
  readonly ok: false
  readonly error: WorkflowOverviewError
}

/** Narrowed remote envelope (`GrayRemoteResult<unknown>` mirror). */
export type WorkflowEnvelope = WorkflowEnvelopeOk | WorkflowEnvelopeErr

const RUN_KINDS: readonly string[] = ['progress', 'design', 'plan', 'review']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Read a path-like field verbatim (no trim). Workspace roots and document
 * paths are rendered and compared as-is — trimming them would distort a
 * legitimate path (audit M7). Only a fully empty value is rejected.
 */
function readPathString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value
}

function readInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.floor(value)
}

function internalFailure(message: string): WorkflowOverviewError {
  return { code: 'GRAY_INTERNAL', message, details: {} }
}

/**
 * Narrow one `GrayWorkflowRunSummary` wire item.
 * @param value - raw item.
 * @returns the typed summary, or null when the item is malformed (dropped).
 */
export function readWorkflowRunSummary(value: unknown): WorkflowRunSummaryLike | null {
  if (!isRecord(value)) return null
  const id = readString(value.id)
  const path = readPathString(value.path)
  const workspace = readPathString(value.workspace)
  if (id === undefined || path === undefined || workspace === undefined) return null
  if (typeof value.kind !== 'string' || !RUN_KINDS.includes(value.kind)) return null
  const kind = value.kind as WorkflowRunKind

  let summary: WorkflowRunSummaryLike = { id, kind, path, workspace }
  const updatedAt = readInt(value.updatedAt)
  if (updatedAt !== undefined) summary = { ...summary, updatedAt }
  const sizeBytes = readInt(value.sizeBytes)
  if (sizeBytes !== undefined) summary = { ...summary, sizeBytes }
  const status = readString(value.status)
  if (status !== undefined) summary = { ...summary, status }
  const phase = readString(value.phase)
  if (phase !== undefined) summary = { ...summary, phase }
  const projectName = readString(value.projectName)
  if (projectName !== undefined) summary = { ...summary, projectName }
  return summary
}

/**
 * Narrow a `workflows/list` value (`{ items, total, nextCursor? }`).
 * Malformed items are dropped; `total` falls back to the surviving item count
 * when absent/unusable.
 * @param value - raw `value` half of the envelope.
 * @returns the typed page, or null when the payload shape is unusable.
 */
export function readWorkflowListResult(value: unknown): WorkflowOverviewListResult | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null
  const items = value.items
    .map(readWorkflowRunSummary)
    .filter((item): item is WorkflowRunSummaryLike => item !== null)
  const total = typeof value.total === 'number' && Number.isFinite(value.total)
    ? Math.floor(value.total)
    : items.length
  const nextCursor = readString(value.nextCursor)
  let result: WorkflowOverviewListResult = { items, total }
  if (nextCursor !== undefined) result = { ...result, nextCursor }
  return result
}

/**
 * Narrow a `workflows/get` value (`GrayWorkflowRunDetail` mirror: summary +
 * `content` + optional `metadata`).
 * @param value - raw `value` half of the envelope.
 */
export function readWorkflowRunDetail(value: unknown): WorkflowRunDetailLike | null {
  if (!isRecord(value) || typeof value.content !== 'string') return null
  const summary = readWorkflowRunSummary(value)
  if (summary === null) return null
  let detail: WorkflowRunDetailLike = { ...summary, content: value.content }
  if (isRecord(value.metadata)) {
    detail = { ...detail, metadata: value.metadata as Readonly<Record<string, unknown>> }
  }
  return detail
}

/**
 * Narrow a `GrayRemoteFailure` value (`{ code, message, details }`).
 * @param value - raw `error` half of the envelope.
 */
export function readWorkflowFailure(value: unknown): WorkflowOverviewError | null {
  if (!isRecord(value)) return null
  const code = readString(value.code)
  if (code === undefined) return null
  return {
    code,
    message: typeof value.message === 'string' ? value.message : '',
    details: isRecord(value.details) ? (value.details as Readonly<Record<string, unknown>>) : {},
  }
}

/**
 * Narrow the raw remote envelope (`GrayRemoteResult<unknown>` mirror).
 * Anything that is not a well-formed envelope degrades to a stable
 * `GRAY_INTERNAL` failure — the consumer never crashes on the wire.
 * @param value - raw envelope from the transport.
 */
export function readWorkflowEnvelope(value: unknown): WorkflowEnvelope {
  if (!isRecord(value)) {
    return { ok: false, error: internalFailure('malformed remote envelope') }
  }
  if (value.ok === true) return { ok: true, value: value.value }
  if (value.ok === false) {
    const error = readWorkflowFailure(value.error)
    if (error !== null) return { ok: false, error }
  }
  return { ok: false, error: internalFailure('malformed remote envelope') }
}

/**
 * Normalize an arbitrary thrown value into a stable {@link WorkflowOverviewError}
 * (used at the data-source boundary; rejects never leak raw internals).
 * @param error - anything the transport/implementation threw.
 */
export function readWorkflowThrownError(error: unknown): WorkflowOverviewError {
  if (isRecord(error) && typeof error.code === 'string') {
    return {
      code: error.code,
      message: typeof error.message === 'string' ? error.message : '',
      details: isRecord(error.details) ? (error.details as Readonly<Record<string, unknown>>) : {},
    }
  }
  return internalFailure('unexpected error')
}
