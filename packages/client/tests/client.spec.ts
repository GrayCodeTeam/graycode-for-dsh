import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import { GRAYCODE_NS, graycodeDictionaries, graycodeJaPlaceholder } from '../src/client/locales.ts'
import { createWorkflowNodeDefinition } from '../src/client/workflowNode/definition.ts'
import {
  GRAYCODE_WORKFLOW_NS,
  graycodeWorkflowDictionaries,
  graycodeWorkflowJaPlaceholder,
} from '../src/client/workflowNode/locales.ts'

/** Minimal client-context double covering exactly what apply() touches. */
function makeFakeCtx() {
  const localeRegister = vi.fn(() => () => {})
  const slotInject = vi.fn((_key: string, callback: () => unknown) => {
    callback()
    return () => {}
  })
  const slotRegister = vi.fn(() => () => {})
  const conversationEventsRegister = vi.fn(() => () => {})
  // 'chat' view target is owned by the host's ui-conversation — apply() must
  // never touch this registry (a second 'chat' builder would collide).
  const conversationViewsRegister = vi.fn(() => () => {})
  const effect = vi.fn((execute: () => unknown) => {
    execute()
    return () => {}
  })
  const ctx = {
    locale: { register: localeRegister },
    slots: { inject: slotInject, register: slotRegister },
    conversationEvents: { register: conversationEventsRegister },
    conversationViews: { register: conversationViewsRegister },
    effect,
  } as unknown as ClientContext
  return { ctx, localeRegister, slotInject, slotRegister, conversationEventsRegister, conversationViewsRegister, effect }
}

describe('@graycode/dsh-client browser half apply()', () => {
  it('declares the required client services', () => {
    expect(inject).toEqual(['slots', 'locale', 'conversationEvents'])
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
    // Eight namespaces × two forms (typed zh/en dictionaries + untyped ja
    // placeholder) = sixteen registrations. Covers the base `graycode` ns,
    // the workflow node ns and all six Phase 4 management surfaces.
    expect(localeRegister).toHaveBeenCalledTimes(16)
    const namespaces = localeRegister.mock.calls.map((call) => call[0])
    for (const ns of [
      GRAYCODE_NS,
      GRAYCODE_WORKFLOW_NS,
      'graycode.workflowOverview',
      'graycode.memoryManage',
      'graycode.checkpointList',
      'graycode.restorePreview',
      'graycode.stagedDiffCard',
      'graycode.settingsContribution',
    ]) {
      // Each namespace is registered exactly twice: dict + ja placeholder.
      expect(namespaces.filter((n) => n === ns)).toHaveLength(2)
    }
  })

  it('registers the workflow conversation node Definition', () => {
    const { ctx, conversationEventsRegister } = makeFakeCtx()
    apply(ctx)
    expect(conversationEventsRegister).toHaveBeenCalledTimes(1)
    const definition = conversationEventsRegister.mock.calls[0]?.[0]
    expect(definition).toBeDefined()
    expect(definition.kind).toBe('graycode.workflow')
    expect(definition.target).toBe('chat')
    expect(typeof definition.match).toBe('function')
    expect(typeof definition.start).toBe('function')
    expect(typeof definition.update).toBe('function')
    expect(typeof definition.buildViewNode).toBe('function')
  })

  it('ties the Definition disposer to the fiber via ctx.effect', () => {
    const { ctx, conversationEventsRegister, effect } = makeFakeCtx()
    apply(ctx)
    expect(effect).toHaveBeenCalledTimes(1)
    const disposer = conversationEventsRegister.mock.results[0]?.value
    expect(typeof disposer).toBe('function')
    // The effect body returns the registry disposer, so fiber unload runs it.
    expect(effect.mock.calls[0]?.[0]()).toBe(disposer)
  })

  it('registers the same Definition shape the factory produces', () => {
    const { ctx, conversationEventsRegister } = makeFakeCtx()
    apply(ctx)
    const registered = conversationEventsRegister.mock.calls[0]?.[0]
    const factory = createWorkflowNodeDefinition()
    expect(registered.kind).toBe(factory.kind)
    expect(registered.target).toBe(factory.target)
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
