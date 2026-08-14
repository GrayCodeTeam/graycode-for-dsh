/**
 * GrayCode - prompt mode injection adapter (V2 §6.6 / §P3F, D-11 = c)
 *
 * Registers the current prompt mode as a system-prompt section on every
 * targeted agent's scoped context at `agent/created`, mirroring the persona
 * registrar (persona.ts): scoped registrations shadow globals, participate in
 * that agent's prompt assembly, and unwind automatically when the agent scope
 * disposes.
 *
 * Shadowing relationship: the persona occupies `deployment:persona` at order
 * 0 (PERSONA_ORDER); the mode section occupies the `graycode:prompt` slot at
 * PROMPT_ORDER = 1, i.e. the mode template is layered immediately after the
 * persona as the agent's "mode preset" (persona + mode compose; neither
 * replaces the other). Switching modes re-registers the section on live
 * agents (old disposer first, then the new one).
 *
 * D-11 = c mapping (see domain/entries.ts for the full table):
 * - The whole mode (template + entries + prefix/suffix) is ONE section text;
 *   user/assistant entries become labeled context paragraphs and fake
 *   thoughts become plain-text prefixes inside it.
 * - Because DSH rc.6 has no request-construction injection point (P0-14 GAP),
 *   the old send-side thought stripping is replaced by an injection-time gate:
 *   when sendHistoryThoughts is off, fake thought text is never written.
 * - There is no public "list existing sections" API: re-registration works by
 *   keeping our own disposers and a fingerprint key per agent; identical
 *   state (same mode + template + entry fingerprint + thought switch) is
 *   skipped so HMR reloads and duplicate change events cannot double-inject.
 */

import * as os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentScopeMode } from '../agentScope.ts'
import { renderModeSectionText } from './domain/entries.ts'
import { fingerprint } from './domain/fingerprint.ts'
import type { PromptMode } from './domain/promptTypes.ts'

/** Stable section name; registered per agent on its scoped context. */
export const PROMPT_SECTION_NAME = 'graycode:prompt'

/** Section order: immediately after the deployment persona (order 0). */
export const PROMPT_ORDER = 1

/** Variable exposing the current mode name (`{{graycode_prompt_mode}}`). */
export const PROMPT_MODE_VARIABLE = 'graycode_prompt_mode'

/** Snapshot of what should currently be injected (provided by the plugin). */
export interface PromptRenderState {
  /** Current mode; undefined → no prompt section is injected. */
  mode: PromptMode | undefined
  /** D-11 = c fake-thought gate (replaces the old send-side strip). */
  sendHistoryThoughts: boolean
  /** `{{$MODULE}}` placeholder values (canonical module names); optional. */
  placeholderValues?: Readonly<Record<string, string>>
}

/** Registrar handle: `refresh` re-evaluates all agents; `dispose` is idempotent. */
export interface PromptInjector {
  /** Re-evaluate every installed agent against the current state (mode switches). */
  refresh(): void
  dispose(): void
}

/** Best-effort user language: host locale (DSH has no editor host; fallback 'en'). */
function userLanguage(): string {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale
  return locale.length > 0 ? locale : 'en'
}

/** Operating-system description mirroring old contextSections.getOSInfo(). */
function osDescription(): string {
  const release = os.release()
  switch (process.platform) {
    case 'win32':
      return `Windows ${release}`
    case 'darwin':
      return `macOS ${release}`
    case 'linux':
      return `Linux ${release}`
    default:
      return `${process.platform} ${release}`
  }
}

/**
 * Default `{{$MODULE}}` values derivable from the agent session alone. The
 * ENVIRONMENT value mirrors the old static environment section
 * (contextSections.generateStaticEnvironmentSection + wrapSection): full
 * workspace path, operating system, timezone, user language and the
 * "respond in the user's language" instruction, wrapped
 * `====\n\nENVIRONMENT\n\n…`. All inside the D-11 = c text-injection frame
 * (no DSH extension surface involved).
 */
function defaultPlaceholderValues(cwd: string | undefined): Record<string, string> {
  const environment = [
    cwd ? `Current Workspace: ${cwd}` : 'No workspace open',
    `Operating System: ${osDescription()}`,
    `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    `User Language: ${userLanguage()}`,
    "Please respond using the user's language by default.",
  ].join('\n')
  return { ENVIRONMENT: `====\n\nENVIRONMENT\n\n${environment}` }
}

/** The rendered section text of a state (template + entries + prefix/suffix). */
function renderStateText(state: PromptRenderState, cwd: string | undefined): string {
  const mode = state.mode
  if (!mode) return ''
  return renderModeSectionText(mode, {
    sendHistoryThoughts: state.sendHistoryThoughts,
    placeholderValues: state.placeholderValues ?? defaultPlaceholderValues(cwd),
  })
}

/**
 * Dedup key: same mode id + template + entry fingerprint + thought switch
 * means the assembled section did not change; re-registration is skipped.
 */
function stateKey(state: PromptRenderState): string {
  const mode = state.mode
  if (!mode) return ''
  return [
    mode.id,
    mode.template,
    fingerprint(mode.promptEntries),
    state.sendHistoryThoughts ? '1' : '0',
  ].join('\u0000')
}

function cwdOf(agent: Agent): string | undefined {
  return agent.session.header.cwd
}

/**
 * Create the prompt mode injector for one plugin instance. Installs the mode
 * section (+ the `graycode_prompt_mode` variable) on every targeted live
 * agent, arms the `agent/created` listener for later agents, and backfills
 * agents that predate the plugin load (HMR / late mount), mirroring
 * createPersonaRegistrar. `refresh()` is the mode-switch channel: it
 * recomputes fingerprints and re-registers only the agents whose state
 * actually changed (old disposer first, then the new section).
 *
 * @param ctx - the applying plugin context (`ctx.agents` must be live).
 * @param agentScope - `roots` installs only top-level agents; `all` includes
 *   subagents; `disabled` never registers.
 * @param getState - current render state; the injector reads it per install
 *   and per assembly (section text is a provider, so placeholder values stay
 *   fresh without re-registration).
 */
export function createPromptInjector(
  ctx: Context,
  agentScope: AgentScopeMode,
  getState: () => PromptRenderState,
): PromptInjector {
  if (agentScope === 'disabled') {
    return { refresh: () => {}, dispose: () => {} }
  }

  /** Agent -> its key + disposers; purged on agent disposal. */
  const installed = new Map<Agent, { key: string; disposers: ReadonlyArray<() => void> }>()
  let active = false
  let detachCreated: (() => void) | undefined
  let detachDisposed: (() => void) | undefined

  const targets = (agent: Agent): boolean =>
    agentScope === 'all' || ctx.agents.roots().some(root => root.id === agent.id)

  const disposeInstall = (agent: Agent): void => {
    const entry = installed.get(agent)
    if (!entry) return
    for (const dispose of entry.disposers) dispose()
    installed.delete(agent)
  }

  const install = (agent: Agent): void => {
    // dispose 后到达的调用（如 pending getCurrentMode().then 回调触发的 refresh）
    // 一律忽略：不得向存活 agent 泄漏 section 注册
    if (!active) return
    const state = getState()
    if (!state.mode) {
      disposeInstall(agent)
      return
    }
    const key = stateKey(state)
    const existing = installed.get(agent)
    if (existing && existing.key === key) return
    if (existing) disposeInstall(agent)

    const disposers: Array<() => void> = []
    try {
      // Push each registration separately: if variable() throws during
      // argument evaluation of a combined push(), the already-obtained
      // section disposer would be lost before push() ever runs.
      disposers.push(
        // Provider-style text: re-evaluated per assembly so placeholder values
        // are always current; mode switches re-register via refresh().
        agent.ctx.systemPrompt.section({
          name: PROMPT_SECTION_NAME,
          order: PROMPT_ORDER,
          text: () => renderStateText(getState(), cwdOf(agent)),
        }),
      )
      disposers.push(agent.ctx.systemPrompt.variable(PROMPT_MODE_VARIABLE, () => getState().mode?.name))
    } catch (error) {
      // 差距-2: unwind partial registration (e.g. section() succeeded but
      // variable() threw); otherwise the next refresh would re-register the
      // section and either leak or hit duplicate-name errors.
      for (const dispose of disposers) dispose()
      throw error
    }
    installed.set(agent, { key, disposers })
  }

  const deactivate = (): void => {
    if (!active) return
    active = false
    detachCreated?.()
    detachCreated = undefined
    detachDisposed?.()
    detachDisposed = undefined
    for (const agent of [...installed.keys()]) disposeInstall(agent)
  }

  const activate = (): void => {
    if (active) return
    active = true
    // `agent/created` dispatches with the new agent already in the registry.
    detachCreated = ctx.on('agent/created', ({ agent }) => {
      if (targets(agent)) install(agent)
    })
    // Purge entries for agents that die while this injector is live (their
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
  return {
    refresh: () => {
      // dispose 后置 active=false，pending 异步回调触发的 refresh 直接短路
      if (!active) return
      for (const agent of ctx.agents.list()) {
        if (targets(agent)) install(agent)
      }
    },
    dispose: deactivate,
  }
}
