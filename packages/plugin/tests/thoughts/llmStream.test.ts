/**
 * thoughts llm/stream adapter 集成测试（A1 请求构造层接线）。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  markAgentLoopRequest,
  type GenerateOptions,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { createLlmStreamThoughtsAdapter, type ThoughtsAdapterState } from '../../src/thoughts/adapters/llmStream.ts'
import type { PresetInjection } from '../../src/thoughts/domain/rewrite.ts'

function loopOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return markAgentLoopRequest({
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [
      { id: 'm1' as never, role: 'user', content: [], source: { kind: 'user' } },
    ],
    ...overrides,
  })
}

/** 用户主动输入（agent-loop inbox claim 后 append 的真实形状）。 */
function userInput(text = 'user input'): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** 插件快照（运行时上下文 / 记忆快照：role=user 但 source.kind==='plugin'）。 */
function pluginSnapshot(text: string, plugin = 'graycode-memory'): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin },
  })
}

/** 工具结果（迭代 step 末尾的真实形状）。 */
function toolResult(text = 'tool result'): Message {
  return createToolResultMessage({
    callId: CallId('call-1'),
    content: [{ type: 'text', text }],
    isError: false,
  })
}

/** 模型 assistant 消息（迭代 step 中工具调用后的下一条消息）。 */
function assistantText(text = 'assistant text'): Message {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'deepseek', model: 'deepseek-chat' },
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
  listeners: Array<(options: GenerateOptions, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>>
  on: ReturnType<typeof vi.fn>
  llm: { stream: ReturnType<typeof vi.fn> }
  logger: { warn: ReturnType<typeof vi.fn> }
}

function makeCtx(): FakeCtx {
  const listeners: FakeCtx['listeners'] = []
  const ctx = {
    listeners,
    on: vi.fn((_event: string, handler: (options: GenerateOptions, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) => {
      listeners.push(handler)
      return () => {}
    }),
    llm: { stream: vi.fn(() => fakeStream()) },
    logger: { warn: vi.fn() },
  }
  return ctx
}

const injections: PresetInjection[] = [{ role: 'user', text: 'preset-entry', entryOrder: 1 }]

function stateOf(overrides: Partial<ThoughtsAdapterState> = {}): ThoughtsAdapterState {
  return {
    enabled: true,
    sendHistoryThoughts: true,
    injections,
    blockOrders: [{ role: 'user', order: 1 }],
    ...overrides,
  }
}

describe('createLlmStreamThoughtsAdapter', () => {
  it('enabled=false → 透传原请求，不调用 llm.stream', async () => {
    const ctx = makeCtx()
    const adapter = createLlmStreamThoughtsAdapter(ctx as never, () => stateOf({ enabled: false }))
    const options = loopOptions()
    let nextCalled = false
    const out = ctx.listeners[0]!(options, () => {
      nextCalled = true
      return fakeStream()
    })
    await out[Symbol.asyncIterator]()!.next()
    expect(nextCalled).toBe(true)
    expect(ctx.llm.stream).not.toHaveBeenCalled()
    adapter.dispose()
  })

  it('非 loop 请求（未标记）→ 透传', async () => {
    const ctx = makeCtx()
    createLlmStreamThoughtsAdapter(ctx as never, () => stateOf())
    const options: GenerateOptions = { provider: 'p', model: 'm', messages: [] }
    let nextCalled = false
    await ctx.listeners[0]!(options, () => {
      nextCalled = true
      return fakeStream()
    })[Symbol.asyncIterator]()!.next()
    expect(nextCalled).toBe(true)
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })

  it('loop 请求 + injections → 构造新 options 重入 ctx.llm.stream（消息含注入）', async () => {
    const ctx = makeCtx()
    // chat_history marker 在 user 块之后 → 注入消息落 before-history（messages 头部）
    createLlmStreamThoughtsAdapter(ctx as never, () =>
      stateOf({ blockOrders: [{ role: 'user', order: 1 }, { role: 'chat_history', order: 2 }] }),
    )
    const options = loopOptions()
    await ctx.listeners[0]!(options, () => fakeStream())[Symbol.asyncIterator]()!.next()

    expect(ctx.llm.stream).toHaveBeenCalledTimes(1)
    const rewritten = ctx.llm.stream.mock.calls[0]![0] as GenerateOptions
    expect(rewritten).not.toBe(options)
    expect(rewritten.messages).toHaveLength(options.messages.length + 1)
    expect(rewritten.messages[0]!.content).toEqual([{ type: 'text', text: 'preset-entry' }])
    // 原 messages 未被 mutate
    expect(options.messages).toHaveLength(1)
  })

  it('重入短路：rewritten 请求再次进入 listener 不再 stream（每个请求恰改写一次）', async () => {
    const ctx = makeCtx()
    createLlmStreamThoughtsAdapter(ctx as never, () => stateOf())
    const options = loopOptions()
    const handler = ctx.listeners[0]!
    await handler(options, () => fakeStream())[Symbol.asyncIterator]()!.next()

    // 第二次：用第一次改写产出的 options（模拟 waterfall 重入）
    const rewritten = ctx.llm.stream.mock.calls[0]![0] as GenerateOptions
    let nextCalled = false
    await handler(rewritten, () => {
      nextCalled = true
      return fakeStream()
    })[Symbol.asyncIterator]()!.next()

    expect(ctx.llm.stream).toHaveBeenCalledTimes(1) // 未再重入
    expect(nextCalled).toBe(true) // 短路走 next
  })

  it('injections 为空 → 透传', async () => {
    const ctx = makeCtx()
    createLlmStreamThoughtsAdapter(ctx as never, () => stateOf({ injections: [] }))
    const options = loopOptions()
    let nextCalled = false
    await ctx.listeners[0]!(options, () => {
      nextCalled = true
      return fakeStream()
    })[Symbol.asyncIterator]()!.next()
    expect(nextCalled).toBe(true)
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })

  it('改写失败 → fail-closed 透传原请求并 warn', async () => {
    const ctx = makeCtx()
    createLlmStreamThoughtsAdapter(
      ctx as never,
      () =>
        stateOf({
          injections: [
            // 构造一个让 injectionMessage 抛错的输入不可行（纯构造不抛）；
            // 改由 getState 抛错验证 fail-closed 路径
          ],
        }),
    )
    // 直接验证 getState 抛错时透传：覆盖 enabled 分支内异常
    const failing = makeCtx()
    createLlmStreamThoughtsAdapter(failing as never, () => {
      throw new Error('state broken')
    })
    const options = loopOptions()
    let nextCalled = false
    await failing.listeners[0]!(options, () => {
      nextCalled = true
      return fakeStream()
    })[Symbol.asyncIterator]()!.next()
    expect(nextCalled).toBe(true)
    expect(failing.logger.warn).toHaveBeenCalled()
    expect(failing.llm.stream).not.toHaveBeenCalled()
    void ctx
  })

  it('dispose 后不再拦截', async () => {
    const ctx = makeCtx()
    const adapter = createLlmStreamThoughtsAdapter(ctx as never, () => stateOf())
    adapter.dispose()
    const options = loopOptions()
    let nextCalled = false
    await ctx.listeners[0]!(options, () => {
      nextCalled = true
      return fakeStream()
    })[Symbol.asyncIterator]()!.next()
    expect(nextCalled).toBe(true)
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })

  // ─── B1：只在本回合第一个 step 注入 ───────────────────────────────

  it('B1：末尾为工具结果（user/tool）→ 不注入（工具迭代 step）', async () => {
    const ctx = makeCtx()
    createLlmStreamThoughtsAdapter(ctx as never, () => stateOf())
    const options = loopOptions({ messages: [userInput(), toolResult()] })
    let nextCalled = false
    await ctx.listeners[0]!(options, () => {
      nextCalled = true
      return fakeStream()
    })[Symbol.asyncIterator]()!.next()
    expect(nextCalled).toBe(true)
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })

  it('B1：末尾为 assistant 消息（model）→ 不注入（工具迭代 step）', async () => {
    const ctx = makeCtx()
    createLlmStreamThoughtsAdapter(ctx as never, () => stateOf())
    const options = loopOptions({ messages: [userInput(), assistantText()] })
    let nextCalled = false
    await ctx.listeners[0]!(options, () => {
      nextCalled = true
      return fakeStream()
    })[Symbol.asyncIterator]()!.next()
    expect(nextCalled).toBe(true)
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })

  it('B1：末尾为 user 输入（user/user）→ 注入（回合首步）', async () => {
    const ctx = makeCtx()
    createLlmStreamThoughtsAdapter(ctx as never, () => stateOf())
    const options = loopOptions({ messages: [userInput('hello')] })
    await ctx.listeners[0]!(options, () => fakeStream())[Symbol.asyncIterator]()!.next()
    expect(ctx.llm.stream).toHaveBeenCalledTimes(1)
    const rewritten = ctx.llm.stream.mock.calls[0]![0] as GenerateOptions
    expect(rewritten.messages[0]!.content).toEqual([{ type: 'text', text: 'preset-entry' }])
  })

  it('B1：用户输入后追加插件快照（运行时上下文/记忆）→ 仍注入（真实首步形状）', async () => {
    const ctx = makeCtx()
    createLlmStreamThoughtsAdapter(ctx as never, () => stateOf())
    // agent-loop preStep 在 claim 之后追加 runtime-context 快照（source.kind==='plugin'）
    const options = loopOptions({ messages: [userInput('hello'), pluginSnapshot('Current runtime context. …')] })
    await ctx.listeners[0]!(options, () => fakeStream())[Symbol.asyncIterator]()!.next()
    expect(ctx.llm.stream).toHaveBeenCalledTimes(1)
    const rewritten = ctx.llm.stream.mock.calls[0]![0] as GenerateOptions
    expect(rewritten.messages[0]!.content).toEqual([{ type: 'text', text: 'preset-entry' }])
  })

  it('B1：工具结果后追加记忆快照（plugin）→ 不注入（迭代循环中记忆变更）', async () => {
    const ctx = makeCtx()
    createLlmStreamThoughtsAdapter(ctx as never, () => stateOf())
    // 迭代 step：memory 内容变更时 preStep 会在工具结果之后追加记忆快照，
    // 末尾不再是 tool-result 而是 plugin——仅看末条消息会误判为首步。
    const options = loopOptions({ messages: [userInput('hello'), toolResult(), pluginSnapshot('--- Workspace memory ---')] })
    let nextCalled = false
    await ctx.listeners[0]!(options, () => {
      nextCalled = true
      return fakeStream()
    })[Symbol.asyncIterator]()!.next()
    expect(nextCalled).toBe(true)
    expect(ctx.llm.stream).not.toHaveBeenCalled()
  })
})
