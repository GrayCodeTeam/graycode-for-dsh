/**
 * GrayCode - thoughts domain (A1 ability-internal subset, request-construction layer)
 *
 * Pure-TS core of the "true temp messages + typed reasoning" route (see
 * docs/ADR-0002 §A1 and docs/PROGRESS.md A1): the llm/stream waterfall is the
 * only public surface that can reach full semantics (assistant messages with
 * `{type:'reasoning'}` blocks), but loop-built requests arrive deep-frozen and
 * documented read-only — so every rewrite here constructs a NEW options object
 * and NEW messages array, never mutating the original (ADR-0002 records this
 * as a NON-CONTRACT usage; the plugin is enabled by default and the adapter
 * re-marks + deep-freezes the substituted request so the loop contract holds,
 * see adapters/llmStream.ts).
 *
 * This module is host-free: everything takes plain values and returns new
 * values. `createUserMessage` / `createAssistantMessage` are imported as pure
 * constructors (they only build + freeze a message value).
 */

import {
  createAssistantMessage,
  createUserMessage,
  type GenerateOptions,
  type Message,
} from '@deepseek-ai/dsh-llm'
import type { PromptEntry } from '../../prompt/domain/promptTypes.ts'

/** Plugin source tag stamped on injected user messages (merge-extensible kind). */
export const THOUGHTS_PLUGIN_SOURCE = 'graycode-thoughts'

/** One preset user/assistant entry projected for the request layer. */
export interface PresetInjection {
  /** Entry role; chat_history/system entries never project here. */
  role: 'user' | 'assistant'
  /** Rendered body text (placeholder-rendered by the caller). */
  text: string
  /**
   * 源预设条目的渲染序号（entry.order）。placeInjections 直接以它对照 chat_history
   * marker 切分，避免 disabled/空文本条目让「按下标与 user/assistant 块配对」错位
   * （3.15-M3：注入被放错历史一侧）。
   */
  entryOrder: number
  /**
   * Fake-thought text (trimmed) for role=assistant entries when
   * sendHistoryThoughts is on; maps to a `{type:'reasoning'}` block.
   *
   * TYPED-ONLY: this field is the ONLY carrier for fake thoughts. It is never
   * rendered into a `[thinking]` text prefix — when the reasoning block cannot
   * be carried the thought is dropped entirely (gate off), never downgraded
   * to text (see {@link injectionMessage}).
   */
  thought?: string
}

/**
 * Project enabled user/assistant preset entries into request-layer injections,
 * in render order (order asc, id tie-break — same sort as assembleEntries).
 *
 * Mirrors the old Gray fake-thought rules: only role=assistant entries with a
 * non-empty (after trim) fakeThought are affected; pure-whitespace thoughts
 * count as absent. `sendHistoryThoughts` is the gate — off means the `thought`
 * field is simply not set: no chain-of-thought is injected at all. It is
 * NEVER degraded to a `[thinking]` text prefix — the typed reasoning block
 * ({@link injectionMessage}) is the only carrier; a channel that cannot carry
 * it gets no thought, not a text stand-in.
 */
export function presetEntriesToInjections(
  entries: readonly PromptEntry[],
  sendHistoryThoughts: boolean,
): PresetInjection[] {
  const enabled = entries
    .filter(entry => entry.enabled && (entry.role === 'user' || entry.role === 'assistant'))
    .slice()
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))

  const injections: PresetInjection[] = []
  for (const entry of enabled) {
    const role = entry.role === 'assistant' ? 'assistant' : 'user'
    const text = entry.content
    // Old Gray skipped entries whose rendered text was empty.
    if (text.trim().length === 0) continue
    const thought = entry.fakeThought?.trim()
    const injection: PresetInjection = { role, text, entryOrder: entry.order }
    if (role === 'assistant' && sendHistoryThoughts && thought && thought.length > 0) {
      injection.thought = thought
    }
    injections.push(injection)
  }
  return injections
}

/** Where an injection lands relative to the real history. */
export type InjectionPlacement = 'before-history' | 'after-history'

/** Placement decision for a block order with chat_history markers. */
export function placementOf(
  blockOrders: ReadonlyArray<{ role: string; order: number }>,
  entryOrder: number,
): InjectionPlacement {
  const firstMarker = blockOrders.find(block => block.role === 'chat_history')
  if (!firstMarker) return 'after-history'
  return entryOrder < firstMarker.order ? 'before-history' : 'after-history'
}

/**
 * Pair sorted injections with their placement. Each injection carries its source
 * entry's render order (see {@link PresetInjection.entryOrder}), so placement is
 * decided against the chat_history marker directly — no index-pairing with the
 * user/assistant blocks in `blockOrders`. This is what keeps disabled / empty
 * entries from shifting the pairing and dropping injections on the wrong side of
 * the history (3.15-M3).
 */
export function placeInjections(
  injections: readonly PresetInjection[],
  blockOrders: ReadonlyArray<{ role: string; order: number }>,
): ReadonlyArray<{ injection: PresetInjection; placement: InjectionPlacement }> {
  return injections.map((injection) => ({
    injection,
    placement: placementOf(blockOrders, injection.entryOrder),
  }))
}

/**
 * Build the message blocks for one injection: user → text block; assistant →
 * optional reasoning block first, then the text block. Pure: no mutation.
 *
 * TYPED-ONLY: the reasoning block (`{type:'reasoning'}`) is the sole carrier
 * for fake thoughts — this function never emits a `[thinking]` text prefix.
 * A thought present on the injection becomes the reasoning block; an absent
 * thought (gate off / no fakeThought) yields a single text block.
 */
export function injectionMessage(injection: PresetInjection, provider: string, model: string): Message {
  const content: Array<{ type: 'text' | 'reasoning'; text: string }> = []
  if (injection.thought !== undefined) {
    content.push({ type: 'reasoning', text: injection.thought })
  }
  content.push({ type: 'text', text: injection.text })

  if (injection.role === 'assistant') {
    // createAssistantMessage requires an assistant provenance source; the
    // request's own provider/model identity is the closest truthful value
    // (kind stays unset — this is a plugin-built message, not a model one).
    return createAssistantMessage({
      content,
      source: { provider, model },
    })
  }
  return createUserMessage({
    content,
    source: { kind: 'plugin', plugin: THOUGHTS_PLUGIN_SOURCE },
  })
}

export interface RewriteLoopRequestResult {
  /** New options object: same scalars, new messages array. Never mutates input. */
  options: GenerateOptions
  /** Number of injected messages (pre + post). */
  injectedCount: number
}

/**
 * Rewrite a loop-built request with preset injections, immutably.
 *
 * - Returns a NEW options object (shallow copy of scalars) with a NEW messages
 *   array; the input object/messages are never touched (the loop request is
 *   deep-frozen and documented read-only).
 * - Injections placed `before-history` are prepended (the old Gray "preset
 *   entries before the real history" position).
 * - Injections placed `after-history` are inserted BEFORE the current turn's
 *   user message: the anchor is the LAST message with role==='user' AND
 *   source.kind==='user', searched from the end (this is the current-turn
 *   user input in an agent-loop request — deriveMessages appends it after the
 *   inbox claim; tool results are user-role but source.kind==='tool' and do
 *   not count). This aligns with the original Gray current-turn semantics
 *   (findLastUserMessageGroupIndex / findCurrentTurnStartIndex, base.ts
 *   L109-156): after entries land before the current turn's history instead
 *   of being blindly appended at the end. When no user message exists the
 *   anchor falls back to the end of the list.
 * - The original messages array is shared by reference where untouched
 *   (immutable sharing — no copy cost).
 */
export function rewriteLoopRequest(
  options: GenerateOptions,
  injections: ReadonlyArray<{ injection: PresetInjection; placement: InjectionPlacement }>,
): RewriteLoopRequestResult {
  if (injections.length === 0) {
    return { options, injectedCount: 0 }
  }
  const pre: Message[] = []
  const post: Message[] = []
  for (const { injection, placement } of injections) {
    const message = injectionMessage(injection, options.provider, options.model)
    if (placement === 'before-history') {
      pre.push(message)
    } else {
      post.push(message)
    }
  }

  // after anchor: last role==='user' AND source.kind==='user' message (the
  // current turn's user input); fall back to the end when none exists.
  let anchor = options.messages.length
  for (let i = options.messages.length - 1; i >= 0; i--) {
    const message = options.messages[i]!
    if (message.role === 'user' && message.source.kind === 'user') {
      anchor = i
      break
    }
  }

  return {
    options: {
      ...options,
      messages: [...pre, ...options.messages.slice(0, anchor), ...post, ...options.messages.slice(anchor)],
    },
    injectedCount: injections.length,
  }
}
