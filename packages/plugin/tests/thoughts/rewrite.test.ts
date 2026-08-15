/**
 * thoughts domain 纯函数测试（A1 能力内子集核心）。
 */

import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { PromptEntry } from '../../src/prompt/domain/promptTypes.ts'
import {
  injectionMessage,
  placeInjections,
  placementOf,
  presetEntriesToInjections,
  rewriteLoopRequest,
  THOUGHTS_PLUGIN_SOURCE,
  type InjectionPlacement,
  type PresetInjection,
} from '../../src/thoughts/domain/rewrite.ts'

function entry(overrides: Partial<PromptEntry> & { id: string }): PromptEntry {
  return {
    role: 'user',
    order: 0,
    enabled: true,
    content: '',
    ...overrides,
  }
}

function loopOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [
      { id: 'm1' as never, role: 'user', content: [], source: { kind: 'user' } },
      { id: 'm2' as never, role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } },
    ],
    ...overrides,
  }
}

/**
 * 更真实的 agent-loop 历史：旧 user/assistant、tool-result user、当前轮 user。
 * 最后一个 role==='user' 且 source.kind==='user' 的消息是 'cur'（当前轮输入）。
 */
function richLoopOptions(): GenerateOptions {
  return {
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [
      { id: 'h1' as never, role: 'user', content: [], source: { kind: 'user' } },
      { id: 'h2' as never, role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } },
      { id: 't1' as never, role: 'user', content: [], source: { kind: 'tool', callId: 'call-1' as never } },
      { id: 'cur' as never, role: 'user', content: [], source: { kind: 'user' } },
    ],
  }
}

describe('presetEntriesToInjections', () => {
  it('只投影 enabled 的 user/assistant 条目，按 order 排序（id 决胜）', () => {
    const entries = [
      entry({ id: 's', role: 'system', content: 'sys' }),
      entry({ id: 'a2', role: 'assistant', order: 2, content: 'A2' }),
      entry({ id: 'u1', role: 'user', order: 1, content: 'U1' }),
      entry({ id: 'off', role: 'user', order: 0, content: 'off', enabled: false }),
      entry({ id: 'h', role: 'chat_history', order: 0 }),
    ]
    const out = presetEntriesToInjections(entries, false)
    expect(out).toEqual([
      { role: 'user', text: 'U1', entryOrder: 1 },
      { role: 'assistant', text: 'A2', entryOrder: 2 },
    ])
  })

  it('空文本条目跳过（与 assembleEntries 同规则）', () => {
    const out = presetEntriesToInjections(
      [
        entry({ id: 'u', role: 'user', order: 0, content: '   ' }),
        entry({ id: 'a', role: 'assistant', order: 1, content: 'ok' }),
      ],
      false,
    )
    expect(out).toEqual([{ role: 'assistant', text: 'ok', entryOrder: 1 }])
  })

  it('fakeThought：仅 assistant + sendHistoryThoughts 开 + trim 后非空才携带', () => {
    const entries = [
      entry({ id: 'a1', role: 'assistant', order: 0, content: 'A1', fakeThought: '  think-1  ' }),
      entry({ id: 'u', role: 'user', order: 1, content: 'U', fakeThought: 'user-thought' }),
      entry({ id: 'a2', role: 'assistant', order: 2, content: 'A2', fakeThought: '   ' }),
    ]
    expect(presetEntriesToInjections(entries, false)).toEqual([
      { role: 'assistant', text: 'A1', entryOrder: 0 },
      { role: 'user', text: 'U', entryOrder: 1 },
      { role: 'assistant', text: 'A2', entryOrder: 2 },
    ])
    expect(presetEntriesToInjections(entries, true)).toEqual([
      { role: 'assistant', text: 'A1', thought: 'think-1', entryOrder: 0 },
      { role: 'user', text: 'U', entryOrder: 1 },
      { role: 'assistant', text: 'A2', entryOrder: 2 },
    ])
  })
})

describe('placementOf / placeInjections', () => {
  it('无 chat_history marker → 全部 after-history', () => {
    expect(placementOf([{ role: 'user', order: 1 }], 0)).toBe('after-history')
  })

  it('entry 在首个 marker 之前 → before-history；之后 → after-history', () => {
    const blocks = [
      { role: 'user', order: 1 },
      { role: 'chat_history', order: 2 },
      { role: 'assistant', order: 3 },
    ]
    expect(placementOf(blocks, 1)).toBe('before-history')
    expect(placementOf(blocks, 3)).toBe('after-history')
    expect(placementOf(blocks, 2)).toBe('after-history') // 与 marker 同 order → 后
  })

  it('placeInjections 按序配对 user/assistant 块并切分', () => {
    const injections = presetEntriesToInjections(
      [
        entry({ id: 'u', role: 'user', order: 1, content: 'U' }),
        entry({ id: 'a', role: 'assistant', order: 3, content: 'A' }),
      ],
      false,
    )
    const blocks = [
      { role: 'user', order: 1 },
      { role: 'chat_history', order: 2 },
      { role: 'assistant', order: 3 },
    ]
    expect(placeInjections(injections, blocks)).toEqual([
      { injection: { role: 'user', text: 'U', entryOrder: 1 }, placement: 'before-history' },
      { injection: { role: 'assistant', text: 'A', entryOrder: 3 }, placement: 'after-history' },
    ])
  })

  it('disabled 条目不再让注入与块按下标配对错位（3.15-M3）', () => {
    // chat_history marker 在 order 3；order 2 的 user 条目 disabled（不投影、但占一个
    // user/assistant 块位）。旧实现按下标配对：A（order 4）会被错配到 order 2 的块 →
    // 误放 before-history；新实现用注入自带 entryOrder 4 直接对照 marker → after-history。
    const injections = presetEntriesToInjections(
      [
        entry({ id: 'u1', role: 'user', order: 1, content: 'U1' }),
        entry({ id: 'd1', role: 'user', order: 2, content: 'skip me', enabled: false }),
        entry({ id: 'a1', role: 'assistant', order: 4, content: 'A1' }),
      ],
      false,
    )
    const blocks = [
      { role: 'user', order: 1 },
      { role: 'user', order: 2 },
      { role: 'chat_history', order: 3 },
      { role: 'assistant', order: 4 },
    ]
    expect(placeInjections(injections, blocks)).toEqual([
      { injection: { role: 'user', text: 'U1', entryOrder: 1 }, placement: 'before-history' },
      { injection: { role: 'assistant', text: 'A1', entryOrder: 4 }, placement: 'after-history' },
    ])
  })
})

describe('injectionMessage', () => {
  it('user → 单 text 块 + plugin source', () => {
    const message = injectionMessage({ role: 'user', text: 'hello', entryOrder: 0 }, 'p', 'm') as Message & {
      source: { kind: string; plugin: string }
    }
    expect(message.role).toBe('user')
    expect(message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(message.source).toEqual({ kind: 'plugin', plugin: THOUGHTS_PLUGIN_SOURCE })
  })

  it('assistant + thought → reasoning 块前置 + text 块；source 取请求 provider/model', () => {
    const message = injectionMessage({ role: 'assistant', text: 'body', thought: 'think', entryOrder: 0 }, 'p', 'm')
    expect(message.role).toBe('assistant')
    expect(message.content).toEqual([
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: 'body' },
    ])
    expect(message.source).toMatchObject({ provider: 'p', model: 'm' })
  })

  it('assistant 无 thought → 单 text 块', () => {
    const message = injectionMessage({ role: 'assistant', text: 'body', entryOrder: 0 }, 'p', 'm')
    expect(message.content).toEqual([{ type: 'text', text: 'body' }])
  })
})

describe('rewriteLoopRequest', () => {
  it('空 injections → 原对象引用返回，injectedCount 0', () => {
    const options = loopOptions()
    const result = rewriteLoopRequest(options, [])
    expect(result.options).toBe(options)
    expect(result.injectedCount).toBe(0)
  })

  it('构造新 options（非同一引用）+ 新 messages：before 前插、after 插在最后 user-source user 消息之前', () => {
    const options = richLoopOptions()
    const injections: ReadonlyArray<{ injection: PresetInjection; placement: InjectionPlacement }> = [
      { injection: { role: 'user', text: 'pre', entryOrder: 0 }, placement: 'before-history' },
      { injection: { role: 'assistant', text: 'post', thought: 't', entryOrder: 1 }, placement: 'after-history' },
    ]
    const result = rewriteLoopRequest(options, injections)

    expect(result.options).not.toBe(options)
    expect(result.injectedCount).toBe(2)
    expect(result.options.messages).toHaveLength(options.messages.length + 2)
    // 前插消息在最前
    expect(result.options.messages[0]!.content).toEqual([{ type: 'text', text: 'pre' }])
    // 原历史原样保序（元素引用不变）
    expect(result.options.messages.slice(1, 4).map(message => (message as { id: string }).id)).toEqual(['h1', 'h2', 't1'])
    // after 消息（reasoning 前置）插在最后一个 user-source user 消息（cur）之前
    expect(result.options.messages[4]!.content).toEqual([
      { type: 'reasoning', text: 't' },
      { type: 'text', text: 'post' },
    ])
    expect((result.options.messages[5] as { id: string }).id).toBe('cur')
  })

  it('after 锚点 = 最后一个 role==="user" 且 source.kind==="user" 的消息（tool-result 不计数）', () => {
    // 历史：user(h1) / assistant(h2) / tool-result user(t1) / 当前轮 user(cur)
    const options = richLoopOptions()
    const result = rewriteLoopRequest(options, [
      { injection: { role: 'user', text: 'post', entryOrder: 2 }, placement: 'after-history' },
    ])
    const postIndex = result.options.messages.findIndex(message =>
      message.content.some(block => (block as { text?: string }).text === 'post'),
    )
    // post 落在 cur 之前（而不是 t1 之前、更不是末尾）
    expect((result.options.messages[postIndex + 1] as { id: string }).id).toBe('cur')
    expect(result.options.messages[postIndex + 2]).toBeUndefined()
  })

  it('无 user-source user 消息时 after 注入回退到末尾', () => {
    const options = loopOptions({
      messages: [
        { id: 'a1' as never, role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
      ],
    })
    const result = rewriteLoopRequest(options, [
      { injection: { role: 'assistant', text: 'post', entryOrder: 0 }, placement: 'after-history' },
    ])
    expect(result.options.messages.at(-1)!.content).toEqual([{ type: 'text', text: 'post' }])
    // 原 assistant 消息仍在（before 位置）
    expect((result.options.messages[0] as { id: string }).id).toBe('a1')
  })

  it('绝不 mutate 输入：原 messages 数组与元素均未被改动', () => {
    const options = loopOptions()
    const originalMessages = options.messages
    rewriteLoopRequest(options, [
      { injection: { role: 'user', text: 'x', entryOrder: 0 }, placement: 'before-history' },
    ])
    expect(options.messages).toBe(originalMessages)
    expect(options.messages).toHaveLength(2)
    expect(options.messages[0]).toMatchObject({ role: 'user' })
    // 标量字段不变
    expect(options.provider).toBe('deepseek')
  })

  it('scalar 字段透传（provider/model/sessionId 等保留）', () => {
    const options = loopOptions({ sessionId: 'sess-1' as never })
    const result = rewriteLoopRequest(options, [
      { injection: { role: 'user', text: 'x', entryOrder: 0 }, placement: 'after-history' },
    ])
    expect(result.options.provider).toBe('deepseek')
    expect(result.options.model).toBe('deepseek-chat')
    expect(result.options.sessionId).toBe('sess-1')
  })
})
