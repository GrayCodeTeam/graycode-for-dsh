/**
 * Workflow node types and defensive event readers (P4-01).
 *
 * PROBE FINDING (rc.6): `@deepseek-ai/dsh-session` is not resolvable from this
 * package — it is a transitive dependency of `dsh-client-runtime`, not a peer
 * dependency, and tsc reports TS2307 for a direct import. The runtime's own
 * declarations reference it (suppressed by `skipLibCheck`), but source files
 * must not. The Definition therefore works against a structural
 * {@link WorkflowEventLike} supertype: every real `SessionEvent` is assignable
 * to it (contravariant parameter position), and every reader narrows
 * defensively instead of trusting the wire.
 *
 * CLIENT BOUNDARY RULES (PLAN_V2 §5.6): this module is replay-safe — it never
 * performs I/O, never touches the workspace, and treats document paths purely
 * as strings carried by event data. A path may reference a file that no longer
 * exists; the card renders it as text and leaves opening to a declarative
 * callback wired by the host.
 */
import type { ConversationLocation, ConversationViewNode } from '@deepseek-ai/dsh-client-runtime/client'
import { isWorkflowResultMeta, type WorkflowFamily, type WorkflowResultMeta } from './tools.ts'

/** Structural session-event view accepted by the workflow Definition. */
export interface WorkflowEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** Structural stand-in for the engine's `ConversationMatch`. */
export interface WorkflowMatchLike {
  readonly event: WorkflowEventLike
  readonly role: 'start' | 'update'
  readonly location: ConversationLocation
}

/** Structural stand-in for the engine's `ConversationNodeContext<State>`. */
export interface WorkflowContextLike<State> {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly matches: readonly WorkflowMatchLike[]
  readonly start: WorkflowMatchLike | undefined
  readonly state: State | undefined
  readonly current: ReadonlyMap<string, ConversationViewNode | null>
}

/** Narrowed `tool/call` payload the workflow Definition consumes. */
export interface ToolCallData {
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly name: string
  readonly arguments: string
}

/**
 * Read the fields the workflow Definition needs out of a `tool/call` payload.
 * @param data - raw event data (unknown by contract; narrowed defensively).
 */
export function readToolCallData(data: unknown): ToolCallData | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  if (typeof record.callId !== 'string' || record.callId.length === 0) return null
  if (typeof record.name !== 'string') return null
  return {
    turn: typeof record.turn === 'number' && Number.isSafeInteger(record.turn) ? record.turn : 0,
    step: typeof record.step === 'number' && Number.isSafeInteger(record.step) ? record.step : 0,
    callId: record.callId,
    name: record.name,
    arguments: typeof record.arguments === 'string' ? record.arguments : '',
  }
}

/** Narrowed `tool/result` payload the workflow Definition consumes. */
export interface ToolResultData {
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly error: { readonly name: string; readonly code: string } | undefined
  readonly meta: unknown
}

/**
 * Read the fields the workflow Definition needs out of a `tool/result` payload.
 *
 * Call correlation comes from `message.source.callId` (`ToolResultMessage`
 * carries it per the dsh-llm message contract); the workflow meta marker is a
 * secondary source when the host attaches one.
 * @param data - raw event data.
 */
export function readToolResultData(data: unknown): ToolResultData | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  const callId = readResultCallId(record)
  if (callId === null) return null
  const error = readResultError(record.error)
  return {
    turn: typeof record.turn === 'number' && Number.isSafeInteger(record.turn) ? record.turn : 0,
    step: typeof record.step === 'number' && Number.isSafeInteger(record.step) ? record.step : 0,
    callId,
    error,
    meta: record.meta,
  }
}

function readResultCallId(record: Record<string, unknown>): string | null {
  const message = record.message
  if (typeof message === 'object' && message !== null) {
    const source = (message as Record<string, unknown>).source
    if (typeof source === 'object' && source !== null) {
      const callId = (source as Record<string, unknown>).callId
      if (typeof callId === 'string' && callId.length > 0) return callId
    }
  }
  const meta = record.meta
  if (isWorkflowResultMeta(meta) && typeof meta.callId === 'string' && meta.callId.length > 0) {
    return meta.callId
  }
  return null
}

function readResultError(value: unknown): { readonly name: string; readonly code: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || typeof record.code !== 'string') return undefined
  return { name: record.name, code: record.code }
}

/**
 * First plain-text line of a tool result's model-facing output, if any.
 * @param data - raw `tool/result` event data.
 */
export function readToolResultText(data: unknown): string | null {
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
  const message = record?.message
  const content = (
    typeof message === 'object' && message !== null
    && Array.isArray((message as Record<string, unknown>).content)
  )
    ? (message as Record<string, unknown>).content as unknown[]
    : null
  if (content === null) return null
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const item = block as Record<string, unknown>
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0) {
      return item.text
    }
    if (Array.isArray(item.output)) {
      for (const inner of item.output) {
        if (typeof inner !== 'object' || inner === null) continue
        const part = inner as Record<string, unknown>
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0) {
          return part.text
        }
      }
    }
  }
  return null
}

/**
 * Parse the tool's JSON result payload out of the model-facing output text.
 * The workflow tools render `JSON.stringify(value)` as their text output, so
 * this recovers the structured result without any workspace access.
 * @param data - raw `tool/result` event data.
 */
export function readResultPayload(data: unknown): Readonly<Record<string, unknown>> | null {
  const text = readToolResultText(data)
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    // Not JSON (e.g. a plain error line) — treat as absent payload.
    return null
  }
}

function readStringField(payload: Readonly<Record<string, unknown>> | null, field: string): string | null {
  if (payload === null) return null
  const value = payload[field]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function firstStringField(payload: Readonly<Record<string, unknown>> | null, fields: readonly string[]): string | null {
  if (payload === null) return null
  for (const field of fields) {
    const value = readStringField(payload, field)
    if (value !== null) return value
  }
  return null
}

/** Document path from a workflow result payload (design/progress/review all carry `path`). */
export function readResultPath(data: unknown): string | null {
  return readStringField(readResultPayload(data), 'path')
}

/** Document-level status from a workflow result payload (e.g. progress `status`). */
export function readDocumentStatus(data: unknown): string | null {
  return readStringField(readResultPayload(data), 'status')
}

/** One-line summary from a workflow result payload (review title / progress focus). */
export function readResultSummary(data: unknown): string | null {
  return firstStringField(readResultPayload(data), ['currentFocus', 'title', 'projectName'])
}

/**
 * Parse `tool/call.arguments` (the raw JSON string the model produced).
 * @param raw - verbatim arguments string.
 * @returns the parsed plain object, or `{}` when absent/malformed.
 */
export function parseWorkflowArgs(raw: string): Readonly<Record<string, unknown>> {
  if (raw.trim().length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

/** Lifecycle status of one workflow tool call (drives the card badge). */
export type WorkflowToolStatus = 'draft' | 'active' | 'completed' | 'failed' | 'cancelled'

/** Structured failure surfaced on failed/cancelled workflow calls. */
export interface WorkflowNodeError {
  readonly name: string
  readonly code: string
  /** First line of the model-facing output text, when the log carries one. */
  readonly message?: string
}

/** Definition-owned immutable state of one workflow tool call. */
export interface WorkflowNodeState {
  readonly call: {
    readonly callId: string
    readonly tool: string
    /** Parsed `tool/call.arguments` (defensive; `{}` when malformed). */
    readonly args: Readonly<Record<string, unknown>>
    readonly turn: number
    readonly step: number
    /** Unix epoch ms of the `tool/call` event. */
    readonly calledAt: number
  }
  readonly status: WorkflowToolStatus
  /** Resolved document path (args path, then result path). */
  readonly path: string | null
  /** Unix epoch ms of the `tool/result` event, null while running. */
  readonly resultAt: number | null
  readonly error: WorkflowNodeError | null
  readonly summary: string | null
  /** Document-level status surfaced by the host meta/payload, if any. */
  readonly documentStatus: string | null
}

/** Render payload carried by `ChatConversationViewNode.data`. */
export interface WorkflowNodeData {
  readonly callId: string
  readonly tool: string
  readonly family: WorkflowFamily | null
  readonly status: WorkflowToolStatus
  readonly path: string | null
  readonly calledAt: number
  readonly resultAt: number | null
  readonly error: WorkflowNodeError | null
  readonly summary: string | null
  readonly documentStatus: string | null
  /** Whether the card should offer a retry entry (failed/cancelled). */
  readonly retryable: boolean
}

/**
 * Step-scoped business value published by `buildLocationData` so other client
 * surfaces (e.g. a details panel) can read "this step ran a workflow tool"
 * through the typed `ConversationStepDataMap` reader without scanning nodes.
 */
export interface WorkflowStepLocationData {
  readonly callId: string
  readonly tool: string
  readonly status: WorkflowToolStatus
  readonly path: string | null
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationStepDataMap {
    /**
     * Engine-enforced identity: the location-data `key` must equal the owning
     * Definition's `kind`, so this key is `WORKFLOW_KIND` ('graycode.workflow').
     */
    'graycode.workflow': WorkflowStepLocationData
  }
}

export type { WorkflowFamily, WorkflowResultMeta }
