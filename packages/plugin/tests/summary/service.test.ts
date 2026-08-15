/**
 * summary 域服务层纯逻辑测试：模型路由解析（requestContext 优先、provenance
 * 回退）与流式文本收集（text-delta 拼接、finish error/aborted 上抛、信号中止）。
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  collectSummaryText,
  resolveModelRoute,
  type SummarySessionLike,
} from '../../src/summary/service.ts'

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
