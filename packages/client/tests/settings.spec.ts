/**
 * Gray Code 设置面板（settings.section）— 纯逻辑测试。
 *
 * 覆盖：store 的 `getAtPath`/`setAtPath` 路径读写（嵌套创建、顶层补丁提取、
 * 不可变性）、store 状态机（loading → ready/error、RPC 载荷转发、并发串行
 * 化）、默认配置形状（17 个分类顶层键）、分类注册表（17 个页签、Gray-Code
 * 顺序）、以及 locale 对齐（zh/en 平衡 + ja 占位镜像 + 每个页签文案键存在）。
 *
 * React 组件不在此渲染（node 环境）；store.ts 的 useSyncExternalStore 仅被
 * hook 使用，本 spec 只驱动 store 的公开面。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  DEFAULTS,
  DEFAULT_TOOL_AUTO_EXEC,
  TOKEN_COUNT_PROVIDERS,
} from '../src/client/settings/defaults.ts'
import { GRAYCODE_CHANNEL, createGrayCodeStore, getAtPath, setAtPath } from '../src/client/settings/store.ts'
import {
  GRAYCODE_SETTINGS_NS,
  graycodeSettingsDictionaries,
  graycodeSettingsJaPlaceholder,
  zh,
} from '../src/client/settings/locales.ts'
import { CATEGORIES } from '../src/client/settings/pages.tsx'
import type { GrayCodeConfig } from '../src/client/settings/types.ts'

/** 最小 ConnectionHandle 双：只提供 rpc.call。 */
function makeConnection(call: ReturnType<typeof vi.fn>): ConnectionHandle {
  return { rpc: { call } } as unknown as ConnectionHandle
}

// ---------------------------------------------------------------------------
// getAtPath / setAtPath
// ---------------------------------------------------------------------------

describe('getAtPath', () => {
  it('reads nested values along a dotted path', () => {
    const config = structuredClone(DEFAULTS)
    expect(getAtPath(config, ['sound', 'cues', 'warning'])).toBe(true)
    expect(getAtPath(config, ['general', 'updateChannel'])).toBe('stable')
  })

  it('returns undefined for missing or non-object intermediate steps', () => {
    const config = structuredClone(DEFAULTS)
    expect(getAtPath(config, ['nope', 'x'])).toBeUndefined()
    expect(getAtPath(config, ['channels', 0, 'name'])).toBeUndefined()
    expect(getAtPath(config, ['activeChannelId', 'length'])).toBeUndefined()
  })
})

describe('setAtPath', () => {
  it('sets a nested value and derives a shallow top-level patch', () => {
    const config = structuredClone(DEFAULTS)
    const { next, patch } = setAtPath(config, ['sound', 'cues', 'warning'], false)
    expect(next.sound.cues.warning).toBe(false)
    expect(patch).toEqual({ sound: { ...DEFAULTS.sound, cues: { ...DEFAULTS.sound.cues, warning: false } } })
    // 原配置不被修改（纯函数）。
    expect(config.sound.cues.warning).toBe(true)
  })

  it('creates missing intermediate objects', () => {
    const config = structuredClone(DEFAULTS)
    const { next, patch } = setAtPath(config, ['toolsEnabled', 'new_tool'], true)
    expect(next.toolsEnabled.new_tool).toBe(true)
    expect(patch.toolsEnabled).toEqual({ new_tool: true })
  })

  it('returns an empty patch when the value is unchanged', () => {
    const config = structuredClone(DEFAULTS)
    const { patch } = setAtPath(config, ['general', 'updateChannel'], 'stable')
    expect(patch).toEqual({})
  })

  it('keeps the changed top-level patch minimal (only affected keys)', () => {
    const config = structuredClone(DEFAULTS)
    const { patch } = setAtPath(config, ['memory', 'wakeLines'], 42)
    expect(Object.keys(patch)).toEqual(['memory'])
  })

  it('replaces array items wholesale', () => {
    const config = structuredClone(DEFAULTS)
    config.channels = [
      { id: 'c1', name: 'A', type: 'openai', enabled: true },
    ]
    const { next, patch } = setAtPath(config, ['channels'], [
      { id: 'c1', name: 'B', type: 'openai', enabled: true },
    ])
    expect(next.channels[0]!.name).toBe('B')
    expect(patch.channels).toEqual(next.channels)
  })
})

// ---------------------------------------------------------------------------
// store 状态机（/graycode RPC 通道）
// ---------------------------------------------------------------------------

describe('GrayCodeStore', () => {
  it('starts in loading and moves to ready with defaults merged on refresh', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: { sound: { enabled: true } } }))
    const store = createGrayCodeStore(makeConnection(call))
    expect(store.state).toEqual({ status: 'loading' })
    await store.refresh()
    expect(call).toHaveBeenCalledWith(GRAYCODE_CHANNEL, 'config.get', {})
    expect(store.state.status).toBe('ready')
    if (store.state.status === 'ready') {
      expect(store.state.config.sound.enabled).toBe(true)
      expect(store.state.config.memory.enabled).toBe(true) // 默认值兜底
    }
  })

  it('surfaces the RPC error message in the error state', async () => {
    const call = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'internal', message: 'graycode: boom' },
    }))
    const store = createGrayCodeStore(makeConnection(call))
    await store.refresh()
    expect(store.state).toEqual({ status: 'error', message: 'graycode: boom' })
  })

  it('catches thrown transport errors', async () => {
    const call = vi.fn(async () => { throw new Error('socket gone') })
    const store = createGrayCodeStore(makeConnection(call))
    await store.refresh()
    expect(store.state).toEqual({ status: 'error', message: 'socket gone' })
  })

  it('forwards patch/replace/reset payloads and adopts the echoed config', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: { sound: { enabled: false } } }))
    const store = createGrayCodeStore(makeConnection(call))
    await store.patch({ sound: { enabled: false } })
    expect(call).toHaveBeenLastCalledWith(GRAYCODE_CHANNEL, 'config.update', {
      patch: { sound: { enabled: false } },
    })
    expect(store.state.status).toBe('ready')

    await store.replace({} as GrayCodeConfig)
    expect(call).toHaveBeenLastCalledWith(GRAYCODE_CHANNEL, 'config.replace', {})

    await store.reset()
    expect(call).toHaveBeenLastCalledWith(GRAYCODE_CHANNEL, 'config.reset', {})
  })

  it('notifies subscribers on every snapshot change and unsubscribes cleanly', async () => {
    const call = vi.fn(async () => ({ ok: true as const, value: {} }))
    const store = createGrayCodeStore(makeConnection(call))
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    await store.refresh()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    await store.refresh()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('coalesces refreshes scheduled in the same tick into one pump', async () => {
    let resolveGet!: (value: { ok: true; value: unknown }) => void
    const gate = new Promise<{ ok: true; value: unknown }>(resolve => { resolveGet = resolve })
    const call = vi.fn(() => gate)
    const store = createGrayCodeStore(makeConnection(call))
    const first = store.refresh()
    const second = store.refresh()
    // 同步 tick 内的第二次 refresh 不重复拉取：pump 串行化并消费 invalidated
    // 标记（见 StoreImpl.pump）。
    resolveGet({ ok: true, value: { activeChannelId: 'c1' } })
    await Promise.all([first, second])
    expect(call).toHaveBeenCalledTimes(1)
    expect(store.state.status).toBe('ready')
    if (store.state.status === 'ready') {
      expect(store.state.config.activeChannelId).toBe('c1')
    }
  })
})

// ---------------------------------------------------------------------------
// 默认配置形状（17 个分类顶层键）
// ---------------------------------------------------------------------------

describe('DEFAULTS', () => {
  it('covers the 17 Gray-Code categories as top-level keys', () => {
    const expected = [
      'activeChannelId',
      'channels',
      'defaultToolMode',
      'maxToolIterations',
      'toolsEnabled',
      'toolAutoExec',
      'mcpServers',
      'checkpoint',
      'summarize',
      'imageGen',
      'context',
      'prompt',
      'tokenCount',
      'sound',
      'appearance',
      'memory',
      'subagents',
      'proxy',
      'general',
    ]
    expect(Object.keys(DEFAULTS).sort()).toEqual(expected.sort())
  })

  it('seeds empty collections and Gray-Code default tool confirmation policy', () => {
    expect(DEFAULTS.channels).toEqual([])
    expect(DEFAULTS.mcpServers).toEqual([])
    expect(DEFAULTS.subagents.agents).toEqual([])
    expect(DEFAULTS.toolAutoExec).toEqual(DEFAULT_TOOL_AUTO_EXEC)
  })

  it('keeps every token-count provider section populated', () => {
    for (const provider of TOKEN_COUNT_PROVIDERS) {
      expect(typeof DEFAULTS.tokenCount[provider].baseUrl).toBe('string')
      expect(DEFAULTS.tokenCount[provider].enabled).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// 分类注册表（17 个页签，Gray-Code 顺序）
// ---------------------------------------------------------------------------

describe('CATEGORIES', () => {
  it('exposes exactly the 17 Gray-Code categories in Gray-Code order', () => {
    expect(CATEGORIES.map(category => category.id)).toEqual([
      'channel',
      'tools',
      'autoExec',
      'mcp',
      'subagents',
      'checkpoint',
      'summarize',
      'imageGen',
      'dependencies',
      'context',
      'prompt',
      'tokenCount',
      'sound',
      'appearance',
      'memory',
      'general',
      'usage',
    ])
  })

  it('keeps ids unique and every label key in the dictionaries', () => {
    const zhKeys = new Set(Object.keys(zh))
    const ids = new Set<string>()
    for (const category of CATEGORIES) {
      expect(ids.has(category.id), `duplicate id ${category.id}`).toBe(false)
      ids.add(category.id)
      expect(zhKeys.has(category.labelKey), `zh missing ${category.labelKey}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// locale 对齐（zh/en 平衡 + ja 占位镜像）
// ---------------------------------------------------------------------------

describe('settings.graycode locales', () => {
  const en = graycodeSettingsDictionaries.en
  const ja = graycodeSettingsJaPlaceholder

  it('owns the dedicated settings namespace', () => {
    expect(GRAYCODE_SETTINGS_NS).toBe('settings.graycode')
  })

  it('keeps zh/en dictionaries balanced', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('keeps the ja placeholder key-aligned with zh/en', () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(zh).sort())
  })

  it('fills every shipped dictionary with non-empty text', () => {
    for (const dict of [zh, en, ja]) {
      for (const text of Object.values(dict)) {
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })

  it('covers every page title and description key the pages translate', () => {
    const zhKeys = new Set(Object.keys(zh))
    for (const category of CATEGORIES) {
      expect(zhKeys.has(`pages.${category.id}.title`), `zh missing pages.${category.id}.title`).toBe(true)
      expect(zhKeys.has(`pages.${category.id}.description`), `zh missing pages.${category.id}.description`).toBe(true)
    }
  })
})
