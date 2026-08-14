/**
 * GrayCode - prompt domain type contract (V2 §6.6 / §P3F)
 *
 * PromptMode / PromptEntry mirror gray-code-plugin's promptModes +
 * types/promptTypes (fast-tavern style presets). This file holds only the
 * persisted shape and pure predicates; rendering and entry orchestration live
 * in template.ts / entries.ts / fingerprint.ts. No host imports.
 */

/** fast-tavern style ordered entry roles. */
export type PromptEntryRole = 'system' | 'user' | 'assistant' | 'chat_history'

/** One preset entry of a mode. */
export interface PromptEntry {
  /** Stable per-mode entry id (UI and manual edits reference it). */
  id: string
  role: PromptEntryRole
  /** Ascending render order within the mode. */
  order: number
  enabled: boolean
  content: string
  /**
   * Fake "thought" text. Only honored for role=assistant. Under D-11 (c) it
   * degrades to a plain-text prefix inside the system prompt — it is NOT a
   * typed thought part (see fakeThoughtPolicy in entries.ts).
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
}

/** Built-in mode ids; these modes seed the store and cannot be deleted. */
export const BUILTIN_MODE_IDS = ['code', 'design', 'plan', 'ask', 'review'] as const

export type BuiltinModeId = (typeof BUILTIN_MODE_IDS)[number]

export function isBuiltinModeId(id: string): boolean {
  return (BUILTIN_MODE_IDS as readonly string[]).includes(id)
}

/** Persisted envelope schema version (`<dataRoot>/prompt/modes.json`). */
export const PROMPT_MODE_STORE_VERSION = 1

/** Persisted envelope of the prompt settings store. */
export interface PromptModeStore {
  version: number
  currentModeId: string
  modes: PromptMode[]
}

/** Stable machine-readable error codes (tools/UI do not parse messages). */
export const PromptErrorCode = {
  MODE_NOT_FOUND: 'GRAY_PROMPT_MODE_NOT_FOUND',
  MODE_ID_CONFLICT: 'GRAY_PROMPT_MODE_ID_CONFLICT',
  BUILTIN_IMMUTABLE: 'GRAY_PROMPT_BUILTIN_IMMUTABLE',
  INVALID_PAYLOAD: 'GRAY_PROMPT_INVALID_PAYLOAD',
  STORAGE_CORRUPT: 'GRAY_PROMPT_STORAGE_CORRUPT',
  STORAGE_WRITE_FAILED: 'GRAY_PROMPT_STORAGE_WRITE_FAILED',
} as const

export type PromptErrorCodeValue = (typeof PromptErrorCode)[keyof typeof PromptErrorCode]

/** Prompt domain error carrying a stable code. */
export class PromptError extends Error {
  readonly code: PromptErrorCodeValue

  constructor(message: string, code: PromptErrorCodeValue) {
    super(message)
    this.name = 'PromptError'
    this.code = code
  }
}
