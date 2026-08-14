/**
 * GrayCode - persona / preset registration (Phase 2 closure)
 *
 * Registers the Gray persona as a system-prompt section on every targeted
 * agent's scoped context at `agent/created` (sections registered through
 * `agent.ctx` live in that agent's scope: they shadow globals, participate in
 * that agent's prompt assembly, and unwind automatically when the agent
 * scope disposes). Mode presets (P3F) replace the persona by composing a
 * different `Config` at the composition root; the stable section name
 * `graycode:persona` and the PERSONA_ORDER slot give a later preset engine a
 * predictable shadowing target.
 */

import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PERSONA_ORDER } from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import { agentScopeSchema, type AgentScopeMode } from './agentScope.ts'

/** Stable section name; registered per agent on its scoped context. */
export const PERSONA_SECTION_NAME = 'graycode:persona'

/** Workspace variable the template may interpolate (`{{graycode_workspace}}`). */
export const PERSONA_WORKSPACE_VARIABLE = 'graycode_workspace'

/** Built-in default persona (English, short; GrayCode capability statement). */
export const DEFAULT_PERSONA_TEMPLATE = [
  'You are the GrayCode-enhanced DeepSeek Harness assistant.',
  'Beyond the standard harness you can:',
  '- author and maintain design / progress / review documents under the workspace .graycode/ directory;',
  '- use permanent memory, global and per-workspace, via the memory_* tools;',
  '- snapshot workspace checkpoints for rollback;',
  '- organize work across tree-shaped branches.',
].join('\n')

/**
 * Persona plugin configuration. `enabled` is the master switch;
 * `agentScope` reuses the shared agent-scope mode (roots / all / disabled);
 * `template` optionally overrides the built-in persona and may reference
 * `{{variable}}` placeholders resolved by system-prompt variables (e.g.
 * `{{graycode_workspace}}`, `{{cwd}}`).
 */
export interface Config {
  enabled: boolean
  agentScope: AgentScopeMode
  /** Empty (default) selects the built-in persona. */
  template?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  agentScope: agentScopeSchema,
  template: z.string().default(''),
})

/** Registrar handle: `dispose` is idempotent and also bound to the fiber. */
export interface PersonaRegistrar {
  dispose(): void
}

/**
 * Create the persona registrar for one plugin instance. Installs the persona
 * section (plus the `graycode_workspace` variable) on every targeted live
 * agent, arms the `agent/created` listener for later agents, and backfills
 * agents that predate the plugin load (HMR / late mount). Agent disposal
 * unwinds the agent scope, which unregisters the scoped contributions.
 *
 * @param ctx - the applying plugin context (`ctx.agents` must be live).
 * @param config - persona switch, install scope, and optional template.
 */
export function createPersonaRegistrar(ctx: Context, config: Config): PersonaRegistrar {
  if (!config.enabled || config.agentScope === 'disabled') {
    return { dispose: () => {} }
  }

  const template = config.template && config.template.length > 0 ? config.template : DEFAULT_PERSONA_TEMPLATE
  /** Agent -> disposers of its scoped section/variable; purged on disposal. */
  const installed = new Map<Agent, ReadonlyArray<() => void>>()
  let active = false
  let detachCreated: (() => void) | undefined
  let detachDisposed: (() => void) | undefined

  /** Whether this agent receives the persona under the current mode. */
  const targets = (agent: Agent): boolean =>
    config.agentScope === 'all' || ctx.agents.roots().some(root => root.id === agent.id)

  const install = (agent: Agent): void => {
    if (installed.has(agent)) return
    const disposers = [
      agent.ctx.systemPrompt.section({
        name: PERSONA_SECTION_NAME,
        order: PERSONA_ORDER,
        text: template,
      }),
      agent.ctx.systemPrompt.variable(PERSONA_WORKSPACE_VARIABLE, () => {
        const cwd = agent.session.header.cwd
        return cwd ? path.basename(cwd.replace(/\\/g, '/')) : undefined
      }),
    ]
    installed.set(agent, disposers)
  }

  const deactivate = (): void => {
    if (!active) return
    active = false
    detachCreated?.()
    detachCreated = undefined
    detachDisposed?.()
    detachDisposed = undefined
    for (const disposers of installed.values()) {
      for (const dispose of disposers) {
        dispose()
      }
    }
    installed.clear()
  }

  const activate = (): void => {
    if (active) return
    active = true
    // `agent/created` dispatches with the new agent already in the registry
    // (the entry is inserted before the announcement), so `roots()` resolves
    // the root/subagent split at listener time.
    detachCreated = ctx.on('agent/created', ({ agent }) => {
      if (targets(agent)) install(agent)
    })
    // Purge entries for agents that die while this registrar is live (their
    // scope already unregistered the section/variable itself).
    detachDisposed = ctx.on('agent/disposed', ({ agent }) => {
      installed.delete(agent)
    })
    // Backfill agents that predate this plugin load (HMR / late mount).
    for (const agent of ctx.agents.list()) {
      if (targets(agent)) install(agent)
    }
    // Bind teardown to this plugin's fiber so unload never leaks.
    ctx.effect(() => () => deactivate())
  }

  activate()
  return { dispose: deactivate }
}

export const name = 'graycode-persona'

export const inject = ['agents'] as const

/** Cordis plugin entry: mounts the persona registrar on this plugin's fiber. */
export function apply(ctx: Context, config: Config): void {
  const registrar = createPersonaRegistrar(ctx, config)
  // The registrar binds its own teardown to this fiber; this effect keeps the
  // HMR contract explicit and idempotent.
  ctx.effect(() => registrar.dispose)
}
