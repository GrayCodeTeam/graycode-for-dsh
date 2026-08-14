/**
 * P0-03 reload stability — refresh replay consistency + HMR mount/unmount
 * idempotency (browser half).
 *
 * PLAN_V2 P0-03 acceptance checks that `dsh.client` reloads correctly
 * (slot visible, refresh/HMR/cache invalidation correct). The per-surface pure
 * logic is already covered by workflowNode.spec.ts / memoryManage.spec.ts /
 * client.spec.ts; this spec fills the systematic gap:
 *
 * 1. Refresh replay consistency — the same event sequence folded live (stream
 *    appends / page accumulation) and replayed from scratch after a refresh
 *    (window `replace` / page-1 re-fetch) must produce identical render
 *    projections. Zero network: pure component-level derivation only.
 * 2. HMR mount/unmount idempotency — the client entry (`apply(ctx)`) must be
 *    a pure function of the fiber context, and the DSH unload→re-apply cycle
 *    must not accumulate duplicate registrations or leave residue. The host
 *    HMR contract is *dispose old fiber, then apply a fresh one* (a second
 *    apply on the same live fiber legitimately double-registers — cordis
 *    entries are not self-guarding, see the pinned test below).
 *
 * Environment: node (packages/client/vitest.config.ts). React is only pulled
 * in transitively via the entry import (client.spec.ts does the same).
 */
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { apply } from '../src/client/index.ts'
import { GRAYCODE_NS } from '../src/client/locales.ts'
import { GRAYCODE_WORKFLOW_NS } from '../src/client/workflowNode/locales.ts'
import {
  EMPTY_WORKFLOW_STREAM,
  applyWorkflowStreamUpdate,
} from '../src/client/workflowNode/stream.ts'
import {
  buildWorkflowViewNode,
  foldWorkflowWindow,
  startWorkflowNode,
  updateWorkflowNode,
} from '../src/client/workflowNode/definition.ts'
import type {
  WorkflowContextLike,
  WorkflowEventLike,
  WorkflowNodeState,
} from '../src/client/workflowNode/types.ts'
import { WORKFLOW_KIND } from '../src/client/workflowNode/tools.ts'
import {
  appendMemoryListPage,
  buildMemoryListViewModel,
} from '../src/client/memoryManage/logic.ts'
import type { GrayMemoryEntryView, GrayMemoryListResult } from '../src/client/memoryManage/types.ts'

// ---------------------------------------------------------------------------
// Session event builders (structural SessionEvent views, mirroring
// workflowNode.spec.ts)
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

function contextOf(id: string, state: WorkflowNodeState | undefined, start?: WorkflowEventLike): WorkflowContextLike<WorkflowNodeState> {
  const startMatch = start === undefined
    ? undefined
    : { event: start, role: 'start' as const, location: { kind: 'unresolved' } as const }
  return {
    key: `${WORKFLOW_KIND}:${id}`,
    kind: WORKFLOW_KIND,
    id,
    matches: startMatch === undefined ? [] : [startMatch],
    start: startMatch,
    state,
    current: new Map(),
  }
}

/**
 * Replay one fixed event sequence (call + result) on a fresh Context, exactly
 * as the Definition engine would after a page refresh re-serves the window.
 * Deterministic ⇒ two replays must yield the identical chat node.
 */
function replayWorkflowNode(): ReturnType<typeof buildWorkflowViewNode> {
  const call = toolCall(10, 'c1', 'create_design', { title: 'T' }, { time: 5000 })
  const result = toolResult(20, 'c1', { path: '.graycode/design/a.md' }, { time: 9000 })
  const startMatch = { event: call, role: 'start' as const, location: { kind: 'unresolved' } as const }
  const start = startWorkflowNode(contextOf('call:c1', undefined), startMatch)
  const updateMatch = { event: result, role: 'update' as const, location: { kind: 'unresolved' } as const }
  const updated = updateWorkflowNode({ ...contextOf('call:c1', start), state: start }, updateMatch)
  return buildWorkflowViewNode({ ...contextOf('call:c1', updated, call), state: updated })
}

// ---------------------------------------------------------------------------
// Refresh replay consistency — workflow session surface (P4-01)
// ---------------------------------------------------------------------------

describe('refresh replay consistency — workflow session surface', () => {
  it('live-append replay and post-refresh replace fold to identical node views', () => {
    const entries = [
      toolCall(10, 'c1', 'create_design', { title: 'T' }, { time: 5000 }),
      toolResult(20, 'c1', { path: '.graycode/design/a.md' }, { time: 9000 }),
      toolCall(30, 'c2', 'create_review', {}, { time: 10000 }),
      toolResult(40, 'c2', { path: '.graycode/review/r.md' }, { time: 14000 }),
    ]
    // Live session: the engine appended events one at a time as they arrived.
    let live = EMPTY_WORKFLOW_STREAM
    for (const entry of entries) {
      live = applyWorkflowStreamUpdate(live, { kind: 'append', entry })
    }
    // Page refresh: the host re-serves the whole window as a single replace.
    const refreshed = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, {
      kind: 'replace',
      entries,
      hasMore: false,
    })
    expect(refreshed.entries.map((event) => event.seq)).toEqual([10, 20, 30, 40])
    // Replaying the re-served window must yield the same node views as the
    // live fold (identical props → identical render projection).
    expect(foldWorkflowWindow(refreshed)).toEqual(foldWorkflowWindow(live))
    expect(foldWorkflowWindow(refreshed)).toHaveLength(2)
  })

  it('appends continue cleanly across a refresh replace (tail duplicates dropped)', () => {
    let live = EMPTY_WORKFLOW_STREAM
    live = applyWorkflowStreamUpdate(live, { kind: 'append', entry: toolCall(10, 'c1', 'create_design', {}) })
    live = applyWorkflowStreamUpdate(live, { kind: 'append', entry: toolResult(20, 'c1', { path: 'a.md' }) })
    const refreshed = applyWorkflowStreamUpdate(EMPTY_WORKFLOW_STREAM, {
      kind: 'replace',
      entries: live.entries,
      hasMore: true,
    })
    // The host re-sends the window tail right after the refresh; the seq guard
    // must drop it (same reference ⇒ no duplicate event in the window).
    const replayedTail = applyWorkflowStreamUpdate(refreshed, {
      kind: 'append',
      entry: toolResult(20, 'c1', { path: 'a.md' }),
    })
    expect(replayedTail).toBe(refreshed)
    // New events land on the refreshed window andfold identically to the
    // live-append path that never refreshed.
    const continued = applyWorkflowStreamUpdate(refreshed, { kind: 'append', entry: toolCall(30, 'c2', 'create_review', {}) })
    const liveContinued = applyWorkflowStreamUpdate(live, { kind: 'append', entry: toolCall(30, 'c2', 'create_review', {}) })
    expect(continued.entries.map((event) => event.seq)).toEqual([10, 20, 30])
    expect(foldWorkflowWindow(continued)).toEqual(foldWorkflowWindow(liveContinued))
  })

  it('replaying the same event sequence on fresh contexts yields the identical final node', () => {
    expect(replayWorkflowNode()).toEqual(replayWorkflowNode())
    const node = replayWorkflowNode()
    expect(node).not.toBeNull()
    expect(node!.data).toMatchObject({
      callId: 'c1',
      tool: 'create_design',
      status: 'completed',
      path: '.graycode/design/a.md',
      resultAt: 9000,
      retryable: false,
    })
  })
})

// ---------------------------------------------------------------------------
// Refresh replay consistency — memory management surface (P4-03)
// ---------------------------------------------------------------------------

describe('refresh replay consistency — memory management surface', () => {
  const entry = (id: number): GrayMemoryEntryView => ({ id, date: '2025-01-01', text: `memory ${id}` })

  it('replaying the same page sequence after a refresh yields the identical list view model', () => {
    const replay = () => {
      const page1: GrayMemoryListResult = { items: [entry(5), entry(4), entry(3)], total: 5, nextCursor: '3' }
      const page2: GrayMemoryListResult = { items: [entry(2), entry(1)], total: 5 }
      const first = buildMemoryListViewModel(page1, { scope: 'global' })
      return appendMemoryListPage(first, buildMemoryListViewModel(page2, { scope: 'global' }))
    }
    const view = replay()
    expect(view.items.map((item) => item.id)).toEqual([5, 4, 3, 2, 1])
    expect(view.total).toBe(5)
    expect(view.hasMore).toBe(false)
    expect(replay()).toEqual(view)
  })

  it('a refresh re-fetches page 1 and invalidates the accumulated view (no stale merge)', () => {
    // Accumulated list before a refresh (page 1 + load-more page 2).
    const page1: GrayMemoryListResult = { items: [entry(5), entry(4), entry(3)], total: 5, nextCursor: '3' }
    const page2: GrayMemoryListResult = { items: [entry(2), entry(1)], total: 5 }
    const stale = appendMemoryListPage(
      buildMemoryListViewModel(page1, { scope: 'global' }),
      buildMemoryListViewModel(page2, { scope: 'global' }),
    )
    // Refresh: the host serves the CURRENT page 1 (entry 5 removed, 6 added).
    const freshPage: GrayMemoryListResult = { items: [entry(6), entry(4), entry(3)], total: 3, nextCursor: '3' }
    // The panel replaces the whole list on refresh (MemoryManagePanel.tsx:
    // setList(buildMemoryListViewModel(...))) — nothing from the stale
    // accumulation may survive the cache-invalidated rebuild.
    const refreshed = buildMemoryListViewModel(freshPage, { scope: 'global' })
    expect(refreshed.items.map((item) => item.id)).toEqual([6, 4, 3])
    for (const staleId of [5, 2, 1]) {
      expect(refreshed.items.some((item) => item.id === staleId), `stale id ${staleId}`).toBe(false)
    }
    // The stale view is untouched (pure functions never mutate their inputs).
    expect(stale.items.map((item) => item.id)).toEqual([5, 4, 3, 2, 1])
  })
})

// ---------------------------------------------------------------------------
// HMR mount/unmount idempotency of the client entry (apply)
// ---------------------------------------------------------------------------

/** The twelve locale namespaces the entry registers (dict + ja placeholder each). */
const EXPECTED_LOCALE_NS: readonly string[] = [
  GRAYCODE_NS,
  GRAYCODE_WORKFLOW_NS,
  'graycode.workflowOverview',
  'graycode.memoryManage',
  'graycode.checkpointList',
  'graycode.restorePreview',
  'graycode.stagedDiffCard',
  'graycode.settingsContribution',
  'graycode.activityHeatmap',
  'graycode.notifications',
  'graycode.scopeMap',
  'settings.graycode',
]

/**
 * Fiber-aware harness modelling the DSH host fiber lifecycle (the contract the
 * code itself documents in src/client/index.ts: a registration disposer is
 * tied to the fiber only when it is handed to `ctx.effect`; `slots.inject`
 * returns a declaration-lifetime disposer; every register call returns a
 * disposer).
 */
function createFiberHarness() {
  const locale = new Map<string, unknown[]>()
  const localeRegister = vi.fn((ns: string, ...args: unknown[]) => {
    const list = locale.get(ns) ?? []
    list.push(args)
    locale.set(ns, list)
    return () => {
      const current = locale.get(ns) ?? []
      const index = current.indexOf(args)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) locale.delete(ns)
    }
  })

  const definitions: unknown[] = []
  const conversationEventsRegister = vi.fn((definition: unknown) => {
    definitions.push(definition)
    return () => {
      const index = definitions.indexOf(definition)
      if (index >= 0) definitions.splice(index, 1)
    }
  })

  const overlayEntries: unknown[] = []
  const slotRegister = vi.fn(() => {
    const token = {}
    overlayEntries.push(token)
    return () => {
      const index = overlayEntries.indexOf(token)
      if (index >= 0) overlayEntries.splice(index, 1)
    }
  })
  const slotInject = vi.fn((_key: string, callback: () => unknown) => {
    // Declaration present immediately in this harness: the injection registers
    // right away (mirrors the real host once shell.overlay is declared). The
    // returned disposer is the declaration-lifetime teardown.
    const disposer = callback() as () => void
    return () => disposer()
  })

  const fiberDisposers: Array<() => void> = []
  const effect = vi.fn((execute: () => unknown) => {
    const disposer = execute()
    if (typeof disposer === 'function') fiberDisposers.push(disposer as () => void)
    return disposer
  })

  const ctx = {
    locale: {
      register: localeRegister,
      // Real bind is stable per namespace; the harness memoizes per ns so the
      // label thunk keeps a stable translation seat across apply() calls.
      bind: vi.fn((_ns: string) => (key: string) => key),
    },
    slots: { inject: slotInject, register: slotRegister },
    conversationEvents: { register: conversationEventsRegister },
    conversationViews: { register: vi.fn(() => () => {}) },
    get: vi.fn(() => ({ rpc: { call: vi.fn(async () => ({ ok: true, value: {} })) } })),
    on: vi.fn(() => () => {}),
    effect,
  } as unknown as ClientContext

  return {
    ctx,
    locale,
    definitions,
    overlayEntries,
    localeRegister,
    conversationEventsRegister,
    slotInject,
    slotRegister,
    effect,
    // Fiber teardown: run the ctx.effect disposers in reverse registration
    // order (the DSH fiber unload contract).
    unload(): void {
      for (let i = fiberDisposers.length - 1; i >= 0; i--) fiberDisposers[i]!()
      fiberDisposers.length = 0
    },
  }
}

/**
 * Slot registration options are compared structurally; the settings section's
 * `label` is a fresh thunk per apply() call, so functions are normalized to a
 * marker before comparing across fibers (their identity is not part of the
 * registration contract).
 */
function plainSlotOptions(calls: Array<Array<unknown>>): unknown[][] {
  return calls.map((call) => [
    JSON.parse(JSON.stringify(call[0], (_key, value) => (typeof value === 'function' ? '<fn>' : value))),
    call[1],
  ])
}

describe('HMR mount/unmount idempotency of apply()', () => {
  it('apply() is a pure function of ctx (no module-level mutable state across fibers)', () => {
    const first = createFiberHarness()
    const second = createFiberHarness()
    apply(first.ctx)
    apply(second.ctx)
    // Identical registration sequences ⇒ a fresh fiber after an HMR reload
    // re-applies the exact same surface set; nothing leaks across fibers
    // through module state.
    expect(second.localeRegister.mock.calls).toEqual(first.localeRegister.mock.calls)
    expect(second.conversationEventsRegister.mock.calls).toEqual(first.conversationEventsRegister.mock.calls)
    expect(second.slotInject.mock.calls.map((call) => call[0])).toEqual(
      first.slotInject.mock.calls.map((call) => call[0]),
    )
    expect(plainSlotOptions(second.slotRegister.mock.calls)).toEqual(plainSlotOptions(first.slotRegister.mock.calls))
  })

  it('a second apply on the SAME live fiber registers twice (host must unload first)', () => {
    // Cordis entries are not self-guarding; the DSH HMR contract is dispose →
    // re-apply. Pinning this so a future "idempotent apply" refactor is an
    // explicit, deliberate change rather than an accident.
    const harness = createFiberHarness()
    apply(harness.ctx)
    const once = harness.definitions.length
    apply(harness.ctx)
    expect(harness.definitions).toHaveLength(once * 2)
    expect(harness.locale.size).toBeGreaterThanOrEqual(EXPECTED_LOCALE_NS.length)
  })

  it('fiber unload removes every effect-tied registration (zero definition residue)', () => {
    const harness = createFiberHarness()
    for (let cycle = 0; cycle < 3; cycle++) {
      apply(harness.ctx)
      expect(harness.definitions.length).toBeGreaterThan(0)
      harness.unload()
      expect(harness.definitions).toHaveLength(0)
    }
  })

  it('an HMR cycle (apply → unload → apply) yields exactly one definition set, no duplicates', () => {
    const baseline = createFiberHarness()
    apply(baseline.ctx)
    const expected = baseline.definitions.length
    const harness = createFiberHarness()
    apply(harness.ctx)
    harness.unload()
    apply(harness.ctx)
    expect(harness.definitions).toHaveLength(expected)
  })

  it('locale namespaces are fiber-tied: an apply→unload→apply HMR cycle leaves no residue', () => {
    const harness = createFiberHarness()
    apply(harness.ctx)
    for (const ns of EXPECTED_LOCALE_NS) {
      expect(harness.locale.get(ns), ns).toHaveLength(2) // dict + ja placeholder
    }
    harness.unload()
    // Every registration disposer is effect-tied — the workflow Definition AND
    // every ctx.locale.register disposer are handed to ctx.effect (the same
    // pattern), so unload runs them in reverse registration order and the live
    // locale store has zero residue.
    expect(harness.definitions).toHaveLength(0)
    expect(harness.locale.size).toBe(0)
    for (const ns of EXPECTED_LOCALE_NS) {
      expect(harness.locale.get(ns), `locale residue for ${ns}`).toBeUndefined()
    }
    // A host HMR cycle (unload old fiber → re-apply) re-registers exactly one
    // set per namespace — nothing accumulates across cycles.
    apply(harness.ctx)
    for (const ns of EXPECTED_LOCALE_NS) {
      expect(harness.locale.get(ns), ns).toHaveLength(2)
    }
  })

  it('slot injection lifetime follows the shell.overlay declaration, not the fiber', () => {
    const harness = createFiberHarness()
    apply(harness.ctx)
    // Two injections: the shell.overlay marker plus the settings.section entry.
    expect(harness.overlayEntries).toHaveLength(2)
    // Declaration teardown calls the inject disposer (apply() leaves it to the
    // declaration lifetime by design — see the index.ts comment).
    const injectDisposer = harness.slotInject.mock.results[0]?.value as () => void
    expect(typeof injectDisposer).toBe('function')
    injectDisposer()
    expect(harness.overlayEntries).toHaveLength(1)

    // Fiber unload alone does NOT remove the injection while the declaration
    // lives — documented declaration-lifetime semantics.
    const other = createFiberHarness()
    apply(other.ctx)
    other.unload()
    expect(other.definitions).toHaveLength(0)
    expect(other.overlayEntries).toHaveLength(2)
  })
})
