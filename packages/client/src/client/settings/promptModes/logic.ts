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

/**
 * Create a fresh entry draft (assistant entries carry an empty fakeThought).
 * chat_history entries are position markers: fixed display name ("Chat
 * History", aligned with the original plugin's marker naming), no content.
 */
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
    // Default display name, editable in the UI (aligned with the original
    // plugin's "Prompt N" naming).
    name: role === 'chat_history' ? 'Chat History' : `Prompt ${entries.length + 1}`,
    content: '',
  }
  if (role === 'assistant') entry.fakeThought = ''
  return entry
}

/**
 * The default preset-entry skeleton every mode starts from (mirrors the
 * original Gray Code `convertLegacyTemplatesToEntries` trio): the system
 * prompt lives in the mode template (visible + editable in the mode editor),
 * the dynamic-context user entry carries the {{$TODO_LIST}}/{{$MEMORY}}
 * placeholders, and one chat_history marker anchors real history. Placeholders
 * are limited to what this port's injector resolves (ENVIRONMENT / TODO_LIST
 * / MEMORY) — unsupported legacy modules would render as deterministic
 * notices, so they are deliberately left out.
 */
/**
 * 默认「系统提示词」条目内容：原项目 DEFAULT_SYSTEM_PROMPT_TEMPLATE 的移植裁剪
 * （仅保留本移植注入器可解析的 {{$ENVIRONMENT}}；TOOLS 等由宿主变量另行承载，
 * 不可解析的旧模块会渲染成确定性提示文本，故省略）。
 */
export const DEFAULT_MINIMAL_SYSTEM_TEMPLATE = `You are a professional programming assistant, proficient in multiple programming languages and frameworks.

{{$ENVIRONMENT}}

====

GUIDELINES

- Use the provided tools to complete tasks. Tools can help you read files, search code, execute commands, and modify files.
- **IMPORTANT: Avoid blind duplicate tool calls.** Do not repeat the same failed call with identical parameters unless another tool call, a code change, or an external state change could reasonably affect the result. Re-running checks after relevant changes is allowed.
- When you need to understand the codebase, use read_file to examine specific files or search_in_files to find specific code patterns.
- For complex, multi-step work, use todo_write once to initialize/replace the TODO list, and todo_update for incremental updates (status/content) as you progress.
- For parallelizable investigations (or when you need to explore multiple areas quickly), use subagents to delegate focused sub-tasks.
- If the task is simple and doesn't require tools, just respond directly without calling any tools.
- Always maintain code readability and maintainability.
- Do not omit any code.`

/** Default dynamic-context entry body (original DEFAULT_DYNAMIC_CONTEXT_TEMPLATE, port-supported placeholders only). */
export const DEFAULT_DYNAMIC_CONTEXT_TEMPLATE = `This is the current turn's dynamic context information you can use. It may change between turns. Continue with the previous task if the information is not needed and ignore it.

{{$TODO_LIST}}

{{$MEMORY}}`

/**
 * 「恢复默认条目」骨架（对齐原项目 convertLegacyTemplatesToEntries 三件套与
 * 用户指定的顺序）：[系统提示词(system, 0), Chat History 定位条(1), 动态上下文
 * (user, 2)]。system 内容直接作为条目承载（模板会被「恢复默认」一并清空，避免
 * 与条目拼接成双份系统文本）。marker id 镜像宿主常量 CHAT_HISTORY_PROMPT_ENTRY_ID
 * （'chat-history'），保存后保持稳定的标记身份。
 */
export function defaultEntries(idFactory: () => string = () => crypto.randomUUID()): PromptEntry[] {
  const system: PromptEntry = {
    id: idFactory(),
    role: 'system',
    order: 0,
    enabled: true,
    name: '系统提示词',
    content: DEFAULT_MINIMAL_SYSTEM_TEMPLATE,
  }
  const marker = createEntry('chat_history', [system], idFactory)
  marker.id = 'chat-history'
  marker.order = 1
  const dynamic: PromptEntry = {
    id: idFactory(),
    role: 'user',
    order: 2,
    enabled: true,
    name: '动态上下文',
    content: DEFAULT_DYNAMIC_CONTEXT_TEMPLATE,
  }
  return [system, marker, dynamic]
}

/** Immutably patch one entry by id. */
export function updateEntry(
  entries: readonly PromptEntry[],
  id: string,
  patch: Partial<Pick<PromptEntry, 'name' | 'role' | 'enabled' | 'content' | 'fakeThought' | 'order'>>,
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

/**
 * Reorder `entries[sourceId]` to sit before/after `entries[targetId]` in
 * render order (drag & drop). Immutable; unknown ids return an unchanged
 * copy; all orders are renumbered 0..n-1 so the render order stays stable.
 */
export function reorderEntries(
  entries: readonly PromptEntry[],
  sourceId: string,
  targetId: string,
  position: 'before' | 'after',
): PromptEntry[] {
  if (sourceId === targetId) return entries.slice()
  const sorted = sortEntries(entries)
  const sourceIndex = sorted.findIndex(entry => entry.id === sourceId)
  if (sourceIndex < 0) return sorted
  const next = sorted.slice()
  const [source] = next.splice(sourceIndex, 1)
  if (source === undefined) return sorted
  const targetIndex = next.findIndex(entry => entry.id === targetId)
  if (targetIndex < 0) return sorted
  const insertAt = position === 'after' ? targetIndex + 1 : targetIndex
  next.splice(insertAt, 0, source)
  return next.map((entry, index) => ({ ...entry, order: index }))
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
 * meaningless `fakeThought`/empty `name` keys.
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
    if (entry.name !== undefined && entry.name.trim().length > 0) next.name = entry.name.trim()
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

/**
 * Read an import file (browser `File` from an `<input type="file">`) into text
 * for the import textarea. Pure-defensive: a missing/empty file selection or a
 * failed read resolves to `null` (the caller shows a file-read error), never
 * throws. Structural typing keeps this unit-testable in a node environment
 * (any `{ name, text() }` object works).
 */
export async function readImportFileText(
  file: { readonly name: string; text(): Promise<string> } | null | undefined,
): Promise<string | null> {
  if (file === null || file === undefined) return null
  if (typeof file.name !== 'string' || file.name.length === 0) return null
  try {
    const text = await file.text()
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

// ==================== Create / save patches ====================

/** Build `modes.create` args: trimmed name (host defaults the template). */
export function buildCreateModeArgs(name: string): { name: string } {
  return { name: name.trim() }
}

export interface ModeSavePatchInput {
  /** Trimmed before sending; omitted entirely when `includeName` is false. */
  name: string
  /** System-prompt template draft (textarea); always part of the patch. */
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
 * Build the `modes.update` patch from the editor draft. The system-prompt
 * template IS part of the patch (the mode editor exposes it as the「系统
 * 提示词」textarea — restoring parity with the original Gray template
 * editor; builtin templates may be edited, only id/kind are immutable).
 * While customization is off the patch omits `toolPolicy` entirely — the host
 * treats an absent policy as the built-in default (the "customized off ⇒
 * toolPolicy undefined" invariant).
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
