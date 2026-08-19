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
  /**
   * Optional display name (UI only; not part of injection/fingerprint).
   * Defaults to "Prompt N" / "Chat History" in the UI when absent.
   */
  name?: string
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
export const BUILTIN_MODE_IDS = ['minimal', 'code', 'design', 'plan', 'ask', 'review'] as const

export type BuiltinModeId = (typeof BUILTIN_MODE_IDS)[number]

/**
 * 固定的 chat_history 定位条目 id（对齐原项目 1.5.4
 * backend/modules/settings/types/promptTypes.ts:63）。每个模式经归一化后
 * 恰好携带一个 chat_history 条目（service.ensureChatHistoryPromptEntry），
 * 自动补齐时使用本 id。
 */
export const CHAT_HISTORY_PROMPT_ENTRY_ID = 'chat-history'

/**
 * 默认动态上下文条目内容（原项目 DEFAULT_DYNAMIC_CONTEXT_TEMPLATE 的移植裁剪：
 * 仅保留本移植注入器可解析的 TODO_LIST / MEMORY 占位符——不可解析的旧模块会
 * 渲染成确定性提示文本）。镜像于 client 侧 promptModes/logic.ts 的同名常量。
 */
export const DEFAULT_DYNAMIC_CONTEXT_TEMPLATE = `This is the current turn's dynamic context information you can use. It may change between turns. Continue with the previous task if the information is not needed and ignore it.

{{$TODO_LIST}}

{{$MEMORY}}`

/**
 * 默认「系统提示词」条目内容（原项目 DEFAULT_SYSTEM_PROMPT_TEMPLATE 的移植
 * 裁剪：仅保留可解析的 {{$ENVIRONMENT}}）。镜像于 client 侧 promptModes/
 * logic.ts 的 DEFAULT_MINIMAL_SYSTEM_TEMPLATE。
 */
export const DEFAULT_MINIMAL_SYSTEM_PROMPT = `You are a professional programming assistant, proficient in multiple programming languages and frameworks.

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
