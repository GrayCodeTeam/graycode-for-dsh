import { describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { DEFAULTS } from '../src/client/settings/defaults.ts'
import { GRAYCODE_CHANNEL, createGrayCodeStore, getAtPath, setAtPath } from '../src/client/settings/store.ts'
import { createGrayRemoteInvoker } from '../src/client/settings/remote.ts'
import {
  GRAYCODE_SETTINGS_NS,
  graycodeSettingsDictionaries,
  graycodeSettingsJaPlaceholder,
  zh,
} from '../src/client/settings/locales.ts'
import { CATEGORIES } from '../src/client/settings/pages.tsx'
import {
  buttonStyle,
  checkpointCreateActionsStyle,
  checkpointCreateRowStyle,
  checkpointTitleInputStyle,
  inputStyle,
  switchWrapStyle,
  tabActiveStyle,
  tabStyle,
  tokens,
} from '../src/client/settings/styles.ts'
import type { GrayCodeConfig } from '../src/client/settings/types.ts'

function makeConnection(call: ReturnType<typeof vi.fn>): ConnectionHandle {
  return { rpc: { call } } as unknown as ConnectionHandle
}

describe('settings path helpers', () => {
  it('reads real module values', () => {
    expect(getAtPath(DEFAULTS, ['memory', 'wakeLines'])).toBe(96)
    expect(getAtPath(DEFAULTS, ['prompt', 'modeToolPolicy'])).toBe(true)
    expect(getAtPath(DEFAULTS, ['missing', 'value'])).toBeUndefined()
  })

  it('updates immutably and emits only the affected top-level module', () => {
    const config = structuredClone(DEFAULTS)
    const { next, patch } = setAtPath(config, ['memory', 'wakeLines'], 42)
    expect(next.memory.wakeLines).toBe(42)
    expect(config.memory.wakeLines).toBe(96)
    expect(patch).toEqual({ memory: { ...DEFAULTS.memory, wakeLines: 42 } })
  })

  it('emits no patch for an unchanged value', () => {
    expect(setAtPath(structuredClone(DEFAULTS), ['todo', 'enabled'], true).patch).toEqual({})
  })
})

describe('GrayCodeStore', () => {
  it('loads the host snapshot and sends the documented update wrapper', async () => {
    const changed = structuredClone(DEFAULTS)
    changed.memory.wakeLines = 77
    const call = vi.fn(async (_channel, endpoint) => ({
      ok: true as const,
      value: endpoint === 'config.get' ? changed : DEFAULTS,
    }))
    const store = createGrayCodeStore(makeConnection(call))
    await store.refresh()
    expect(call).toHaveBeenNthCalledWith(1, GRAYCODE_CHANNEL, 'config.get', {})
    expect(store.state).toEqual({ status: 'ready', config: changed })
    await store.patch({ memory: changed.memory })
    expect(call).toHaveBeenLastCalledWith(GRAYCODE_CHANNEL, 'config.update', {
      patch: { memory: changed.memory },
    })
  })

  it('serializes writes so slower older responses cannot overwrite newer state', async () => {
    const order: string[] = []
    const call = vi.fn(async (_channel, _endpoint, payload: { patch: { thoughts: { enabled: boolean } } }) => {
      order.push(`start:${payload.patch.thoughts.enabled}`)
      await Promise.resolve()
      order.push(`end:${payload.patch.thoughts.enabled}`)
      return { ok: true as const, value: { ...DEFAULTS, thoughts: payload.patch.thoughts } }
    })
    const store = createGrayCodeStore(makeConnection(call))
    await Promise.all([
      store.patch({ thoughts: { enabled: true, sendHistoryThoughts: false } }),
      store.patch({ thoughts: { enabled: false, sendHistoryThoughts: false } }),
    ])
    expect(order).toEqual(['start:true', 'end:true', 'start:false', 'end:false'])
    expect(store.state).toMatchObject({ status: 'ready', config: { thoughts: { enabled: false } } })
  })

  it('rebases queued field edits on the latest snapshot within one module', async () => {
    let host = structuredClone(DEFAULTS)
    const call = vi.fn(async (_channel, endpoint, payload: { patch?: Partial<GrayCodeConfig> }) => {
      if (endpoint === 'config.update' && payload.patch !== undefined) {
        host = { ...host, ...payload.patch } as GrayCodeConfig
      }
      return { ok: true as const, value: structuredClone(host) }
    })
    const store = createGrayCodeStore(makeConnection(call))
    await store.refresh()
    await Promise.all([
      store.set(['memory', 'wakeLines'], 120),
      store.set(['memory', 'entryChars'], 400),
    ])
    expect(host.memory).toMatchObject({ wakeLines: 120, entryChars: 400 })
    const secondWrite = call.mock.calls[2]?.[2] as { patch: GrayCodeConfig }
    expect(secondWrite.patch.memory).toMatchObject({ wakeLines: 120, entryChars: 400 })
  })

  it('surfaces protocol and transport failures and can recover on a later refresh', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'boom', details: {} } })
      .mockResolvedValueOnce({ ok: true, value: DEFAULTS })
    const store = createGrayCodeStore(makeConnection(call))
    await store.refresh()
    expect(store.state).toEqual({ status: 'error', message: 'boom' })
    await store.refresh()
    expect(store.state.status).toBe('ready')
  })

  it('coalesces refreshes started in one turn', async () => {
    let release!: (value: { ok: true; value: GrayCodeConfig }) => void
    const gate = new Promise<{ ok: true; value: GrayCodeConfig }>(resolve => { release = resolve })
    const call = vi.fn(() => gate)
    const store = createGrayCodeStore(makeConnection(call))
    const first = store.refresh()
    const second = store.refresh()
    release({ ok: true, value: DEFAULTS })
    await Promise.all([first, second])
    expect(call).toHaveBeenCalledTimes(1)
  })
})

describe('Gray Remote bridge client', () => {
  it('unwraps the outer DSH RPC envelope and preserves Gray errors', async () => {
    const gray = { ok: false as const, error: { code: 'GRAY_CONFLICT', message: 'changed', details: {} } }
    const call = vi.fn(async () => ({ ok: true as const, value: gray }))
    const invoke = createGrayRemoteInvoker(makeConnection(call))
    expect(await invoke('checkpoints', 'list', { limit: 20 })).toEqual(gray)
    expect(call).toHaveBeenCalledWith(GRAYCODE_CHANNEL, 'remote.invoke', {
      namespace: 'checkpoints', method: 'list', args: { limit: 20 },
    })
  })
})

describe('real settings surface', () => {
  it('contains only real host modules', () => {
    expect(Object.keys(DEFAULTS).sort()).toEqual([
      'activity', 'branches', 'checkpoints', 'file', 'media', 'memory', 'migration',
      'notifications', 'persona', 'prompt', 'stagedDiff', 'subagents', 'thoughts', 'todo', 'workflows',
    ].sort())
    expect(JSON.stringify(DEFAULTS)).not.toContain('apiKey')
  })

  it('uses seven focused native-settings categories', () => {
    expect(CATEGORIES.map(category => category.id)).toEqual([
      'checkpoints', 'memory', 'workflows', 'activity', 'prompt', 'tools', 'advanced',
    ])
    expect(new Set(CATEGORIES.map(category => category.id)).size).toBe(CATEGORIES.length)
    for (const category of CATEGORIES) expect(zh).toHaveProperty(category.labelKey)
  })
})

describe('native settings theme styles', () => {
  it('tracks the DSH color-scheme instead of relying on unavailable aliases', () => {
    for (const color of [tokens.bg, tokens.bgSubtle, tokens.fg, tokens.fgSecondary, tokens.border, tokens.accent]) {
      expect(color).toContain('light-dark(')
      expect(color).not.toContain('--dsw-alias-')
    }
    expect(tokens.fontFamily).toContain('--dsw-font-family')
    expect(tokens.fontMono).toContain('--ds-font-family-code')
    expect(inputStyle.colorScheme).toBe('inherit')
  })

  it('restores an inactive tab border after the active longhand was applied', () => {
    expect(tabStyle.borderColor).toBe('transparent')
    expect(tabActiveStyle.borderColor).not.toBe(tabStyle.borderColor)
  })

  it('gives the custom switch a real containing block for its track and knob', () => {
    expect(switchWrapStyle).toMatchObject({
      display: 'inline-block',
      position: 'relative',
      width: '32px',
      height: '18px',
    })
  })

  it('keeps checkpoint action labels inside their buttons at narrow widths', () => {
    expect(buttonStyle).toMatchObject({
      boxSizing: 'border-box',
      flexShrink: 0,
      whiteSpace: 'nowrap',
    })
    expect(checkpointCreateRowStyle.flexWrap).toBe('wrap')
    expect(checkpointTitleInputStyle).toMatchObject({ flex: '1 1 220px', width: 'auto' })
    expect(checkpointCreateActionsStyle.flex).toBe('none')
  })
})

describe('settings.graycode locales', () => {
  it('owns the namespace and keeps every language key-aligned', () => {
    expect(GRAYCODE_SETTINGS_NS).toBe('settings.graycode')
    expect(Object.keys(graycodeSettingsDictionaries.en).sort()).toEqual(Object.keys(zh).sort())
    expect(Object.keys(graycodeSettingsJaPlaceholder).sort()).toEqual(Object.keys(zh).sort())
  })

  it('contains non-empty copy and every category title/description', () => {
    for (const dict of [zh, graycodeSettingsDictionaries.en, graycodeSettingsJaPlaceholder]) {
      for (const text of Object.values(dict)) expect(text.length).toBeGreaterThan(0)
    }
    for (const category of CATEGORIES) {
      expect(zh).toHaveProperty(`pages.${category.id}.title`)
      expect(zh).toHaveProperty(`pages.${category.id}.description`)
    }
  })
})
