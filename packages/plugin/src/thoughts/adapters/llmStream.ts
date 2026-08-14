/**
 * GrayCode - thoughts domain llm/stream adapter (A1 request-construction layer)
 *
 * Subscribes the `llm/stream` waterfall and rewrites agent-loop requests with
 * preset injections — but ONLY while the plugin is enabled and a mode provides
 * entries. Rewritten requests are built as NEW options objects (see
 * domain/rewrite.ts) and re-entered through `ctx.llm.stream`, with a WeakSet
 * short-circuit so the rewrite happens exactly once per request.
 *
 * NON-CONTRACT USAGE (ADR-0002 §A1): the llm/stream documentation says loop
 * requests arrive deep-frozen and are "read, never rewritten". This adapter
 * never mutates the frozen object — it substitutes a new one — but the
 * substitution itself is outside the documented contract. Fail-closed: any
 * injection error passes the original request through untouched.
 */

import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest, type GenerateOptions } from '@deepseek-ai/dsh-llm'
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
  /** Master switch: off (default) passes every request through untouched. */
  enabled: boolean
  /** sendHistoryThoughts gate for reasoning blocks (same default as prompt). */
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

      rewritten.add(result.options)
      // Re-enter the waterfall with the rewritten options. `rewritten` guards
      // the re-entrant pass of THIS listener; other listeners see the new
      // options once (documented order probe deferred to a real profile).
      return ctx.llm.stream(result.options)
    }) as never,
  ) as unknown as () => void

  return {
    dispose: () => {
      active = false
      detach()
    },
  }
}
