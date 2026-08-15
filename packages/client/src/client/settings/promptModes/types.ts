/**
 * Prompt mode management — contract snapshot (client half).
 *
 * These types mirror the host prompt domain (`packages/plugin/src/prompt/
 * domain/promptTypes.ts`) and the documented `prompt` Remote namespace
 * contract (`modes.list` / `modes.get` / `modes.setCurrent` / `modes.create` /
 * `modes.update` / `modes.delete` / `modes.duplicate` / `modes.import` /
 * `modes.export`). They are hand-synced STRUCTURAL copies: the client bundle
 * must not import the plugin package (bundle purity gate), so every `read*`
 * helper below narrows the `unknown` wire defensively instead of trusting the
 * shape (same discipline as memoryManage/types.ts).
 *
 * Built-in modes (code/design/plan/ask/review) are seeded by the host and
 * cannot be renamed or deleted — the UI mirrors that protection.
 */

/** fast-tavern style ordered entry roles (mirrors host PromptEntryRole). */
export const PROMPT_ENTRY_ROLES = ['system', 'user', 'assistant', 'chat_history'] as const
export type PromptEntryRole = (typeof PROMPT_ENTRY_ROLES)[number]

const PROMPT_ENTRY_ROLE_SET: ReadonlySet<string> = new Set<string>(PROMPT_ENTRY_ROLES)

/** One preset entry of a mode (mirrors host PromptEntry). */
export interface PromptEntry {
  /** Stable per-mode entry id (UI and manual edits reference it). */
  id: string
  /**
   * Optional display name (UI only; the host keeps it for editor ergonomics
   * and it never participates in injection/fingerprint).
   */
  name?: string
  role: PromptEntryRole
  /** Ascending render order within the mode. */
  order: number
  enabled: boolean
  content: string
  /**
   * Fake "thought" text. Only honored for role=assistant; the thoughts domain
   * projects it as a typed reasoning block (never as text).
   */
  fakeThought?: string
}

export type PromptModeKind = 'builtin' | 'custom'

/** A prompt preset: template + prefix/suffix + ordered preset entries. */
export interface PromptMode {
  /** Stable mode id; builtin ids equal their names (code/design/plan/ask/review). */
  id: string
  /** User-visible name. */
  name: string
  kind: PromptModeKind
  /** Static system prompt template; may carry `{{$MODULE}}` placeholders. */
  template: string
  customPrefix?: string
  customSuffix?: string
  /** Ordered preset entries (system/user/assistant/chat_history). */
  promptEntries: PromptEntry[]
  /**
   * Per-mode tool allowlist. When `toolPolicyCustomized` is true the runtime
   * uses this list verbatim; otherwise it falls back to the built-in default
   * for the mode id. undefined = no persisted policy.
   */
  toolPolicy?: string[]
  /**
   * Whether the user actively customized `toolPolicy`. false/undefined = the
   * runtime uses the built-in default; true = the persisted `toolPolicy`
   * (including an explicit empty array = no filtering) is honored.
   */
  toolPolicyCustomized?: boolean
}

/** Built-in mode ids; these modes seed the store and cannot be deleted/renamed. */
export const BUILTIN_MODE_IDS = ['code', 'design', 'plan', 'ask', 'review'] as const

export function isBuiltinModeId(id: string): boolean {
  return (BUILTIN_MODE_IDS as readonly string[]).includes(id)
}

/** Persisted envelope schema version (`<dataRoot>/prompt/modes.json`). */
export const PROMPT_MODE_STORE_VERSION = 1

// ==================== Remote result shapes ====================

/** `prompt/modes.list` result. */
export interface PromptModeListResult {
  currentModeId: string
  modes: PromptMode[]
}

/** `prompt/modes.get|setCurrent|create|update|duplicate` result. */
export interface PromptModeResult {
  mode: PromptMode
}

/** `prompt/modes.delete` result. */
export interface PromptDeleteResult {
  ok: true
}

/** `prompt/modes.import` result: imported modes plus legacy-field notes. */
export interface PromptImportResult {
  modes: PromptMode[]
  warnings: string[]
}

/** `prompt/modes.export` result (versioned envelope, import-ready). */
export interface PromptExportResult {
  version: number
  modes: PromptMode[]
}

/** `prompt/modes.update` patch (mirrors host `updateMode` patch fields). */
export interface PromptModePatch {
  /** Omit for builtin modes — the host rejects renames with BUILTIN_IMMUTABLE. */
  name?: string
  template?: string
  promptEntries?: PromptEntry[]
  /** Only sent while customization is on; omitted = keep/ignore persisted value. */
  toolPolicy?: string[]
  toolPolicyCustomized?: boolean
}

// ==================== Defensive wire readers ====================

/** Narrow an unknown value to a prompt entry (strict: one bad field voids it). */
export function readPromptEntry(value: unknown): PromptEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0) return null
  if (typeof record.role !== 'string' || !PROMPT_ENTRY_ROLE_SET.has(record.role)) return null
  if (typeof record.order !== 'number' || !Number.isFinite(record.order)) return null
  if (typeof record.enabled !== 'boolean') return null
  if (typeof record.content !== 'string') return null
  if (record.name !== undefined && typeof record.name !== 'string') return null
  if (record.fakeThought !== undefined && typeof record.fakeThought !== 'string') return null
  const entry: PromptEntry = {
    id: record.id,
    role: record.role as PromptEntryRole,
    order: record.order,
    enabled: record.enabled,
    content: record.content,
  }
  if (typeof record.name === 'string' && record.name.length > 0) entry.name = record.name
  if (typeof record.fakeThought === 'string') entry.fakeThought = record.fakeThought
  return entry
}

/** Narrow an unknown value to a prompt mode (strict: one bad field voids it). */
export function readPromptMode(value: unknown): PromptMode | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0) return null
  if (typeof record.name !== 'string') return null
  if (record.kind !== 'builtin' && record.kind !== 'custom') return null
  if (typeof record.template !== 'string') return null
  if (!Array.isArray(record.promptEntries)) return null
  const promptEntries: PromptEntry[] = []
  for (const rawEntry of record.promptEntries) {
    const entry = readPromptEntry(rawEntry)
    if (entry === null) return null
    promptEntries.push(entry)
  }
  let toolPolicy: string[] | undefined
  if (record.toolPolicy !== undefined) {
    if (!Array.isArray(record.toolPolicy)) return null
    toolPolicy = []
    for (const rawTool of record.toolPolicy) {
      if (typeof rawTool !== 'string' || rawTool.trim().length === 0) return null
      toolPolicy.push(rawTool)
    }
  }
  if (record.toolPolicyCustomized !== undefined && typeof record.toolPolicyCustomized !== 'boolean') {
    return null
  }
  const mode: PromptMode = {
    id: record.id,
    name: record.name,
    kind: record.kind,
    template: record.template,
    promptEntries,
  }
  if (toolPolicy !== undefined) mode.toolPolicy = toolPolicy
  if (record.toolPolicyCustomized !== undefined) mode.toolPolicyCustomized = record.toolPolicyCustomized
  if (typeof record.customPrefix === 'string') mode.customPrefix = record.customPrefix
  if (typeof record.customSuffix === 'string') mode.customSuffix = record.customSuffix
  return mode
}

/** Narrow an unknown value to the modes.list result. */
export function readPromptModeListResult(value: unknown): PromptModeListResult | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.currentModeId !== 'string') return null
  if (!Array.isArray(record.modes)) return null
  const modes: PromptMode[] = []
  for (const rawMode of record.modes) {
    const mode = readPromptMode(rawMode)
    if (mode === null) return null
    modes.push(mode)
  }
  return { currentModeId: record.currentModeId, modes }
}

/** Narrow an unknown value to a `{ mode }` result. */
export function readPromptModeResult(value: unknown): PromptModeResult | null {
  if (typeof value !== 'object' || value === null) return null
  const mode = readPromptMode((value as Record<string, unknown>).mode)
  return mode === null ? null : { mode }
}

/** Narrow an unknown value to the delete result (must be `{ ok: true }`). */
export function readPromptDeleteResult(value: unknown): PromptDeleteResult | null {
  if (typeof value !== 'object' || value === null) return null
  return (value as Record<string, unknown>).ok === true ? { ok: true } : null
}

/** Narrow an unknown value to the import result. */
export function readPromptImportResult(value: unknown): PromptImportResult | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.modes)) return null
  const modes: PromptMode[] = []
  for (const rawMode of record.modes) {
    const mode = readPromptMode(rawMode)
    if (mode === null) return null
    modes.push(mode)
  }
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter((warning): warning is string => typeof warning === 'string')
    : []
  return { modes, warnings }
}

/** Narrow an unknown value to the export result. */
export function readPromptExportResult(value: unknown): PromptExportResult | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.version !== 'number' || !Number.isFinite(record.version)) return null
  if (!Array.isArray(record.modes)) return null
  const modes: PromptMode[] = []
  for (const rawMode of record.modes) {
    const mode = readPromptMode(rawMode)
    if (mode === null) return null
    modes.push(mode)
  }
  return { version: record.version, modes }
}
