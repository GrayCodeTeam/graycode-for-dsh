/**
 * entries.ts / fingerprint.ts 测试：条目编排（order 排序、disabled 过滤、
 * system 合并、user/assistant 条目 block-only、chat_history 占位符）、
 * fakeThought typed-only（绝不以 [thinking] 文本出现）、renderModeSectionText
 * 组合（prefix + 模板/系统条目 + suffix）、指纹稳定性。
 *
 * V2 entries-first（D-11 = c 语义）：user/assistant 条目只产出 blocks
 * （text = 原始 content），永不进入 systemText；fakeThought 由 thoughts 域
 * 作为 typed reasoning 块注入，本域不渲染任何 [thinking] 文本。
 */
import { describe, expect, test } from 'vitest'
import {
  assembleEntries,
  renderModeSectionText,
} from '../../src/prompt/domain/entries.ts'
import { fingerprint } from '../../src/prompt/domain/fingerprint.ts'
import { unavailablePlaceholderText } from '../../src/prompt/domain/template.ts'
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
    expect(result.chatHistoryMarkers).toBe(0)
  })

  test('user/assistant 条目只产出 blocks（text = 原始 content），绝不进入 systemText', () => {
    const result = assembleEntries(
      [
        entry({ id: 'u1', role: 'user', order: 0, content: 'user body' }),
        entry({ id: 'a1', role: 'assistant', order: 1, content: 'assistant body', fakeThought: 'think' }),
      ],
      { systemText: 'base' },
    )
    expect(result.systemText).toBe('base')
    expect(result.blocks).toEqual([
      { id: 'u1', role: 'user', order: 0, text: 'user body' },
      { id: 'a1', role: 'assistant', order: 1, text: 'assistant body' },
    ])
    expect(result.chatHistoryMarkers).toBe(0)
  })

  test('chat_history 条目只作位置标记：不渲染、不产出 text，计数正确', () => {
    const result = assembleEntries(
      [
        entry({ id: 'h1', role: 'chat_history', order: 0 }),
        entry({ id: 'u1', role: 'user', order: 1, content: 'body' }),
        entry({ id: 'h2', role: 'chat_history', order: 2, enabled: false }),
      ],
      { systemText: 'base' },
    )
    expect(result.chatHistoryMarkers).toBe(1)
    const marker = result.blocks.find(block => block.id === 'h1')
    expect(marker?.chatHistoryMarker).toBe(true)
    expect(marker?.text).toBeUndefined()
    // chat_history 是位置锚点（thoughts 域把真实历史放在这里），不进 systemText
    expect(result.systemText).toBe('base')
  })

  test('空 user/assistant 条目整条跳过，不产出 block（对齐旧空文本 continue）', () => {
    const result = assembleEntries(
      [
        entry({ id: 'empty-user', role: 'user', order: 0, content: '' }),
        entry({ id: 'blank-assistant', role: 'assistant', order: 1, content: '   ' }),
        entry({ id: 'real', role: 'user', order: 2, content: 'body' }),
      ],
      { systemText: 'base' },
    )
    expect(result.blocks.map(block => block.id)).toEqual(['real'])
    expect(result.systemText).toBe('base')
  })

  test('空条目与空 systemText：原样透传', () => {
    const result = assembleEntries([], { systemText: 'base' })
    expect(result.systemText).toBe('base')
    expect(result.blocks).toEqual([])
    expect(result.chatHistoryMarkers).toBe(0)
  })
})

describe('fakeThought 绝不以文本出现（typed-only，thoughts 域接管）', () => {
  test('assembleEntries：assistant 条目 block 只含正文，fakeThought 不进入任何文本', () => {
    const result = assembleEntries(
      [entry({ id: 'a1', role: 'assistant', order: 0, content: 'body', fakeThought: 'secret thinking' })],
      { systemText: 'base' },
    )
    expect(result.blocks[0]!.text).toBe('body')
    expect(result.systemText).toBe('base')
    expect(JSON.stringify(result)).not.toContain('[thinking]')
    expect(JSON.stringify(result)).not.toContain('secret thinking')
  })

  test('renderModeSectionText：sendHistoryThoughts 任意状态下都不渲染 [thinking] 前缀', () => {
    const mode = {
      template: 'tpl',
      promptEntries: [entry({ id: 'a1', role: 'assistant', order: 0, content: 'body', fakeThought: 'secret thinking' })],
    }
    for (const sendHistoryThoughts of [false, true]) {
      const text = renderModeSectionText(mode, { sendHistoryThoughts })
      expect(text).toBe('tpl')
      expect(text).not.toContain('[thinking]')
      expect(text).not.toContain('secret thinking')
    }
  })
})

describe('renderModeSectionText 组合（entries-first 单段注入单元）', () => {
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

  test('prefix + 模板/系统条目合并 + suffix 以空行连接；user/assistant 条目不进正文', () => {
    const text = renderModeSectionText(mode, {
      sendHistoryThoughts: false,
      placeholderValues: { ENVIRONMENT: 'env-value' },
    })
    expect(text).toBe(
      ['PREFIX', 'Template with env-value\n\nsys entry', 'SUFFIX'].join('\n\n'),
    )
    expect(text).not.toContain('user entry')
    expect(text).not.toContain('assistant entry')
    expect(text).not.toContain('[GrayCode preset entry:')
  })

  test('deprecated 选项（sendHistoryThoughts/requestLayer）被忽略：输出与不传一致', () => {
    const base = renderModeSectionText(mode, { placeholderValues: { ENVIRONMENT: 'env-value' } })
    const withDeprecated = renderModeSectionText(mode, {
      sendHistoryThoughts: true,
      requestLayer: true,
      placeholderValues: { ENVIRONMENT: 'env-value' },
    })
    expect(withDeprecated).toBe(base)
    expect(withDeprecated).not.toContain('[thinking]')
  })

  test('无 prefix/suffix 时不产生空段', () => {
    const text = renderModeSectionText({ ...mode, customPrefix: undefined, customSuffix: '' }, {})
    expect(text.startsWith('Template with')).toBe(true)
    expect(text.endsWith('sys entry')).toBe(true)
  })

  test('M6：renderModeSectionText 输出经 cleanupEmptyLines（3+ 换行折叠 + 整体 trim）', () => {
    const text = renderModeSectionText(
      {
        template: '\n\n\nTpl\n\n\n\n',
        customPrefix: 'PREFIX\n\n\n',
        customSuffix: '\n\n\nSUFFIX\n\n\n',
        promptEntries: [entry({ id: 's1', role: 'system', order: 0, content: 'sys\n\n\n\nbody' })],
      },
      {},
    )
    expect(text).toBe('PREFIX\n\nTpl\n\nsys\n\nbody\n\nSUFFIX')
  })

  test('BUG-01：customPrefix/customSuffix 与 body 同路径渲染清洗（B3-P2 无非法 {{...}} 残留）', () => {
    const text = renderModeSectionText(
      {
        template: 'Body {{$TOOLS}}',
        customPrefix: 'PREFIX {{$TOOLS}} {{Foo}} {{a-b}}',
        customSuffix: '{{Bar}} SUFFIX',
        promptEntries: [],
      },
      {},
    )
    // {{$TOOLS}} 无显式值 → 延迟给 DSH 渲染期变量 {{graycode_tools}}（DSH 安全小写变量）
    expect(text).toContain('{{graycode_tools}}')
    // 非法引用（大写/带 $/连字符）全部替换为确定性说明文本
    expect(text).toContain(unavailablePlaceholderText('Foo'))
    expect(text).toContain(unavailablePlaceholderText('a-b'))
    expect(text).toContain(unavailablePlaceholderText('Bar'))
    // 残留的 {{...}} 组只可能是 DSH 安全小写变量（B3-P2：装配器可接受）
    for (const group of text.match(/\{\{[^{}]*\}\}/g) ?? []) {
      expect(group).toMatch(/^\{\{[a-z][a-z0-9_]*\}\}$/)
    }
  })

  test('BUG-01：placeholderValues 同样作用于 customPrefix/customSuffix；DSH 安全小写变量保留', () => {
    const text = renderModeSectionText(
      {
        template: 'tpl',
        customPrefix: 'P {{$ENVIRONMENT}} {{graycode_prompt_mode}}',
        customSuffix: '{{$MEMORY}} S',
        promptEntries: [],
      },
      { placeholderValues: { ENVIRONMENT: 'env-value', MEMORY: 'mem-value' } },
    )
    expect(text).toContain('P env-value {{graycode_prompt_mode}}')
    expect(text).toContain('mem-value S')
    expect(text).not.toContain('{{$ENVIRONMENT}}')
    expect(text).not.toContain('{{$MEMORY}}')
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
