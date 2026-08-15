/**
 * S2 custom subagents — pure client helper tests (no React rendering).
 *
 * The tool-name and slug rules must stay in lockstep with the plugin's
 * identity planning (`packages/plugin/src/subagents/customAgents/domain/plan.ts`),
 * so the preview the settings UI shows is exactly what the host registers.
 */
import { describe, expect, it } from 'vitest'
import {
  createCustomAgentId,
  customAgentSlug,
  customAgentToolNamePreview,
  removeCustomAgent,
  toggleCustomAgentEnabled,
  upsertCustomAgent,
  validateCustomAgentDraft,
} from '../src/client/settings/customAgents.ts'
import type { CustomAgentConfig } from '../src/client/settings/types.ts'

const sample = (overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig => ({
  id: 'agent_1',
  name: 'Code Reviewer',
  description: 'Reviews diffs',
  systemPrompt: 'You are a reviewer.',
  enabled: true,
  ...overrides,
})

describe('createCustomAgentId', () => {
  it('matches the legacy agent_<ts>_<4-digit> shape', () => {
    const id = createCustomAgentId()
    expect(id).toMatch(/^agent_\d{13}_\d{4}$/)
    const ts = Number.parseInt(id.slice('agent_'.length, -5), 10)
    expect(Number.isFinite(ts)).toBe(true)
    expect(ts).toBeGreaterThan(0)
  })

  it('produces distinct ids across calls', () => {
    expect(new Set([createCustomAgentId(), createCustomAgentId(), createCustomAgentId()]).size).toBe(3)
  })
})

describe('customAgentSlug', () => {
  it('lowercases and collapses non-alphanumerics to a single dash', () => {
    expect(customAgentSlug('Code Reviewer')).toBe('code-reviewer')
    expect(customAgentSlug('  Deep   Research  ')).toBe('deep-research')
    expect(customAgentSlug('a/b_c.d')).toBe('a-b-c-d')
  })

  it('trims leading and trailing dashes', () => {
    expect(customAgentSlug('--x--')).toBe('x')
    expect(customAgentSlug('---')).toBe('')
  })

  it('returns empty for non-ASCII input (CJK falls back to the id slug)', () => {
    expect(customAgentSlug('代码审查')).toBe('')
  })
})

describe('customAgentToolNamePreview', () => {
  it('builds subagent_<name-slug> for ASCII names', () => {
    expect(customAgentToolNamePreview({ name: 'Code Reviewer', id: 'agent_1' })).toBe('subagent_code-reviewer')
  })

  it('falls back to the id slug when the name has no ASCII fragment', () => {
    expect(customAgentToolNamePreview({ name: '代码审查', id: 'agent_abc_1234' })).toBe('subagent_agent-abc-1234')
  })

  it('falls back to agent when neither name nor id yields a slug', () => {
    expect(customAgentToolNamePreview({ name: '代码审查', id: '自定义' })).toBe('subagent_agent')
  })
})

describe('validateCustomAgentDraft', () => {
  const existing = [sample({ name: 'Code Reviewer' }), sample({ id: 'agent_2', name: 'Deep Research' })]

  it('rejects empty names with invalidName', () => {
    expect(validateCustomAgentDraft({ name: '' }, [])).toEqual({ name: 'invalidName' })
    expect(validateCustomAgentDraft({ name: '   ' }, existing)).toEqual({ name: 'invalidName' })
  })

  it('rejects names duplicating another entry (trimmed, case-insensitive)', () => {
    expect(validateCustomAgentDraft({ name: 'code reviewer' }, existing)).toEqual({ name: 'duplicateName' })
    expect(validateCustomAgentDraft({ name: '  DEEP research ' }, existing)).toEqual({ name: 'duplicateName' })
  })

  it('accepts unique names', () => {
    expect(validateCustomAgentDraft({ name: 'New Agent' }, existing)).toEqual({})
  })
})

describe('upsertCustomAgent', () => {
  it('appends when the id is unknown', () => {
    const next = upsertCustomAgent([sample()], sample({ id: 'agent_2' }))
    expect(next.map(agent => agent.id)).toEqual(['agent_1', 'agent_2'])
  })

  it('replaces in place when the id matches, preserving list order', () => {
    const base = [sample({ id: 'agent_1', name: 'A' }), sample({ id: 'agent_2', name: 'B' })]
    const next = upsertCustomAgent(base, sample({ id: 'agent_1', name: 'Renamed' }))
    expect(next.map(agent => agent.name)).toEqual(['Renamed', 'B'])
    expect(next).toHaveLength(2)
  })

  it('is immutable: appending shares untouched entries but never mutates them', () => {
    const base = [sample()]
    const next = upsertCustomAgent(base, sample({ id: 'agent_2' }))
    expect(base).toHaveLength(1)
    expect(base[0]!.name).toBe('Code Reviewer')
    expect(next).toHaveLength(2)
    expect(next[0]).toBe(base[0])
    expect(next[1]!.id).toBe('agent_2')
    expect(next[1]!.enabled).toBe(true)
    expect(base[0]!.enabled).toBe(true)
  })
})

describe('removeCustomAgent', () => {
  it('drops the matching entry and keeps the rest', () => {
    const base = [sample({ id: 'agent_1' }), sample({ id: 'agent_2' })]
    const next = removeCustomAgent(base, 'agent_1')
    expect(next.map(agent => agent.id)).toEqual(['agent_2'])
  })

  it('returns a copy without mutating the input when the id is absent', () => {
    const base = [sample({ id: 'agent_1' })]
    const next = removeCustomAgent(base, 'nope')
    expect(next).not.toBe(base)
    expect(next).toEqual(base)
  })
})

describe('toggleCustomAgentEnabled', () => {
  it('flips only the matching entry', () => {
    const base = [sample({ id: 'agent_1', enabled: true }), sample({ id: 'agent_2', enabled: false })]
    const next = toggleCustomAgentEnabled(base, 'agent_2')
    expect(next.map(agent => agent.enabled)).toEqual([true, true])
    expect(base[1]!.enabled).toBe(false)
  })

  it('is immutable: copies the flipped entry only', () => {
    const base = [sample({ id: 'agent_1', enabled: true })]
    const next = toggleCustomAgentEnabled(base, 'agent_1')
    expect(next[0]).not.toBe(base[0])
    expect(next[0]!.enabled).toBe(false)
    expect(base[0]!.enabled).toBe(true)
  })
})
