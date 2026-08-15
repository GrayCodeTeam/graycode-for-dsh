/**
 * Prompt mode management — pure UI logic (no React, no I/O).
 *
 * Everything the components need that can be expressed as a pure function
 * lives here so it can be unit-tested in a node environment:
 * - entry list math: sorting / ordering / move-up-down / add / remove / update;
 * - save payload construction (`buildModeSavePatch` — the single place that
 *   turns the editor draft into the `modes.update` patch);
 * - tool policy text <-> array conversion plus the common-tools preset list;
 * - import/export JSON parsing and serialization;
 * - create-mode argument building.
 *
 * The patch shape intentionally mirrors the host `modes.update` contract
 * (packages/plugin/src/prompt/service.ts `updateMode`): `name` must be
 * omitted for builtin modes (the host rejects it with BUILTIN_IMMUTABLE) and
 * `toolPolicy` is only sent while customization is on — the host treats an
 * absent policy as "use the built-in default" (the documented invariant that
 * a non-customized mode stores `toolPolicy: undefined`).
 */
import type { PromptEntry, PromptEntryRole, PromptMode, PromptModePatch } from './types.ts'

/**
 * Common-tools preset for the "select all common tools" helper. Mirrors the
 * GrayCode tool surface available to the model; the runtime allowlist is the
 * union of the user's current list and this preset, preserving user order.
 */
export const COMMON_TOOL_POLICY: readonly string[] = [
  'read_file',
  'list_files',
  'find_files',
  'search_in_files',
  'goto_definition',
  'find_references',
  'get_symbols',
  'history_search',
  'subagents',
  'memory_wake',
  'memory_note',
  'memory_recall',
  'memory_compress',
  'memory_zoom',
  'memory_forget',
  'memory_config',
  'create_design',
  'update_design',
  'create_plan',
  'update_plan',
  'create_progress',
  'update_progress',
  'record_progress_milestone',
  'validate_progress_document',
  'create_review',
  'record_review_milestone',
  'finalize_review',
  'reopen_review',
  'validate_review_document',
  'compare_review_documents',
  'todo_write',
  'todo_update',
] as const

// ==================== Entry list math ====================

/** Copy of `entries` sorted by ascending order (tie-break by id, stable). */
export function sortEntries(entries: readonly PromptEntry[]): PromptEntry[] {
  return entries
    .slice()
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/** Next order value for a new entry (max order + 1; 0 when empty). */
export function nextEntryOrder(entries: readonly PromptEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.order), -1) + 1
}

/** Create a fresh entry draft (assistant entries carry an empty fakeThought). */
export function createEntry(
  role: PromptEntryRole,
  entries: readonly PromptEntry[],
  idFactory: () => string = () => crypto.randomUUID(),
): PromptEntry {
  const entry: PromptEntry = {
    id: idFactory(),
    role,
    order: nextEntryOrder(entries),
    enabled: true,
    content: '',
  }
  if (role === 'assistant') entry.fakeThought = ''
  return entry
}

/** Immutably patch one entry by id. */
export function updateEntry(
  entries: readonly PromptEntry[],
  id: string,
  patch: Partial<Pick<PromptEntry, 'role' | 'enabled' | 'content' | 'fakeThought' | 'order'>>,
): PromptEntry[] {
  return entries.map(entry => {
    if (entry.id !== id) return entry
    const next = { ...entry, ...patch }
    if (patch.role !== undefined) {
      // fakeThought is only meaningful for assistant; drop it when the role
      // leaves assistant, seed it when the role becomes assistant.
      if (patch.role === 'assistant' && next.fakeThought === undefined) next.fakeThought = ''
      if (patch.role !== 'assistant') delete next.fakeThought
    }
    return next
  })
}

/** Immutably remove one entry by id. */
export function removeEntry(entries: readonly PromptEntry[], id: string): PromptEntry[] {
  return entries.filter(entry => entry.id !== id)
}

/**
 * Swap the order values of `entries[id]` and its neighbor in render order.
 * `direction` is -1 (up) or +1 (down); edge moves are no-ops. Unknown ids
 * return an unchanged copy.
 */
export function moveEntry(
  entries: readonly PromptEntry[],
  id: string,
  direction: -1 | 1,
): PromptEntry[] {
  const sorted = sortEntries(entries)
  const index = sorted.findIndex(entry => entry.id === id)
  if (index < 0) return sorted
  const target = index + direction
  if (target < 0 || target >= sorted.length) return sorted
  const current = sorted[index]!
  const neighbor = sorted[target]!
  const next = sorted.slice()
  next[index] = { ...neighbor, order: current.order }
  next[target] = { ...current, order: neighbor.order }
  return next
}

// ==================== Entry validation ====================

/** Structural problems that must be fixed before saving the entries. */
export type EntryValidationIssue = 'duplicate-id' | 'chat-history-content'

/**
 * Validate a draft entry list. Returns the deduplicated problem codes:
 * - `duplicate-id`: two entries share an id (breaks stable identity);
 * - `chat-history-content`: a chat_history marker carries content (the host
 *   ignores content on markers; the editor hides the content field for them,
 *   so this only surfaces imported/legacy payloads).
 */
export function validateEntries(entries: readonly PromptEntry[]): EntryValidationIssue[] {
  const issues: EntryValidationIssue[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.role === 'chat_history' && entry.content.trim().length > 0) {
      if (!issues.includes('chat-history-content')) issues.push('chat-history-content')
    }
    if (seen.has(entry.id)) {
      if (!issues.includes('duplicate-id')) issues.push('duplicate-id')
    }
    seen.add(entry.id)
  }
  return issues
}

/**
 * Build the `patch.promptEntries` payload: entries in render order with
 * renumbered orders (the editor is the authority for order) and no
 * meaningless `fakeThought` keys on non-assistant entries.
 */
export function buildEntriesSavePayload(entries: readonly PromptEntry[]): PromptEntry[] {
  return sortEntries(entries).map((entry, index) => {
    const next: PromptEntry = {
      id: entry.id,
      role: entry.role,
      order: index,
      enabled: entry.enabled,
      content: entry.content,
    }
    if (entry.fakeThought !== undefined && entry.role === 'assistant') {
      next.fakeThought = entry.fakeThought
    }
    return next
  })
}

// ==================== Tool policy ====================

/** Split a tools textarea (one tool name per line) into a deduped list. */
export function parseToolPolicyText(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of text.split(/\r?\n/u)) {
    const tool = raw.trim()
    if (tool.length === 0 || seen.has(tool)) continue
    seen.add(tool)
    result.push(tool)
  }
  return result
}

/** Join a tool list into textarea form (one tool name per line). */
export function toolPolicyText(tools: readonly string[]): string {
  return tools.join('\n')
}

/**
 * Union of the user's current list and the preset, preserving the user's
 * order and appending preset tools the user does not have yet (deduped).
 */
export function mergeToolPolicy(current: readonly string[], preset: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of [...current, ...preset]) {
    const tool = raw.trim()
    if (tool.length === 0 || seen.has(tool)) continue
    seen.add(tool)
    result.push(tool)
  }
  return result
}

// ==================== Import / export ====================

export type ParseImportPayloadResult =
  | { ok: true; payload: unknown }
  | { ok: false; reason: 'invalid-json' | 'not-object' | 'empty-payload' }

/**
 * Parse a pasted import payload. The host accepts a mode record, an array of
 * records, or a legacy SystemPromptConfig envelope, so the client only
 * requires valid JSON that is an object/array — the host owns the semantic
 * mapping and reports `warnings`.
 */
export function parseImportPayload(text: string): ParseImportPayloadResult {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'empty-payload' }
  let payload: unknown
  try {
    payload = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  // Accept plain objects and arrays alike (the host accepts a single mode
  // record, an array of records, or a legacy SystemPromptConfig envelope).
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: 'not-object' }
  }
  return { ok: true, payload }
}

/** Serialize an export result as copyable pretty JSON. */
export function serializeExportPayload(result: { version: number; modes: readonly PromptMode[] }): string {
  return JSON.stringify(result, null, 2)
}

// ==================== Create / save patches ====================

/** Build `modes.create` args: trimmed name; template omitted when empty. */
export function buildCreateModeArgs(name: string, template: string): { name: string; template?: string } {
  const trimmedName = name.trim()
  const trimmedTemplate = template.trim()
  return trimmedTemplate.length === 0
    ? { name: trimmedName }
    : { name: trimmedName, template: trimmedTemplate }
}

export interface ModeSavePatchInput {
  /** Trimmed before sending; omitted entirely when `includeName` is false. */
  name: string
  template: string
  entries: readonly PromptEntry[]
  toolPolicyCustomized: boolean
  /** Raw textarea value; parsed only while customization is on. */
  toolPolicyText: string
  /**
   * Builtin modes cannot be renamed on the host (BUILTIN_IMMUTABLE); pass
   * false to omit the name field from the patch.
   */
  includeName: boolean
}

/**
 * Build the `modes.update` patch from the editor draft. While customization
 * is off the patch omits `toolPolicy` entirely — the host treats an absent
 * policy as the built-in default (the "customized off ⇒ toolPolicy undefined"
 * invariant), so no `toolPolicy` key is sent.
 */
export function buildModeSavePatch(input: ModeSavePatchInput): PromptModePatch {
  const patch: PromptModePatch = {
    template: input.template,
    promptEntries: buildEntriesSavePayload(input.entries),
    toolPolicyCustomized: input.toolPolicyCustomized,
  }
  if (input.includeName) patch.name = input.name.trim()
  if (input.toolPolicyCustomized) patch.toolPolicy = parseToolPolicyText(input.toolPolicyText)
  return patch
}
