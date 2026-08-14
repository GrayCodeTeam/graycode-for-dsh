/**
 * Workflow conversation node Definition (P4-01).
 *
 * Implements the DSH rc.6 `ConversationNodeDefinition` contract
 * (`match/start/update/buildLocationData/buildViewNode`) so Gray workflow tool
 * calls (create/update_design, create/update_progress, create_review, …)
 * render as dedicated cards in the conversation flow.
 *
 * Lifecycle mapping (pure, replay-safe — derives only from session events):
 *
 * - `tool/call` of a workflow tool        → start, status `active`
 * - `tool/result` (error code GRAY_CANCELLED) → update, status `cancelled`
 * - `tool/result` (other error)           → update, status `failed`
 * - `tool/result` (success, doc status `draft`) → update, status `draft`
 * - `tool/result` (success)               → update, status `completed`
 *
 * ENGINE SEMANTICS (verified against dsh-client-runtime rc.6 sources):
 * - `match()` returns the role; the engine correlates Contexts by the returned
 *   id. A `tool/result` whose `tool/call` is outside the loaded window lands
 *   as a start-less Context (state stays undefined → `buildViewNode` returns
 *   null → no node) and is replayed once an older page supplies the call.
 * - `buildLocationData` must publish `key === kind` and `kind === scope`
 *   (engine throws otherwise) — see `types.ts`.
 * - `buildViewNode` must return `node.key === context.key` (engine throws
 *   otherwise) — we always use `context.key` verbatim.
 */
import type {
  ChatConversationViewNode,
  ConversationLocationData,
  ConversationLocationDataScope,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkflowStreamWindow } from './stream.ts'
import { WORKFLOW_KIND, isWorkflowToolName, workflowToolFamily, isWorkflowResultMeta } from './tools.ts'
import {
  parseWorkflowArgs,
  readDocumentStatus,
  readResultPath,
  readResultSummary,
  readToolCallData,
  readToolResultData,
  readToolResultText,
  type ToolCallData,
  type WorkflowContextLike,
  type WorkflowEventLike,
  type WorkflowMatchLike,
  type WorkflowNodeData,
  type WorkflowNodeState,
  type WorkflowStepLocationData,
  type WorkflowToolStatus,
} from './types.ts'

/** Stable Definition-local identity of one tool call. */
export function workflowCallId(callId: string): string {
  return `call:${callId}`
}

/**
 * Recognise one session event as part of the workflow surface.
 * @param event - raw session event (structural view; see types.ts).
 * @returns the stable business identity and lifecycle role, or null.
 */
export function matchWorkflowEvent(event: WorkflowEventLike): { id: string; role: 'start' | 'update' } | null {
  if (event.type === 'tool/call') {
    const data = readToolCallData(event.data)
    if (data === null || !isWorkflowToolName(data.name)) return null
    return { id: workflowCallId(data.callId), role: 'start' }
  }
  if (event.type === 'tool/result') {
    const data = readToolResultData(event.data)
    if (data === null) return null
    // Every tool result matches by call id; update() folds only Contexts that
    // actually started as workflow calls (the engine calls update() only when
    // State exists, so unrelated results are inert — see module doc).
    return { id: workflowCallId(data.callId), role: 'update' }
  }
  return null
}

function firstString(args: Readonly<Record<string, unknown>>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = args[field]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

/**
 * Create State from the unique start Match (a workflow `tool/call`).
 * @param context - complete evidence currently collected for the Context.
 * @param match - the start Match.
 */
export function startWorkflowNode(context: WorkflowContextLike<WorkflowNodeState>, match: WorkflowMatchLike): WorkflowNodeState {
  const data = readToolCallData(match.event.data)
  const call = data ?? fallbackCall(context)
  const args = parseWorkflowArgs(call.arguments)
  return {
    call: {
      callId: call.callId,
      tool: call.name,
      args,
      turn: call.turn,
      step: call.step,
      calledAt: match.event.time,
    },
    status: 'active',
    path: firstString(args, ['path']),
    resultAt: null,
    error: null,
    summary: firstString(args, ['title', 'projectName', 'currentFocus', 'overview']),
    documentStatus: null,
  }
}

/** Defensive fallback when direct callers bypass match() (the engine never does). */
function fallbackCall(context: WorkflowContextLike<WorkflowNodeState>): ToolCallData {
  return {
    turn: 0,
    step: 0,
    callId: context.id.startsWith('call:') ? context.id.slice('call:'.length) : context.id,
    name: 'unknown',
    arguments: '',
  }
}

/**
 * Apply one post-start update Match (a correlated `tool/result`).
 * @param context - Context with its current State.
 * @param match - update Match in ascending log order.
 */
export function updateWorkflowNode(
  context: WorkflowContextLike<WorkflowNodeState> & { readonly state: WorkflowNodeState },
  match: WorkflowMatchLike,
): WorkflowNodeState {
  const state = context.state
  const data = readToolResultData(match.event.data)
  // The engine correlates by identity, so a mismatch is a caller bug; stay inert.
  if (data === null || data.callId !== state.call.callId) return state

  const error = data.error === undefined
    ? null
    : {
        name: data.error.name,
        code: data.error.code,
        message: readToolResultText(match.event.data) ?? undefined,
      }

  let status: WorkflowToolStatus
  if (error !== null) {
    status = error.code === 'GRAY_CANCELLED' ? 'cancelled' : 'failed'
  } else {
    status = 'completed'
  }

  const meta = isWorkflowResultMeta(data.meta) ? data.meta : null
  const documentStatus = meta?.status ?? readDocumentStatus(match.event.data) ?? state.documentStatus
  // 'draft' is a document-level state: a successful call whose document is
  // still a draft renders the draft badge instead of completed.
  if (status === 'completed' && documentStatus === 'draft') status = 'draft'

  return {
    ...state,
    status,
    path: meta?.path ?? readResultPath(match.event.data) ?? state.path,
    resultAt: match.event.time,
    error,
    summary: readResultSummary(match.event.data) ?? state.summary,
    documentStatus,
  }
}

/**
 * Publish this Definition's step-scoped business value (the workflow call
 * facts) so typed readers can observe it without scanning chat nodes.
 * @param context - latest complete Context.
 * @param scope - location hierarchy level being materialized.
 */
export function buildWorkflowLocationData(
  context: WorkflowContextLike<WorkflowNodeState>,
  scope: ConversationLocationDataScope,
): ConversationLocationData | null {
  if (scope !== 'step') return null
  const state = context.state
  if (state === undefined) return null
  const value: WorkflowStepLocationData = {
    callId: state.call.callId,
    tool: state.call.tool,
    status: state.status,
    path: state.path,
  }
  return {
    kind: 'step',
    turn: state.call.turn,
    step: state.call.step,
    key: WORKFLOW_KIND,
    value,
  }
}

/** The chat node produced by the workflow Definition. */
export type WorkflowChatViewNode = ChatConversationViewNode & {
  readonly kind: typeof WORKFLOW_KIND
  readonly data: WorkflowNodeData
}

/**
 * Materialize the final chat node for a workflow Context.
 * @param context - latest complete Context.
 * @returns the node, or null when the Context has no State yet (its start
 *          `tool/call` is outside the loaded window — see module doc).
 */
export function buildWorkflowViewNode(context: WorkflowContextLike<WorkflowNodeState>): WorkflowChatViewNode | null {
  const state = context.state
  if (state === undefined) return null
  const anchorEvent = context.start?.event ?? context.matches[0]?.event
  if (anchorEvent === undefined) return null
  const data: WorkflowNodeData = {
    callId: state.call.callId,
    tool: state.call.tool,
    family: workflowToolFamily(state.call.tool),
    status: state.status,
    path: state.path,
    calledAt: state.call.calledAt,
    resultAt: state.resultAt,
    error: state.error,
    summary: state.summary,
    documentStatus: state.documentStatus,
    retryable: state.status === 'failed' || state.status === 'cancelled',
  }
  return {
    key: context.key,
    kind: WORKFLOW_KIND,
    id: context.id,
    target: 'chat',
    data,
    anchorSeq: anchorEvent.seq,
    location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
    visibility: 'visible',
  }
}

/**
 * The registered Definition. Register it with the client runtime:
 *
 * ```ts
 * const disposer = ctx.conversationEvents.register(createWorkflowNodeDefinition())
 * ctx.effect(() => disposer)
 * ```
 *
 * (The browser half of `index.ts` is wired by the main session — P4-01 keeps
 * this factory pure and testable.)
 */
export function createWorkflowNodeDefinition(): ConversationNodeDefinition<WorkflowNodeState> {
  return {
    kind: WORKFLOW_KIND,
    target: 'chat',
    match: matchWorkflowEvent,
    start: startWorkflowNode,
    update: updateWorkflowNode,
    buildLocationData: buildWorkflowLocationData,
    buildViewNode: buildWorkflowViewNode,
  }
}

/** One folded workflow Context kept by {@link foldWorkflowWindow}. */
interface FoldedWorkflowContext {
  readonly start: WorkflowMatchLike
  readonly matches: readonly WorkflowMatchLike[]
  readonly state: WorkflowNodeState
}

function foldWorkflowContext(
  id: string,
  start: WorkflowMatchLike | undefined,
  state: WorkflowNodeState | undefined,
): WorkflowContextLike<WorkflowNodeState> {
  return {
    key: `${WORKFLOW_KIND}:${id}`,
    kind: WORKFLOW_KIND,
    id,
    matches: start === undefined ? [] : [start],
    start,
    state,
    current: new Map(),
  }
}

/**
 * Fold a stream window into workflow node views (pure derivation helper).
 *
 * Mirrors the engine's per-event Definition evaluation over the window: start
 * on the first workflow `tool/call`, fold correlated results, then build views
 * in start-event order. Used by tests and by client-side projections that keep
 * their own window; the engine performs the same fold over its Contexts.
 *
 * @param window - a stream window (see stream.ts).
 * @returns node view payloads in window order.
 */
export function foldWorkflowWindow(window: WorkflowStreamWindow): WorkflowNodeData[] {
  const folded = new Map<string, FoldedWorkflowContext>()
  for (const event of window.entries) {
    const result = matchWorkflowEvent(event)
    if (result === null) continue
    const id = result.id
    const match: WorkflowMatchLike = {
      event,
      role: result.role,
      location: { kind: 'unresolved' },
    }
    const existing = folded.get(id)
    if (result.role === 'start') {
      if (existing !== undefined) continue // duplicate start: first wins
      const state = startWorkflowNode(foldWorkflowContext(id, undefined, undefined), match)
      folded.set(id, { start: match, matches: [match], state })
    } else if (existing !== undefined) {
      // Result without an in-window call stays start-less (no node) — same
      // semantics as the engine's pending-match replay.
      const state = updateWorkflowNode({
        ...foldWorkflowContext(id, existing.start, undefined),
        state: existing.state,
      }, match)
      folded.set(id, { start: existing.start, matches: [...existing.matches, match], state })
    }
  }

  const views: WorkflowNodeData[] = []
  for (const event of window.entries) {
    const result = matchWorkflowEvent(event)
    if (result === null || result.role !== 'start') continue
    const foldedContext = folded.get(result.id)
    if (foldedContext === undefined) continue
    const node = buildWorkflowViewNode({
      key: `${WORKFLOW_KIND}:${result.id}`,
      kind: WORKFLOW_KIND,
      id: result.id,
      matches: foldedContext.matches,
      start: foldedContext.start,
      state: foldedContext.state,
      current: new Map(),
    })
    if (node !== null) views.push(node.data)
  }
  return views
}
