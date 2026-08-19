/**
 * P4-01 workflow conversation node — pure-logic tests.
 *
 * Covers: workflow tool recognition (match), the Definition state machine
 * (start/update), node view-model construction (buildViewNode), the
 * replace/prepend/append stream merge (with seq dedupe), the end-to-end
 * window fold, and locale key alignment.
 *
 * React is intentionally not imported: these are node-environment tests of the
 * replay-safe pure logic (the card component is not rendered here).
 */
import { describe, expect, it } from 'vitest'
import {
  WORKFLOW_KIND,
  WORKFLOW_TOOLS,
  isWorkflowToolName,
  workflowToolFamily,
  workflowToolLocaleKey,
} from '../src/client/workflowNode/tools.ts'
import {
  buildWorkflowViewNode,
  createWorkflowNodeDefinition,
  foldWorkflowWindow,
  matchWorkflowEvent,
  startWorkflowNode,
  updateWorkflowNode,
  workflowCallId,
} from '../src/client/workflowNode/definition.ts'
import {
  EMPTY_WORKFLOW_STREAM,
  applyWorkflowStreamUpdate,
  dedupeWorkflowEvents,
} from '../src/client/workflowNode/stream.ts'
import {
  GRAYCODE_WORKFLOW_NS,
  graycodeWorkflowDictionaries,
  graycodeWorkflowJaPlaceholder,
} from '../src/client/workflowNode/locales.ts'
import type { WorkflowContextLike, WorkflowEventLike, WorkflowNodeState } from '../src/client/workflowNode/types.ts'

// ---------------------------------------------------------------------------
// Event builders (structural SessionEvent views)
// ---------------------------------------------------------------------------

function toolCall(
  seq: number,
  callId: string,
  name: string,
  args: unknown,
  opts: { turn?: number; step?: number; time?: number } = {},
): WorkflowEventLike {
  return {
    type: 'tool/call',
    seq,
    time: opts.time ?? seq * 1000,
    data: {
      turn: opts.turn ?? 1,
      step: opts.step ?? 1,
      callId,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  }
}

function toolResult(
  seq: number,
  callId: string,
  payload: unknown,
  opts: {
    error?: { name: string; code: string }
    meta?: unknown
    turn?: number
    step?: number
    time?: number
    text?: string
  } = {},
): WorkflowEventLike {
  const text = opts.text ?? JSON.stringify(payload)
  return {
    type: 'tool/result',
    seq,
    time: opts.time ?? seq * 1000,
    data: {
      turn: opts.turn ?? 1,
      step: opts.step ?? 1,
      message: {
        role: 'user',
        id: `msg-${seq}`,
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', callId, output: [{ type: 'text', text }] }],
      },
      ...(opts.error !== undefined ? { error: opts.error } : {}),
      ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
    },
  }
}

function contextOf(id: string, state: WorkflowNodeState | undefined, start?: WorkflowEventLike): WorkflowContextLike<WorkflowNodeState> & { state: WorkflowNodeState } {
  const startMatch = start === undefined
    ? undefined
    : { event: start, role: 'start' as const, location: { kind: 'unresolved' } as const }
  return {
    key: `${WORKFLOW_KIND}:${id}`,
    kind: WORKFLOW_KIND,
    id,
    matches: startMatch === undefined ? [] : [startMatch],
    start: startMatch,
    // Callers pass a real state whenever the node needs one (update paths);
    // the assertion only narrows the test-helper surface, not runtime data.
    state: state as WorkflowNodeState,
    current: new Map(),
  }
}

// ---------------------------------------------------------------------------
// Workflow tool recognition
// ---------------------------------------------------------------------------

describe('workflow tool recognition', () => {
  it('recognises all 14 workflow tool names', () => {
    expect(WORKFLOW_TOOLS).toHaveLength(14)
    for (const name of WORKFLOW_TOOLS) {
      expect(isWorkflowToolName(name), name).toBe(true)
    }
  })

  it('rejects non-workflow tool names', () => {
    for (const name of ['memory_note', 'staged_diff_stage', 'checkpoint_create', 'branch_list', '', 'create_design_x']) {
      expect(isWorkflowToolName(name), name).toBe(false)
    }
  })

  it('classifies every tool into its family', () => {
    expect(workflowToolFamily('create_design')).toBe('design')
    expect(workflowToolFamily('update_design')).toBe('design')
    expect(workflowToolFamily('create_plan')).toBe('plan')
    expect(workflowToolFamily('update_plan')).toBe('plan')
    expect(workflowToolFamily('create_progress')).toBe('progress')
    expect(workflowToolFamily('validate_review_document')).toBe('review')
    expect(workflowToolFamily('unknown_tool')).toBeNull()
  })

  it('derives locale keys for every workflow tool and rejects others', () => {
    for (const name of WORKFLOW_TOOLS) {
      expect(workflowToolLocaleKey(name)).toBe(`tool.${name}`)
    }
    expect(workflowToolLocaleKey('memory_note')).toBeNull()
  })

  it('match() starts on workflow tool calls with a stable call identity', () => {
    const event = toolCall(10, 'c1', 'create_design', { title: 'T' })
    expect(matchWorkflowEvent(event)).toEqual({ id: workflowCallId('c1'), role: 'start' })
  })

  it('match() ignores non-workflow calls and unrelated event types', () => {
    expect(matchWorkflowEvent(toolCall(10, 'c1', 'memory_note', {}))).toBeNull()
    expect(matchWorkflowEvent({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })).toBeNull()
    expect(matchWorkflowEvent({ type: 'assistant/message', seq: 2, time: 2, data: {} })).toBeNull()
  })

  it('match() treats malformed tool/call data as unrelated', () => {
    expect(matchWorkflowEvent({ type: 'tool/call', seq: 1, time: 1, data: null })).toBeNull()
    expect(matchWorkflowEvent({ type: 'tool/call', seq: 1, time: 1, data: { name: 'create_design' } })).toBeNull()
  })

  it('match() updates on tool results via message.source.callId', () => {
    const event = toolResult(20, 'c1', { path: '.graycode/design/a.md' })
    expect(matchWorkflowEvent(event)).toEqual({ id: workflowCallId('c1'), role: 'update' })
  })

  it('match() falls back to meta.callId when the message source is absent', () => {
    const event: WorkflowEventLike = {
      type: 'tool/result',
      seq: 20,
      time: 20000,
      data: { turn: 1, step: 1, meta: { kind: 'graycode.workflow', callId: 'c9' } },
    }
    expect(matchWorkflowEvent(event)).toEqual({ id: workflowCallId('c9'), role: 'update' })
  })

  it('match() ignores results with no call identity', () => {
    expect(matchWorkflowEvent({ type: 'tool/result', seq: 1, time: 1, data: { turn: 1, step: 1 } })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Definition state machine
// ---------------------------------------------------------------------------

describe('workflow node state machine', () => {
  it('start() creates an active state from the tool call', () => {
    const event = toolCall(10, 'c1', 'create_design', { title: 'T', path: '.graycode/design/a.md' }, { time: 5000 })
    const match = { event, role: 'start' as const, location: { kind: 'unresolved' } as const }
    const state = startWorkflowNode(contextOf('call:c1', undefined), match)
    expect(state.status).toBe('active')
    expect(state.call.callId).toBe('c1')
    expect(state.call.tool).toBe('create_design')
    expect(state.call.calledAt).toBe(5000)
    expect(state.path).toBe('.graycode/design/a.md')
    expect(state.summary).toBe('T')
    expect(state.error).toBeNull()
    expect(state.resultAt).toBeNull()
    // retryable lives on the built view data, not on the state
    expect('retryable' in state).toBe(false)
  })

  it('start() survives malformed arguments JSON', () => {
    const event = toolCall(10, 'c1', 'create_review', '{not json', { time: 5000 })
    const match = { event, role: 'start' as const, location: { kind: 'unresolved' } as const }
    const state = startWorkflowNode(contextOf('call:c1', undefined), match)
    expect(state.status).toBe('active')
    expect(state.path).toBeNull()
  })

  it('update() completes the call and resolves the document path', () => {
    const call = toolCall(10, 'c1', 'create_design', { title: 'T' }, { time: 5000 })
    const start = startWorkflowNode(contextOf('call:c1', undefined), {
      event: call,
      role: 'start',
      location: { kind: 'unresolved' },
    })
    const result = toolResult(20, 'c1', { path: '.graycode/design/a.md' }, { time: 9000 })
    const state = updateWorkflowNode(contextOf('call:c1', start), {
      event: result,
      role: 'update',
      location: { kind: 'unresolved' },
    })
    expect(state.status).toBe('completed')
    expect(state.path).toBe('.graycode/design/a.md')
    expect(state.resultAt).toBe(9000)
    expect(state.error).toBeNull()
  })

  it('update() marks failed calls with the structured error', () => {
    const call = toolCall(10, 'c1', 'update_design', { path: 'x.md' }, { time: 5000 })
    const start = startWorkflowNode(contextOf('call:c1', undefined), {
      event: call,
      role: 'start',
      location: { kind: 'unresolved' },
    })
    const result = toolResult(
      20,
      'c1',
      null,
      { error: { name: 'DesignError', code: 'GRAY_INVALID_INPUT' }, text: 'path is required' },
    )
    const state = updateWorkflowNode(contextOf('call:c1', start), {
      event: result,
      role: 'update',
      location: { kind: 'unresolved' },
    })
    expect(state.status).toBe('failed')
    expect(state.error).toEqual({
      name: 'DesignError',
      code: 'GRAY_INVALID_INPUT',
      message: 'path is required',
    })
  })

  it('update() maps GRAY_CANCELLED to the cancelled status', () => {
    const call = toolCall(10, 'c1', 'create_progress', {}, { time: 5000 })
    const start = startWorkflowNode(contextOf('call:c1', undefined), {
      event: call,
      role: 'start',
      location: { kind: 'unresolved' },
    })
    const result = toolResult(20, 'c1', null, { error: { name: 'GrayCancelled', code: 'GRAY_CANCELLED' } })
    const state = updateWorkflowNode(contextOf('call:c1', start), {
      event: result,
      role: 'update',
      location: { kind: 'unresolved' },
    })
    expect(state.status).toBe('cancelled')
  })

  it('update() surfaces a draft document status from the workflow meta', () => {
    const call = toolCall(10, 'c1', 'create_review', {}, { time: 5000 })
    const start = startWorkflowNode(contextOf('call:c1', undefined), {
      event: call,
      role: 'start',
      location: { kind: 'unresolved' },
    })
    const result = toolResult(20, 'c1', { path: '.graycode/review/r.md' }, {
      meta: { kind: 'graycode.workflow', callId: 'c1', status: 'draft' },
    })
    const state = updateWorkflowNode(contextOf('call:c1', start), {
      event: result,
      role: 'update',
      location: { kind: 'unresolved' },
    })
    expect(state.status).toBe('draft')
    expect(state.documentStatus).toBe('draft')
  })

  it('update() reads document status from the result payload when no meta is present', () => {
    const call = toolCall(10, 'c1', 'create_progress', {}, { time: 5000 })
    const start = startWorkflowNode(contextOf('call:c1', undefined), {
      event: call,
      role: 'start',
      location: { kind: 'unresolved' },
    })
    const result = toolResult(20, 'c1', { path: '.graycode/progress.md', status: 'active' })
    const state = updateWorkflowNode(contextOf('call:c1', start), {
      event: result,
      role: 'update',
      location: { kind: 'unresolved' },
    })
    expect(state.status).toBe('completed')
    expect(state.documentStatus).toBe('active')
  })

  it('update() stays inert for an uncorrelated result', () => {
    const call = toolCall(10, 'c1', 'create_design', {}, { time: 5000 })
    const start = startWorkflowNode(contextOf('call:c1', undefined), {
      event: call,
      role: 'start',
      location: { kind: 'unresolved' },
    })
    const result = toolResult(20, 'OTHER', { path: 'x.md' })
    const state = updateWorkflowNode(contextOf('call:c1', start), {
      event: result,
      role: 'update',
      location: { kind: 'unresolved' },
    })
    expect(state).toBe(start)
    expect(state.status).toBe('active')
  })
})

// ---------------------------------------------------------------------------
// View node construction
// ---------------------------------------------------------------------------

describe('buildViewNode', () => {
  it('returns null while the Context has no State (start outside the window)', () => {
    expect(buildWorkflowViewNode(contextOf('call:c1', undefined))).toBeNull()
  })

  it('builds a chat node carrying the workflow payload', () => {
    const call = toolCall(10, 'c1', 'create_review', { title: 'Review A' }, { time: 5000 })
    const start = startWorkflowNode(contextOf('call:c1', undefined), {
      event: call,
      role: 'start',
      location: { kind: 'unresolved' },
    })
    const result = toolResult(20, 'c1', { path: '.graycode/review/a.md' }, { time: 9000 })
    const state = updateWorkflowNode(contextOf('call:c1', start), {
      event: result,
      role: 'update',
      location: { kind: 'unresolved' },
    })
    const node = buildWorkflowViewNode(contextOf('call:c1', state, call))
    expect(node).not.toBeNull()
    expect(node!.key).toBe(`${WORKFLOW_KIND}:call:c1`)
    expect(node!.kind).toBe(WORKFLOW_KIND)
    expect(node!.id).toBe('call:c1')
    expect(node!.target).toBe('chat')
    expect(node!.anchorSeq).toBe(10)
    expect(node!.location).toEqual({ kind: 'unresolved' })
    expect(node!.visibility).toBe('visible')
    expect(node!.data).toEqual({
      callId: 'c1',
      tool: 'create_review',
      family: 'review',
      status: 'completed',
      path: '.graycode/review/a.md',
      calledAt: 5000,
      resultAt: 9000,
      error: null,
      summary: 'Review A',
      documentStatus: null,
      retryable: false,
    })
  })

  it('exposes retryable only for failed/cancelled nodes', () => {
    const call = toolCall(10, 'c1', 'create_design', {}, { time: 5000 })
    const start = startWorkflowNode(contextOf('call:c1', undefined), {
      event: call,
      role: 'start',
      location: { kind: 'unresolved' },
    })
    const failed = updateWorkflowNode(contextOf('call:c1', start), {
      event: toolResult(20, 'c1', null, { error: { name: 'E', code: 'GRAY_INVALID_INPUT' } }),
      role: 'update',
      location: { kind: 'unresolved' },
    })
    expect(buildWorkflowViewNode(contextOf('call:c1', failed, call))!.data.retryable).toBe(true)

    const running = buildWorkflowViewNode(contextOf('call:c1', start, call))
    expect(running!.data.retryable).toBe(false)
    expect(running!.data.status).toBe('active')
  })

  it('returns a family-null payload for unknown tools (defensive)', () => {
    const call = toolCall(10, 'c1', 'unknown_tool', {}, { time: 5000 })
    const match = { event: call, role: 'start' as const, location: { kind: 'unresolved' } as const }
    const state = startWorkflowNode(contextOf('call:c1', undefined), match)
    // start() never sees non-workflow names through the engine; direct calls
    // still must not throw (state.tool is what it is).
    const node = buildWorkflowViewNode(contextOf('call:c1', state, call))
    expect(node!.data.family).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Stream updates (replace / prepend / append)
// ---------------------------------------------------------------------------

describe('workflow stream updates', () => {
  it('replace installs a fresh deduplicated window', () => {
    const call = toolCall(10, 'c1', 'create_design', {})
    const dup = toolCall(10, 'c1', 'create_design', {})
    const window = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, {
      kind: 'replace',
      entries: [dup, call],
      hasMore: true,
    })
    expect(window.entries.map((event) => event.seq)).toEqual([10])
    expect(window.hasMore).toBe(true)
    expect(window.revision).toBe(1)
  })

  it('replace keeps ascending seq order and resets prior state', () => {
    const first = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, {
      kind: 'append',
      entry: toolCall(50, 'c1', 'create_design', {}),
    })
    const second = applyWorkflowStreamUpdate(first, {
      kind: 'replace',
      entries: [toolCall(10, 'c2', 'create_review', {}), toolCall(20, 'c3', 'create_progress', {})],
      hasMore: false,
    })
    expect(second.entries.map((event) => event.seq)).toEqual([10, 20])
    expect(second.hasMore).toBe(false)
    expect(second.revision).toBe(first.revision + 1)
  })

  it('append lands a contiguous tail event and preserves hasMore', () => {
    const base = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, {
      kind: 'replace',
      entries: [toolCall(10, 'c1', 'create_design', {})],
      hasMore: true,
    })
    const next = applyWorkflowStreamUpdate(base, {
      kind: 'append',
      entry: toolResult(20, 'c1', { path: 'a.md' }),
    })
    expect(next.entries.map((event) => event.seq)).toEqual([10, 20])
    expect(next.hasMore).toBe(true)
    expect(next.revision).toBe(base.revision + 1)
  })

  it('append drops duplicate and out-of-order seqs without mutating', () => {
    const base = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, {
      kind: 'replace',
      entries: [toolCall(10, 'c1', 'create_design', {})],
      hasMore: false,
    })
    const duplicate = applyWorkflowStreamUpdate(base, { kind: 'append', entry: toolCall(10, 'c1', 'create_design', {}) })
    expect(duplicate).toBe(base)
    const overlap = applyWorkflowStreamUpdate(base, { kind: 'append', entry: toolCall(9, 'c2', 'create_review', {}) })
    expect(overlap).toBe(base)
  })

  it('prepend lands an older page before the window head', () => {
    const base = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, {
      kind: 'replace',
      entries: [toolCall(30, 'c2', 'create_design', {}), toolResult(40, 'c2', { path: 'a.md' })],
      hasMore: false,
    })
    const next = applyWorkflowStreamUpdate(base, {
      kind: 'prepend',
      entries: [toolCall(10, 'c1', 'create_review', {}), toolCall(20, 'c3', 'create_progress', {})],
      hasMore: true,
    })
    expect(next.entries.map((event) => event.seq)).toEqual([10, 20, 30, 40])
    expect(next.hasMore).toBe(true)
    expect(next.revision).toBe(base.revision + 1)
  })

  it('prepend filters boundary overlaps and duplicates', () => {
    const base = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, {
      kind: 'replace',
      entries: [toolCall(30, 'c2', 'create_design', {})],
      hasMore: false,
    })
    const next = applyWorkflowStreamUpdate(base, {
      kind: 'prepend',
      entries: [toolCall(10, 'c1', 'create_review', {}), toolCall(30, 'c2', 'create_design', {}), toolCall(40, 'c3', 'create_progress', {})],
      hasMore: true,
    })
    expect(next.entries.map((event) => event.seq)).toEqual([10, 30])
  })

  it('prepend is a no-op when nothing changes', () => {
    const base = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, {
      kind: 'replace',
      entries: [toolCall(10, 'c1', 'create_design', {})],
      hasMore: true,
    })
    const same = applyWorkflowStreamUpdate(base, { kind: 'prepend', entries: [], hasMore: true })
    expect(same).toBe(base)
  })

  it('dedupeWorkflowEvents keeps the first occurrence per seq', () => {
    const a = toolCall(10, 'c1', 'create_design', {})
    const b = toolCall(10, 'c1', 'create_design', { path: 'other.md' })
    const deduped = dedupeWorkflowEvents([b, a])
    expect(deduped).toHaveLength(1)
    expect(deduped[0]).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// End-to-end window fold
// ---------------------------------------------------------------------------

describe('foldWorkflowWindow (window → node views)', () => {
  it('derives a completed node from a call+result pair', () => {
    const window = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, {
      kind: 'append',
      entry: toolCall(10, 'c1', 'create_design', { title: 'T' }, { time: 5000 }),
    })
    const withResult = applyWorkflowStreamUpdate(window, {
      kind: 'append',
      entry: toolResult(20, 'c1', { path: '.graycode/design/a.md' }, { time: 9000 }),
    })
    const views = foldWorkflowWindow(withResult)
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({
      callId: 'c1',
      tool: 'create_design',
      family: 'design',
      status: 'completed',
      path: '.graycode/design/a.md',
      calledAt: 5000,
      resultAt: 9000,
      retryable: false,
    })
  })

  it('keeps an active node for a call without a result', () => {
    const window = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, {
      kind: 'replace',
      entries: [toolCall(10, 'c1', 'create_progress', {})],
      hasMore: false,
    })
    const views = foldWorkflowWindow(window)
    expect(views).toHaveLength(1)
    expect(views[0]!.status).toBe('active')
    expect(views[0]!.resultAt).toBeNull()
  })

  it('produces no node for a result whose call is outside the window', () => {
    const window = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, {
      kind: 'replace',
      entries: [toolResult(20, 'c1', { path: 'a.md' })],
      hasMore: true,
    })
    expect(foldWorkflowWindow(window)).toEqual([])
  })

  it('folds cancelled and draft statuses through the stream', () => {
    const cancelled = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, {
      kind: 'replace',
      entries: [
        toolCall(10, 'c1', 'create_progress', {}),
        toolResult(20, 'c1', null, { error: { name: 'GrayCancelled', code: 'GRAY_CANCELLED' } }),
        toolCall(30, 'c2', 'create_review', {}),
        toolResult(40, 'c2', { path: '.graycode/review/r.md' }, {
          meta: { kind: 'graycode.workflow', callId: 'c2', status: 'draft' },
        }),
      ],
      hasMore: false,
    })
    const views = foldWorkflowWindow(cancelled)
    expect(views.map((view) => view.status)).toEqual(['cancelled', 'draft'])
    expect(views[0]!.retryable).toBe(true)
    expect(views[1]!.retryable).toBe(false)
  })

  it('ignores non-workflow calls and uncorrelated results in the fold', () => {
    const window = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, {
      kind: 'replace',
      entries: [
        toolCall(10, 'm1', 'memory_note', {}),
        toolResult(20, 'm1', {}),
        toolCall(30, 'c1', 'create_design', {}),
        toolResult(40, 'c1', { path: 'a.md' }),
      ],
      hasMore: false,
    })
    const views = foldWorkflowWindow(window)
    expect(views).toHaveLength(1)
    expect(views[0]!.tool).toBe('create_design')
  })

  it('replays identically after a replace of the same window', () => {
    const entries = [
      toolCall(10, 'c1', 'create_design', {}),
      toolResult(20, 'c1', { path: 'a.md' }),
    ]
    const first = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, { kind: 'replace', entries, hasMore: false })
    const second = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, { kind: 'replace', entries, hasMore: false })
    expect(foldWorkflowWindow(first)).toEqual(foldWorkflowWindow(second))
  })

  it('emits one view per callId when a start is re-delivered (first wins)', () => {
    const window = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, {
      kind: 'replace',
      entries: [
        toolCall(10, 'c1', 'create_design', { title: 'First' }),
        toolCall(20, 'c1', 'create_design', { title: 'Second' }),
        toolResult(30, 'c1', { path: '.graycode/design/a.md' }),
      ],
      hasMore: false,
    })
    const views = foldWorkflowWindow(window)
    expect(views).toHaveLength(1)
    expect(views[0]!.summary).toBe('First')
    expect(views[0]!.status).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// Locale alignment
// ---------------------------------------------------------------------------

describe('graycode.workflow locale dictionaries', () => {
  it('declares its own namespace', () => {
    expect(GRAYCODE_WORKFLOW_NS).toBe('graycode.workflow')
  })

  it('keeps zh/en dictionaries balanced (identical key sets)', () => {
    const en = Object.keys(graycodeWorkflowDictionaries.en).sort()
    const zh = Object.keys(graycodeWorkflowDictionaries.zh).sort()
    expect(zh).toEqual(en)
  })

  it('keeps the ja placeholder on the same key set', () => {
    expect(Object.keys(graycodeWorkflowJaPlaceholder).sort()).toEqual(
      Object.keys(graycodeWorkflowDictionaries.en).sort(),
    )
  })

  it('fills every shipped locale with non-empty text', () => {
    for (const dict of Object.values(graycodeWorkflowDictionaries)) {
      for (const text of Object.values(dict)) {
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })

  it('covers every workflow tool, family and status (keys aligned with the card)', () => {
    const en = graycodeWorkflowDictionaries.en
    for (const name of WORKFLOW_TOOLS) {
      expect(en[`tool.${name}`]).toBeDefined()
    }
    for (const family of ['design', 'plan', 'progress', 'review'] as const) {
      expect(en[`family.${family}`]).toBeDefined()
    }
    for (const status of ['draft', 'active', 'completed', 'failed', 'cancelled'] as const) {
      expect(en[`status.${status}`]).toBeDefined()
    }
    for (const label of ['path', 'summary', 'calledAt', 'completedAt', 'error', 'retry', 'openDocument', 'replayOnly']) {
      expect((en as Record<string, string>)[label]).toBeDefined()
    }
  })
})
