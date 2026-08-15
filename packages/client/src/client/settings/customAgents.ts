/**
 * S2 custom subagents — pure client helpers (no React, no I/O).
 *
 * These mirror the plugin's identity-planning contract in
 * `packages/plugin/src/subagents/customAgents/domain/plan.ts` so the settings
 * UI can preview tool names and validate drafts with the exact rules the host
 * will apply at registration time.
 */
import type { CustomAgentConfig } from './types.ts'

/** Unique id for a new custom agent (`agent_<ts>_<rand>`, like the legacy Gray ids). */
export function createCustomAgentId(): string {
  const rand = Math.floor(Math.random() * 10_000).toString().padStart(4, '0')
  return `agent_${Date.now()}_${rand}`
}

/** ASCII-fragment slug: lowercase, non-alphanumerics collapse to `-`. */
export function customAgentSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Model-facing tool-name preview (`subagent_<name-slug>`, CJK name falls back to the id slug). */
export function customAgentToolNamePreview(agent: { name: string; id: string }): string {
  const nameSlug = customAgentSlug(agent.name)
  const idSlug = customAgentSlug(agent.id)
  const stem = nameSlug.length > 0 ? nameSlug : idSlug.length > 0 ? idSlug : 'agent'
  return `subagent_${stem}`
}

/**
 * Draft validation: empty name, an exact duplicate, or a tool-name slug
 * collision with another entry. The plugin registers each enabled agent under
 * `subagent_<slug(name)>` (`deriveToolName` in the plugin's
 * `subagents/customAgents/domain/plan.ts`) and throws on duplicate tool names,
 * so two differently-typed names that collapse to the same slug (e.g.
 * `Code Reviewer` / `Code-Reviewer`) must be rejected here even though the raw
 * names differ.
 */
export function validateCustomAgentDraft(
  draft: { name: string },
  existing: readonly CustomAgentConfig[],
): { name?: string } {
  if (draft.name.trim().length === 0) return { name: 'invalidName' }
  const normalized = draft.name.trim().toLowerCase()
  if (existing.some(agent => agent.name.trim().toLowerCase() === normalized)) return { name: 'duplicateName' }
  const draftToolName = customAgentToolNamePreview({ name: draft.name, id: '' })
  if (existing.some(agent => customAgentToolNamePreview(agent) === draftToolName)) return { name: 'duplicateToolName' }
  return {}
}

/** Insert or replace by id (immutable; shallow copies). */
export function upsertCustomAgent(list: readonly CustomAgentConfig[], agent: CustomAgentConfig): CustomAgentConfig[] {
  const index = list.findIndex(candidate => candidate.id === agent.id)
  if (index === -1) return [...list, { ...agent }]
  return list.map((candidate, i) => (i === index ? { ...agent } : candidate))
}

/** Remove by id (immutable). */
export function removeCustomAgent(list: readonly CustomAgentConfig[], id: string): CustomAgentConfig[] {
  return list.filter(agent => agent.id !== id)
}

/** Toggle the enabled flag by id (immutable; shallow copies). */
export function toggleCustomAgentEnabled(list: readonly CustomAgentConfig[], id: string): CustomAgentConfig[] {
  return list.map(agent =>
    agent.id === id ? { ...agent, enabled: !agent.enabled } : agent)
}
