import { describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { DEFAULTS, DSH_AFTER_TOOL_DEFAULTS, DSH_BEFORE_TOOL_DEFAULTS, DSH_TOOL_DEFAULTS } from '../src/client/settings/defaults.ts'
import { GRAYCODE_CHANNEL, createGrayCodeStore, getAtPath, setAtPath } from '../src/client/settings/store.ts'
import { createGrayRemoteInvoker } from '../src/client/settings/remote.ts'
import {
  GRAYCODE_SETTINGS_NS,
  graycodeSettingsDictionaries,
  graycodeSettingsJaPlaceholder,
  zh,
} from '../src/client/settings/locales.ts'
import { CATEGORIES, commaListTransform, optionalSelectTransform, summaryTokenBudgetTransform } from '../src/client/settings/pages.tsx'
import { selectCurrentSessionWorkspace } from '../src/client/settings/GrayCodeSettingsSection.tsx'
import {
  createFieldDraft,
  prepareNumberCommit,
  prepareTextCommit,
  reduceFieldDraft,
} from '../src/client/settings/fieldDraft.ts'
import {
  WorkspaceRequestGuard,
  shouldAdoptWorkspaceDefault,
} from '../src/client/settings/workspaceRequestGuard.ts'
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
    expect(getAtPath(DEFAULTS, ['prompt', 'dataRoot'])).toBe('')
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

describe('shared settings layer: memory.enabled / checkpoints extensions', () => {
  it('mirrors the new host fields in the browser defaults', () => {
    expect(DEFAULTS.memory.enabled).toBe(true)
    expect(DEFAULTS.checkpoints.enabled).toBe(true)
    expect(DEFAULTS.checkpoints.autoCheckpoint).toBe(true)
    expect(DEFAULTS.checkpoints.modelToolsEnabled).toBe(true)
    expect(DEFAULTS.checkpoints.messageCheckpoint).toEqual({
      beforeMessages: ['user', 'model'],
      afterMessages: [],
      modelOuterLayerOnly: true,
      mergeUnchangedCheckpoints: true,
    })
    expect(DEFAULTS.checkpoints.beforeTools).toEqual([...DSH_BEFORE_TOOL_DEFAULTS])
    expect(DEFAULTS.checkpoints.afterTools).toEqual([...DSH_AFTER_TOOL_DEFAULTS])
    expect(DSH_TOOL_DEFAULTS).toHaveLength(24)
  })

  it('resolves every new field path on the defaults snapshot', () => {
    for (const path of [
      ['memory', 'enabled'],
      ['checkpoints', 'enabled'],
      ['checkpoints', 'autoCheckpoint'],
      ['checkpoints', 'modelToolsEnabled'],
      ['checkpoints', 'messageCheckpoint', 'beforeMessages'],
      ['checkpoints', 'messageCheckpoint', 'afterMessages'],
      ['checkpoints', 'messageCheckpoint', 'modelOuterLayerOnly'],
      ['checkpoints', 'messageCheckpoint', 'mergeUnchangedCheckpoints'],
      ['checkpoints', 'beforeTools'],
      ['checkpoints', 'afterTools'],
    ]) {
      expect(getAtPath(DEFAULTS, path), path.join('.')).toBeDefined()
    }
  })

  it('toggling the checkpoints master switch emits the whole segment with the nested policy intact', () => {
    const { patch } = setAtPath(structuredClone(DEFAULTS), ['checkpoints', 'enabled'], false)
    expect(patch).toEqual({ checkpoints: { ...DEFAULTS.checkpoints, enabled: false } })
    expect(patch.checkpoints?.messageCheckpoint).toEqual(DEFAULTS.checkpoints.messageCheckpoint)
    expect(patch.checkpoints?.beforeTools).toEqual(DEFAULTS.checkpoints.beforeTools)
  })

  it('replaces the nested messageCheckpoint policy wholesale through a top-level patch', () => {
    const config = structuredClone(DEFAULTS)
    const { next, patch } = setAtPath(config, ['checkpoints', 'messageCheckpoint', 'beforeMessages'], ['model'])
    expect(next.checkpoints.messageCheckpoint.beforeMessages).toEqual(['model'])
    expect(config.checkpoints.messageCheckpoint.beforeMessages).toEqual(['user', 'model'])
    expect(patch).toEqual({
      checkpoints: {
        ...DEFAULTS.checkpoints,
        messageCheckpoint: { ...DEFAULTS.checkpoints.messageCheckpoint, beforeMessages: ['model'] },
      },
    })
  })

  it('emits a patch when toggling memory.enabled off', () => {
    const { patch } = setAtPath(structuredClone(DEFAULTS), ['memory', 'enabled'], false)
    expect(patch).toEqual({ memory: { ...DEFAULTS.memory, enabled: false } })
  })

  it('round-trips comma-separated tool lists through the text transform', () => {
    expect(commaListTransform.toInput(DEFAULTS.checkpoints.beforeTools)).toBe(DSH_BEFORE_TOOL_DEFAULTS.join(', '))
    expect(commaListTransform.toInput(DEFAULTS.checkpoints.afterTools)).toBe(DSH_AFTER_TOOL_DEFAULTS.join(', '))
    expect(commaListTransform.fromInput('write, edit , bash,')).toEqual(['write', 'edit', 'bash'])
    expect(commaListTransform.fromInput('')).toEqual([])
    expect(commaListTransform.fromInput(42)).toEqual([])
    expect(prepareTextCommit('write, edit', commaListTransform)).toEqual({
      value: ['write', 'edit'],
      canonical: 'write, edit',
    })
  })

  it('checkpoint message-slot toggles moved to the config section (multi-kind arrays clobber in page transforms)', () => {
    // 2×2 消息边界选择读写完整数组，页面层单路径 transform 会互相覆盖成员；
    // 该编辑面已下放到 CheckpointConfigSection（withCheckpointConfigMessageKind）。
    const { patch } = setAtPath(structuredClone(DEFAULTS), ['checkpoints', 'messageCheckpoint', 'beforeMessages'], ['model'])
    expect(patch.checkpoints?.messageCheckpoint?.beforeMessages).toEqual(['model'])
  })
})

describe('settings workspace and local-draft guards', () => {
  it('selects the current session cwd and never invents a host cwd fallback', () => {
    const base = {
      ids: ['session-a'],
      byId: { 'session-a': { cwd: '  D:\\repo  ' } },
      current: 'session-a',
      phase: 'ready',
      subagentsByParent: {},
      jobsBySession: {},
      currentAddress: undefined,
    }
    expect(selectCurrentSessionWorkspace(base as never)).toBe('D:\\repo')
    expect(selectCurrentSessionWorkspace({ ...base, current: undefined } as never)).toBeUndefined()
    expect(selectCurrentSessionWorkspace({ ...base, byId: { 'session-a': {} } } as never)).toBeUndefined()
  })

  it('follows changed session defaults only while the path remains unedited', () => {
    expect(shouldAdoptWorkspaceDefault('C:\\old', 'C:\\old', 'D:\\next')).toBe(true)
    expect(shouldAdoptWorkspaceDefault('E:\\manual', 'C:\\old', 'D:\\next')).toBe(false)
    expect(shouldAdoptWorkspaceDefault('', undefined, 'D:\\next')).toBe(true)
  })

  it('invalidates old and cross-workspace checkpoint responses', () => {
    const guard = new WorkspaceRequestGuard('C:\\one')
    const first = guard.beginFor('C:\\one')!
    const newer = guard.beginFor(' C:\\one ' )!
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(newer)).toBe(true)
    guard.moveTo('D:\\two')
    expect(guard.isCurrent(newer)).toBe(false)
    expect(guard.beginFor('C:\\one')).toBeNull()
    expect(guard.isCurrent(guard.beginFor('D:\\two')!)).toBe(true)
  })

  it('keeps newer typing when an older RPC snapshot is acknowledged', () => {
    let draft = createFieldDraft('')
    draft = reduceFieldDraft(draft, { type: 'edit', value: 'a' })
    draft = reduceFieldDraft(draft, { type: 'commit', canonical: 'a' })
    draft = reduceFieldDraft(draft, { type: 'edit', value: 'ab' })
    draft = reduceFieldDraft(draft, { type: 'external', value: 'a' })
    expect(draft).toEqual({ draft: 'ab', dirty: true, pending: null })
    draft = reduceFieldDraft(draft, { type: 'commit', canonical: 'ab' })
    draft = reduceFieldDraft(draft, { type: 'external', value: 'stale-a' })
    expect(draft.draft).toBe('ab')
    expect(draft.pending).toBe('ab')
    expect(reduceFieldDraft(draft, { type: 'external', value: 'ab' })).toEqual(createFieldDraft('ab'))
    expect(reduceFieldDraft(draft, { type: 'settle', canonical: 'ab' }).pending).toBeNull()
  })

  it('preserves number intermediate states and normalizes multiline text only at commit', () => {
    expect(prepareNumberCommit('')).toBeNull()
    expect(prepareNumberCommit('-')).toBeNull()
    expect(prepareNumberCommit('1.5')).toEqual({ value: 1.5, canonical: '1.5' })
    const lines = {
      toInput: (value: unknown) => Array.isArray(value) ? value.join('\n') : '',
      fromInput: (value: unknown) => typeof value === 'string'
        ? value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
        : [],
    }
    expect(prepareTextCommit('one\n', lines)).toEqual({ value: ['one'], canonical: 'one' })
  })

  it('clamps out-of-range number commits into the declared bounds at commit', () => {
    expect(prepareNumberCommit('0.5', undefined, 1, 10)).toEqual({ value: 1, canonical: '1' })
    expect(prepareNumberCommit('42', undefined, 1, 10)).toEqual({ value: 10, canonical: '10' })
    expect(prepareNumberCommit('5', undefined, 1, 10)).toEqual({ value: 5, canonical: '5' })
    expect(prepareNumberCommit('5', undefined, undefined, undefined)).toEqual({ value: 5, canonical: '5' })
    // Bounds are declared in the display domain (seconds here), the stored
    // value stays in the storage domain (milliseconds).
    const seconds = {
      toInput: (value: unknown) => typeof value === 'number' ? value / 1000 : 0,
      fromInput: (value: unknown) => typeof value === 'number' ? Math.round(value * 1000) : 1000,
    }
    expect(prepareNumberCommit('4000', seconds, 1, 3600)).toEqual({ value: 3600000, canonical: '3600' })
    expect(prepareNumberCommit('0.5', seconds, 1, 3600)).toEqual({ value: 1000, canonical: '1' })
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
    const call = vi.fn(async (_channel, _endpoint, payload: { patch: { thoughts: { sendHistoryThoughts: boolean } } }) => {
      order.push(`start:${payload.patch.thoughts.sendHistoryThoughts}`)
      await Promise.resolve()
      order.push(`end:${payload.patch.thoughts.sendHistoryThoughts}`)
      return { ok: true as const, value: { ...DEFAULTS, thoughts: payload.patch.thoughts } }
    })
    const store = createGrayCodeStore(makeConnection(call))
    await Promise.all([
      store.patch({ thoughts: { sendHistoryThoughts: true } }),
      store.patch({ thoughts: { sendHistoryThoughts: false } }),
    ])
    expect(order).toEqual(['start:true', 'end:true', 'start:false', 'end:false'])
    expect(store.state).toMatchObject({ status: 'ready', config: { thoughts: { sendHistoryThoughts: false } } })
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

  it('keeps a queued refresh alive when an in-flight write succeeds', async () => {
    let releaseWrite!: (value: { ok: true; value: GrayCodeConfig }) => void
    const writeGate = new Promise<{ ok: true; value: GrayCodeConfig }>(resolve => { releaseWrite = resolve })
    let releaseRead!: (value: { ok: true; value: GrayCodeConfig }) => void
    const readGate = new Promise<{ ok: true; value: GrayCodeConfig }>(resolve => { releaseRead = resolve })
    const calls: string[] = []
    const call = vi.fn(async (_channel, endpoint) => {
      calls.push(endpoint)
      return endpoint === 'config.get' ? readGate : writeGate
    })
    const store = createGrayCodeStore(makeConnection(call))
    const write = store.patch({ memory: { ...DEFAULTS.memory, wakeLines: 3 } })
    const refresh = store.refresh()
    releaseWrite({ ok: true, value: { ...DEFAULTS, memory: { ...DEFAULTS.memory, wakeLines: 3 } } })
    await write
    releaseRead({ ok: true, value: DEFAULTS })
    await refresh
    // The refresh was queued behind the write; the write's success must NOT
    // cancel it (previously it cleared `invalidated`), so `config.get` still
    // fires and re-reads the acknowledged snapshot.
    expect(calls).toEqual(['config.update', 'config.get'])
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
      'activity', 'branches', 'checkpoints', 'file', 'images', 'media', 'memory', 'migration',
      'notifications', 'persona', 'prompt', 'stagedDiff', 'subagents', 'summary', 'thoughts', 'todo', 'workflows',
    ].sort())
    // 唯一凭据字段是 images.apiKey（镜像插件域；空默认值）
    const imagesOnly: Record<string, unknown> = { ...DEFAULTS }
    delete imagesOnly.images
    expect(JSON.stringify(imagesOnly)).not.toContain('apiKey')
    expect(DEFAULTS.images.apiKey).toBe('')
  })

  it('uses focused native-settings categories', () => {
    expect(CATEGORIES.map(category => category.id)).toEqual([
      'checkpoints', 'memory', 'workflows', 'activity', 'summary', 'image', 'subagents', 'prompt', 'tools', 'appearance', 'advanced',
    ])
    expect(new Set(CATEGORIES.map(category => category.id)).size).toBe(CATEGORIES.length)
    for (const category of CATEGORIES) expect(zh).toHaveProperty(category.labelKey)
  })

  it('normalizes summary token budgets without losing percentages', () => {
    expect(summaryTokenBudgetTransform.toInput('50%')).toBe('50%')
    expect(summaryTokenBudgetTransform.toInput(4096)).toBe('4096')
    expect(summaryTokenBudgetTransform.fromInput(' 4096 ')).toBe(4096)
    expect(summaryTokenBudgetTransform.fromInput(' 50% ')).toBe('50%')
  })
})

describe('images defaults', () => {
  it('mirrors the plugin images domain (disabled, roots scope, reference endpoint/model)', () => {
    expect(DEFAULTS.images).toEqual({
      enabled: false,
      agentScope: 'roots',
      url: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: '',
      model: 'gemini-3-pro-image-preview',
      enableAspectRatio: false,
      defaultAspectRatio: undefined,
      enableImageSize: false,
      defaultImageSize: undefined,
      maxBatchTasks: 5,
      maxImagesPerTask: 1,
    })
  })

  it('keeps the images block out of other module snapshots', () => {
    const config = structuredClone(DEFAULTS)
    const { patch } = setAtPath(config, ['checkpoints', 'maxCheckpoints'], 3)
    expect(patch.images).toBeUndefined()
  })

  it('turns the aspect-ratio select back into undefined for "auto"', () => {
    // The select's 「自动」option submits '' which must be stored as undefined;
    // a concrete value passes through unchanged (the setAtPath passthrough
    // itself is covered by the path-helper tests above).
    expect(optionalSelectTransform.toInput('16:9')).toBe('16:9')
    expect(optionalSelectTransform.toInput(undefined)).toBe('')
    expect(optionalSelectTransform.fromInput('16:9')).toBe('16:9')
    expect(optionalSelectTransform.fromInput('')).toBeUndefined()
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
