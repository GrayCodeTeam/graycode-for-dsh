/**
 * GrayCode - preset entry orchestration (V2 §6.6.2 / §6.6.3, entries-first)
 *
 * fast-tavern style entry ordering, extracted from gray-code-plugin's
 * PromptManager.getPromptContextBundle. Pure TS.
 *
 * Entry roles under the entries-first model (the D-11 = c system-text
 * injection path is retired):
 *
 * | role         | render path                                                              |
 * | ------------ | ------------------------------------------------------------------------ |
 * | system       | merged into the mode's system text (template + system entry bodies)      |
 * | user         | NOT rendered into system text — block with raw content only; the thoughts domain projects it as a real user message |
 * | assistant    | NOT rendered into system text — block with raw content only; the thoughts domain projects it as a real assistant message |
 * | chat_history | position marker block only; the thoughts domain places real history here |
 *
 * fakeThought is never rendered as text by this domain: there is no
 * thinking-tag prefix and no system-prompt paragraph path. The thoughts
 * domain owns the typed reasoning injection (gated by its sendHistoryThoughts
 * switch).
 */

import { cleanupEmptyLines, renderPromptTemplate } from './template.ts'
import type { PromptEntry, PromptEntryRole, PromptMode } from './promptTypes.ts'

/** One enabled entry in final render order. */
export interface AssembledBlock {
  id: string
  role: PromptEntryRole
  order: number
  /** Rendered body for system/user/assistant entries (raw content). */
  text?: string
  /** True for enabled chat_history entries (position markers, not rendered). */
  chatHistoryMarker?: boolean
}

export interface AssembleEntriesInput {
  /** The mode template text that system entries merge into. */
  systemText: string
}

export interface AssembleEntriesResult {
  /** Every enabled entry in render order (chat_history markers included). */
  blocks: AssembledBlock[]
  /** systemText plus merged system-entry bodies. */
  systemText: string
  /** Enabled chat_history marker count. */
  chatHistoryMarkers: number
}

/**
 * Assemble preset entries: sort by order (tie-break by id for determinism),
 * filter disabled, merge system entries into the system text, and count
 * chat_history markers. user/assistant entries only produce blocks carrying
 * their raw content — they never enter the system text (the thoughts domain
 * projects them as real messages, using the chat_history blocks as placement
 * anchors).
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
    // user/assistant: block only, text = raw content (fakeThought is never
    // folded in here — the thoughts domain handles it as a typed reasoning
    // block). Old Gray skipped entries whose rendered text was empty
    // (PromptManager.ts:824-826); keep the same skip so the block list stays
    // aligned with what the thoughts domain can project.
    const text = entry.content
    if (text.trim().length === 0) continue
    blocks.push({ id: entry.id, role: entry.role, order: entry.order, text })
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
    chatHistoryMarkers,
  }
}

export interface RenderModeSectionOptions {
  /**
   * @deprecated Ignored: fakeThought is never rendered as text by this domain
   * (the thoughts domain owns the sendHistoryThoughts gate). Kept so existing
   * callers keep compiling.
   */
  sendHistoryThoughts?: boolean
  /**
   * @deprecated Ignored: user/assistant entries never render into the system
   * text (blocks only). Kept so existing callers keep compiling.
   */
  requestLayer?: boolean
  /** `{{$MODULE}}` placeholder values (canonical module names). */
  placeholderValues?: Readonly<Record<string, string>>
}

/**
 * Compose the full system-prompt section text of a mode:
 * `[customPrefix] + [template + merged system entries] + [customSuffix]`,
 * with `{{$MODULE}}` placeholders rendered. user/assistant entries are not
 * part of the section text (the thoughts domain projects them as real
 * messages).
 */
export function renderModeSectionText(
  mode: Pick<PromptMode, 'template' | 'customPrefix' | 'customSuffix' | 'promptEntries'>,
  options: RenderModeSectionOptions = {},
): string {
  const assembled = assembleEntries(mode.promptEntries, { systemText: mode.template })
  const values = options.placeholderValues ?? {}
  const body = renderPromptTemplate(assembled.systemText, values)
  // BUG-01: customPrefix/customSuffix must take the same render path as the
  // body — a raw `{{$TOOLS}}`/`{{Foo}}` in them would otherwise survive into
  // the final section text and trip the DSH assembler's strict variable-name
  // validation (B3-P2), aborting the whole turn. The renderer replaces every
  // unresolvable reference with a deterministic notice and preserves only
  // DSH-safe lowercase variables (e.g. `{{graycode_prompt_mode}}`).
  const prefix = mode.customPrefix !== undefined ? renderPromptTemplate(mode.customPrefix, values) : ''
  const suffix = mode.customSuffix !== undefined ? renderPromptTemplate(mode.customSuffix, values) : ''

  const parts: string[] = []
  if (prefix.length > 0) parts.push(prefix)
  if (body.length > 0) parts.push(body)
  if (suffix.length > 0) parts.push(suffix)
  // Old Gray cleaned the whole assembled output; keep the same post-processing
  // so prefix/suffix internal blank runs never leak 3+ consecutive newlines.
  return cleanupEmptyLines(parts.join('\n\n'))
}
