/**
 * GrayCode - thoughts domain (A1 ability-internal subset, request-construction layer)
 *
 * Pure-TS core of the "true temp messages + typed reasoning" route (see
 * docs/ADR-0002 §A1 and docs/PROGRESS.md A1): the llm/stream waterfall is the
 * only public surface that can reach full semantics (assistant messages with
 * `{type:'reasoning'}` blocks), but loop-built requests arrive deep-frozen and
 * documented read-only — so every rewrite here constructs a NEW options object
 * and NEW messages array, never mutating the original (ADR-0002 records this
 * as a NON-CONTRACT usage; the switch is off by default and the plugin is not
 * mounted until a follow-up batch wires the prompt-injector requestLayer
 * hand-off).
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
   * Fake-thought text (trimmed) for role=assistant entries when
   * sendHistoryThoughts is on; maps to a `{type:'reasoning'}` block.
   */
  thought?: string
}

/**
 * Project enabled user/assistant preset entries into request-layer injections,
 * in render order (order asc, id tie-break — same sort as assembleEntries).
 *
 * Mirrors the old Gray fake-thought rules: only role=assistant entries with a
 * non-empty (after trim) fakeThought are affected; pure-whitespace thoughts
 * count as absent. `sendHistoryThoughts` is the gate — off means no thought
 * block is emitted at all (same default as the D-11 = c injection gate).
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
    const injection: PresetInjection = { role, text }
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
 * Pair sorted injections with their placement. `injections` must be in the
 * same render order as the user/assistant entries inside `blockOrders` (the
 * k-th injection matches the k-th user/assistant block); system and
 * chat_history blocks are skipped as anchors only.
 */
export function placeInjections(
  injections: readonly PresetInjection[],
  blockOrders: ReadonlyArray<{ role: string; order: number }>,
): ReadonlyArray<{ injection: PresetInjection; placement: InjectionPlacement }> {
  const entryBlocks = blockOrders.filter(block => block.role === 'user' || block.role === 'assistant')
  return injections.map((injection, index) => ({
    injection,
    placement: placementOf(blockOrders, entryBlocks[index]?.order ?? Number.MAX_SAFE_INTEGER),
  }))
}

/**
 * Build the message blocks for one injection: user → text block; assistant →
 * optional reasoning block first, then the text block. Pure: no mutation.
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
 *   entries before the real history" position); `after-history` are appended
 *   after the existing history.
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
  return {
    options: {
      ...options,
      messages: [...pre, ...options.messages, ...post],
    },
    injectedCount: injections.length,
  }
}
