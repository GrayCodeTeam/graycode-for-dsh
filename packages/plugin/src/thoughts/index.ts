/**
 * GrayCode - thoughts plugin (A1 request-construction layer)
 *
 * Request-construction layer for true temp messages + typed reasoning
 * (docs/ADR-0002 §4b, docs/PROGRESS.md A1). Subscribes the `llm/stream`
 * waterfall and rewrites agent-loop requests with preset user/assistant
 * injections when enabled — fake thoughts become `{type:'reasoning'}` blocks
 * and preset entries become real messages instead of system-text paragraphs.
 *
 * NON-CONTRACT USAGE: the rewrite substitutes a NEW options object for the
 * documented read-only loop request (see ADR-0002 §4b). The switch is off by
 * default (fail-closed).
 *
 * requestLayer hand-off (prompt): when `prompt.requestLayer` is enabled the
 * prompt injector skips user/assistant context paragraphs — the same preset
 * would otherwise be injected twice (once as system text by D-11 = c, once
 * as real messages here). The pairing is config-side: enable both
 * `prompt.requestLayer` and `thoughts.enabled` together.
 *
 * State source: the live prompt mode service (`graycode.promptModes`,
 * provided by graycode-prompt). Per llm/stream event the current mode's
 * preset entries are projected to injections + block-order anchors. If the
 * service is absent (prompt disabled / not mounted) or no mode is loaded,
 * the adapter degrades to passing every request untouched.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createLlmStreamThoughtsAdapter, type ThoughtsAdapterState } from './adapters/llmStream.ts'
import { presetEntriesToInjections, type PresetInjection } from './domain/rewrite.ts'
import { PROMPT_MODES_SERVICE } from '../prompt/index.ts'

export const name = 'graycode-thoughts'

/** Adapter state provider: returns the current injection set (read per event). */
export type ThoughtsStateProvider = () => Omit<ThoughtsAdapterState, 'enabled' | 'sendHistoryThoughts'>

/** Minimal view of the prompt-mode service consumed by this plugin. */
export interface PromptModesLike {
  currentModeSnapshot(): { id: string; promptEntries: readonly { role: string; order: number }[] } | undefined
}

/**
 * Thoughts config. Defaults are OFF: mounting this plugin changes nothing
 * until `enabled` flips (fail-closed, ADR-0002 non-contract usage).
 */
export interface Config {
  /** Master switch: off (default) passes every llm/stream request untouched. */
  enabled: boolean
  /** sendHistoryThoughts gate for reasoning blocks (same default as prompt). */
  sendHistoryThoughts: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  sendHistoryThoughts: z.boolean().default(false),
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
    enabled: config.enabled,
    sendHistoryThoughts: config.sendHistoryThoughts,
    ...getState(),
  }))
  return () => {
    adapter.dispose()
  }
}
