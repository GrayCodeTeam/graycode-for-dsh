/**
 * GrayCode - summary 域服务（宿主侧）。
 *
 * LLM 通道选型（详见 docs 报告与域注释）：插件侧 `ctx.llm.stream`——
 * `@deepseek-ai/dsh-llm` 的 `LlmRuntime` 暴露流式文本 API
 * `stream(GenerateOptions)`（provider/model/messages/system），
 * provider/model 取自 `session.requestContext()`（最新路由元数据）或
 * 最后一条 assistant 消息的 provenance；`ctx.llm` 为 cordis 服务，经
 * `ctx.get('llm')` 读取，缺失时返回 LLM_SERVICE_UNAVAILABLE 而非抛错。
 *
 * 不选浏览器侧 `connection.api.llm`：那是 `ApiProxy.llm`（LlmApi）——
 * 仅 provider 拓扑发现面（providers/models/discoverModels），无任何文本
 * 生成方法；客户端唯一生成相邻面是 `sessions.prompt`（向会话投递用户消息，
 * 会污染 append-only 会话日志并驱动 agent 循环，语义不符）。
 *
 * 落地简化：DSH 宿主为 append-only 日志，总结不截断历史、不插入消息，
 * 只生成总结文本返回客户端弹层展示。
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRuntime, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  MIN_SUMMARY_LENGTH,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_USER_PROMPT_TEMPLATE,
  buildSummaryInput,
  renderSummaryPrompt,
  validateSummaryText,
} from './policy.ts'

/** 总结 LLM 流式调用兜底超时（毫秒）：流挂起不无限期等待（客户端弹层另有超时，双保险）。 */
export const SUMMARY_LLM_TIMEOUT_MS = 120_000

export type SummaryErrorCode =
  | 'SESSION_SERVICE_UNAVAILABLE'
  | 'SESSION_NOT_FOUND'
  | 'LLM_SERVICE_UNAVAILABLE'
  | 'NO_MODEL_ROUTE'
  | 'EMPTY_INPUT'
  | 'EMPTY_SUMMARY'
  | 'LOW_QUALITY_SUMMARY'
  | 'LLM_FAILED'
  | 'ABORTED'

export interface SummaryError {
  readonly code: SummaryErrorCode
  readonly message: string
}

export type SummaryGenerateResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: SummaryError }

export interface SummaryServiceOptions {
  /** 保留最近轮数（下限保护）。 */
  readonly keepRecentRounds: number
  /** 保留预算（绝对 token 数或百分比）。 */
  readonly keepRecentTokens: number | string
  /** 用户 prompt 模板（空 = 内置模板）。 */
  readonly summarizePrompt: string
  /** LLM 流式收集兜底超时（毫秒；默认 SUMMARY_LLM_TIMEOUT_MS；测试注入小预算）。 */
  readonly llmTimeoutMs?: number
}

/** 一次 LLM 流式调用的失败（携带稳定机器码，映射自 finish reason）。 */
class LlmCallFailure extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'LlmCallFailure'
    this.code = code
  }
}

/** 信号取消（Node 环境无全局 AbortError 构造器，本地实现同形错误）。 */
class SummaryAbortError extends Error {
  constructor(message = 'summarize aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (error instanceof Error && error.name === 'AbortError') return true
  if (error instanceof Error && error.message === 'cancelled') return true
  return false
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 会话消息的历史文本（服务层使用的可测输入切片）。 */
export interface SummarySessionLike {
  readonly messages: readonly Message[]
  readonly requestContext: () => { readonly provider: string; readonly model: string } | undefined
}

/** 解析 provider/model 路由：优先 session.requestContext()，回退最后一条 model 消息 provenance。 */
export function resolveModelRoute(
  session: SummarySessionLike
): { readonly provider: string; readonly model: string } | undefined {
  const context = session.requestContext()
  if (context && typeof context.provider === 'string' && typeof context.model === 'string') {
    return { provider: context.provider, model: context.model }
  }
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const source = session.messages[index]?.source
    if (
      source?.kind === 'model'
      && typeof (source as { provider?: unknown }).provider === 'string'
      && typeof (source as { model?: unknown }).model === 'string'
    ) {
      return {
        provider: (source as { provider: string }).provider,
        model: (source as { model: string }).model,
      }
    }
  }
  return undefined
}

/** 流式收集文本：text-delta 拼接；finish error/aborted 抛 LlmCallFailure；abort 信号中止。 */
export async function collectSummaryText(
  chunks: AsyncIterable<StreamChunk>,
  signal?: AbortSignal
): Promise<string> {
  let text = ''
  for await (const chunk of chunks) {
    if (signal?.aborted) throw new SummaryAbortError()
    if (chunk.type === 'text-delta') {
      text += chunk.text
    } else if (chunk.type === 'finish') {
      const reason = chunk.reason
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        throw new LlmCallFailure(reason.failure.message, reason.failure.code)
      }
    }
  }
  return text
}

/**
 * 带兜底超时的流式收集（L-4）：内部 AbortController 桥接调用方信号，
 * 超时触发时中止流并确定性拒绝为「超时取消」（调用方 isAbortLike 命中 → ABORTED）。
 */
async function collectSummaryTextWithTimeout(
  chunks: AsyncIterable<StreamChunk>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onAbort)
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort()
        reject(new SummaryAbortError('summarize timed out'))
      }, timeoutMs)
      collectSummaryText(chunks, controller.signal).then(
        text => {
          clearTimeout(timer)
          resolve(text)
        },
        error => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 总结服务：读会话派生消息 → 裁剪输入 → 组装 prompt → ctx.llm.stream →
 * 质量校验 → 返回文本。不修改任何会话状态（append-only 落地）。
 */
export class SummaryService {
  constructor(
    private readonly ctx: Context,
    private readonly options: SummaryServiceOptions
  ) {}

  async generateSummary(sessionId: string, signal?: AbortSignal): Promise<SummaryGenerateResult> {
    try {
      const sessions = this.ctx.get('sessions') as
        | { get(id: SessionId): Session | undefined }
        | undefined
      if (sessions === undefined) {
        return {
          ok: false,
          error: {
            code: 'SESSION_SERVICE_UNAVAILABLE',
            message: 'the session service is not available',
          },
        }
      }
      const session = sessions.get(SessionId(sessionId))
      if (session === undefined) {
        return {
          ok: false,
          error: { code: 'SESSION_NOT_FOUND', message: `session not found: ${sessionId}` },
        }
      }

      const messages = session.deriveMessages()
      const route = resolveModelRoute({
        messages,
        requestContext: () => session.requestContext(),
      })
      if (route === undefined) {
        return {
          ok: false,
          error: {
            code: 'NO_MODEL_ROUTE',
            message: 'no model route recorded for this session (no request context or assistant provenance)',
          },
        }
      }

      const input = buildSummaryInput({
        messages,
        keepRecentRounds: this.options.keepRecentRounds,
        keepRecentTokens: this.options.keepRecentTokens,
      })
      if (input.text.length === 0) {
        return {
          ok: false,
          error: {
            code: 'EMPTY_INPUT',
            message: 'nothing to summarize: the conversation has no rounds older than the keep-recent window',
          },
        }
      }

      const prompt = renderSummaryPrompt(
        this.options.summarizePrompt.trim() || SUMMARY_USER_PROMPT_TEMPLATE,
        input.text
      )
      const llm = this.ctx.get('llm') as LlmRuntime | undefined
      if (llm === undefined) {
        return {
          ok: false,
          error: {
            code: 'LLM_SERVICE_UNAVAILABLE',
            message: 'the llm service is not available',
          },
        }
      }

      const request: GenerateOptions = {
        provider: route.provider,
        model: route.model,
        system: SUMMARY_SYSTEM_PROMPT,
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: prompt }],
            source: { kind: 'plugin', plugin: 'graycode.summary' },
          }),
        ],
        ...(signal !== undefined ? { signal } : {}),
      }
      const text = await collectSummaryTextWithTimeout(
        llm.stream(request),
        signal,
        this.options.llmTimeoutMs ?? SUMMARY_LLM_TIMEOUT_MS,
      )

      const validation = validateSummaryText(text)
      if (!validation.ok) {
        return {
          ok: false,
          error: validation.reason === 'empty'
            ? { code: 'EMPTY_SUMMARY', message: 'the model returned an empty summary' }
            : {
                code: 'LOW_QUALITY_SUMMARY',
                message: `summary too short (${validation.length} chars, minimum ${MIN_SUMMARY_LENGTH})`,
              },
        }
      }
      return { ok: true, text }
    } catch (error) {
      if (isAbortLike(error, signal)) {
        // 保留具体取消原因（调用方中止 vs 超时兜底），供日志/诊断使用
        const message = error instanceof Error && error.message.length > 0 ? error.message : 'summarize aborted'
        return { ok: false, error: { code: 'ABORTED', message } }
      }
      const failure = error instanceof LlmCallFailure ? error : undefined
      return {
        ok: false,
        error: {
          code: 'LLM_FAILED',
          message: failure ? `${failure.code}: ${failure.message}` : messageOf(error),
        },
      }
    }
  }
}
