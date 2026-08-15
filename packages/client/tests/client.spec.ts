import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import { GRAYCODE_NS, graycodeDictionaries, graycodeJaPlaceholder } from '../src/client/locales.ts'
import {
  GRAYCODE_SETTINGS_NS,
  graycodeSettingsDictionaries,
  graycodeSettingsJaPlaceholder,
} from '../src/client/settings/locales.ts'
import { createWorkflowNodeDefinition } from '../src/client/workflowNode/definition.ts'
import {
  GRAYCODE_WORKFLOW_NS,
  graycodeWorkflowDictionaries,
  graycodeWorkflowJaPlaceholder,
} from '../src/client/workflowNode/locales.ts'
import { GRAYCODE_REROLL_NS } from '../src/client/rerollEdit/locales.ts'
import { EDIT_ACTION_KIND } from '../src/client/rerollEdit/editNode.ts'

/** Minimal client-context double covering exactly what apply() touches. */
function makeFakeCtx(options: { sessions?: { open: (sessionId: string) => void } } = {}) {
  const localeRegister = vi.fn((_namespace: string, _dictionary?: unknown) => () => {})
  const localeBind = vi.fn(() => (key: string) => key)
  const slotInject = vi.fn((_key: string, callback: () => unknown) => {
    callback()
    return () => {}
  })
  const slotRegister = vi.fn((_options: unknown) => () => {})
  const conversationEventsRegister = vi.fn((_definition: unknown) => () => {})
  // 'chat' view target is owned by the host's ui-conversation — apply() must
  // never touch this registry (a second 'chat' builder would collide).
  const conversationViewsRegister = vi.fn((_definition: unknown) => () => {})
  const connectionCall = vi.fn(async () => ({ ok: true, value: {} }))
  const on = vi.fn((_event: string, _handler: unknown) => () => {})
  const effect = vi.fn((execute: () => unknown) => {
    execute()
    return () => {}
  })
  const ctx = {
    locale: { register: localeRegister, bind: localeBind },
    slots: { inject: slotInject, register: slotRegister },
    conversationEvents: { register: conversationEventsRegister },
    conversationViews: { register: conversationViewsRegister },
    get: vi.fn((key: string) => (key === 'sessions' ? options.sessions : { rpc: { call: connectionCall } })),
    on,
    effect,
  } as unknown as ClientContext
  return { ctx, localeRegister, localeBind, slotInject, slotRegister, conversationEventsRegister, conversationViewsRegister, connectionCall, on, effect }
}

describe('@graycode/dsh-client browser half apply()', () => {
  it('declares the required client services', () => {
    expect(inject).toEqual(['slots', 'locale', 'conversationEvents', 'connection'])
  })

  it('registers the graycode locale namespace (typed zh/en + ja placeholder)', () => {
    const { ctx, localeRegister } = makeFakeCtx()
    apply(ctx)
    expect(localeRegister).toHaveBeenCalledWith(GRAYCODE_NS, graycodeDictionaries)
    expect(localeRegister).toHaveBeenCalledWith(GRAYCODE_NS, 'ja', graycodeJaPlaceholder)
  })

  it('registers the independent graycode.workflow locale namespace (typed zh/en + ja placeholder)', () => {
    const { ctx, localeRegister } = makeFakeCtx()
    apply(ctx)
    expect(localeRegister).toHaveBeenCalledWith(GRAYCODE_WORKFLOW_NS, graycodeWorkflowDictionaries)
    expect(localeRegister).toHaveBeenCalledWith(GRAYCODE_WORKFLOW_NS, 'ja', graycodeWorkflowJaPlaceholder)
  })

  it('registers every Phase 4 locale namespace (zh/en dict + ja placeholder each)', () => {
    const { ctx, localeRegister } = makeFakeCtx()
    apply(ctx)
    // Seventeen namespaces × two forms (typed zh/en dictionaries + untyped ja
    // placeholder) = thirty-four registrations. Covers the base `graycode` ns,
    // the workflow node ns, all six Phase 4 management surfaces, the
    // activity heatmap surface (C6), the notifications surface (C4), the
    // migration scope-map surface (D-1/D-2), the subagent back-to-main
    // action (S1), the reroll/edit-turn actions (F1/F2), the branch-candidate
    // switcher, the summarize action and the settings panel ns.
    expect(localeRegister).toHaveBeenCalledTimes(34)
    const namespaces = localeRegister.mock.calls.map((call) => call[0])
    for (const ns of [
      GRAYCODE_NS,
      GRAYCODE_WORKFLOW_NS,
      'graycode.workflowOverview',
      'graycode.memoryManage',
      'graycode.checkpointList',
      'graycode.checkpointConfig',
      'graycode.restorePreview',
      'graycode.stagedDiffCard',
      'graycode.settingsContribution',
      'graycode.activityHeatmap',
      'graycode.notifications',
      'graycode.scopeMap',
      'graycode.subagentBack',
      'graycode.rerollEdit',
      'graycode.branchSwitch',
      'graycode.summarize',
      'settings.graycode',
    ]) {
      // Each namespace is registered exactly twice: dict + ja placeholder.
      expect(namespaces.filter((n) => n === ns)).toHaveLength(2)
    }
  })

  it('registers the workflow conversation node Definition', () => {
    const { ctx, conversationEventsRegister } = makeFakeCtx()
    apply(ctx)
    // Two Definitions: the workflow card (P4-01) and the edit-action pencil
    // node (F2). The workflow one is registered first.
    expect(conversationEventsRegister).toHaveBeenCalledTimes(2)
    const definition = conversationEventsRegister.mock.calls[0]?.[0] as
      | { kind: string; target: string; match: unknown; start: unknown; update: unknown; buildViewNode: unknown }
      | undefined
    expect(definition).toBeDefined()
    expect(definition?.kind).toBe('graycode.workflow')
    expect(definition?.target).toBe('chat')
    expect(typeof definition?.match).toBe('function')
    expect(typeof definition?.start).toBe('function')
    expect(typeof definition?.update).toBe('function')
    expect(typeof definition?.buildViewNode).toBe('function')
  })

  it('ties the Definition disposers to the fiber via ctx.effect', () => {
    const { ctx, conversationEventsRegister, effect } = makeFakeCtx()
    apply(ctx)
    // One ctx.effect per registration disposer: the two Definitions (workflow
    // + editAction) plus every locale namespace (17 × dict + ja placeholder)
    // plus the connection/reset refresh subscription = 2 + 34 + 1.
    expect(effect).toHaveBeenCalledTimes(37)
    const disposer = conversationEventsRegister.mock.results[0]?.value
    expect(typeof disposer).toBe('function')
    // The first effect body returns the Definition registry disposer, so
    // fiber unload runs it.
    expect(effect.mock.calls[0]?.[0]()).toBe(disposer)
  })

  it('registers the same Definition shape the factory produces', () => {
    const { ctx, conversationEventsRegister } = makeFakeCtx()
    apply(ctx)
    const registered = conversationEventsRegister.mock.calls[0]?.[0] as { kind: string; target: string } | undefined
    const factory = createWorkflowNodeDefinition()
    expect(registered?.kind).toBe(factory.kind)
    expect(registered?.target).toBe(factory.target)
  })

  it('does NOT register a second chat view builder (ui-conversation owns the target)', () => {
    const { ctx, conversationViewsRegister } = makeFakeCtx()
    expect(() => apply(ctx)).not.toThrow()
    expect(conversationViewsRegister).not.toHaveBeenCalled()
  })

  it('waits for shell.overlay and registers the marker entry into it', () => {
    const { ctx, slotInject, slotRegister } = makeFakeCtx()
    apply(ctx)
    expect(slotInject).toHaveBeenCalledWith('shell.overlay', expect.any(Function))
    expect(slotRegister).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'shell.overlay', id: 'graycode.loaded', locale: GRAYCODE_NS }),
      expect.any(Function),
    )
  })

  it('registers the settings.graycode locale namespace (typed zh/en + ja placeholder)', () => {
    const { ctx, localeRegister } = makeFakeCtx()
    apply(ctx)
    expect(localeRegister).toHaveBeenCalledWith(GRAYCODE_SETTINGS_NS, graycodeSettingsDictionaries)
    expect(localeRegister).toHaveBeenCalledWith(GRAYCODE_SETTINGS_NS, 'ja', graycodeSettingsJaPlaceholder)
  })

  it('waits for settings.section and registers the Gray Code section entry (id graycode, order 200)', () => {
    const { ctx, slotInject, slotRegister } = makeFakeCtx()
    apply(ctx)
    expect(slotInject).toHaveBeenCalledWith('settings.section', expect.any(Function))
    const sectionCall = slotRegister.mock.calls.find((call) => (call[0] as { name?: string }).name === 'settings.section')
    expect(sectionCall).toBeDefined()
    const options = sectionCall?.[0] as { id?: string; order?: number; locale?: string; label?: () => string } | undefined
    expect(options?.id).toBe('graycode')
    expect(options?.order).toBe(200)
    expect(options?.locale).toBe(GRAYCODE_SETTINGS_NS)
    expect(typeof options?.label).toBe('function')
    expect(options?.label?.()).toBe('nav')
  })

  it('wires the config store to ctx.connection and refreshes on connection/reset', async () => {
    const { ctx, connectionCall, on } = makeFakeCtx()
    apply(ctx)
    expect(ctx.get).toHaveBeenCalledWith('connection')
    expect(on).toHaveBeenCalledWith('connection/reset', expect.any(Function))
    // apply() fire-and-forgets store.refresh(); the RPC is queued behind the
    // store's microtask pump, so nothing has hit the wire at this synchronous
    // point (H-13: the old `not.toHaveBeenCalled()` assertion never observed
    // the refresh and was vacuously true).
    expect(connectionCall).not.toHaveBeenCalled()
    // Deterministically wait for the refresh pump to reach the /graycode RPC
    // channel (no hard-coded microtask round counts).
    await vi.waitFor(() => {
      expect(connectionCall).toHaveBeenCalledTimes(1)
    })
    expect(connectionCall).toHaveBeenCalledWith('/graycode', 'config.get', {})
    // The connection/reset handler replays the same refresh through the store.
    const resetHandler = on.mock.calls.find((call) => call[0] === 'connection/reset')?.[1] as (() => void) | undefined
    expect(typeof resetHandler).toBe('function')
    resetHandler?.()
    // refresh() queues behind the settled pump rather than firing synchronously.
    expect(connectionCall).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(connectionCall).toHaveBeenCalledTimes(2)
    })
  })

  it('registers the back-to-main header action when the sessions service is present', () => {
    const open = vi.fn()
    const { ctx, slotInject, slotRegister } = makeFakeCtx({ sessions: { open } })
    apply(ctx)
    expect(slotInject).toHaveBeenCalledWith('conversation.session.header.actions', expect.any(Function))
    const actionCall = slotRegister.mock.calls.find((call) => (call[0] as { name?: string }).name === 'conversation.session.header.actions')
    expect(actionCall).toBeDefined()
    const options = actionCall?.[0] as { id?: string; order?: number; locale?: string; inject?: () => { open: (id: string) => void } } | undefined
    expect(options?.id).toBe('graycode.back-to-main')
    expect(options?.order).toBe(20)
    expect(options?.locale).toBe('graycode.subagentBack')
    // The injected seat forwards to the sessions service.
    options?.inject?.().open('session-parent')
    expect(open).toHaveBeenCalledWith('session-parent')
  })

  it('registers the back-to-main action unconditionally and no-ops when the sessions service is absent', () => {
    const { ctx, slotInject, slotRegister } = makeFakeCtx()
    apply(ctx)
    // 4.3-L5: the seat is always registered; the sessions service is resolved
    // at action time, so a late-started host service is honored — and a
    // missing one simply no-ops on click instead of throwing.
    expect(slotInject).toHaveBeenCalledWith('conversation.session.header.actions', expect.any(Function))
    const actionCall = slotRegister.mock.calls.find((call) => (call[0] as { name?: string }).name === 'conversation.session.header.actions')
    expect(actionCall).toBeDefined()
    const options = actionCall?.[0] as { id?: string; inject?: () => { open: (id: string) => void } } | undefined
    expect(options?.id).toBe('graycode.back-to-main')
    expect(() => options?.inject?.().open('session-parent')).not.toThrow()
  })

  it('registers the edit pencil into the keyed chat node seat (F2, beside the user message)', () => {
    const { ctx, slotInject, slotRegister } = makeFakeCtx()
    apply(ctx)
    expect(slotInject).toHaveBeenCalledWith('conversation.chat.node', expect.any(Function))
    const nodeCall = slotRegister.mock.calls.find((call) => (call[0] as { name?: string }).name === 'conversation.chat.node')
    expect(nodeCall).toBeDefined()
    const options = nodeCall?.[0] as {
      key?: string
      locale?: string
      inject?: () => { remote: unknown; onCommitted?: () => void }
    }
    // The payload kind merges into ChatNodeDataMap; the keyed entry anchors a
    // pencil right after each user message.
    expect(options.key).toBe('graycode.editAction')
    expect(options.locale).toBe(GRAYCODE_REROLL_NS)
    expect(typeof options.inject?.().remote).toBe('function')
    expect(typeof options.inject?.().onCommitted).toBe('function')
  })

  it('registers the branch switcher into the turn-tail chain (regenerate lives on the user-message row)', () => {
    const open = vi.fn()
    const { ctx, slotInject, slotRegister } = makeFakeCtx({ sessions: { open } })
    apply(ctx)
    expect(slotInject).toHaveBeenCalledWith('conversation.chat.turnTail', expect.any(Function))
    const chainCall = slotRegister.mock.calls.find((call) => (call[0] as { name?: string }).name === 'conversation.chat.turnTail')
    expect(chainCall).toBeDefined()
    const options = chainCall?.[0] as {
      locale?: string
      select?: (owner: { turn: { turn: number } }) => unknown
      inject?: () => { remote: unknown; open?: (sessionId: string) => void; branchT: unknown }
    }
    expect(options.locale).toBe(GRAYCODE_REROLL_NS)
    expect(typeof options.inject?.().remote).toBe('function')
    // The chain selector hands the completed turn's session turn number to
    // the entry as `matched`.
    expect(options.select?.({ turn: { turn: 3 } })).toEqual({ turn: 3 })
    // The injected seat carries the /graycode remote dispatcher, the
    // branch-session navigator, and the switcher's bound translate seat.
    expect(typeof options.inject?.().open).toBe('function')
    expect(typeof options.inject?.().branchT).toBe('function')
    options.inject?.().open?.('session-branch')
    expect(open).toHaveBeenCalledWith('session-branch')
  })

  it('registers the user-message action row (edit pencil + regenerate) with the branch navigator', () => {
    const open = vi.fn()
    const { ctx, slotInject, slotRegister } = makeFakeCtx({ sessions: { open } })
    apply(ctx)
    expect(slotInject).toHaveBeenCalledWith('conversation.chat.node', expect.any(Function))
    const nodeCall = slotRegister.mock.calls.find((call) => (call[0] as { name?: string; key?: string }).name === 'conversation.chat.node' && (call[0] as { key?: string }).key === EDIT_ACTION_KIND)
    expect(nodeCall).toBeDefined()
    const options = nodeCall?.[0] as {
      locale?: string
      inject?: () => { remote: unknown; open?: (sessionId: string) => void; onCommitted?: () => void }
    }
    expect(options.locale).toBe(GRAYCODE_REROLL_NS)
    expect(typeof options.inject?.().remote).toBe('function')
    expect(typeof options.inject?.().open).toBe('function')
    expect(typeof options.inject?.().onCommitted).toBe('function')
    options.inject?.().open?.('session-branch')
    expect(open).toHaveBeenCalledWith('session-branch')
  })

  it('registers the session-level branch switcher into the header actions', () => {
    const open = vi.fn()
    const { ctx, slotInject, slotRegister } = makeFakeCtx({ sessions: { open } })
    apply(ctx)
    expect(slotInject).toHaveBeenCalledWith('conversation.session.header.actions', expect.any(Function))
    const actionCall = slotRegister.mock.calls.find((call) => (call[0] as { name?: string; id?: string }).name === 'conversation.session.header.actions' && (call[0] as { id?: string }).id === 'graycode.branch-switch')
    expect(actionCall).toBeDefined()
    const options = actionCall?.[0] as {
      order?: number
      locale?: string
      inject?: () => { remote: unknown; open?: (sessionId: string) => void }
    }
    expect(options.order).toBe(40)
    expect(options.locale).toBe('graycode.branchSwitch')
    expect(typeof options.inject?.().remote).toBe('function')
    options.inject?.().open?.('session-candidate')
    expect(open).toHaveBeenCalledWith('session-candidate')
  })
})

describe('graycode locale dictionaries', () => {
  it('keeps zh/en dictionaries balanced (identical key sets)', () => {
    const en = Object.keys(graycodeDictionaries.en).sort()
    const zh = Object.keys(graycodeDictionaries.zh).sort()
    expect(zh).toEqual(en)
  })

  it('keeps the ja placeholder on the same key set', () => {
    expect(Object.keys(graycodeJaPlaceholder).sort()).toEqual(
      Object.keys(graycodeDictionaries.en).sort(),
    )
  })

  it('fills every shipped locale with non-empty text', () => {
    for (const dict of Object.values(graycodeDictionaries)) {
      for (const text of Object.values(dict)) {
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })
})
