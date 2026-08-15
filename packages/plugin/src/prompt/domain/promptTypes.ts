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
   * Fake "thought" text. Only honored for role=assistant. The prompt domain
   * never renders it as text (there is no system-prompt prefix path); the
   * thoughts domain projects it as a typed reasoning block, gated by its
   * sendHistoryThoughts switch.
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
   * Per-mode tool allowlist (D-4 persistence). When `toolPolicyCustomized` is
   * true the runtime uses this list verbatim; otherwise it falls back to the
   * built-in default for the mode id (workflows/domain/modeToolsPolicy.ts
   * resolveModeToolPolicy). undefined = no persisted policy.
   */
  toolPolicy?: string[]
  /**
   * Whether the user actively customized `toolPolicy`. false/undefined = the
   * runtime uses the built-in default for the mode id; true = the persisted
   * `toolPolicy` (including an explicit empty array = no filtering) is honored.
   */
  toolPolicyCustomized?: boolean
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
