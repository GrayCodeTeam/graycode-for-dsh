/**
 * GrayCode - thoughts plugin (A1 ability-internal subset; NOT mounted by default)
 *
 * Request-construction layer for true temp messages + typed reasoning
 * (docs/ADR-0002 §A1, docs/PROGRESS.md A1). Subscribes the `llm/stream`
 * waterfall and rewrites agent-loop requests with preset user/assistant
 * injections when enabled — fake thoughts become `{type:'reasoning'}` blocks
 * and preset entries become real messages instead of system-text paragraphs.
 *
 * NON-CONTRACT USAGE: the rewrite substitutes a NEW options object for the
 * documented read-only loop request (see ADR-0002). The switch is off by
 * default and this plugin is deliberately NOT mounted in the composition root
 * until the follow-up batch wires the prompt-injector requestLayer hand-off
 * (otherwise preset paragraphs would be injected twice — once as system text
 * by D-11 = c, once as messages here).
 *
 * Mount recipe (follow-up batch, once requestLayer lands):
 * ```ts
 * ctx.plugin(thoughts, { enabled: true, sendHistoryThoughts: true })
 * ```
 * with the prompt injector configured to skip user/assistant paragraphs while
 * this is enabled.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createLlmStreamThoughtsAdapter, type ThoughtsAdapterState } from './adapters/llmStream.ts'
import type { PresetInjection } from './domain/rewrite.ts'

export const name = 'graycode-thoughts'

/** Adapter state provider: returns the current injection set (read per event). */
export type ThoughtsStateProvider = () => Omit<ThoughtsAdapterState, 'enabled' | 'sendHistoryThoughts'>

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
 * @param ctx - applying context (host must expose the llm service).
 * @param config - thoughts configuration.
 * @param getState - per-event state: current preset injections + block order
 *   anchors (normally sourced from the prompt mode service).
 */
export function apply(
  ctx: Context,
  config: Config,
  getState: ThoughtsStateProvider = () => ({ injections: [] as PresetInjection[], blockOrders: [] }),
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
