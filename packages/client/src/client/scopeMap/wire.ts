/**
 * Migration workspace memory mapping (D-1/D-2) — contract-driven envelope
 * readers (pure).
 *
 * The host returns every remote call as a `GrayRemoteResult<T>` envelope
 * (`{ ok: true, value }` | `{ ok: false, error }`). These readers narrow the
 * raw `unknown` defensively — the client never trusts the wire: malformed
 * entries are dropped and unknown shapes degrade to a stable `GRAY_INTERNAL`
 * failure.
 */

import type { ScopeMapEntryLike, ScopeMapError, ScopeMapResultLike } from './types.ts'

/** Narrowed `ok` half of the remote envelope. */
export interface ScopeMapEnvelopeOk {
  readonly ok: true
  readonly value: unknown
}

/** Narrowed failure half of the remote envelope. */
export interface ScopeMapEnvelopeErr {
  readonly ok: false
  readonly error: ScopeMapError
}

/** Narrowed remote envelope (`GrayRemoteResult<unknown>` mirror). */
export type ScopeMapEnvelope = ScopeMapEnvelopeOk | ScopeMapEnvelopeErr

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function internalFailure(message: string): ScopeMapError {
  return { code: 'GRAY_INTERNAL', message, details: {} }
}

/** Narrow one `ScopeMapEntry` wire item; malformed rows degrade to null. */
export function readScopeMapEntry(value: unknown): ScopeMapEntryLike | null {
  if (!isRecord(value)) return null
  const hashDir = readString(value.hashDir)
  if (hashDir === undefined) return null
  if (value.status !== 'auto' && value.status !== 'unmapped') return null
  const sourcePath = readString(value.sourcePath)
  const uri = readString(value.uri)
  const suggestedTarget = readString(value.suggestedTarget) ?? null
  return {
    hashDir,
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    ...(uri !== undefined ? { uri } : {}),
    status: value.status,
    suggestedTarget,
  }
}

/**
 * Narrow the `migration/scopeMap` result value. Malformed rows are dropped; an
 * absent/empty `entries` array is valid (the panel's empty state).
 */
export function readScopeMapResult(value: unknown): ScopeMapResultLike | null {
  if (!isRecord(value) || !Array.isArray(value.entries)) return null
  return {
    entries: value.entries
      .map(readScopeMapEntry)
      .filter((entry): entry is ScopeMapEntryLike => entry !== null),
  }
}

/** Narrow a `GrayRemoteFailure` value (`{ code, message, details }`). */
export function readScopeMapFailure(value: unknown): ScopeMapError | null {
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
 * Narrow the raw remote envelope. Anything that is not a well-formed envelope
 * degrades to a stable `GRAY_INTERNAL` failure — the consumer never crashes on
 * the wire.
 */
export function readScopeMapEnvelope(value: unknown): ScopeMapEnvelope {
  if (!isRecord(value)) {
    return { ok: false, error: internalFailure('malformed remote envelope') }
  }
  if (value.ok === true) return { ok: true, value: value.value }
  if (value.ok === false) {
    const error = readScopeMapFailure(value.error)
    if (error !== null) return { ok: false, error }
  }
  return { ok: false, error: internalFailure('malformed remote envelope') }
}

/**
 * Normalize an arbitrary thrown value into a stable {@link ScopeMapError}
 * (used at the data-source boundary; rejects never leak raw internals).
 */
export function readScopeMapThrownError(error: unknown): ScopeMapError {
  if (isRecord(error) && typeof error.code === 'string') {
    return {
      code: error.code,
      message: typeof error.message === 'string' ? error.message : '',
      details: isRecord(error.details) ? (error.details as Readonly<Record<string, unknown>>) : {},
    }
  }
  return internalFailure('unexpected error')
}
