/**
 * GrayCode - thoughts domain llm/stream adapter (A1 request-construction layer)
 *
 * Subscribes the `llm/stream` waterfall and rewrites agent-loop requests with
 * preset injections — but ONLY while the plugin is enabled and a mode provides
 * entries. Rewritten requests are built as NEW options objects (see
 * domain/rewrite.ts) and re-entered through `ctx.llm.stream`, with a WeakSet
 * short-circuit so the rewrite happens exactly once per request.
 *
 * TURN-FIRST-STEP ONLY (B1): injections are applied only on the first step of a
 * user turn — aligned with the original Gray dynamic-context semantics
 * (PromptManager.getDynamicContextMessages: dynamic context is inserted only
 * when the user actively sends a message, never repeatedly inside the AI's
 * tool-iteration loop). The discriminator is the request tail after the last
 * user-input message (source.kind==='user'): it may only hold plugin snapshots
 * (runtime context / memory), never tool results (source.kind==='tool') or
 * assistant messages — those mark a later step of the same turn.
 *
 * The substituted request keeps the loop request contract: it is re-marked
 * with `markAgentLoopRequest` and `deepFreeze` as a PAIR, exactly like
 * dsh-agent-loop's buildRequest (agent.ts L486) — downstream listeners still
 * see `isAgentLoopRequest` true and any mutation throws (deepFreeze skips the
 * AbortSignal so cancellation keeps working).
 *
 * NON-CONTRACT USAGE (ADR-0002 §A1): the llm/stream documentation says loop
 * requests arrive deep-frozen and are "read, never rewritten". This adapter
 * never mutates the frozen object — it substitutes a new one — but the
 * substitution itself is outside the documented contract. Fail-closed: any
 * injection error passes the original request through untouched.
 */

import type { Context } from '@deepseek-ai/cordis'
import { deepFreeze, isAgentLoopRequest, markAgentLoopRequest, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  placeInjections,
  rewriteLoopRequest,
  type PresetInjection,
} from '../domain/rewrite.ts'

/** Block-order snapshot used to place injections relative to chat_history markers. */
export interface InjectionBlockOrder {
  role: string
  order: number
}

/** What the adapter needs to decide and build an injection set. */
export interface ThoughtsAdapterState {
  /** Master switch (default true): off passes every request through untouched. */
  enabled: boolean
  /** sendHistoryThoughts gate for reasoning blocks (default true). */
  sendHistoryThoughts: boolean
  /** Preset user/assistant entries of the current mode ([] → no rewrite). */
  injections: PresetInjection[]
  /** Render-order block list incl. chat_history markers (placement anchor). */
  blockOrders: InjectionBlockOrder[]
}

export interface LlmStreamThoughtsAdapter {
  /** Unsubscribe the llm/stream listener (idempotent). */
  dispose(): void
}

/**
 * Install the llm/stream rewrite listener. `getState` is read per event so
 * mode switches / config HMR take effect without re-registration.
 */
export function createLlmStreamThoughtsAdapter(
  ctx: Context,
  getState: () => ThoughtsAdapterState,
): LlmStreamThoughtsAdapter {
  // Requests this adapter already rewrote (or is about to): short-circuit the
  // re-entrant ctx.llm.stream() call so each request is rewritten exactly once.
  const rewritten = new WeakSet<GenerateOptions>()
  let active = true

  const detach = ctx.on(
    'llm/stream' as never,
    ((
      options: GenerateOptions,
      next: () => AsyncIterable<unknown>,
    ): AsyncIterable<unknown> => {
      if (!active) return next()
      let state: ThoughtsAdapterState
      try {
        state = getState()
      } catch (error) {
        // Fail-closed: a broken state provider must never break a model call.
        ctx.logger.warn('[graycode-thoughts] state provider failed; passing original', error)
        return next()
      }
      if (!state.enabled || state.injections.length === 0) return next()
      // Only loop-assembled requests are rewritten; plugin/hand-built calls pass.
      if (!isAgentLoopRequest(options)) return next()
      // Re-entrant call (our own ctx.llm.stream with the rewritten options).
      if (rewritten.has(options)) return next()

      // 只在本回合第一个 step 注入（对齐原版 PromptManager.getDynamicContextMessages：
      // 「这些消息应该只在用户主动发送消息时插入，在 AI 连续调用工具的迭代循环中
      // 不应该重复添加」）。
      // 回合首步判定：从末尾向前找到最后一个「用户主动输入」消息（role==='user'
      // 且 source.kind==='user'，由 agent-loop inbox claim 后 append），其后的尾部
      // 只允许插件快照（运行时上下文 / 记忆快照：role==='user' 且
      // source.kind==='plugin'，agent-loop preStep 在 claim 之后追加）。尾部一旦
      // 出现工具结果（role==='user' 但 source.kind==='tool'）或 assistant 消息，
      // 即说明这是工具迭代循环的后续 step → 跳过注入。
      // 注意：不能用「末尾恰是 source.kind==='user'」判断——运行时上下文投影在
      // 首步请求末尾追加 plugin 快照（默认配置下几乎总是存在），那样会误杀首步。
      const messages = options.messages
      let anchor = messages.length - 1
      while (anchor >= 0 && messages[anchor]!.source.kind !== 'user') anchor -= 1
      if (anchor < 0) return next()
      for (let i = anchor + 1; i < messages.length; i += 1) {
        const tail = messages[i]!
        if (tail.role !== 'user' || tail.source.kind === 'tool') return next()
      }

      const placed = placeInjections(state.injections, state.blockOrders)

      let result
      try {
        result = rewriteLoopRequest(options, placed)
      } catch (error) {
        // Fail-closed: never break a model call because of the rewrite.
        ctx.logger.warn('[graycode-thoughts] request rewrite failed; passing original', error)
        return next()
      }
      if (result.injectedCount === 0) return next()

      // The substituted request keeps the loop request contract: mark +
      // deep-freeze as a pair (dsh-agent-loop agent.ts L486). isAgentLoopRequest
      // stays true for downstream listeners and mutation throws; the AbortSignal
      // is skipped by deepFreeze so cancellation is preserved.
      const loopRequest = markAgentLoopRequest(deepFreeze(result.options))
      rewritten.add(loopRequest)
      // Re-enter the waterfall with the rewritten options. `rewritten` guards
      // the re-entrant pass of THIS listener; other listeners see the new
      // options once (documented order probe deferred to a real profile).
      return ctx.llm.stream(loopRequest)
    }) as never,
  ) as unknown as () => void

  return {
    dispose: () => {
      active = false
      detach()
    },
  }
}
