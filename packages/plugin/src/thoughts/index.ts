/**
 * GrayCode - thoughts plugin (A1 request-construction layer)
 *
 * Request-construction layer for true temp messages + typed reasoning
 * (docs/ADR-0002 §4b, docs/PROGRESS.md A1). Subscribes the `llm/stream`
 * waterfall and rewrites agent-loop requests with preset user/assistant
 * injections — fake thoughts become `{type:'reasoning'}` blocks (typed-only,
 * never a `[thinking]` text prefix) and preset entries become real messages
 * instead of system-text paragraphs. `before` entries land at the head of the
 * message list; `after` entries land before the current turn's user message
 * (aligned with the original Gray semantics).
 *
 * This layer is always active so preset entries cannot be accidentally
 * disabled. `sendHistoryThoughts` only controls optional reasoning blocks.
 * The rewrite substitutes a NEW options object for the documented
 * read-only loop request (NON-CONTRACT usage, ADR-0002 §4b) and re-marks +
 * deep-freezes it to keep the loop contract; any state/rewrite failure passes
 * the original request through untouched (fail-closed).
 *
 * Request-layer hand-off: the prompt injector skips user/assistant
 * prompt injector skips user/assistant context paragraphs — the same preset
 * would otherwise be injected twice (once as system text by D-11 = c, once
 * as real messages here). Both halves are installed together by the
 * composition root.
 *
 * State source: the live prompt mode service (`graycode.promptModes`,
 * provided by graycode-prompt). Per llm/stream event the current mode's
 * preset entries are projected to injections + block-order anchors. If the
 * service is absent or no mode is loaded,
 * the adapter degrades to passing every request untouched.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createLlmStreamThoughtsAdapter, type ThoughtsAdapterState } from './adapters/llmStream.ts'
import { presetEntriesToInjections, type PresetInjection } from './domain/rewrite.ts'
import { PROMPT_MODES_SERVICE } from '../prompt/index.ts'

export const name = 'graycode-thoughts'

// The adapter re-enters the host waterfall through ctx.llm.stream(). Cordis
// only exposes injected services on a plugin fiber, so declaring this
// dependency is required even when the llm runtime is already mounted.
export const inject = ['llm']

/** Adapter state provider: returns the current injection set (read per event). */
export type ThoughtsStateProvider = () => Omit<ThoughtsAdapterState, 'enabled' | 'sendHistoryThoughts'>

/** Minimal view of the prompt-mode service consumed by this plugin. */
export interface PromptModesLike {
  currentModeSnapshot(): { id: string; promptEntries: readonly { role: string; order: number }[] } | undefined
}

/**
 * Thoughts config. Preset messages are always injected; this option only
 * controls whether assistant fake-thought fields become reasoning blocks.
 */
export interface Config {
  /**
   * sendHistoryThoughts gate for reasoning blocks (default true; off = the
   * thought field is simply not set — never a `[thinking]` text downgrade).
   */
  sendHistoryThoughts: boolean
}

export const Config: z<Config> = z.object({
  sendHistoryThoughts: z.boolean().default(true),
})

/**
 * Default state provider: reads the current prompt mode from the
 * cross-domain service and projects its preset entries to injections +
 * block-order anchors. A missing service/mode yields empty state (no-op).
 */
function modeDrivenState(ctx: Context, sendHistoryThoughts: boolean): ThoughtsStateProvider {
  return () => {
    const service = (ctx.get(PROMPT_MODES_SERVICE) as PromptModesLike | undefined)
    const mode = service?.currentModeSnapshot()
    if (!mode) return { injections: [] as PresetInjection[], blockOrders: [] }
    return {
      injections: presetEntriesToInjections(mode.promptEntries as never, sendHistoryThoughts),
      blockOrders: mode.promptEntries.map(entry => ({ role: entry.role, order: entry.order })),
    }
  }
}

/**
 * @param ctx - applying context (host must expose the llm service).
 * @param config - thoughts configuration.
 * @param getState - per-event state: current preset injections + block order
 *   anchors. Defaults to the live prompt-mode projection (see
 *   {@link modeDrivenState}); tests inject a fixed provider.
 */
export function apply(
  ctx: Context,
  config: Config,
  getState: ThoughtsStateProvider = modeDrivenState(ctx, config.sendHistoryThoughts),
): () => void {
  const adapter = createLlmStreamThoughtsAdapter(ctx, () => ({
    enabled: true,
    sendHistoryThoughts: config.sendHistoryThoughts,
    ...getState(),
  }))
  return () => {
    adapter.dispose()
  }
}
