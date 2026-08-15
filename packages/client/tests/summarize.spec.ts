/**
 * Manual conversation summary — node-environment tests.
 *
 * Covers the pure decision surface (envelope flattening + click-flow driver
 * with a mocked remote seat) and the locale alignment. React is intentionally
 * not rendered (node env, no react-dom): the component is a thin shell over
 * the logic tested here.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  isEmptyInputResult,
  runSummarize,
  unpackSummarizeResult,
  type SummarizeRemoteLike,
  type SummarizeRunState,
} from '../src/client/summarize/logic.ts'
import {
  GRAYCODE_SUMMARIZE_NS,
  graycodeSummarizeDictionaries,
  graycodeSummarizeJaPlaceholder,
} from '../src/client/summarize/locales.ts'

// ==================== 信封扁平化 ====================

describe('unpackSummarizeResult', () => {
  it('成功：嵌套信封解出文本', () => {
    const result = unpackSummarizeResult({
      ok: true,
      value: { ok: true, value: { ok: true, text: 'summary text' } },
    })
    expect(result).toEqual({ ok: true, text: 'summary text' })
  })

  it('业务失败：grayRemote 失败信封（details.code 透出域码）', () => {
    const result = unpackSummarizeResult({
      ok: true,
      value: {
        ok: false,
        error: { code: 'GRAY_INVALID_INPUT', message: 'nothing to summarize', details: { code: 'EMPTY_INPUT' } },
      },
    })
    expect(result).toMatchObject({ ok: false, code: 'GRAY_INVALID_INPUT', domainCode: 'EMPTY_INPUT' })
  })

  it('transport 失败：RPC 信封 ok=false', () => {
    const result = unpackSummarizeResult({
      ok: false,
      error: { code: 'endpoint-not-found', message: 'no such endpoint' },
    })
    expect(result).toMatchObject({ ok: false, code: 'endpoint-not-found' })
  })

  it('畸形/空文本防御：绝不把空文本当成功', () => {
    expect(unpackSummarizeResult({ ok: true, value: undefined })).toMatchObject({ ok: false, code: 'malformed' })
    expect(unpackSummarizeResult({ ok: true, value: { ok: true, text: '' } })).toMatchObject({ ok: false, code: 'empty' })
    expect(unpackSummarizeResult({ ok: true, value: { ok: true, text: '   ' } })).toMatchObject({ ok: false, code: 'empty' })
    expect(unpackSummarizeResult({ ok: true, value: { ok: true } })).toMatchObject({ ok: false, code: 'empty' })
  })
})

// ==================== 点击流程驱动 ====================

describe('runSummarize', () => {
  const translate = (key: string): string => (key === 'failed' ? 'Summarize failed' : key)
  const collect = (): { states: SummarizeRunState[]; push: (state: SummarizeRunState) => void } => {
    const states: SummarizeRunState[] = []
    return {
      states,
      push: (state: SummarizeRunState) => { states.push(state) },
    }
  }

  it('成功：working → success(text)，remote 收到 summary/generate', async () => {
    const remote = vi.fn(async () => ({
      ok: true,
      value: { ok: true, value: { ok: true, text: 'the summary' } },
    })) as unknown as SummarizeRemoteLike
    const holder = collect()
    const terminal = await runSummarize(remote, 's1', holder.push, translate)

    expect(remote).toHaveBeenCalledWith('summary', 'generate', { sessionId: 's1' })
    expect(holder.states).toEqual([
      { phase: 'working' },
      { phase: 'success', text: 'the summary' },
    ])
    expect(terminal).toEqual({ phase: 'success', text: 'the summary' })
  })

  it('业务失败：failed 带 t(failed)+message，并 console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const remote = vi.fn(async () => ({
        ok: true,
        value: { ok: false, error: { code: 'GRAY_NOT_FOUND', message: 'session not found' } },
      })) as unknown as SummarizeRemoteLike
      const holder = collect()
      const terminal = await runSummarize(remote, 's1', holder.push, translate)
      expect(holder.states[1]).toEqual({ phase: 'failed', failure: 'Summarize failed: session not found' })
      expect(terminal.phase).toBe('failed')
      expect(warn).toHaveBeenCalledWith('[graycode.summarize] GRAY_NOT_FOUND: session not found')
    } finally {
      warn.mockRestore()
    }
  })

  it('EMPTY_INPUT 域码 → 本地化「无内容」文案（非通用 failed 文案）', async () => {
    const remote = vi.fn(async () => ({
      ok: true,
      value: {
        ok: false,
        error: { code: 'GRAY_INVALID_INPUT', message: 'nothing to summarize', details: { code: 'EMPTY_INPUT' } },
      },
    })) as unknown as SummarizeRemoteLike
    const holder = collect()
    const terminal = await runSummarize(remote, 's1', holder.push, translate)
    expect(terminal).toEqual({ phase: 'failed', failure: 'empty' })
  })

  it('transport 异常：failed 携带异常信息，不静默', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const remote = vi.fn(async () => { throw new Error('socket closed') }) as unknown as SummarizeRemoteLike
      const holder = collect()
      const terminal = await runSummarize(remote, 's1', holder.push, translate)
      expect(terminal.phase).toBe('failed')
      expect(terminal.failure).toBe('Summarize failed: socket closed')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('isEmptyInputResult 只认 EMPTY_INPUT', () => {
    expect(isEmptyInputResult('EMPTY_INPUT')).toBe(true)
    expect(isEmptyInputResult('GRAY_INVALID_INPUT')).toBe(false)
    expect(isEmptyInputResult(undefined)).toBe(false)
  })
})

// ==================== locale 对齐 ====================

describe('graycode.summarize locale dictionaries', () => {
  it('declares its own namespace', () => {
    expect(GRAYCODE_SUMMARIZE_NS).toBe('graycode.summarize')
  })

  it('keeps zh/en dictionaries balanced (identical key sets)', () => {
    const en = Object.keys(graycodeSummarizeDictionaries.en).sort()
    const zh = Object.keys(graycodeSummarizeDictionaries.zh).sort()
    expect(zh).toEqual(en)
  })

  it('keeps the ja placeholder on the same key set', () => {
    expect(Object.keys(graycodeSummarizeJaPlaceholder).sort()).toEqual(
      Object.keys(graycodeSummarizeDictionaries.en).sort(),
    )
  })

  it('fills every shipped locale with non-empty text', () => {
    for (const dict of Object.values(graycodeSummarizeDictionaries)) {
      for (const text of Object.values(dict)) {
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })
})
