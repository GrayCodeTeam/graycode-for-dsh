/**
 * summary 域服务层纯逻辑测试：模型路由解析（requestContext 优先、provenance
 * 回退）与流式文本收集（text-delta 拼接、finish error/aborted 上抛、信号中止）。
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  collectSummaryText,
  resolveModelRoute,
  SummaryService,
  type SummaryGenerateResult,
  type SummarySessionLike,
} from '../../src/summary/service.ts'
import { createSummaryRemoteHandlers } from '../../src/summary/index.ts'
import { GrayRemoteError } from '../../src/remote/errors.ts'
import { GRAY_REMOTE_ERROR_CODES } from '../../src/remote/types.ts'

// ==================== 模型路由解析 ====================

function sessionWith(messages: SummarySessionLike['messages'], context?: { provider: string; model: string }): SummarySessionLike {
  return { messages, requestContext: () => context }
}

describe('resolveModelRoute', () => {
  const assistant = (provider: string, model: string) =>
    createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider, model } })
  const user = () => createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })

  it('优先 requestContext', () => {
    const session = sessionWith(
      [assistant('deepseek-official', 'deepseek-chat')],
      { provider: 'pi-ai', model: 'pi-ai-route' },
    )
    expect(resolveModelRoute(session)).toEqual({ provider: 'pi-ai', model: 'pi-ai-route' })
  })

  it('requestContext 缺失时回退最后一条 model 消息 provenance', () => {
    const session = sessionWith([user(), assistant('deepseek-official', 'deepseek-chat')])
    expect(resolveModelRoute(session)).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    })
  })

  it('无上下文且无 model 消息 → undefined', () => {
    expect(resolveModelRoute(sessionWith([user()]))).toBeUndefined()
    expect(resolveModelRoute(sessionWith([]))).toBeUndefined()
  })
})

// ==================== 流式文本收集 ====================

function delta(text: string): StreamChunk {
  return { type: 'text-delta', index: 0, text }
}

function finish(kind: 'stop' | 'error' | 'aborted'): StreamChunk {
  return kind === 'stop'
    ? { type: 'finish', reason: { kind } }
    : {
        type: 'finish',
        reason: {
          kind,
          failure: { message: `${kind} boom`, code: 'PROVIDER_BOOM' },
        },
      }
}

async function* chunksOf(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) yield chunk
}

describe('collectSummaryText', () => {
  it('text-delta 拼接为完整文本', async () => {
    const text = await collectSummaryText(chunksOf([delta('sum'), delta('mary'), finish('stop')]))
    expect(text).toBe('summary')
  })

  it('finish error/aborted 上抛（携带稳定码）', async () => {
    await expect(collectSummaryText(chunksOf([delta('x'), finish('error')]))).rejects.toMatchObject({
      name: 'LlmCallFailure',
      code: 'PROVIDER_BOOM',
      message: 'error boom',
    })
    await expect(collectSummaryText(chunksOf([delta('x'), finish('aborted')]))).rejects.toMatchObject({
      name: 'LlmCallFailure',
      code: 'PROVIDER_BOOM',
      message: 'aborted boom',
    })
  })

  it('信号已中止时抛取消错误', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      collectSummaryText(chunksOf([delta('x')]), controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
// ==================== generateSummary 全路径（stub ctx.sessions / ctx.llm） ====================

/** 构造 3 轮对话（超出默认 keepRecentRounds=2 保留窗口，保证有可总结输入）。 */
function threeRoundMessages(): Array<ReturnType<typeof userMessage> | ReturnType<typeof assistantMessage>> {
  const messages = [
    userMessage('first question'),
    assistantMessage('first answer'),
    userMessage('second question'),
    assistantMessage('second answer'),
    userMessage('third question'),
    assistantMessage('third answer'),
  ]
  return messages
}

function userMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistantMessage(text: string): ReturnType<typeof createAssistantMessage> {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: { provider: 'p', model: 'm' },
  })
}

/** 最小 Context stub：只有 get()（服务只读 ctx.get('sessions') / ctx.get('llm')）。 */
function stubCtx(services: Record<string, unknown>): Context {
  return { get: (key: string) => services[key] } as unknown as Context
}

/** 会话 stub：deriveMessages + requestContext。 */
function stubSession(
  messages: readonly unknown[],
  requestContext?: { provider: string; model: string },
): unknown {
  return {
    deriveMessages: () => messages,
    requestContext: () => requestContext,
  }
}

/** llm stub：stream 返回构造的 chunk 流。 */
function stubLlm(chunks: readonly StreamChunk[] | (() => AsyncIterable<StreamChunk>)): { stream: () => AsyncIterable<StreamChunk> } {
  return {
    stream: () => (typeof chunks === 'function' ? chunks() : chunksOf(chunks)),
  }
}

/** 服务选项：保留 2 轮、大预算、关闭超时（避免挂起测试受 120s 默认值影响）。 */
const serviceOptions = {
  keepRecentRounds: 2,
  keepRecentTokens: 1_000_000,
  summarizePrompt: '',
}

function makeService(ctx: Context, overrides: Partial<{ llmTimeoutMs: number }> = {}): SummaryService {
  return new SummaryService(ctx, { ...serviceOptions, ...overrides })
}

function sessionsStore(session: unknown): { get: (id: SessionId) => unknown } {
  return { get: (id: SessionId) => (String(id) === 's1' ? session : undefined) }
}

async function expectErrorCode(
  promise: Promise<SummaryGenerateResult>,
  code: string,
): Promise<void> {
  const result = await promise
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error.code).toBe(code)
}

describe('SummaryService.generateSummary（错误分支全路径）', () => {
  it('SESSION_SERVICE_UNAVAILABLE：ctx.sessions 缺失', async () => {
    const service = makeService(stubCtx({}))
    await expectErrorCode(service.generateSummary('s1'), 'SESSION_SERVICE_UNAVAILABLE')
  })

  it('SESSION_NOT_FOUND：会话不存在', async () => {
    const ctx = stubCtx({ sessions: sessionsStore(undefined) })
    const service = makeService(ctx)
    await expectErrorCode(service.generateSummary('s1'), 'SESSION_NOT_FOUND')
  })

  it('NO_MODEL_ROUTE：无 requestContext 且无 model 消息 provenance', async () => {
    const session = stubSession([userMessage('q')])
    const ctx = stubCtx({ sessions: sessionsStore(session) })
    const service = makeService(ctx)
    await expectErrorCode(service.generateSummary('s1'), 'NO_MODEL_ROUTE')
  })

  it('EMPTY_INPUT：全部轮次落在保留窗口内', async () => {
    const session = stubSession([userMessage('q'), assistantMessage('a')], { provider: 'p', model: 'm' })
    const ctx = stubCtx({ sessions: sessionsStore(session), llm: stubLlm([]) })
    const service = makeService(ctx, { llmTimeoutMs: 5_000 })
    await expectErrorCode(service.generateSummary('s1'), 'EMPTY_INPUT')
  })

  it('LLM_SERVICE_UNAVAILABLE：ctx.llm 缺失', async () => {
    const session = stubSession(threeRoundMessages(), { provider: 'p', model: 'm' })
    const ctx = stubCtx({ sessions: sessionsStore(session) })
    const service = makeService(ctx)
    await expectErrorCode(service.generateSummary('s1'), 'LLM_SERVICE_UNAVAILABLE')
  })

  it('LLM_FAILED：finish reason error 上抛（携带稳定码）', async () => {
    const session = stubSession(threeRoundMessages(), { provider: 'p', model: 'm' })
    const ctx = stubCtx({ sessions: sessionsStore(session), llm: stubLlm([finish('error')]) })
    const service = makeService(ctx)
    const result = await service.generateSummary('s1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('LLM_FAILED')
      expect(result.error.message).toBe('PROVIDER_BOOM: error boom')
    }
  })

  it('EMPTY_SUMMARY：模型返回空文本', async () => {
    const session = stubSession(threeRoundMessages(), { provider: 'p', model: 'm' })
    const ctx = stubCtx({ sessions: sessionsStore(session), llm: stubLlm([finish('stop')]) })
    const service = makeService(ctx)
    await expectErrorCode(service.generateSummary('s1'), 'EMPTY_SUMMARY')
  })

  it('LOW_QUALITY_SUMMARY：文本低于最低长度', async () => {
    const session = stubSession(threeRoundMessages(), { provider: 'p', model: 'm' })
    const ctx = stubCtx({ sessions: sessionsStore(session), llm: stubLlm([delta('short'), finish('stop')]) })
    const service = makeService(ctx)
    const result = await service.generateSummary('s1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('LOW_QUALITY_SUMMARY')
      expect(result.error.message).toMatch(/too short/)
    }
  })

  it('ABORTED：调用方信号中止', async () => {
    const session = stubSession(threeRoundMessages(), { provider: 'p', model: 'm' })
    const ctx = stubCtx({ sessions: sessionsStore(session), llm: stubLlm([delta('x')]) })
    const service = makeService(ctx)
    const controller = new AbortController()
    controller.abort()
    await expectErrorCode(service.generateSummary('s1', controller.signal), 'ABORTED')
  })

  it('ABORTED（超时兜底）：LLM 流挂起超过 llmTimeoutMs', async () => {
    const session = stubSession(threeRoundMessages(), { provider: 'p', model: 'm' })
    const hanging = stubLlm(() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {})
      },
    }))
    const ctx = stubCtx({ sessions: sessionsStore(session), llm: hanging })
    const service = makeService(ctx, { llmTimeoutMs: 20 })
    const result = await service.generateSummary('s1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('ABORTED')
      expect(result.error.message).toBe('summarize timed out')
    }
  })

  it('成功路径：ok + text（文本质量校验通过）', async () => {
    const session = stubSession(threeRoundMessages(), { provider: 'p', model: 'm' })
    const ctx = stubCtx({ sessions: sessionsStore(session), llm: stubLlm([delta('A useful summary that is long enough to pass the quality gate. '), finish('stop')]) })
    const service = makeService(ctx)
    const result = await service.generateSummary('s1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text.length).toBeGreaterThanOrEqual(50)
    }
  })
})

// ==================== summary/generate 端点（错误码映射） ====================

describe('createSummaryRemoteHandlers（summary/generate 错误码映射）', () => {
  const invoke = async (
    ctx: Context,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; value: unknown } | { ok: false; code: string; details: Record<string, unknown> }> => {
    const service = makeService(ctx)
    const handler = createSummaryRemoteHandlers(service)['summary/generate']!
    try {
      const value = await handler(args)
      return { ok: true, value }
    } catch (error) {
      expect(error).toBeInstanceOf(GrayRemoteError)
      const remote = error as GrayRemoteError
      return { ok: false, code: remote.code, details: remote.details }
    }
  }

  it('缺 sessionId → GRAY_INVALID_INPUT', async () => {
    const result = await invoke(stubCtx({}), {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })

  it('会话缺失 → GRAY_NOT_FOUND + details.code=SESSION_NOT_FOUND', async () => {
    const ctx = stubCtx({ sessions: sessionsStore(undefined) })
    const result = await invoke(ctx, { sessionId: 's1' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(GRAY_REMOTE_ERROR_CODES.NOT_FOUND)
      expect(result.details.code).toBe('SESSION_NOT_FOUND')
    }
  })

  it('空输入 → GRAY_INVALID_INPUT + details.code=EMPTY_INPUT', async () => {
    const session = stubSession([userMessage('q'), assistantMessage('a')], { provider: 'p', model: 'm' })
    const ctx = stubCtx({ sessions: sessionsStore(session), llm: stubLlm([]) })
    const result = await invoke(ctx, { sessionId: 's1' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
      expect(result.details.code).toBe('EMPTY_INPUT')
    }
  })

  it('模型失败 → GRAY_INTERNAL + details.code=LLM_FAILED', async () => {
    const session = stubSession(threeRoundMessages(), { provider: 'p', model: 'm' })
    const ctx = stubCtx({ sessions: sessionsStore(session), llm: stubLlm([finish('error')]) })
    const result = await invoke(ctx, { sessionId: 's1' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(GRAY_REMOTE_ERROR_CODES.INTERNAL)
      expect(result.details.code).toBe('LLM_FAILED')
    }
  })

  it('取消 → GRAY_CANCELLED + details.code=ABORTED（L-1 映射）', async () => {
    const session = stubSession(threeRoundMessages(), { provider: 'p', model: 'm' })
    const ctx = stubCtx({ sessions: sessionsStore(session), llm: stubLlm([delta('x')]) })
    const service = makeService(ctx)
    const handler = createSummaryRemoteHandlers(service)['summary/generate']!
    const controller = new AbortController()
    controller.abort()
    try {
      await handler({ sessionId: 's1' }, controller.signal)
      expect.unreachable('expected GrayRemoteError to be thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(GrayRemoteError)
      const remote = error as GrayRemoteError
      expect(remote.code).toBe(GRAY_REMOTE_ERROR_CODES.CANCELLED)
      expect(remote.details.code).toBe('ABORTED')
    }
  })

  it('成功 → { ok: true, text }', async () => {
    const session = stubSession(threeRoundMessages(), { provider: 'p', model: 'm' })
    const ctx = stubCtx({ sessions: sessionsStore(session), llm: stubLlm([delta('A useful summary that is long enough to pass the quality gate. '), finish('stop')]) })
    const result = await invoke(ctx, { sessionId: 's1' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toMatchObject({ ok: true })
      expect((result.value as { text: string }).text.length).toBeGreaterThanOrEqual(50)
    }
  })
})
