/**
 * GrayCode - agent-scoped tool registration
 *
 * Installs tool definitions on `agent.ctx` (per-agent scoped registrations that
 * shadow same-named globals) instead of the plugin-global layer. The registrar
 * listens to the public `agent/created` lifecycle event, installs on the
 * agents selected by the mode, backfills agents that already existed when the
 * plugin loaded, and unregisters on plugin unload (HMR) via the agent.ctx
 * effect disposers. Agent disposal unwinds the agent scope itself, which
 * automatically unregisters the scoped tools.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** Which agents receive the scoped tool registrations. */
export type AgentScopeMode = 'roots' | 'all' | 'disabled'

/** Shared schemastery schema; each domain Config embeds it with the default `roots`. */
export const agentScopeSchema = z.union(['roots', 'all', 'disabled'] as const).default('roots')

/** A tool-set registrar bound to one plugin instance (HMR instance = one registrar). */
export interface ScopedToolRegistrar {
  /**
   * Install the definitions on every targeted live agent (backfill included)
   * and arm the `agent/created` listener for later agents. Subsequent calls
   * append definitions (name-deduped), backfill the delta onto already-installed
   * agents, and re-arm a disposed registrar.
   */
  register(definitions: readonly ToolDefinition[]): void
  /** Remove the listener and unregister every scoped tool (idempotent). */
  dispose(): void
}

/**
 * Create the agent-scoped registrar for one plugin instance.
 * @param ctx - the applying plugin context (`ctx.agents` must be live).
 * @param mode - `roots` installs only top-level agents (no runtime owner);
 *   `all` installs on every agent including subagents; `disabled` never
 *   registers. The tool set is fixed at registration time; it is never
 *   switched while a session has produced content.
 */
export function createScopedToolRegistrar(ctx: Context, mode: AgentScopeMode): ScopedToolRegistrar {
  if (mode === 'disabled') {
    return {
      register: () => {},
      dispose: () => {},
    }
  }

  const definitions: ToolDefinition[] = []
  /**
   * Agent -> 已安装 disposers 与该 agent 已装定义数。追加注册（register 再次调用）
   * 时只给已安装 agent 补装增量（记录索引，避免重复注册同名工具）。
   */
  const installed = new Map<Agent, { disposers: ReadonlyArray<() => void>; installedCount: number }>()
  let active = false
  let detachListener: (() => void) | undefined
  let detachDisposedListener: (() => void) | undefined

  /** Whether this agent receives the registrations under the current mode. */
  const targets = (agent: Agent): boolean =>
    mode === 'all' || ctx.agents.roots().some(root => root.id === agent.id)

  const install = (agent: Agent): void => {
    if (installed.has(agent)) return
    const disposers = definitions.map(definition => agent.ctx.tools.register(definition))
    installed.set(agent, { disposers, installedCount: definitions.length })
  }

  /** 给已安装 agent 补装 [fromIndex, definitions.length) 的新定义（跳过已装部分）。 */
  const installAppended = (agent: Agent, fromIndex: number): void => {
    const entry = installed.get(agent)
    if (!entry || entry.installedCount >= definitions.length) return
    const start = Math.max(fromIndex, entry.installedCount)
    const added = definitions.slice(start).map(definition => agent.ctx.tools.register(definition))
    installed.set(agent, { disposers: [...entry.disposers, ...added], installedCount: definitions.length })
  }

  const deactivate = (): void => {
    if (!active) return
    active = false
    detachListener?.()
    detachListener = undefined
    detachDisposedListener?.()
    detachDisposedListener = undefined
    for (const { disposers } of installed.values()) {
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
    detachListener = ctx.on('agent/created', ({ agent }) => {
      if (targets(agent)) install(agent)
    })
    // Purge entries for agents that die while this registrar is live, so the
    // installed map never retains disposed agents (their scope already
    // unregistered the tools itself).
    detachDisposedListener = ctx.on('agent/disposed', ({ agent }) => {
      installed.delete(agent)
    })
    // Backfill agents that predate this plugin load (HMR / late mount).
    for (const agent of ctx.agents.list()) {
      if (targets(agent)) install(agent)
    }
    // Bind teardown to this plugin's fiber so unload never leaks.
    ctx.effect(() => () => deactivate())
  }

  return {
    register(definitionsToAdd) {
      // 按工具名去重：同一实例重复 register 同名定义不重复安装（dsh-tools 按名唯一）
      const fromIndex = definitions.length
      const added: ToolDefinition[] = []
      for (const definition of definitionsToAdd) {
        if (definitions.some(existing => existing.name === definition.name)) continue
        added.push(definition)
      }
      definitions.push(...added)
      activate()
      // activate 对已 active 实例是幂等短路（不重新回填）：既有 agent 拿不到新定义，
      // 这里按增量补装（每个 agent 记录已装定义索引，只装 [fromIndex, end) 的新增部分）
      if (fromIndex < definitions.length) {
        for (const agent of installed.keys()) {
          installAppended(agent, fromIndex)
        }
      }
    },
    dispose: deactivate,
  }
}
