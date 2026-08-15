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
 * Host prompt override (waterfall): with overrideHostPrompt on, an
 * agent-scoped `system-prompt/assemble` listener keeps only the
 * `graycode:persona` and `graycode:prompt` sections, folds every removed host
 * section (harness identity, deployment persona, tool guidance, …) into the
 * `{{graycode_dsh_prompt}}` variable with `{{...}}` references neutralized
 * (values are output verbatim by the DSH renderer, so the model never sees a
 * bare reference), and drops host contexts — only `graycode.*` contexts
 * survive. The waterfall value is authoritative, the listener must `await
 * next()` (not calling it vetoes every other listener in the same scope) and
 * is fail-closed (any error falls back to the downstream continuation). The
 * listener never retains the assembly's AbortSignal.
 *
 * Tool manifest: `{{graycode_tools}}` (and the `{{tools}}` alias consumed by
 * domain/template.ts, which maps `{{$TOOLS}}` to `{{tools}}`) is set on EVERY
 * assembly — also when overrideHostPrompt is off — because every built-in
 * template carries `{{$TOOLS}}` and variable interpolation is strict
 * (unknown/undefined variables throw).
 *
 * Dynamic context: `graycode.todo` (order 10) and `graycode.memory` (order
 * 20) are registered as systemPrompt.context providers on the agent scope;
 * the DSH host persists each snapshot into history (user-role message) and
 * the client renders it automatically (ContextInjectionRow). The providers
 * return '' while their switch is off, which contributes nothing. The MEMORY
 * text comes from the memory domain's cross-domain service
 * (`graycode.memoryPrompt`, lazily fetched per assembly): custom
 * `memory.systemPrompt` when set, '' while `memory.enabled` is false, the
 * built-in note otherwise (absent service → built-in note).
 * `suppressRuntimeContext()` is deliberately NOT used — it would clear our
 * own contexts along with the host's.
 *
 * D-11 = c mapping (see domain/entries.ts for the full table):
 * - The mode's SYSTEM part (template + system entries + prefix/suffix) is ONE
 *   section text; user/assistant entries are blocks only — the thoughts domain
 *   projects them as real messages (request layer), and fakeThought becomes a
 *   typed reasoning block gated by the thoughts domain's sendHistoryThoughts
 *   switch (the options accepted by renderModeSectionText are deprecated
 *   compatibility no-ops).
 * - There is no public "list existing sections" API: re-registration works by
 *   keeping our own disposers and a fingerprint key per agent; identical
 *   state (same mode + template + entry fingerprint + switches) is skipped so
 *   HMR reloads and duplicate change events cannot double-inject.
 */

import * as os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssembleContext, AssembledSection, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { AgentScopeMode } from '../agentScope.ts'
import { MEMORY_PROMPT_SERVICE, type MemoryPromptService } from '../memory/index.ts'
import { renderModeSectionText } from './domain/entries.ts'
import { fingerprint } from './domain/fingerprint.ts'
import type { PromptMode } from './domain/promptTypes.ts'

/** Stable section name; registered per agent on its scoped context. */
export const PROMPT_SECTION_NAME = 'graycode:prompt'

/** Section order: immediately after the deployment persona (order 0). */
export const PROMPT_ORDER = 1

/** Variable exposing the current mode name (`{{graycode_prompt_mode}}`). */
export const PROMPT_MODE_VARIABLE = 'graycode_prompt_mode'

/**
 * Tool manifest variable (`{{graycode_tools}}`), set on every assembly —
 * unconditional, because every built-in template carries `{{$TOOLS}}`.
 */
export const TOOLS_VARIABLE = 'graycode_tools'

/**
 * Overridden host prompt variable (`{{graycode_dsh_prompt}}`), set only while
 * overrideHostPrompt is on (the neutralized text of every removed section).
 */
export const HOST_PROMPT_VARIABLE = 'graycode_dsh_prompt'

/** Dynamic context name: TODO snapshot (order 10). */
export const CONTEXT_TODO_NAME = 'graycode.todo'

/** Dynamic context name: memory capability note (order 20). */
export const CONTEXT_MEMORY_NAME = 'graycode.memory'

/** Snapshot of what should currently be injected (provided by the plugin). */
export interface PromptRenderState {
  /** Current mode; undefined → no prompt section is injected. */
  mode: PromptMode | undefined
  /** D-11 = c fake-thought gate (replaces the old send-side strip). */
  sendHistoryThoughts: boolean
  /**
   * A1 request layer: skip user/assistant context paragraphs — the thoughts
   * plugin injects them as real messages at the request-construction layer.
   * Optional for state providers that predate the flag (defaults to false).
   */
  requestLayer?: boolean
  /**
   * Host prompt override (default true): the injector's
   * `system-prompt/assemble` waterfall keeps only the `graycode:persona` and
   * `graycode:prompt` sections, folds every other host section into
   * `{{graycode_dsh_prompt}}` and drops non-graycode contexts. `false` leaves
   * the host prompt and its contexts untouched — the mode section simply
   * joins them (the tool manifest is still provided).
   */
  overrideHostPrompt?: boolean
  /** Dynamic context: `graycode.todo` TODO snapshot (default true). */
  dynamicTodo?: boolean
  /** Dynamic context: `graycode.memory` capability note (default true). */
  dynamicMemory?: boolean
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

/** Deterministic replacement for `{{...}}` groups found in host prompt text. */
const HOST_VARIABLE_OMITTED = '[host prompt variable omitted]'

/** Any complete `{{...}}` group (same shape dsh-system-prompt scans for). */
const GROUP_PATTERN = /\{\{[^{}]*\}\}/g

/**
 * Neutralize every `{{...}}` group in host section text. Host sections may
 * reference `{{cwd}}`/`{{model}}` etc.; once moved into
 * `{{graycode_dsh_prompt}}` the DSH renderer does NOT re-scan the value (it is
 * output verbatim), so replacing the groups here keeps the model from seeing
 * bare references.
 */
function neutralizeHostVariables(text: string): string {
  return text.replace(GROUP_PATTERN, HOST_VARIABLE_OMITTED)
}

/** A raw DSH todo entry as stored in `todo/write` events. */
interface DshTodoLike {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * Latest `todo/write` snapshot in the agent session (last-write-wins;
 * no record → empty list), mirroring the todo adapter's readTodos pattern.
 * Guarded against sessions without an events log (test doubles).
 */
function readTodoSnapshot(agent: Agent): DshTodoLike[] {
  const events = agent.session.events
  if (!Array.isArray(events)) return []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'todo/write') continue
    const data = event.data as { todos?: unknown }
    return Array.isArray(data?.todos) ? (data.todos as DshTodoLike[]) : []
  }
  return []
}

type TodoStatusKey = 'pending' | 'in_progress' | 'completed' | 'cancelled'

function isTodoStatusKey(value: unknown): value is TodoStatusKey {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'cancelled'
}

function normalizeTodoItems(raw: unknown): Array<{ content: string; status: TodoStatusKey }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ content: string; status: TodoStatusKey }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const content = (item as Record<string, unknown>).content
    const status = (item as Record<string, unknown>).status
    if (typeof content !== 'string') continue
    if (!isTodoStatusKey(status)) continue
    out.push({ content, status })
  }
  return out
}

/** Old Gray truncateText: collapse whitespace, trim, hard-cut with '…'. */
function truncateText(s: string, maxLen: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= maxLen) return t
  return t.slice(0, Math.max(0, maxLen - 1)) + '…'
}

const TODO_MAX_ITEMS = 50
const TODO_CONTENT_MAX = 200

/**
 * Format the todo snapshot for the model, aligned with old Gray
 * textUtils.formatTodoListText (DSH entries carry no id, so no `#id` suffix):
 * a `Total: N | pending: x | in_progress: y | completed: z | cancelled: w`
 * summary line, then `- [status] content` lines (content truncated at 200
 * chars), sorted in_progress < pending < completed < cancelled, capped at 50
 * items with `... and N more items.`. Empty list → ''.
 */
function formatTodoListText(raw: unknown): string {
  const todos = normalizeTodoItems(raw)
  if (todos.length === 0) return ''
  const order: Record<TodoStatusKey, number> = { in_progress: 0, pending: 1, completed: 2, cancelled: 3 }
  const sorted = [...todos].sort((a, b) => {
    const oa = order[a.status] ?? 9
    const ob = order[b.status] ?? 9
    if (oa !== ob) return oa - ob
    return a.content.localeCompare(b.content)
  })
  const counts: Record<TodoStatusKey, number> = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 }
  for (const t of todos) counts[t.status]++
  const shown = sorted.slice(0, TODO_MAX_ITEMS)
  const lines: string[] = [
    `Total: ${todos.length} | pending: ${counts.pending} | in_progress: ${counts.in_progress} | completed: ${counts.completed} | cancelled: ${counts.cancelled}`,
  ]
  for (const t of shown) lines.push(`- [${t.status}] ${truncateText(t.content, TODO_CONTENT_MAX)}`)
  if (sorted.length > shown.length) lines.push(`... and ${sorted.length - shown.length} more items.`)
  return lines.join('\n')
}

/**
 * Default MEMORY capability note (English): permanent memory via the memory_*
 * tools, global/workspace scopes, and when to use wake/note/recall. Used when
 * the memory domain's cross-domain service is absent or reports no custom
 * systemPrompt — the actual memory contents live behind the memory_* tools.
 */
const MEMORY_TEXT = [
  'Permanent Memory',
  'A permanent memory system is available through the memory_* tools (memory_wake, memory_note, memory_recall, memory_compress, memory_zoom, memory_forget, memory_config).',
  'Memories live in two scopes: "global" memories persist across every workspace and session, while "workspace" memories are tied to the current workspace.',
  'Call memory_wake at the start of every session to load what you already know, memory_note when you learn something worth keeping, and memory_recall to search past memories before answering.',
].join('\n\n')

/** Render the tool manifest text: one `- name: description` line per tool. */
function formatToolListText(tools: readonly { name: string; description: string }[]): string {
  return tools.map(tool => `- ${tool.name}: ${tool.description}`).join('\n')
}

/**
 * Default `{{$MODULE}}` values derivable from the agent session alone. The
 * ENVIRONMENT value mirrors the old static environment section
 * (contextSections.generateStaticEnvironmentSection + wrapSection): full
 * workspace path, operating system, timezone, user language and the
 * "respond in the user's language" instruction, wrapped
 * `====\n\nENVIRONMENT\n\n…`. TODO_LIST is the live todo snapshot and MEMORY
 * the memory-domain text (custom systemPrompt / enabled switch / built-in
 * note, resolved via the cross-domain service); both are only supplied while
 * their dynamic switches are on (off → key omitted, so the template renders
 * the deterministic "not available" notice instead).
 */
function defaultPlaceholderValues(agent: Agent, state: PromptRenderState, resolveMemoryText: () => string): Record<string, string> {
  const cwd = cwdOf(agent)
  const environment = [
    cwd ? `Current Workspace: ${cwd}` : 'No workspace open',
    `Operating System: ${osDescription()}`,
    `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    `User Language: ${userLanguage()}`,
    "Please respond using the user's language by default.",
  ].join('\n')
  const values: Record<string, string> = { ENVIRONMENT: `====\n\nENVIRONMENT\n\n${environment}` }
  if (state.dynamicTodo ?? true) values.TODO_LIST = formatTodoListText(readTodoSnapshot(agent))
  if (state.dynamicMemory ?? true) values.MEMORY = resolveMemoryText()
  return values
}

/** The rendered section text of a state (system part: template + prefix/suffix). */
function renderStateText(state: PromptRenderState, agent: Agent, resolveMemoryText: () => string): string {
  const mode = state.mode
  if (!mode) return ''
  return renderModeSectionText(mode, {
    // sendHistoryThoughts / requestLayer are deprecated no-ops in the current
    // renderer (entries-first: user/assistant entries and fake thoughts are
    // projected as real messages by the thoughts domain); kept for callers
    // that predate the refactor.
    sendHistoryThoughts: state.sendHistoryThoughts,
    requestLayer: state.requestLayer ?? false,
    placeholderValues: state.placeholderValues ?? defaultPlaceholderValues(agent, state, resolveMemoryText),
  })
}

/**
 * Dedup key: same mode id + template + entry fingerprint + switches means the
 * assembled section did not change; re-registration is skipped. The new
 * switches (overrideHostPrompt / dynamicTodo / dynamicMemory) are part of the
 * key so toggling them re-registers the per-agent registrations.
 */
function stateKey(state: PromptRenderState): string {
  const mode = state.mode
  if (!mode) return ''
  return [
    mode.id,
    mode.template,
    fingerprint(mode.promptEntries),
    state.sendHistoryThoughts ? '1' : '0',
    state.requestLayer ? '1' : '0',
    state.overrideHostPrompt !== false ? '1' : '0',
    state.dynamicTodo !== false ? '1' : '0',
    state.dynamicMemory !== false ? '1' : '0',
  ].join('\u0000')
}

function cwdOf(agent: Agent): string | undefined {
  return agent.session.header.cwd
}

/**
 * Create the prompt mode injector for one plugin instance. Installs the mode
 * section (+ the `graycode_prompt_mode` variable), the host-prompt override
 * waterfall and the dynamic contexts (graycode.todo / graycode.memory) on
 * every targeted live agent, arms the `agent/created` listener for later
 * agents, and backfills agents that predate the plugin load (HMR / late
 * mount), mirroring createPersonaRegistrar. `refresh()` is the mode-switch
 * channel: it recomputes fingerprints and re-registers only the agents whose
 * state actually changed (old disposer first, then the new registrations).
 *
 * @param ctx - the applying plugin context (`ctx.agents` must be live).
 * @param agentScope - `roots` installs only top-level agents; `all` includes
 *   subagents; `disabled` never registers.
 * @param getState - current render state; the injector reads it per install
 *   and per assembly (section text and context providers are providers, so
 *   placeholder values and dynamic snapshots stay fresh without
 *   re-registration).
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

  /**
   * Resolve the MEMORY text from the memory domain's cross-domain service
   * (lazily fetched per call so mount order and HMR restarts are picked up):
   * absent service → built-in static note; disabled → '' (nothing injected,
   * legacy parity with generateMemorySection); custom non-empty systemPrompt
   * → custom text; otherwise the built-in note.
   */
  const resolveMemoryText = (): string => {
    const svc = ctx.get(MEMORY_PROMPT_SERVICE) as MemoryPromptService | undefined
    if (!svc) return MEMORY_TEXT
    if (svc.isEnabled() === false) return ''
    const custom = svc.getSystemPrompt()
    return custom.length > 0 ? custom : MEMORY_TEXT
  }

  /**
   * The `system-prompt/assemble` waterfall listener (host prompt override).
   * Registered on the agent's scoped context, so it only receives that
   * agent's assemblies. Always sets the tool manifest variables; with
   * overrideHostPrompt it also keeps only the graycode sections, folds the
   * removed host sections into `{{graycode_dsh_prompt}}` and drops
   * non-graycode contexts. Fail-closed: any error falls back to `next()`.
   * The listener must not retain the assembly's AbortSignal — it does not
   * touch it.
   */
  const createAssembleListener = () => {
    return async (
      _assembly: PromptAssembly,
      _context: AssembleContext,
      next: () => Promise<PromptAssembly>,
    ): Promise<PromptAssembly> => {
      try {
        // `await next()` is mandatory: not calling it vetoes every other
        // listener in the same scope. The returned value is authoritative.
        const downstream = await next()
        const variables: Record<string, string | undefined> = { ...downstream.variables }
        // Tool manifest: unconditional. Every built-in template carries
        // `{{$TOOLS}}`, which domain/template.ts maps to `{{tools}}` and
        // defers to this waterfall — both names must always resolve (the DSH
        // renderer throws on unknown/undefined variables).
        const toolsText = formatToolListText(downstream.tools)
        variables[TOOLS_VARIABLE] = toolsText
        variables.tools = toolsText

        const state = getState()
        if ((state.overrideHostPrompt ?? true) === false) {
          // No override: the host prompt (sections + contexts) stays as-is;
          // only the tool manifest is added.
          return { ...downstream, variables }
        }

        // Host complete-section detection: a host section marked `complete` is
        // restored by the assembler as the SOLE prompt section after the
        // waterfall — the keep-only-graycode filtering below is overridden.
        // Warn only (fail-open, never intervene): the user must remove the
        // complete flag or disable the override.
        const [soleSection] = downstream.sections
        if (downstream.sections.length === 1 && soleSection && soleSection.name !== PROMPT_SECTION_NAME) {
          ctx.logger.warn(
            `[graycode-prompt] host complete section "${soleSection.name}" overrides prompt filtering (overrideHostPrompt ineffective); remove the complete flag or disable it`,
          )
        }

        // Keep only the graycode sections (empty text contributes nothing and
        // is skipped); everything else becomes the host prompt variable.
        const kept: AssembledSection[] = []
        const removed: AssembledSection[] = []
        for (const section of downstream.sections) {
          const isGray = section.name === 'graycode:persona' || section.name === PROMPT_SECTION_NAME
          if (section.text.trim().length === 0) continue
          if (isGray) kept.push(section)
          else removed.push(section)
        }
        variables[HOST_PROMPT_VARIABLE] = removed
          .map(section => neutralizeHostVariables(section.text))
          .join('\n\n')
        // Contexts: only our own survive (the host prompt they belonged to is
        // replaced; graycode.todo / graycode.memory are re-added on top).
        return {
          ...downstream,
          sections: kept,
          contexts: downstream.contexts.filter(context => context.name.startsWith('graycode.')),
          variables,
        }
      } catch {
        // Fail-closed: our transformation must never break the assembly —
        // fall back to the plain downstream continuation.
        return next()
      }
    }
  }

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
      // Push each registration separately: if a later registration throws
      // during argument evaluation, the already-obtained disposers are still
      // unwound by the catch below.
      disposers.push(
        // Host prompt override waterfall — registered FIRST so the other
        // registrations are composed inside its transform.
        agent.ctx.on('system-prompt/assemble', createAssembleListener()),
      )
      disposers.push(
        // Provider-style text: re-evaluated per assembly so placeholder values
        // (ENVIRONMENT / TODO_LIST / MEMORY) are always current; mode switches
        // re-register via refresh().
        agent.ctx.systemPrompt.section({
          name: PROMPT_SECTION_NAME,
          order: PROMPT_ORDER,
          text: () => renderStateText(getState(), agent, resolveMemoryText),
        }),
      )
      disposers.push(agent.ctx.systemPrompt.variable(PROMPT_MODE_VARIABLE, () => getState().mode?.name))
      disposers.push(
        // Dynamic context: TODO snapshot. Provider-style: empty text
        // contributes nothing; the host persists non-empty snapshots into
        // history and the client shows them as context rows.
        agent.ctx.systemPrompt.context({
          name: CONTEXT_TODO_NAME,
          order: 10,
          text: () => (getState().dynamicTodo ?? true) ? formatTodoListText(readTodoSnapshot(agent)) : '',
        }),
      )
      disposers.push(
        // Dynamic context: memory note. Text comes from the memory domain's
        // cross-domain service (custom systemPrompt / enabled switch); empty
        // text contributes nothing and the host persists non-empty snapshots
        // into history.
        agent.ctx.systemPrompt.context({
          name: CONTEXT_MEMORY_NAME,
          order: 20,
          text: () => (getState().dynamicMemory ?? true) ? resolveMemoryText() : '',
        }),
      )
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
