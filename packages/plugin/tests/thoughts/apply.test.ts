/**
 * thoughts apply 接线测试：默认状态源 = prompt 域 `graycode.promptModes`
 * 服务的实时 mode 投影（A1 requestLayer 联动核心）。
 */

import { describe, expect, it, vi } from 'vitest'
import { markAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply, type PromptModesLike } from '../../src/thoughts/index.ts'
import type { PromptEntry } from '../../src/prompt/domain/promptTypes.ts'

function entry(overrides: Partial<PromptEntry> & { id: string }): PromptEntry {
  return {
    role: 'user',
    order: 0,
    enabled: true,
    content: '',
    ...overrides,
  }
}

function modeWithEntries(entries: PromptEntry[]): PromptModesLike {
  return {
    currentModeSnapshot: () => ({ id: 'design', promptEntries: entries }),
  }
}

function loopOptions(): GenerateOptions {
  return markAgentLoopRequest({
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [
      { id: 'm1' as never, role: 'user', content: [], source: { kind: 'user' } },
    ],
  })
}

function fakeStream(): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

interface FakeCtx {
  get: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  llm: { stream: ReturnType<typeof vi.fn> }
  logger: { warn: ReturnType<typeof vi.fn> }
  listeners: Array<(options: GenerateOptions, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>>
}

function makeCtx(service: PromptModesLike | undefined): FakeCtx {
  const listeners: FakeCtx['listeners'] = []
  const ctx: FakeCtx = {
    get: vi.fn(() => service),
    on: vi.fn((_event: string, handler: (options: GenerateOptions, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) => {
      listeners.push(handler)
      return () => {}
    }),
    llm: { stream: vi.fn(() => fakeStream()) },
    logger: { warn: vi.fn() },
    listeners,
  }
  return ctx
}

function fire(ctx: FakeCtx, options: GenerateOptions): AsyncIterable<unknown> {
  return ctx.listeners[0]!(options, () => fakeStream())
}

describe('thoughts apply 接线（promptModes 服务投影）', () => {
  it('prompt 服务缺失 → 即使 enabled=true 也透传（降级 no-op）', async () => {
    const ctx = makeCtx(undefined)
    const dispose = apply(ctx as never, { enabled: true, sendHistoryThoughts: true })
    await fire(ctx, loopOptions())[Symbol.asyncIterator]()!.next()
    expect(ctx.llm.stream).not.toHaveBeenCalled()
    dispose()
  })

  it('无当前 mode → 空注入透传', async () => {
    const ctx = makeCtx({ currentModeSnapshot: () => undefined })
    apply(ctx as never, { enabled: true, sendHistoryThoughts: true })
    await fire(ctx, loopOptions())[Symbol.asyncIterator]()!.next()
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })

  it('有服务 + enabled：mode 预设投影为注入消息（user 前插、assistant 带 reasoning 插在当前轮 user 之前）', async () => {
    const ctx = makeCtx(
      modeWithEntries([
        entry({ id: 'u1', role: 'user', order: 1, content: 'U1' }),
        entry({ id: 'h1', role: 'chat_history', order: 2 }),
        entry({ id: 'a1', role: 'assistant', order: 3, content: 'A1', fakeThought: 'think' }),
      ]),
    )
    apply(ctx as never, { enabled: true, sendHistoryThoughts: true })
    const options = loopOptions()
    await fire(ctx, options)[Symbol.asyncIterator]()!.next()

    expect(ctx.llm.stream).toHaveBeenCalledTimes(1)
    const rewritten = ctx.llm.stream.mock.calls[0]![0] as GenerateOptions
    expect(rewritten).not.toBe(options)
    // before-history：user 注入在最前
    expect(rewritten.messages[0]!.content).toEqual([{ type: 'text', text: 'U1' }])
    // after-history：assistant 注入（reasoning 前置）插在当前轮 user 消息之前
    expect(rewritten.messages[1]!.content).toEqual([
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: 'A1' },
    ])
    // 原历史（当前轮 user 消息）保持在最后，未被改动
    expect(rewritten.messages[2]).toEqual(options.messages[0])
  })

  it('sendHistoryThoughts=false → assistant 注入不携带 reasoning 块', async () => {
    const ctx = makeCtx(
      modeWithEntries([
        entry({ id: 'a1', role: 'assistant', order: 1, content: 'A1', fakeThought: 'think' }),
      ]),
    )
    apply(ctx as never, { enabled: true, sendHistoryThoughts: false })
    await fire(ctx, loopOptions())[Symbol.asyncIterator]()!.next()

    const rewritten = ctx.llm.stream.mock.calls[0]![0] as GenerateOptions
    // 无 chat_history marker → after-history：插在当前轮 user 消息之前（位置 0）
    expect(rewritten.messages[0]!.content).toEqual([{ type: 'text', text: 'A1' }])
    expect(rewritten.messages[0]!.content).not.toEqual([
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: 'A1' },
    ])
  })

  it('enabled=false → 透传原请求', async () => {
    const ctx = makeCtx(modeWithEntries([entry({ id: 'u1', role: 'user', order: 1, content: 'U1' })]))
    apply(ctx as never, { enabled: false, sendHistoryThoughts: true })
    let nextCalled = false
    await ctx.listeners[0]!(loopOptions(), () => {
      nextCalled = true
      return fakeStream()
    })[Symbol.asyncIterator]()!.next()
    expect(nextCalled).toBe(true)
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })

  it('getState 注入覆盖默认投影（测试替身）', async () => {
    const ctx = makeCtx(undefined)
    const dispose = apply(
      ctx as never,
      { enabled: true, sendHistoryThoughts: false },
      () => ({
        injections: [{ role: 'user', text: 'fixed', entryOrder: 1 }],
        blockOrders: [{ role: 'user', order: 1 }, { role: 'chat_history', order: 2 }],
      }),
    )
    await fire(ctx, loopOptions())[Symbol.asyncIterator]()!.next()
    const rewritten = ctx.llm.stream.mock.calls[0]![0] as GenerateOptions
    expect(rewritten.messages[0]!.content).toEqual([{ type: 'text', text: 'fixed' }])
    dispose()
  })
})
