/**
 * GrayCode - PromptSettingsService (V2 §6.6.1 / §6.6.2)
 *
 * Mode CRUD (list/create/update/rename/duplicate/delete), JSON import/export,
 * currentModeId persistence and template normalization. The store lives at
 * `<dataRoot>/prompt/modes.json` (versioned envelope, atomic tmp+rename
 * writes with the Windows retry pattern of memory/domain/configFile.ts).
 *
 * Built-in modes (code/design/plan/ask/review) seed the store on first run;
 * they cannot be deleted or renamed (their ids are stable identity), but
 * their templates/entries may be edited like any other mode. The store is
 * lazy-loaded: every public method awaits the load before touching state, so
 * the plugin may fire-and-forget construction (same contract as branches).
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  BUILTIN_MODE_IDS,
  PROMPT_MODE_STORE_VERSION,
  PromptError,
  PromptErrorCode,
  type BuiltinModeId,
  type PromptEntry,
  type PromptEntryRole,
  type PromptErrorCodeValue,
  type PromptMode,
  type PromptModeKind,
  type PromptModeStore,
} from './domain/promptTypes.ts'
import { normalizeTemplate } from './domain/template.ts'

export const PROMPT_STORE_FILE = 'modes.json'

/** Change events emitted to subscribers (the injector re-registers on them). */
export type PromptChangeEvent = { type: 'mode-changed' } | { type: 'modes-changed' }

/** Result of an import: the imported modes plus human-readable legacy-field notes. */
export interface PromptImportResult {
  modes: PromptMode[]
  /**
   * Notes about legacy (Gray Code 1.5.4) fields that were dropped (no
   * new-format equivalent), remapped (`type:'chat_history'` →
   * `role:'chat_history'`, `dynamicTemplate` → user preset entry) or folded
   * (SystemPromptConfig envelope) during import. Empty when the payload had
   * no legacy-only fields.
   */
  warnings: string[]
}

export interface PromptSettingsConfig {
  /** Plugin-private data root; the store lives under `<dataRoot>/prompt/`. */
  dataRoot: string
}

const BUILTIN_ROLE: readonly PromptEntryRole[] = ['system', 'user', 'assistant', 'chat_history']

/** Legacy (Gray Code 1.5.4) entry fields with no new-format equivalent: dropped on import. */
const LEGACY_ENTRY_DROPPED_FIELDS = [] as const

/**
 * Legacy (Gray Code 1.5.4) mode fields with no new-format equivalent: dropped
 * on import (warnings). toolPolicy / toolPolicyCustomized are saved (per-mode
 * toolPolicy persistence); dynamicTemplate / dynamicTemplateEnabled are mapped
 * to a user preset entry (see parseModeRecord).
 */
const LEGACY_MODE_DROPPED_FIELDS = [
  'icon',
  'promptAssemblyMode',
  'dynamicContextStrategy',
] as const

/**
 * Default templates of the five built-in modes.
 *
 * Aligned with the Gray Code 1.5.4 built-in mode templates (D-1: align to
 * legacy, audit H1) — text is byte-identical to
 * `backend/modules/settings/promptModes.ts` (CODE_MODE_TEMPLATE /
 * DESIGN_MODE_TEMPLATE / PLAN_MODE_TEMPLATE / ASK_MODE_TEMPLATE /
 * REVIEW_MODE_TEMPLATE) modulo line endings (LF here). The templates carry
 * the legacy `{{$MODULE}}` placeholders; the new render pipeline resolves
 * them (see domain/template.ts): ENVIRONMENT is supplied by the injection
 * layer, TOOLS/MEMORY stay verbatim when no value is provided, and the
 * editor-only modules (CONTEXT_BADGE_FORMAT / MCP_TOOLS) are replaced by the
 * deterministic deprecation notice. Only the template text was replaced; the
 * rendering pipeline, placeholder mechanism and cleanupEmptyLines are
 * unchanged.
 */
export const BUILTIN_MODE_TEMPLATES: Record<BuiltinModeId, string> = {
  code: `You are a professional programming assistant, proficient in multiple programming languages and frameworks.

{{$ENVIRONMENT}}

{{$CONTEXT_BADGE_FORMAT}}

{{$TOOLS}}

{{$MCP_TOOLS}}

{{$MEMORY}}

====

GUIDELINES

- Use the provided tools to complete tasks. Tools can help you read files, search code, execute commands, and modify files.
- **IMPORTANT: Avoid blind duplicate tool calls.** Do not repeat the same failed call with identical parameters unless another tool call, a code change, or an external state change could reasonably affect the result. Re-running checks after relevant changes is allowed.
- When you need to understand the codebase, use read_file to examine specific files or search_in_files to find relevant code patterns.
- When you need to make changes, use apply_diff for targeted modifications or write_file for creating new files.
- If the conversation contains an approved implementation continuation (for example continuationApproved === true with continuationIntent === 'implement_now'), immediately start implementation and use the provided source artifact fields as the source of truth for reasoning, but only pass arguments that are explicitly defined by the tool you are calling.
- Treat legacy handoff fields such as planExecutionPrompt, planPath, or planContent as the same kind of approved implementation continuation when unified continuation fields are absent.
- Do not say that the plan is ready for review, and do not create another plan unless the user explicitly asks to revise it.
- For complex, multi-step work, use todo_write once to initialize/replace the TODO list, then use todo_update for incremental updates (status/content) as you progress.
- When TODO status changes in a meaningful way during approved implementation, call update_plan with updateMode: 'progress_sync' to sync the latest TODO snapshot back to the approved plan document.
- In progress_sync mode, only send path, todos, updateMode, and optional changeSummary. NEVER pass sourceArtifact or any continuation/source-artifact carry-over fields (sourceArtifactType, sourcePath, sourceContent, planPath, planContent, continuationPrompt, planExecutionPrompt, continuationApproved, continuationIntent). sourceArtifact is only valid for create_plan or update_plan with updateMode: 'revision'.

- If a TODO moves into in_progress, completed, or cancelled, sync the plan promptly.
- If the plan itself must change, use update_plan with updateMode: 'revision', then stop and wait for the user to confirm the revised plan.
- For parallelizable investigations (or when you need to explore multiple areas quickly), use subagents to delegate focused sub-tasks.
- If the task is simple and doesn't require tools, just respond directly without calling any tools.
- Always maintain code readability and maintainability.
- Do not omit any code.`,
  design: `You are a professional software architect and design consultant. Your primary role is to help users clarify requirements, design solutions, and plan implementation strategies.

{{$ENVIRONMENT}}

{{$CONTEXT_BADGE_FORMAT}}

{{$TOOLS}}

{{$MCP_TOOLS}}

{{$MEMORY}}

====

GUIDELINES

- Use the provided tools to complete tasks. Tools can help you read files, search code, execute commands, and modify files.
- **IMPORTANT: Avoid blind duplicate tool calls.** Do not repeat the same failed call with identical parameters unless another tool call, a code change, or an external state change could reasonably affect the result. Re-running checks after relevant changes is allowed.
- When you need to understand the codebase, use read_file to examine specific files or search_in_files to find relevant code patterns.
- When you need to make changes, use apply_diff for targeted modifications or write_file for creating new files.
- If the task is simple and doesn't require tools, just respond directly without calling any tools.
- Always maintain code readability and maintainability.
- Do not omit any code.

====

DESIGN MODE BEHAVIOR

**IMPORTANT: You are in DESIGN MODE. Follow these principles:**

1. **Communicate First**: Before making any code changes, discuss the design with the user. Ask clarifying questions about requirements, constraints, and preferences.

2. **Analyze and Plan**: When asked to implement something, first analyze the current codebase structure, identify potential approaches, and present options to the user.

3. **Seek Confirmation**: Always confirm your understanding of the requirements and proposed solution before proceeding with implementation.

4. **Minimal File Modifications**: Only write or modify files when:
   - The user explicitly requests implementation
   - You need to create design documents or diagrams
   - The user confirms they want you to proceed with changes

5. **Focus on Design Artifacts**: Prefer creating or discussing:
   - Architecture diagrams and flowcharts (in markdown/mermaid)
   - API specifications and interfaces
   - Data models and schemas
   - Implementation roadmaps and task breakdowns

6. **Iterative Refinement**: Work with the user to refine the design through multiple rounds of discussion before implementation.

7. **Create or Update Design Docs via Tool**: Use create_design for a new design document and update_design when revising an existing design document under .graycode/design/**.md.

8. **Stop After Writing Design Doc**: After calling create_design or update_design, STOP and wait for the user to review the design and decide whether to generate or update a plan.

9. **Do Not Skip to Plan or Code**: Do not create plan documents or perform implementation work directly in Design mode unless the user explicitly changes the workflow.`,
  plan: `You are a professional programming assistant, proficient in multiple programming languages and frameworks.

{{$ENVIRONMENT}}

{{$CONTEXT_BADGE_FORMAT}}

{{$TOOLS}}

{{$MCP_TOOLS}}

{{$MEMORY}}

====

PLAN MODE

**IMPORTANT: You are in PLAN MODE. Follow these principles:**

- Use the provided tools to analyze the codebase and create implementation plans.
- **IMPORTANT: Avoid blind duplicate tool calls.** Do not repeat the same failed call with identical parameters unless another tool call, a code change, or an external state change could reasonably affect the result. Re-running checks after relevant changes is allowed.
- When you need to understand the codebase, use read_file to examine specific files or search_in_files to find relevant code patterns.
- If the conversation contains an approved plan-generation continuation (for example continuationApproved === true with continuationIntent === 'generate_plan_now'), immediately create the plan and use sourceArtifactType, sourcePath, and sourceContent as the source of truth for reasoning, but only pass fields that are explicitly defined by the target tool schema.
- Treat legacy handoff fields such as planGenerationPrompt plus designPath/designContent or reviewPath/reviewContent as the same approved plan-generation continuation when unified continuation fields are absent.
- Once a plan-generation continuation is approved, do not ask for another confirmation and do not restate that the design or review is ready for review.
- When generating a plan from a confirmed design, include a clear section near the top of the plan that references the source design document path.
- When generating a plan from a confirmed review, include a clear section near the top of the plan that references the source review document path and the findings or follow-up items you are implementing.
- When generating a new plan from a confirmed design or review, call create_plan and pass sourceArtifact with the confirmed source type and path.
- Use create_plan to write the plan document in .graycode/plans/**.md.
- If the user asks to revise an existing plan document, use update_plan to rewrite the current .graycode/plans/**.md file instead of creating a second plan document.
- Use update_plan with updateMode: 'revision' when the plan structure changes. Use update_plan with updateMode: 'progress_sync' only when you are syncing TODO state without changing the plan itself.
- In progress_sync mode, only send path, todos, updateMode, and optional changeSummary. NEVER pass sourceArtifact or any continuation/source-artifact carry-over fields (sourceArtifactType, sourcePath, sourceContent, planPath, planContent, continuationPrompt, planExecutionPrompt, continuationApproved, continuationIntent). sourceArtifact is only valid for create_plan or update_plan with updateMode: 'revision'.
- **MANDATORY: When calling create_plan or update_plan, you MUST provide the "todos" argument.** This will automatically keep the plan TODO section synchronized for the user.
- After creating or updating the plan, STOP and wait for the user to review and confirm the latest plan before doing any implementation work. The user will click the "Execute Plan" button on the plan card to confirm.
- You can use subagents for focused planning sub-tasks, but stay within the allowed tools and do not modify code.
- Focus on creating detailed implementation plans and task breakdowns.
- Do not modify actual code files directly. Only create plan documents.
- Always maintain code readability and maintainability in your plans.
- Do not omit any code.`,
  ask: `You are a professional programming assistant, proficient in multiple programming languages and frameworks.

{{$ENVIRONMENT}}

{{$CONTEXT_BADGE_FORMAT}}

{{$TOOLS}}

{{$MCP_TOOLS}}

====

ASK MODE

**IMPORTANT: You are in ASK MODE. Follow these principles:**

- Use the provided tools to read and analyze the codebase to answer questions.
- **IMPORTANT: Avoid blind duplicate tool calls.** Do not repeat the same failed call with identical parameters unless another tool call, a code change, or an external state change could reasonably affect the result. Re-running checks after relevant changes is allowed.
- When you need to understand the codebase, use read_file to examine specific files or search_in_files to find relevant code patterns.
- You can only use the tools provided in the current mode. You may only write TODO list files; you cannot modify code or execute commands.
- Focus on providing accurate answers based on code analysis.
- Always maintain code readability and maintainability in your responses.`,
  review: `You are a professional programming assistant, proficient in multiple programming languages and frameworks.

{{$ENVIRONMENT}}

{{$CONTEXT_BADGE_FORMAT}}

{{$TOOLS}}

{{$MCP_TOOLS}}

{{$MEMORY}}

====

REVIEW MODE

**IMPORTANT: You are in REVIEW MODE. Follow these principles:**

- Review the current workspace end-to-end using the provided read and analysis tools, but do the work incrementally instead of reading everything first and writing the review only at the end.
- **IMPORTANT: Avoid blind duplicate tool calls.** Do not repeat the same failed call with identical parameters unless another tool call, a code change, or an external state change could reasonably affect the result. Re-running checks after relevant changes is allowed.
- At the start of each complete review run, use create_review to create exactly one review document under .graycode/review/**.md.
- Record the date in the review document header. The filename does not need to contain the date.
- In V4, the trailing Review Snapshot JSON is the single source of truth. Keep the Markdown body aligned with that snapshot-driven lifecycle.
- Track progress by milestones only. Do not use TODO comments or TODO lists as the review progress model.
- Do not postpone review writing until after you have read the entire target area or the entire workspace.
- Work step by step: after you finish reviewing one meaningful module-level or system-level review unit, immediately use record_review_milestone to append a new milestone to the same review document before moving on.
- Keep the review document synchronized with the actual investigation sequence. Do not batch many completed modules into one delayed update.
- Do not create milestone noise for very small observations, small functions, or isolated style details.
- When you pass structuredFindings to record_review_milestone, keep title short and issue-oriented. Do not put full evidence sentences, file paths, recommendations, or multiple clauses into the title.
- Put detailed analysis into structuredFindings[].description, follow-up action into structuredFindings[].recommendation, and file or line references into structuredFindings[].evidence or evidenceFiles.
- If you do not already have a short stable finding id, omit structuredFindings[].id and let the tool generate it. Do not build ids by copying a full sentence title.
- Review mode is read-only for code. You may read and analyze the workspace, but you must not modify business code.
- You may only write review documents under .graycode/review/**.md.
- One complete review run must correspond to one review document.
- You can use subagents for focused review work, but stay within the allowed tools and keep the workflow read-only for code.
- Use validate_review_document when you need to diagnose review document consistency without modifying the file.
- When the review is complete, use finalize_review to write the final conclusion and stop. After finalization, do not record more milestones unless you explicitly reopen the same review with reopen_review.`,
}

function createBuiltinModes(): PromptMode[] {
  return BUILTIN_MODE_IDS.map(id => ({
    id,
    name: id,
    kind: 'builtin' as const,
    template: BUILTIN_MODE_TEMPLATES[id],
    promptEntries: [],
  }))
}

function newModeId(): string {
  return `mode-${crypto.randomUUID()}`
}

function newEntryId(): string {
  return `entry-${crypto.randomUUID()}`
}

/** Normalize one entry's text fields (content + fakeThought). */
function normalizeEntry(entry: PromptEntry): PromptEntry {
  return {
    ...entry,
    content: normalizeTemplate(entry.content),
    fakeThought: entry.fakeThought !== undefined ? normalizeTemplate(entry.fakeThought) : undefined,
  }
}

/** Validate + normalize a mode toolPolicy allowlist (array of non-empty strings). */
function normalizeToolPolicy(value: unknown, errorCode: PromptErrorCodeValue): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new PromptError('mode toolPolicy must be an array of non-empty strings', errorCode)
  }
  const result: string[] = []
  for (const element of value) {
    if (typeof element !== 'string' || element.trim().length === 0) {
      throw new PromptError('mode toolPolicy must contain only non-empty strings', errorCode)
    }
    result.push(element.trim())
  }
  return result
}

/** Validate + normalize the toolPolicyCustomized flag. */
function normalizeToolPolicyCustomized(value: unknown, errorCode: PromptErrorCodeValue): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new PromptError('mode toolPolicyCustomized must be a boolean', errorCode)
  }
  return value
}

/**
 * Build the user preset entry that carries a legacy dynamicTemplate: order is
 * one slot before the first (lowest-order) chat_history marker, mirroring the
 * old "dynamic context before history" placement; 0 when no marker exists.
 */
function dynamicTemplateUserEntry(content: string, entries: readonly PromptEntry[]): PromptEntry {
  const chatHistoryOrders = entries
    .filter(entry => entry.role === 'chat_history')
    .map(entry => entry.order)
  const order = chatHistoryOrders.length > 0 ? Math.min(...chatHistoryOrders) - 1 : 0
  return { id: newEntryId(), role: 'user', order, enabled: true, content }
}

/** Deep-copy a mode preserving entry ids (reads / exports). */
function deepCopyMode(mode: PromptMode): PromptMode {
  return {
    ...mode,
    toolPolicy: mode.toolPolicy !== undefined ? [...mode.toolPolicy] : undefined,
    promptEntries: mode.promptEntries.map(entry => ({ ...entry })),
  }
}

/** Deep-copy a mode with fresh ids for the copy (duplicate/imports). */
function copyWithNewIds(mode: PromptMode): PromptMode {
  return {
    ...mode,
    toolPolicy: mode.toolPolicy !== undefined ? [...mode.toolPolicy] : undefined,
    promptEntries: mode.promptEntries.map(entry => ({
      ...entry,
      id: newEntryId(),
    })),
  }
}

/**
 * Validate + normalize one entry record (shared by store load and import).
 *
 * Legacy (Gray Code 1.5.4) entries express the history insertion point via
 * `type: 'chat_history'` (role stays system/user/assistant); the new role
 * model has a dedicated `chat_history` role, so the type is mapped directly
 * (a warning records the mapping). Legacy fields without a new-format
 * equivalent (e.g. the display `name`) are silently dropped and reported
 * through `warnings` (store load passes a throwaway array).
 *
 * @param errorCode - INVALID_PAYLOAD for import payloads, STORAGE_CORRUPT
 *   for persisted store records (parseStore).
 */
function parseEntryRecord(
  raw: unknown,
  errorCode: PromptErrorCodeValue,
  warnings: string[],
): PromptEntry {
  if (typeof raw !== 'object' || raw === null) {
    throw new PromptError('prompt entry must be an object', errorCode)
  }
  const record = raw as Record<string, unknown>
  let role = record.role
  if (record.type === 'chat_history') {
    role = 'chat_history'
    warnings.push('entry mapped legacy type:chat_history to role:chat_history')
  } else if (typeof role !== 'string' || !(BUILTIN_ROLE as readonly string[]).includes(role)) {
    throw new PromptError(`entry role must be one of ${BUILTIN_ROLE.join('/')}`, errorCode)
  }
  const content = record.content
  if (typeof content !== 'string') {
    throw new PromptError('entry content must be a string', errorCode)
  }
  const name = record.name
  if (name !== undefined && typeof name !== 'string') {
    throw new PromptError('entry name must be a string', errorCode)
  }
  const fakeThought = record.fakeThought
  if (fakeThought !== undefined && typeof fakeThought !== 'string') {
    throw new PromptError('entry fakeThought must be a string', errorCode)
  }
  const order = record.order
  if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order))) {
    throw new PromptError('entry order must be a finite number', errorCode)
  }
  const dropped = LEGACY_ENTRY_DROPPED_FIELDS.filter(field => record[field] !== undefined)
  if (dropped.length > 0) {
    warnings.push(`entry dropped legacy field(s): ${dropped.join(', ')}`)
  }
  return {
    id: typeof record.id === 'string' && record.id.length > 0 ? record.id : newEntryId(),
    role: role as PromptEntryRole,
    order: typeof order === 'number' ? order : 0,
    enabled: record.enabled !== false,
    name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined,
    content: normalizeTemplate(content),
    fakeThought: fakeThought !== undefined ? normalizeTemplate(fakeThought) : undefined,
  }
}

interface ParseModeOptions {
  /** Error code for malformed records: INVALID_PAYLOAD (import) / STORAGE_CORRUPT (store load). */
  errorCode: PromptErrorCodeValue
  /** Ids already claimed by earlier modes; colliding ids are regenerated (import). */
  existingIds: ReadonlySet<string> | undefined
  /** Import surfaces legacy-field notes here; store load passes a throwaway array. */
  warnings: string[]
  /** Import forces kind:'custom'; store load preserves a valid persisted kind. */
  forceCustomKind: boolean
  /**
   * Store load requires the full persisted shape: id / template / promptEntries
   * are identity-bearing and every write path emits them, so a missing field
   * is corruption (STORAGE_CORRUPT). Import tolerates partial payloads.
   */
  requireFullShape: boolean
}

/**
 * Validate + normalize one mode record. Shared by import (parseImportedMode)
 * and store load (parseStore): template / prefix / suffix / entries run
 * through the same checks and normalization so both paths stay consistent.
 * Import regenerates missing/colliding ids and forces kind:'custom'; store
 * load treats ids as persisted identity and keeps the persisted kind so
 * builtin protection survives a reload.
 */
function parseModeRecord(raw: unknown, options: ParseModeOptions): PromptMode {
  if (typeof raw !== 'object' || raw === null) {
    throw new PromptError('prompt mode must be an object', options.errorCode)
  }
  const record = raw as Record<string, unknown>
  const name = record.name
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new PromptError('mode name must be a non-empty string', options.errorCode)
  }
  const template = record.template
  if (template !== undefined && typeof template !== 'string') {
    throw new PromptError('mode template must be a string', options.errorCode)
  }
  if (options.requireFullShape && template === undefined) {
    throw new PromptError('mode template is required', options.errorCode)
  }
  const customPrefix = record.customPrefix
  const customSuffix = record.customSuffix
  if (customPrefix !== undefined && typeof customPrefix !== 'string') {
    throw new PromptError('mode customPrefix must be a string', options.errorCode)
  }
  if (customSuffix !== undefined && typeof customSuffix !== 'string') {
    throw new PromptError('mode customSuffix must be a string', options.errorCode)
  }
  const rawEntries = record.promptEntries
  if (options.requireFullShape && rawEntries === undefined) {
    throw new PromptError('mode promptEntries is required', options.errorCode)
  }
  const entries = rawEntries !== undefined ? rawEntries : []
  if (!Array.isArray(entries)) {
    throw new PromptError('mode promptEntries must be an array', options.errorCode)
  }
  const rawId = record.id
  let id: string
  if (typeof rawId === 'string' && rawId.length > 0) {
    id = rawId
    if (options.existingIds?.has(id)) id = newModeId()
  } else if (options.requireFullShape) {
    throw new PromptError('mode id must be a non-empty string', options.errorCode)
  } else {
    id = newModeId()
  }
  const dropped = LEGACY_MODE_DROPPED_FIELDS.filter(field => record[field] !== undefined)
  if (dropped.length > 0) {
    options.warnings.push(`mode "${name.trim()}": dropped legacy field(s): ${dropped.join(', ')}`)
  }
  // Legacy promptAssemblyMode: in Gray Code 1.5.4 a 'legacy' mode never
  // activated its promptEntries (only 'entries' did). Every imported mode is
  // entries-first now, so previously dormant entries become active — surface
  // the behavior change.
  if (record.promptAssemblyMode === 'legacy') {
    options.warnings.push(
      `mode "${name.trim()}": legacy promptAssemblyMode 'legacy' means its promptEntries never took effect in Gray Code 1.5.4; they become active after import`,
    )
  }
  // Per-mode toolPolicy persistence (D-4): validated and saved instead of
  // dropped; resolveModeToolPolicy decides runtime use via toolPolicyCustomized.
  const toolPolicy = normalizeToolPolicy(record.toolPolicy, options.errorCode)
  const toolPolicyCustomized = normalizeToolPolicyCustomized(record.toolPolicyCustomized, options.errorCode)
  // Legacy dynamicTemplate (enabled + non-empty) maps to a real user preset
  // entry: under the entries-first model the dynamic context is a user entry
  // the thoughts domain projects as a real message. Order = one slot before
  // the first (lowest-order) chat_history marker, mirroring the old
  // "dynamic context before history" placement; 0 when no marker exists.
  let parsedEntries = entries.map(entry => parseEntryRecord(entry, options.errorCode, options.warnings))
  if (record.dynamicTemplateEnabled === true && typeof record.dynamicTemplate === 'string' && record.dynamicTemplate.trim().length > 0) {
    parsedEntries = [
      ...parsedEntries,
      dynamicTemplateUserEntry(normalizeTemplate(record.dynamicTemplate), parsedEntries),
    ]
    options.warnings.push(`mode "${name.trim()}": mapped legacy dynamicTemplate (enabled) to a user preset entry`)
  }
  return {
    id,
    name: name.trim(),
    // Imported modes are always custom (builtin ids are host-seeded identity);
    // store load preserves the persisted kind so builtin protection survives.
    kind: options.forceCustomKind ? 'custom' : record.kind === 'builtin' ? 'builtin' : 'custom',
    template: normalizeTemplate(template ?? ''),
    customPrefix: customPrefix !== undefined ? normalizeTemplate(customPrefix) : undefined,
    customSuffix: customSuffix !== undefined ? normalizeTemplate(customSuffix) : undefined,
    toolPolicy,
    toolPolicyCustomized,
    promptEntries: parsedEntries,
  }
}

/**
 * Validate + normalize one imported mode; ids colliding with existing ones
 * (or with earlier modes of the same payload) are regenerated. Legacy
 * (1.5.4) mode fields without a new-format equivalent are silently dropped
 * and reported through `warnings`.
 */
function parseImportedMode(raw: unknown, existingIds: ReadonlySet<string>, warnings: string[]): PromptMode {
  return parseModeRecord(raw, {
    errorCode: PromptErrorCode.INVALID_PAYLOAD,
    existingIds,
    warnings,
    forceCustomKind: true,
    requireFullShape: false,
  })
}

/**
 * Detect a SystemPromptConfig envelope (old Gray `system_prompt` export):
 * - `modes` present as a Record (not an array), or
 * - top-level `currentModeId` (a config-only field), or
 * - top-level `template` / `dynamicTemplate` without single-mode markers
 *   (`name` / `id` / `promptEntries`) — covers old-version configs that had
 *   no `modes` map at all. Single mode records always carry `name` (and
 *   usually `id` / `promptEntries`), so they are never misclassified.
 */
function isSystemPromptConfigShape(payload: unknown): payload is Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false
  const record = payload as Record<string, unknown>
  if (record.modes !== undefined) {
    return typeof record.modes === 'object' && record.modes !== null && !Array.isArray(record.modes)
  }
  if (record.currentModeId !== undefined) return true
  if (record.dynamicTemplate !== undefined || record.template !== undefined) {
    return record.name === undefined && record.id === undefined && record.promptEntries === undefined
  }
  return false
}

/**
 * Windows rename-overwrite retry (mirrors memory/domain/configFile.ts):
 * transient EPERM/EACCES/EBUSY are retried with backoff; when exhausted and
 * the target exists (EEXIST/EPERM), unlink the old file and rename once more.
 */
export async function renameStoreOverwrite(tmpPath: string, storePath: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(tmpPath, storePath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'EEXIST') {
        throw error
      }
      if (attempt >= 4) {
        if (code === 'EEXIST' || code === 'EPERM') {
          try {
            await fs.unlink(storePath)
          } catch {
            // The final rename surfaces the real error if the target is gone
          }
          await fs.rename(tmpPath, storePath)
          return
        }
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 30 * attempt))
    }
  }
}

export class PromptSettingsService {
  private readonly rootDir: string
  private readonly storePath: string
  private store: PromptModeStore | undefined
  private loadPromise: Promise<void> | undefined
  private readonly listeners = new Set<(event: PromptChangeEvent) => void>()
  /** In-process serialized mutations (keeps single-process writes ordered). */
  private mutationChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly config: PromptSettingsConfig) {
    this.rootDir = path.join(config.dataRoot, 'prompt')
    this.storePath = path.join(this.rootDir, PROMPT_STORE_FILE)
  }

  /** Lazy load: ENOENT seeds builtins; corrupted stores fail loudly. */
  private ensureLoaded(): Promise<void> {
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = (async () => {
      try {
        const raw = await fs.readFile(this.storePath, 'utf8')
        this.store = this.parseStore(raw)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.store = this.seedStore()
          await this.persist()
        } else {
          throw error
        }
      }
    })()
    return this.loadPromise
  }

  private seedStore(): PromptModeStore {
    return {
      version: PROMPT_MODE_STORE_VERSION,
      currentModeId: BUILTIN_MODE_IDS[0] as string,
      modes: createBuiltinModes(),
    }
  }

  private parseStore(raw: string): PromptModeStore {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new PromptError('prompt modes store is not valid JSON', PromptErrorCode.STORAGE_CORRUPT)
    }
    const record = parsed as { version?: unknown; currentModeId?: unknown; modes?: unknown }
    if (record.version !== PROMPT_MODE_STORE_VERSION || !Array.isArray(record.modes)) {
      throw new PromptError(
        `prompt modes store has an unsupported shape (expected version ${PROMPT_MODE_STORE_VERSION})`,
        PromptErrorCode.STORAGE_CORRUPT,
      )
    }
    const currentModeId = typeof record.currentModeId === 'string' ? record.currentModeId : (BUILTIN_MODE_IDS[0] as string)
    // BUG-02: per-mode validation + normalization instead of a blind cast — a
    // mode missing `template` or carrying `promptEntries: null` used to
    // surface as a bare TypeError at the first read point (deepCopyMode /
    // promptInjector.getState → agent/created). Invalid records now fail
    // loudly with STORAGE_CORRUPT; ids are store identity and must be unique.
    const modes: PromptMode[] = []
    const seenIds = new Set<string>()
    for (const [index, rawMode] of record.modes.entries()) {
      let mode: PromptMode
      try {
        mode = parseModeRecord(rawMode, {
          errorCode: PromptErrorCode.STORAGE_CORRUPT,
          existingIds: undefined,
          warnings: [],
          forceCustomKind: false,
          requireFullShape: true,
        })
      } catch (error) {
        throw new PromptError(
          `prompt modes store mode #${index} is corrupt: ${error instanceof Error ? error.message : String(error)}`,
          PromptErrorCode.STORAGE_CORRUPT,
        )
      }
      if (seenIds.has(mode.id)) {
        throw new PromptError(`prompt modes store has duplicate mode id "${mode.id}"`, PromptErrorCode.STORAGE_CORRUPT)
      }
      seenIds.add(mode.id)
      modes.push(mode)
    }
    // L6：currentModeId 必须引用已存在的 mode——手改 store 产生悬垂引用时回退到
    // 首个内置模式（与 getCurrentMode/currentModeSnapshot 的既有回退语义一致），
    // 而不是把悬垂 id 留在内存快照里。合法 store 的 currentModeId 始终指向真实 mode。
    const resolvedCurrent = modes.some(mode => mode.id === currentModeId)
      ? currentModeId
      : (BUILTIN_MODE_IDS[0] as string)
    return { version: PROMPT_MODE_STORE_VERSION, currentModeId: resolvedCurrent, modes }
  }

  /** Atomic persist (tmp + rename with Windows retry). */
  private async persist(): Promise<void> {
    const store = this.store
    if (!store) {
      throw new PromptError('prompt modes store is not loaded', PromptErrorCode.STORAGE_CORRUPT)
    }
    const tmpPath = `${this.storePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await fs.mkdir(this.rootDir, { recursive: true })
      await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), 'utf8')
      await renameStoreOverwrite(tmpPath, this.storePath)
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined)
      throw new PromptError(
        `prompt modes store write failed: ${error instanceof Error ? error.message : String(error)}`,
        PromptErrorCode.STORAGE_WRITE_FAILED,
      )
    }
  }

  /** Subscribe to change events; returns an unsubscribe function. */
  subscribe(listener: (event: PromptChangeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(event: PromptChangeEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  /** Serialized mutation path shared by every write. */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(operation, operation)
    this.mutationChain = run.catch(() => undefined)
    return run
  }

  // ─── reads ────────────────────────────────────────────

  async listModes(): Promise<PromptMode[]> {
    await this.ensureLoaded()
    return (this.store?.modes ?? []).map(mode => deepCopyMode(mode))
  }

  async getMode(id: string): Promise<PromptMode | undefined> {
    await this.ensureLoaded()
    const mode = this.store?.modes.find(m => m.id === id)
    return mode ? deepCopyMode(mode) : undefined
  }

  /** Current mode; falls back to the first builtin when unset or unknown. */
  async getCurrentMode(): Promise<PromptMode> {
    await this.ensureLoaded()
    const store = this.store!
    const current = store.modes.find(mode => mode.id === store.currentModeId)
    if (current) return deepCopyMode(current)
    const fallback = store.modes.find(mode => isFirstBuiltin(mode.id))
    if (fallback) return deepCopyMode(fallback)
    throw new PromptError('prompt modes store is empty', PromptErrorCode.STORAGE_CORRUPT)
  }

  /**
   * Synchronous snapshot of the current mode for the injector's render state;
   * undefined until the store has been loaded (the plugin calls refresh() once
   * the lazy load resolves, so agents install then).
   */
  currentModeSnapshot(): PromptMode | undefined {
    if (!this.store) return undefined
    const current = this.store.modes.find(mode => mode.id === this.store?.currentModeId)
    if (current) return deepCopyMode(current)
    const fallback = this.store.modes.find(mode => isFirstBuiltin(mode.id))
    return fallback ? deepCopyMode(fallback) : undefined
  }

  // ─── writes ───────────────────────────────────────────

  async setCurrentMode(id: string): Promise<PromptMode> {
    return this.mutate(async () => {
      const store = await this.requireStore()
      const mode = store.modes.find(m => m.id === id)
      if (!mode) {
        throw new PromptError(`prompt mode "${id}" not found`, PromptErrorCode.MODE_NOT_FOUND)
      }
      if (store.currentModeId !== id) {
        const previous = store.currentModeId
        store.currentModeId = id
        try {
          await this.persist()
        } catch (error) {
          // 差距-1: never leave "memory new / disk old" — roll the in-memory
          // id back so a failed persist keeps memory and disk consistent.
          store.currentModeId = previous
          throw error
        }
        this.emit({ type: 'mode-changed' })
      }
      return deepCopyMode(mode)
    })
  }

  async createMode(input: {
    name: string
    template?: string
    customPrefix?: string
    customSuffix?: string
    promptEntries?: readonly PromptEntry[]
    toolPolicy?: string[]
    toolPolicyCustomized?: boolean
  }): Promise<PromptMode> {
    return this.mutate(async () => {
      const store = await this.requireStore()
      const name = input.name.trim()
      if (name.length === 0) {
        throw new PromptError('mode name must be a non-empty string', PromptErrorCode.INVALID_PAYLOAD)
      }
      const mode: PromptMode = {
        id: newModeId(),
        name,
        kind: 'custom',
        // P-06：UI 不再提供模板输入，空模板回退内置 code 模板，避免新模式空 section
        // 被注入器瀑布丢弃（overrideHostPrompt 下模型看不到任何模式内容）。
        template: normalizeTemplate(input.template ?? '') || BUILTIN_MODE_TEMPLATES.code,
        customPrefix: input.customPrefix !== undefined ? normalizeTemplate(input.customPrefix) : undefined,
        customSuffix: input.customSuffix !== undefined ? normalizeTemplate(input.customSuffix) : undefined,
        toolPolicy: normalizeToolPolicy(input.toolPolicy, PromptErrorCode.INVALID_PAYLOAD),
        toolPolicyCustomized: normalizeToolPolicyCustomized(input.toolPolicyCustomized, PromptErrorCode.INVALID_PAYLOAD),
        promptEntries: (input.promptEntries ?? []).map(entry => normalizeEntry(entry)),
      }
      store.modes.push(mode)
      await this.persist()
      this.emit({ type: 'modes-changed' })
      return deepCopyMode(mode)
    })
  }

  /**
   * Update a mode. Builtin modes may be edited (template/entries) but their
   * id and kind are immutable.
   */
  async updateMode(
    id: string,
    patch: {
      name?: string
      template?: string
      customPrefix?: string
      customSuffix?: string
      promptEntries?: readonly PromptEntry[]
      toolPolicy?: string[]
      toolPolicyCustomized?: boolean
    },
  ): Promise<PromptMode> {
    return this.mutate(async () => {
      const store = await this.requireStore()
      const mode = this.requireMode(store, id)
      const isBuiltin = mode.kind === 'builtin'
      if (patch.name !== undefined && isBuiltin) {
        throw new PromptError(
          `builtin prompt mode "${id}" cannot be renamed`,
          PromptErrorCode.BUILTIN_IMMUTABLE,
        )
      }
      const name = patch.name?.trim()
      if (name !== undefined && name.length === 0) {
        throw new PromptError('mode name must be a non-empty string', PromptErrorCode.INVALID_PAYLOAD)
      }
      const next: PromptMode = {
        ...mode,
        name: name ?? mode.name,
        template: patch.template !== undefined ? normalizeTemplate(patch.template) : mode.template,
        customPrefix: patch.customPrefix !== undefined
          ? patch.customPrefix.length > 0 ? normalizeTemplate(patch.customPrefix) : undefined
          : mode.customPrefix,
        customSuffix: patch.customSuffix !== undefined
          ? patch.customSuffix.length > 0 ? normalizeTemplate(patch.customSuffix) : undefined
          : mode.customSuffix,
        toolPolicy: patch.toolPolicy !== undefined
          ? normalizeToolPolicy(patch.toolPolicy, PromptErrorCode.INVALID_PAYLOAD)
          : mode.toolPolicy,
        toolPolicyCustomized: patch.toolPolicyCustomized !== undefined
          ? normalizeToolPolicyCustomized(patch.toolPolicyCustomized, PromptErrorCode.INVALID_PAYLOAD)
          : mode.toolPolicyCustomized,
        promptEntries: patch.promptEntries !== undefined
          ? patch.promptEntries.map(entry => normalizeEntry(entry))
          : mode.promptEntries,
      }
      store.modes[store.modes.indexOf(mode)] = next
      await this.persist()
      this.emit({ type: 'modes-changed' })
      return deepCopyMode(next)
    })
  }

  async renameMode(id: string, name: string): Promise<PromptMode> {
    return this.updateMode(id, { name })
  }

  /** Copy a mode as a new custom mode (entries get fresh ids). */
  async duplicateMode(id: string): Promise<PromptMode> {
    return this.mutate(async () => {
      const store = await this.requireStore()
      const mode = this.requireMode(store, id)
      const copy: PromptMode = {
        ...copyWithNewIds(mode),
        id: newModeId(),
        name: `${mode.name} copy`,
        kind: 'custom',
      }
      store.modes.push(copy)
      await this.persist()
      this.emit({ type: 'modes-changed' })
      return deepCopyMode(copy)
    })
  }

  /** Delete a custom mode; builtin modes are protected. */
  async deleteMode(id: string): Promise<void> {
    return this.mutate(async () => {
      const store = await this.requireStore()
      const mode = this.requireMode(store, id)
      if (mode.kind === 'builtin') {
        throw new PromptError(
          `builtin prompt mode "${id}" cannot be deleted`,
          PromptErrorCode.BUILTIN_IMMUTABLE,
        )
      }
      store.modes = store.modes.filter(m => m.id !== id)
      if (store.currentModeId === id) {
        store.currentModeId = BUILTIN_MODE_IDS[0] as string
      }
      await this.persist()
      this.emit({ type: 'modes-changed' })
    })
  }

  /**
   * Import modes from a JSON payload. Two payload shapes are accepted:
   *
   * 1. One or many mode records (array or single object) — imported modes are
   *    always custom; colliding ids are regenerated (including duplicates
   *    inside the same payload); templates and entry content are normalized;
   *    legacy-only fields are dropped / mapped and reported in `warnings`.
   * 2. A SystemPromptConfig envelope (old Gray `system_prompt` export: `modes`
   *    as a Record, and/or top-level `currentModeId` / `template` /
   *    `dynamicTemplate`) — folded globally: each mode value goes through
   *    parseImportedMode; the code/default mode falls back to the global
   *    `template` when it has none; the global `dynamicTemplate` (when
   *    enabled) maps to a user preset entry; `currentModeId` is honored when
   *    it resolves after import. Every folding decision is recorded in
   *    `warnings`.
   */
  async importModes(payload: unknown): Promise<PromptImportResult> {
    return this.mutate(async () => {
      const store = await this.requireStore()
      const warnings: string[] = []
      const existingIds = new Set(store.modes.map(mode => mode.id))
      const imported: PromptMode[] = []

      if (isSystemPromptConfigShape(payload)) {
        const config = payload as Record<string, unknown>
        warnings.push('imported payload is a SystemPromptConfig; folding the global config')
        const globalTemplate = typeof config.template === 'string' ? normalizeTemplate(config.template) : undefined
        const globalDynEnabled = config.dynamicTemplateEnabled === true
        const globalDyn = typeof config.dynamicTemplate === 'string' && config.dynamicTemplate.trim().length > 0
          ? normalizeTemplate(config.dynamicTemplate)
          : undefined
        const rawModes = config.modes
        if (typeof rawModes === 'object' && rawModes !== null && !Array.isArray(rawModes)) {
          // BUG-06: each parsed mode claims its final id inside the loop, so
          // same-payload duplicates get regenerated instead of colliding.
          for (const rawMode of Object.values(rawModes as Record<string, unknown>)) {
            const mode = parseImportedMode(rawMode, existingIds, warnings)
            existingIds.add(mode.id)
            imported.push(mode)
          }
        } else if (globalTemplate !== undefined || globalDyn !== undefined || config.currentModeId !== undefined) {
          // Old-version config without a modes map: synthesize the default
          // (code) mode from the global fields.
          const codeMode: PromptMode = {
            id: 'code',
            name: 'Code',
            kind: 'custom',
            template: globalTemplate ?? '',
            promptEntries: [],
          }
          const parsed = parseImportedMode(codeMode, existingIds, warnings)
          warnings.push('config without modes: synthesized the default (code) mode from the global template')
          existingIds.add(parsed.id)
          imported.push(parsed)
        }
        // code / default mode: fall back to the global template when it has none.
        const defaultMode = imported.find(mode => mode.id === 'code')
          ?? (typeof config.currentModeId === 'string' ? imported.find(mode => mode.id === config.currentModeId) : undefined)
          ?? imported[0]
        if (defaultMode && defaultMode.template.length === 0 && globalTemplate !== undefined && globalTemplate.length > 0) {
          defaultMode.template = globalTemplate
          warnings.push(`mode "${defaultMode.id}": template fell back to the global config template`)
        }
        // Global dynamicTemplate (enabled) maps to a user entry on the default
        // mode, unless that mode already carries the same entry from its own
        // dynamicTemplate field.
        if (defaultMode && globalDynEnabled && globalDyn !== undefined
          && !defaultMode.promptEntries.some(entry => entry.content === globalDyn)) {
          defaultMode.promptEntries.push(dynamicTemplateUserEntry(globalDyn, defaultMode.promptEntries))
          warnings.push(`mode "${defaultMode.id}": mapped global dynamicTemplate (enabled) to a user preset entry`)
        }
        const rawCurrent = config.currentModeId
        if (typeof rawCurrent === 'string' && rawCurrent.length > 0) {
          if (imported.some(mode => mode.id === rawCurrent) || store.modes.some(mode => mode.id === rawCurrent)) {
            store.currentModeId = rawCurrent
            warnings.push(`currentModeId "${rawCurrent}" set as the current mode`)
          } else {
            warnings.push(`currentModeId "${rawCurrent}" not found after import; keeping the current mode`)
          }
        }
      } else {
        const raws = Array.isArray(payload) ? payload : [payload]
        for (const raw of raws) {
          const mode = parseImportedMode(raw, existingIds, warnings)
          // BUG-06: each parsed mode claims its final id inside the loop, so
          // same-payload duplicates get regenerated instead of colliding.
          existingIds.add(mode.id)
          imported.push(mode)
        }
      }

      store.modes.push(...imported)
      await this.persist()
      this.emit({ type: 'modes-changed' })
      return { modes: imported.map(mode => deepCopyMode(mode)), warnings }
    })
  }

  /**
   * Export modes (JSON-safe envelope, ready to be fed back to importModes).
   * `ids` limits the export; omitted = all modes.
   */
  async exportModes(ids?: readonly string[]): Promise<{ version: number; modes: PromptMode[] }> {
    await this.ensureLoaded()
    const store = this.store!
    const modes = ids ? store.modes.filter(mode => ids.includes(mode.id)) : store.modes
    return { version: PROMPT_MODE_STORE_VERSION, modes: modes.map(mode => deepCopyMode(mode)) }
  }

  // ─── internal ─────────────────────────────────────────

  private async requireStore(): Promise<PromptModeStore> {
    await this.ensureLoaded()
    if (!this.store) {
      throw new PromptError('prompt modes store is not loaded', PromptErrorCode.STORAGE_CORRUPT)
    }
    return this.store
  }

  private requireMode(store: PromptModeStore, id: string): PromptMode {
    const mode = store.modes.find(m => m.id === id)
    if (!mode) {
      throw new PromptError(`prompt mode "${id}" not found`, PromptErrorCode.MODE_NOT_FOUND)
    }
    return mode
  }
}

function isFirstBuiltin(id: string): boolean {
  return id === (BUILTIN_MODE_IDS[0] as string)
}

