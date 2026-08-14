/**
 * entries.ts / fingerprint.ts 测试：条目编排（order 排序、disabled 过滤、
 * system 合并、user/assistant 上下文段落、chat_history 占位符）、fakeThought
 * 两态开关、renderModeSectionText 组合、指纹稳定性。
 */
import { describe, expect, test } from 'vitest'
import {
  assembleEntries,
  fakeThoughtPolicy,
  renderModeSectionText,
} from '../../src/prompt/domain/entries.ts'
import { fingerprint } from '../../src/prompt/domain/fingerprint.ts'
import type { PromptEntry } from '../../src/prompt/domain/promptTypes.ts'

function entry(overrides: Partial<PromptEntry> & Pick<PromptEntry, 'id' | 'role'>): PromptEntry {
  return { order: 0, enabled: true, content: '', ...overrides }
}

describe('assembleEntries 编排', () => {
  test('按 order 升序排序（id 决胜）、disabled 条目被过滤', () => {
    const entries = [
      entry({ id: 'a', role: 'system', order: 3, content: 'three' }),
      entry({ id: 'b', role: 'system', order: 1, content: 'one' }),
      entry({ id: 'c', role: 'system', order: 2, content: 'two', enabled: false }),
      entry({ id: 'd', role: 'system', order: 2, content: 'two-a' }),
    ]
    const result = assembleEntries(entries, { systemText: 'base' })
    expect(result.blocks.map(block => block.id)).toEqual(['b', 'd', 'a'])
    expect(result.systemText).toBe('base\n\none\n\ntwo-a\n\nthree')
  })

  test('system 条目合并进系统段；无 base 时只含条目', () => {
    const result = assembleEntries(
      [entry({ id: 's1', role: 'system', order: 0, content: 'sys-a' })],
      { systemText: '' },
    )
    expect(result.systemText).toBe('sys-a')
    expect(result.contextParagraphs).toEqual([])
  })

  test('user/assistant 条目渲染为带角色标签的上下文段落（D-11=c）', () => {
    const result = assembleEntries(
      [
        entry({ id: 'u1', role: 'user', order: 0, content: 'user body' }),
        entry({ id: 'a1', role: 'assistant', order: 1, content: 'assistant body' }),
      ],
      { systemText: 'base' },
    )
    expect(result.contextParagraphs).toEqual([
      '[GrayCode preset entry: role=user]\nuser body',
      '[GrayCode preset entry: role=assistant]\nassistant body',
    ])
    expect(result.systemText).toBe('base')
    expect(result.chatHistoryMarkers).toBe(0)
  })

  test('chat_history 条目只作位置标记：不渲染、不进入段落，计数正确', () => {
    const result = assembleEntries(
      [
        entry({ id: 'h1', role: 'chat_history', order: 0 }),
        entry({ id: 'u1', role: 'user', order: 1, content: 'body' }),
        entry({ id: 'h2', role: 'chat_history', order: 2, enabled: false }),
      ],
      { systemText: 'base' },
    )
    expect(result.chatHistoryMarkers).toBe(1)
    expect(result.contextParagraphs).toEqual(['[GrayCode preset entry: role=user]\nbody'])
    const marker = result.blocks.find(block => block.id === 'h1')
    expect(marker?.chatHistoryMarker).toBe(true)
    expect(marker?.text).toBeUndefined()
    // D-11=c：chatHistoryText 预留（请求构造层）当前不使用
    expect(result.systemText).toBe('base')
  })

  test('空条目与空 systemText：原样透传', () => {
    const result = assembleEntries([], { systemText: 'base' })
    expect(result.systemText).toBe('base')
    expect(result.blocks).toEqual([])
    expect(result.chatHistoryMarkers).toBe(0)
  })
})

describe('fakeThoughtPolicy (D-11=c)', () => {
  test('开关关闭：不输出 thought，正文照发', () => {
    const result = fakeThoughtPolicy(
      entry({ id: 'a', role: 'assistant', content: 'body', fakeThought: 'secret thinking' }),
      false,
    )
    expect(result).toEqual({ text: 'body', thoughtIncluded: false })
  })

  test('开关开启：assistant 条目以 [thinking] 纯文本前缀注入', () => {
    const result = fakeThoughtPolicy(
      entry({ id: 'a', role: 'assistant', content: 'body', fakeThought: 'secret thinking' }),
      true,
    )
    expect(result).toEqual({
      text: '[thinking]\nsecret thinking\n[/thinking]\n\nbody',
      thoughtIncluded: true,
    })
  })

  test('fakeThought 仅对 assistant 生效；空 fakeThought 忽略', () => {
    expect(fakeThoughtPolicy(entry({ id: 'u', role: 'user', content: 'u', fakeThought: 'x' }), true))
      .toEqual({ text: 'u', thoughtIncluded: false })
    expect(fakeThoughtPolicy(entry({ id: 's', role: 'system', content: 's', fakeThought: 'x' }), true))
      .toEqual({ text: 's', thoughtIncluded: false })
    expect(fakeThoughtPolicy(entry({ id: 'a', role: 'assistant', content: 'a' }), true))
      .toEqual({ text: 'a', thoughtIncluded: false })
  })
})

describe('renderModeSectionText 组合（D-11=c 单段注入单元）', () => {
  const mode = {
    template: 'Template with {{$ENVIRONMENT}}',
    customPrefix: 'PREFIX',
    customSuffix: 'SUFFIX',
    promptEntries: [
      entry({ id: 'sys', role: 'system', order: 0, content: 'sys entry' }),
      entry({ id: 'u1', role: 'user', order: 1, content: 'user entry' }),
      entry({ id: 'a1', role: 'assistant', order: 2, content: 'assistant entry', fakeThought: 'think!' }),
    ],
  }

  test('prefix + 模板/系统条目 + 段落 + suffix 以空行连接', () => {
    const text = renderModeSectionText(mode, {
      sendHistoryThoughts: false,
      placeholderValues: { ENVIRONMENT: 'env-value' },
    })
    expect(text).toBe(
      [
        'PREFIX',
        'Template with env-value\n\nsys entry',
        '[GrayCode preset entry: role=user]\nuser entry',
        '[GrayCode preset entry: role=assistant]\nassistant entry',
        'SUFFIX',
      ].join('\n\n'),
    )
  })

  test('sendHistoryThoughts 开启时段落内出现 [thinking] 前缀（与注入层两态一致）', () => {
    const on = renderModeSectionText(mode, { sendHistoryThoughts: true })
    expect(on).toContain('[thinking]\nthink!\n[/thinking]\n\nassistant entry')
    const off = renderModeSectionText(mode, { sendHistoryThoughts: false })
    expect(off).not.toContain('[thinking]')
  })

  test('无 prefix/suffix 时不产生空段', () => {
    const text = renderModeSectionText({ ...mode, customPrefix: undefined, customSuffix: '' }, {})
    expect(text.startsWith('Template with')).toBe(true)
    expect(text.endsWith('assistant entry')).toBe(true)
  })
})

describe('fingerprint', () => {
  const entries = [
    entry({ id: 'u1', role: 'user', order: 0, content: 'c1' }),
    entry({ id: 'a1', role: 'assistant', order: 1, content: 'c2', fakeThought: 't' }),
  ]

  test('同一输入指纹稳定（确定性）', () => {
    expect(fingerprint(entries)).toBe(fingerprint(entries))
    expect(fingerprint([])).toBe(fingerprint([]))
  })

  test('content/role/order/enabled/fakeThought 任一变化指纹变化', () => {
    expect(fingerprint(entries)).not.toBe(fingerprint([entry({ id: 'u1', role: 'user', order: 0, content: 'c1-CHANGED' }), entries[1]!]))
    expect(fingerprint(entries)).not.toBe(fingerprint([{ ...entries[0]!, role: 'assistant' }, entries[1]!]))
    expect(fingerprint(entries)).not.toBe(fingerprint([{ ...entries[0]!, order: 5 }, entries[1]!]))
    expect(fingerprint(entries)).not.toBe(fingerprint([{ ...entries[0]!, enabled: false }, entries[1]!]))
    expect(fingerprint(entries)).not.toBe(fingerprint([entries[0]!, { ...entries[1]!, fakeThought: 't2' }]))
  })

  test('交换条目顺序改变指纹（顺序敏感）', () => {
    expect(fingerprint(entries)).not.toBe(fingerprint([entries[1]!, entries[0]!]))
  })
})
