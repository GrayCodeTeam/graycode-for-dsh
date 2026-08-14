/**
 * GrayCode - preset entry orchestration (V2 §6.6.2 / §6.6.3, D-11 = c)
 *
 * fast-tavern style entry ordering and the fakeThought policy, extracted from
 * gray-code-plugin's PromptManager.getPromptContextBundle. Pure TS.
 *
 * D-11 decision (c) — system-prompt text injection, documented mapping:
 *
 * | Old Gray (1.5.4)                                    | DSH rc.6 (D-11 = c)                                  |
 * | --------------------------------------------------- | ---------------------------------------------------- |
 * | system entry merged into the system prompt          | merged into the mode's system text (kept)            |
 * | user entry → temporary user message in the request  | context paragraph `[GrayCode preset entry: role=user]` inside the system prompt |
 * | assistant entry → temporary model message           | context paragraph `[GrayCode preset entry: role=assistant]` inside the system prompt |
 * | chat_history entry → real-history insertion point   | position marker only (not rendered); the single system segment cannot honor history placement |
 * | fakeThought → typed thought part on the temp message | plain-text `[thinking]...[/thinking]` prefix in the paragraph body |
 * | send-side strip by channel sendHistoryThoughts      | injection-time gate: text is only written when the switch is on (no request-construction layer exists to strip later) |
 *
 * Consequences (known degradations): the model sees user/assistant preset
 * content as system text with role labels instead of real messages; fake
 * thoughts are not typed reasoning blocks and no channel policy can filter
 * them after injection.
 */

import { cleanupEmptyLines, renderPromptTemplate } from './template.ts'
import type { PromptEntry, PromptEntryRole, PromptMode } from './promptTypes.ts'

export interface FakeThoughtResult {
  /** The entry content, with the fake thought prefix applied when honored. */
  text: string
  /** Whether the fake thought text was included in `text`. */
  thoughtIncluded: boolean
}

/**
 * Fake-thought policy (D-11 = c, degraded shape).
 *
 * Old Gray appended the fake thought as a typed thought part
 * (`{ text, thought: true }`) of a temporary model message and stripped it at
 * the channel send side via the sendHistoryThoughts switch. DSH rc.6 has no
 * public request-construction injection point (P0-14 GAP), so the thought is
 * rendered as a plain-text `[thinking]` prefix and the send-side gate moves
 * to injection time: when the switch is off the thought text is never written.
 *
 * Only role=assistant entries with a non-empty fakeThought are affected.
 */
export function fakeThoughtPolicy(entry: PromptEntry, sendHistoryThoughts: boolean): FakeThoughtResult {
  // Old Gray trimmed the fake thought before attaching it
  // (PromptManager.ts:832-833): pure-whitespace thoughts count as absent and
  // surrounding whitespace never leaks into the injected text.
  const thought = entry.fakeThought?.trim()
  if (entry.role !== 'assistant' || !thought || thought.length === 0 || !sendHistoryThoughts) {
    return { text: entry.content, thoughtIncluded: false }
  }
  return {
    text: `[thinking]\n${thought}\n[/thinking]\n\n${entry.content}`,
    thoughtIncluded: true,
  }
}

/** One enabled entry in final render order. */
export interface AssembledBlock {
  id: string
  role: PromptEntryRole
  order: number
  /** Rendered body for system/user/assistant entries. */
  text?: string
  /** True for enabled chat_history entries (position markers, not rendered). */
  chatHistoryMarker?: boolean
}

export interface AssembleEntriesInput {
  /** The mode template text that system entries merge into. */
  systemText: string
  /**
   * Reserved for the future request-construction injection layer (old Gray
   * inserted the real history at chat_history markers). Under D-11 = c this
   * is currently unused: everything renders as one system segment.
   */
  chatHistoryText?: string
  /** D-11 = c fake-thought gate; see {@link fakeThoughtPolicy}. */
  sendHistoryThoughts?: boolean
}

export interface AssembleEntriesResult {
  /** Every enabled entry in render order (chat_history markers included). */
  blocks: AssembledBlock[]
  /** systemText plus merged system-entry bodies. */
  systemText: string
  /** Rendered user/assistant context paragraphs (the D-11 = c section bodies). */
  contextParagraphs: string[]
  /** Enabled chat_history marker count. */
  chatHistoryMarkers: number
}

/** Marker label that prefixes each user/assistant context paragraph. */
export function contextParagraphLabel(role: 'user' | 'assistant'): string {
  return `[GrayCode preset entry: role=${role}]`
}

/**
 * Assemble preset entries: sort by order (tie-break by id for determinism),
 * filter disabled, merge system entries into the system text, render
 * user/assistant entries as context paragraphs, and count chat_history
 * markers. Under D-11 = c everything lands in one system segment.
 */
export function assembleEntries(
  entries: readonly PromptEntry[],
  input: AssembleEntriesInput = { systemText: '' },
): AssembleEntriesResult {
  const enabled = entries
    .filter(entry => entry.enabled)
    .slice()
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))

  const blocks: AssembledBlock[] = []
  const systemParts: string[] = []
  const paragraphs: string[] = []
  let chatHistoryMarkers = 0

  for (const entry of enabled) {
    if (entry.role === 'chat_history') {
      blocks.push({ id: entry.id, role: entry.role, order: entry.order, chatHistoryMarker: true })
      chatHistoryMarkers += 1
      continue
    }
    if (entry.role === 'system') {
      const text = entry.content
      blocks.push({ id: entry.id, role: entry.role, order: entry.order, text })
      if (text.length > 0) systemParts.push(text)
      continue
    }
    const role = entry.role === 'assistant' ? 'assistant' : 'user'
    const policy = fakeThoughtPolicy(entry, input.sendHistoryThoughts ?? false)
    // Old Gray skipped entries whose rendered text was empty (PromptManager.ts:824-826):
    // an empty user/assistant body must not produce a bare labeled paragraph.
    if (policy.text.trim().length === 0) continue
    const paragraph = `${contextParagraphLabel(role)}\n${policy.text}`
    blocks.push({ id: entry.id, role: entry.role, order: entry.order, text: paragraph })
    paragraphs.push(paragraph)
  }

  const base = input.systemText
  const merged = base.length > 0 && systemParts.length > 0
    ? `${base}\n\n${systemParts.join('\n\n')}`
    : base.length > 0
      ? base
      : systemParts.join('\n\n')

  return {
    blocks,
    systemText: merged,
    contextParagraphs: paragraphs,
    chatHistoryMarkers,
  }
}

export interface RenderModeSectionOptions {
  /** D-11 = c fake-thought gate. */
  sendHistoryThoughts?: boolean
  /** `{{$MODULE}}` placeholder values (canonical module names). */
  placeholderValues?: Readonly<Record<string, string>>
}

/**
 * Compose the full system-prompt section text of a mode:
 * `[customPrefix] + [template + system entries + context paragraphs] +
 * [customSuffix]`, with `{{$MODULE}}` placeholders rendered. This is the
 * single D-11 = c injection unit (everything is system text).
 */
export function renderModeSectionText(
  mode: Pick<PromptMode, 'template' | 'customPrefix' | 'customSuffix' | 'promptEntries'>,
  options: RenderModeSectionOptions = {},
): string {
  const assembled = assembleEntries(mode.promptEntries, {
    systemText: mode.template,
    sendHistoryThoughts: options.sendHistoryThoughts,
  })
  const values = options.placeholderValues ?? {}
  const body = renderPromptTemplate(assembled.systemText, values)
  const paragraphs = assembled.contextParagraphs.map(paragraph => renderPromptTemplate(paragraph, values))

  const parts: string[] = []
  if (mode.customPrefix && mode.customPrefix.length > 0) parts.push(mode.customPrefix)
  if (body.length > 0) parts.push(body)
  parts.push(...paragraphs)
  if (mode.customSuffix && mode.customSuffix.length > 0) parts.push(mode.customSuffix)
  // Old Gray cleaned the whole assembled output; keep the same post-processing
  // so prefix/suffix internal blank runs never leak 3+ consecutive newlines.
  return cleanupEmptyLines(parts.join('\n\n'))
}
