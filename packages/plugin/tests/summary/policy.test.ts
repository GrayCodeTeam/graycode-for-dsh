/**
 * summary 域纯逻辑测试：token 估算、块/消息→文本提取、轮次分组、
 * 保留预算解析、输入裁剪（保留最近 N 轮 + 从旧轮收缩）、prompt 组装、
 * MIN_SUMMARY_LENGTH=50 质量校验。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KEEP_RECENT_ROUNDS,
  DEFAULT_KEEP_RECENT_TOKENS,
  MIN_SUMMARY_LENGTH,
  SUMMARY_HISTORY_PLACEHOLDER,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_USER_PROMPT_TEMPLATE,
  blockToText,
  buildSummaryInput,
  estimateTextTokens,
  groupRounds,
  isRoundStart,
  messageToText,
  messagesToTranscript,
  renderSummaryPrompt,
  resolveKeepRecentTokenBudget,
  validateSummaryText,
  type SummaryContentBlockLike,
  type SummaryMessageLike,
} from '../../src/summary/policy.ts'

// ==================== 结构镜像 builder ====================

function textBlock(text: string): SummaryContentBlockLike {
  return { type: 'text', text }
}

function reasoning(text: string): SummaryContentBlockLike {
  return { type: 'reasoning', text }
}

function image(): SummaryContentBlockLike {
  return { type: 'image' }
}

function toolCall(name: string, args: string): SummaryContentBlockLike {
  return { type: 'tool-call', name, arguments: args }
}

function toolResult(blocks: SummaryContentBlockLike[]): SummaryContentBlockLike {
  return { type: 'tool-result', content: blocks }
}

function userMessage(text: string): SummaryMessageLike {
  return { role: 'user', source: { kind: 'user' }, content: [textBlock(text)] }
}

function injectedUser(text: string): SummaryMessageLike {
  return { role: 'user', source: { kind: 'inject' }, content: [textBlock(text)] }
}

function assistantMessage(text: string): SummaryMessageLike {
  return { role: 'assistant', source: { kind: 'model' }, content: [textBlock(text)] }
}

function toolMessage(blocks: SummaryContentBlockLike[]): SummaryMessageLike {
  return { role: 'user', source: { kind: 'tool' }, content: blocks }
}

function systemMessage(text: string): SummaryMessageLike {
  return { role: 'system', source: { kind: 'plugin' }, content: [textBlock(text)] }
}

// ==================== token 估算 ====================

describe('estimateTextTokens', () => {
  it('字符数 / 4 向上取整', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens('abcd')).toBe(1)
    expect(estimateTextTokens('abcde')).toBe(2)
    expect(estimateTextTokens('a'.repeat(100))).toBe(25)
  })
})

// ==================== 块/消息 → 文本 ====================

describe('blockToText', () => {
  it('text 块取原文', () => {
    expect(blockToText(textBlock('hello'))).toBe('hello')
  })

  it('reasoning 块跳过（思考内容不进总结输入）', () => {
    expect(blockToText(reasoning('thinking...'))).toBe('')
  })

  it('image 块转占位符', () => {
    expect(blockToText(image())).toBe('[image]')
  })

  it('tool-call 块转 `tool <name>(<args>)`', () => {
    expect(blockToText(toolCall('apply_diff', '{"path":"a.ts"}')))
      .toBe('tool apply_diff({"path":"a.ts"})')
    expect(blockToText({ type: 'tool-call' })).toBe('tool unknown()')
  })

  it('tool-result 块递归拼接嵌套文本（; 分隔）', () => {
    expect(blockToText(toolResult([textBlock('ok'), textBlock('done')]))).toBe('ok; done')
    expect(blockToText(toolResult([reasoning('skip')]))).toBe('')
  })

  it('未知块型跳过', () => {
    expect(blockToText({ type: 'unknown-thing' })).toBe('')
  })
})

describe('messageToText / messagesToTranscript', () => {
  it('messageToText 拼接消息内全部文本块', () => {
    expect(messageToText({ role: 'user', content: [textBlock('a'), textBlock('b')] })).toBe('a\nb')
  })

  it('messagesToTranscript 按角色加前缀、跳过空消息', () => {
    const transcript = messagesToTranscript([
      systemMessage('env'),
      userMessage('fix the build'),
      assistantMessage('on it'),
      toolMessage([toolResult([textBlock('ok')])]),
    ])
    expect(transcript).toBe(
      'system: env\n\nuser: fix the build\n\nassistant: on it\n\nuser: ok'
    )
  })

  it('messagesToTranscript 空输入/全空消息 → 空串', () => {
    expect(messagesToTranscript([])).toBe('')
    expect(
      messagesToTranscript([{ role: 'assistant', content: [reasoning('x')] }])
    ).toBe('')
  })
})

// ==================== 轮次分组 ====================

describe('isRoundStart / groupRounds', () => {
  it('isRoundStart：role user 且 source.kind === user', () => {
    expect(isRoundStart(userMessage('q'))).toBe(true)
    expect(isRoundStart(injectedUser('q'))).toBe(false)
    expect(isRoundStart(assistantMessage('a'))).toBe(false)
    expect(isRoundStart(toolMessage([textBlock('t')]))).toBe(false)
  })

  it('按真实用户消息分组，首轮前缀并入第一轮', () => {
    const rounds = groupRounds([
      systemMessage('env'),
      userMessage('q1'),
      assistantMessage('a1'),
      userMessage('q2'),
      assistantMessage('a2'),
    ])
    expect(rounds).toHaveLength(2)
    expect(rounds[0]!.messages).toHaveLength(3)
    expect(rounds[1]!.messages).toHaveLength(2)
  })

  it('无真实用户消息时整段作为一轮；空转录 → 空轮列表', () => {
    expect(groupRounds([assistantMessage('a'), toolMessage([textBlock('t')])])).toHaveLength(1)
    expect(
      groupRounds([{ role: 'assistant', content: [reasoning('x')] }])
    ).toHaveLength(0)
  })

  it('轮 token = 转录文本估算', () => {
    const rounds = groupRounds([userMessage('a'.repeat(8)), assistantMessage('b'.repeat(4))])
    expect(rounds[0]!.tokens).toBe(estimateTextTokens('user: aaaaaaaa\n\nassistant: bbbb'))
  })
})

// ==================== 保留预算解析 ====================

describe('resolveKeepRecentTokenBudget', () => {
  it('数字 → 绝对 token 数（向下取整）', () => {
    expect(resolveKeepRecentTokenBudget(800, 1000)).toBe(800)
    expect(resolveKeepRecentTokenBudget(800.9, 1000)).toBe(800)
    expect(resolveKeepRecentTokenBudget('800', 1000)).toBe(800)
  })

  it("百分比 → 基数的占比（'50%' = 截断一半）", () => {
    expect(resolveKeepRecentTokenBudget('50%', 1000)).toBe(500)
    expect(resolveKeepRecentTokenBudget('25%', 1000)).toBe(250)
    expect(resolveKeepRecentTokenBudget('100%', 1000)).toBe(1000)
  })

  it("缺失/非法 → 回落内置默认 '50%'", () => {
    expect(resolveKeepRecentTokenBudget(undefined, 1000)).toBe(500)
    expect(resolveKeepRecentTokenBudget('', 1000)).toBe(500)
    expect(resolveKeepRecentTokenBudget('   ', 1000)).toBe(500)
    expect(resolveKeepRecentTokenBudget(0, 1000)).toBe(500)
    expect(resolveKeepRecentTokenBudget(-5, 1000)).toBe(500)
    expect(resolveKeepRecentTokenBudget('120%', 1000)).toBe(500)
    expect(resolveKeepRecentTokenBudget('abc', 1000)).toBe(500)
  })
})

// ==================== 输入裁剪 ====================

describe('buildSummaryInput', () => {
  it('空消息 → 空输入', () => {
    expect(buildSummaryInput({ messages: [] })).toEqual({
      text: '',
      summarizedRounds: 0,
      excludedRounds: 0,
    })
  })

  it('轮数不足（全部落在保留窗口内）→ 空输入', () => {
    const messages = [userMessage('q1'), assistantMessage('a1')]
    expect(buildSummaryInput({ messages, keepRecentRounds: 2 })).toEqual({
      text: '',
      summarizedRounds: 0,
      excludedRounds: 1,
    })
  })

  it('默认保留最近 2 轮，其余纳入总结输入', () => {
    const messages = [
      userMessage('q1'), assistantMessage('a1'),
      userMessage('q2'), assistantMessage('a2'),
      userMessage('q3'), assistantMessage('a3'),
    ]
    const result = buildSummaryInput({ messages })
    expect(result.summarizedRounds).toBe(1)
    expect(result.excludedRounds).toBe(2)
    expect(result.text).toBe('user: q1\n\nassistant: a1')
  })

  it('keepRecentRounds=1 时只保留最后一轮', () => {
    const messages = [
      userMessage('q1'), assistantMessage('a1'),
      userMessage('q2'), assistantMessage('a2'),
    ]
    const result = buildSummaryInput({ messages, keepRecentRounds: 1 })
    expect(result.summarizedRounds).toBe(1)
    expect(result.excludedRounds).toBe(1)
    expect(result.text).toBe('user: q1\n\nassistant: a1')
  })

  it('keepRecentRounds 非法（0/负/NaN）→ 至少按 1 处理', () => {
    const messages = [userMessage('q1'), assistantMessage('a1'), userMessage('q2'), assistantMessage('a2')]
    for (const raw of [0, -1, Number.NaN]) {
      const result = buildSummaryInput({ messages, keepRecentRounds: raw })
      expect(result.summarizedRounds).toBe(1)
      expect(result.excludedRounds).toBe(1)
    }
  })

  it('超出预算从最旧轮开始裁剪（保留旧区中较新的部分）', () => {
    const messages = [
      userMessage('old-1-' + 'a'.repeat(36)), assistantMessage('old-1-b' + 'b'.repeat(33)),
      userMessage('old-2-' + 'c'.repeat(36)), assistantMessage('old-2-d' + 'd'.repeat(33)),
      userMessage('old-3-' + 'e'.repeat(36)), assistantMessage('old-3-f' + 'f'.repeat(33)),
      userMessage('fresh'), assistantMessage('recent'),
    ]
    const result = buildSummaryInput({ messages, keepRecentRounds: 1, keepRecentTokens: '25%' })
    expect(result.summarizedRounds).toBe(1)
    expect(result.excludedRounds).toBe(3)
    expect(result.text).toContain('old-3')
    expect(result.text).not.toContain('old-1')
    expect(result.text).not.toContain('old-2')
  })

  it('旧区最新一轮无条件保留（单轮即超预算也要有可总结内容）', () => {
    const messages = [
      userMessage('q1'), assistantMessage('a1'),
      userMessage('q2'), assistantMessage('a2'),
    ]
    const result = buildSummaryInput({ messages, keepRecentRounds: 1, keepRecentTokens: 1 })
    expect(result.summarizedRounds).toBe(1)
    expect(result.text).toBe('user: q1\n\nassistant: a1')
  })

  it('keepRecentTokens 为数字时按绝对 token 预算收缩', () => {
    const messages = [
      userMessage('q1'), assistantMessage('a1'),
      userMessage('q2'), assistantMessage('a2'),
      userMessage('q3'), assistantMessage('a3'),
    ]
    const result = buildSummaryInput({ messages, keepRecentRounds: 1, keepRecentTokens: 6 })
    expect(result.summarizedRounds).toBe(1)
    expect(result.text).toBe('user: q2\n\nassistant: a2')
  })

  it('默认常量与配置默认一致', () => {
    expect(DEFAULT_KEEP_RECENT_ROUNDS).toBe(2)
    expect(DEFAULT_KEEP_RECENT_TOKENS).toBe('50%')
  })
})

// ==================== prompt 组装 ====================

describe('renderSummaryPrompt / 内置模板', () => {
  it('内置模板含 {history} 占位并替换', () => {
    expect(SUMMARY_USER_PROMPT_TEMPLATE).toContain(SUMMARY_HISTORY_PLACEHOLDER)
    const rendered = renderSummaryPrompt(SUMMARY_USER_PROMPT_TEMPLATE, 'user: q')
    expect(rendered).toContain('user: q')
    expect(rendered).not.toContain(SUMMARY_HISTORY_PLACEHOLDER)
  })

  it('模板不含占位符时历史追加在末尾', () => {
    expect(renderSummaryPrompt('summarize now', 'history-text')).toBe(
      'summarize now\n\nhistory-text'
    )
  })

  it('内置 system prompt 为 6 段结构', () => {
    for (const section of [
      'User Goal',
      'Completed Steps',
      'Current Progress',
      'Next Steps',
      'Important Constraints',
      'Open Questions / Risks',
    ]) {
      expect(SUMMARY_SYSTEM_PROMPT).toContain(section)
    }
  })
})

// ==================== 质量校验 ====================

describe('validateSummaryText', () => {
  it('空文本 → empty', () => {
    expect(validateSummaryText('')).toEqual({ ok: false, reason: 'empty', length: 0 })
    expect(validateSummaryText('   \n ')).toEqual({ ok: false, reason: 'empty', length: 0 })
  })

  it('长度低于 50 → too-short', () => {
    const result = validateSummaryText('short summary')
    expect(result).toMatchObject({ ok: false, reason: 'too-short' })
    if (!result.ok) expect(result.length).toBe('short summary'.length)
  })

  it('长度达到 50 → ok', () => {
    expect(validateSummaryText('a'.repeat(MIN_SUMMARY_LENGTH))).toEqual({ ok: true })
    expect(MIN_SUMMARY_LENGTH).toBe(50)
  })
})
