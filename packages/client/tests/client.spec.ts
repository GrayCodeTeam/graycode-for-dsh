import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import { GRAYCODE_NS, graycodeDictionaries, graycodeJaPlaceholder } from '../src/client/locales.ts'

/** Minimal client-context double covering exactly what apply() touches. */
function makeFakeCtx() {
  const localeRegister = vi.fn(() => () => {})
  const slotInject = vi.fn((_key: string, callback: () => unknown) => {
    callback()
    return () => {}
  })
  const slotRegister = vi.fn(() => () => {})
  const ctx = {
    locale: { register: localeRegister },
    slots: { inject: slotInject, register: slotRegister },
  } as unknown as ClientContext
  return { ctx, localeRegister, slotInject, slotRegister }
}

describe('@graycode/dsh-client browser half apply()', () => {
  it('declares the required client services', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the graycode locale namespace (typed zh/en + ja placeholder)', () => {
    const { ctx, localeRegister } = makeFakeCtx()
    apply(ctx)
    expect(localeRegister).toHaveBeenCalledTimes(2)
    expect(localeRegister).toHaveBeenCalledWith(GRAYCODE_NS, graycodeDictionaries)
    expect(localeRegister).toHaveBeenCalledWith(GRAYCODE_NS, 'ja', graycodeJaPlaceholder)
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
