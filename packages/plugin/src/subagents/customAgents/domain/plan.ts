/**
 * GrayCode - custom subagents (S2): identity planning (pure).
 *
 * Each enabled custom agent becomes one `ctx.subagents` provider plus one
 * model-facing tool. The provider name must be stable across fibers (config
 * hot-reload restarts re-register under the same name, so running children
 * stay attributable); the tool name must be unique across ALL registered
 * tools (a duplicate throws in `ctx.tools.register`). Both are derived purely
 * here so the settings UI can preview them and tests can pin them.
 */

/** Custom agent configuration (persisted under `subagents.customAgents`). */
export type CustomAgentToolMode = 'all' | 'allow' | 'deny'

export interface CustomAgentConfig {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly systemPrompt: string
  readonly enabled: boolean
  /** Child tool policy; omitted values from older configs mean `all`. */
  readonly toolMode?: CustomAgentToolMode
  /** Tool names used by the allow/deny policy. */
  readonly tools?: string[]
  /** Maximum model/tool iterations for this child; omitted inherits the global default. */
  readonly maxIterations?: number
}

/** ASCII-fragment slug: lowercase, non-alphanumerics collapse to `-`. */
export function slugify(value: string): string {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return ascii.length > 0 ? ascii : ''
}

/** Stable provider name for one agent (`graycode-custom-<slug(id)>`). */
export function deriveProviderName(agentId: string): string {
  return `graycode-custom-${slugify(agentId)}`
}

/**
 * Unique model-facing tool name for one agent. Uses the name slug when it
 * yields something (English names → `subagent_code_reviewer`); a non-ASCII
 * name falls back to the id slug so every agent still gets a distinct tool.
 */
export function deriveToolName(agent: CustomAgentConfig): string {
  const nameSlug = slugify(agent.name)
  const idSlug = slugify(agent.id)
  const stem = nameSlug.length > 0 ? nameSlug : idSlug.length > 0 ? idSlug : 'agent'
  return `subagent_${stem}`
}

/**
 * Resolve tool names for a whole agent list, de-duplicating collisions by
 * appending `-2`, `-3`, … in list order (a duplicate tool name would throw in
 * `ctx.tools.register`). Pure and deterministic — the settings UI and tests
 * share this contract.
 */
export function deriveToolNames(agents: readonly CustomAgentConfig[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  const used = new Set<string>()
  for (const agent of agents) {
    if (!agent.enabled) continue
    const base = deriveToolName(agent)
    let candidate = base
    let suffix = 2
    while (used.has(candidate)) {
      candidate = `${base}-${suffix}`
      suffix += 1
    }
    used.add(candidate)
    names.set(agent.id, candidate)
  }
  return names
}
