/**
 * GrayCode - prompt modes plugin (V2 §P3F, D-11 = c)
 *
 * Mounts the prompt settings service, the agent-scoped injector and the three
 * prompt tools. The injector re-registers the current mode section on live
 * agents whenever the service reports a change (mode switch / store edits)
 * and once the lazy store load resolves.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'
import { PromptSettingsService } from './service.ts'
import { createPromptInjector } from './promptInjector.ts'
import { createPromptTools } from './tools.ts'

export const name = 'graycode-prompt'

export const inject = ['agents'] as const

/**
 * Prompt mode configuration.
 *
 * `sendHistoryThoughts` is the D-11 = c fake-thought gate. Old Gray stripped
 * fake thoughts at the channel send side by a per-channel switch whose default
 * was disputed (base.ts comment "true" vs formatter `?? false`); rc.6 exposes
 * no such switch to plugins (P0-15 SPIKE), so the gate moved to injection
 * time and defaults to `false` — fake thoughts are never written unless
 * explicitly enabled (known D-11 = c degradation, see domain/entries.ts).
 */
export interface Config {
  /** Plugin-private data root (resolved by the composition root). */
  dataRoot: string
  /** Master switch for the whole prompt domain. */
  enabled: boolean
  /** Section + tool install scope: roots (default), all, or disabled. */
  agentScope: AgentScopeMode
  /** D-11 = c fake-thought gate (default false, see comment above). */
  sendHistoryThoughts: boolean
}

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  enabled: z.boolean().default(true),
  agentScope: agentScopeSchema,
  sendHistoryThoughts: z.boolean().default(false),
})

export function apply(ctx: Context, config: Config): () => void {
  if (!config.enabled) return () => {}

  const service = new PromptSettingsService({ dataRoot: config.dataRoot })
  const injector = createPromptInjector(ctx, config.agentScope, () => ({
    mode: service.currentModeSnapshot(),
    sendHistoryThoughts: config.sendHistoryThoughts,
  }))

  // Store edits / mode switches re-inject live agents synchronously (the
  // service updates its in-memory snapshot before emitting).
  const unsubscribe = service.subscribe(() => injector.refresh())

  // Lazy store load: once the current mode is known, backfill every agent.
  void service.getCurrentMode().then(
    () => injector.refresh(),
    (error: unknown) => {
      ctx.logger.warn('prompt modes store unavailable; prompt mode injection disabled', error)
    },
  )

  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  registrar.register(createPromptTools(service, () => config.sendHistoryThoughts))

  return () => {
    unsubscribe()
    registrar.dispose()
    injector.dispose()
  }
}
