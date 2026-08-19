/**
 * Checkpoint config section — pure model (P4-06).
 *
 * The host checkpoints Config grows new fields (enabled / autoCheckpoint /
 * modelToolsEnabled / messageCheckpoint / beforeTools / afterTools). This
 * module owns their browser-side shape, defaults, defensive normalization and
 * the edit semantics the config section renders:
 *
 * - `normalizeCheckpointConfig` narrows an arbitrary host snapshot (missing or
 *   hostile values fall back to defaults — same convention as the settings
 *   store pump);
 * - message-kind toggles map 1:1 to `messageCheckpoint.beforeMessages` /
 *   `afterMessages` membership ("开 = 列表含该消息类型");
 * - tool lists are edited as one-name-per-line text; parse/validate helpers
 *   keep the component thin;
 * - every commit is a path/value pair whose absolute form is
 *   `['checkpoints', ...]` — the same contract the settings update channel
 *   (`store.set(path, value)` → host `config.update`) already uses, so the
 *   section can be wired to `onChange` without a new API.
 *
 * Pure and I/O-free: components stay stateless and tests run in node.
 */
import { graycodeCheckpointConfigDictionaries } from './locales.ts'
import type { GrayCodeCheckpointConfigLocaleKey } from './locales.ts'
import { DSH_AFTER_TOOL_DEFAULTS, DSH_BEFORE_TOOL_DEFAULTS } from '../settings/defaults.ts'

/** A message side that can carry a checkpoint trigger. */
export type CheckpointMessageKind = 'user' | 'model'

/** `messageCheckpoint` config block (structural mirror of the host field). */
export interface CheckpointMessageCheckpointConfig {
  readonly beforeMessages: readonly CheckpointMessageKind[]
  readonly afterMessages: readonly CheckpointMessageKind[]
  readonly modelOuterLayerOnly: boolean
  readonly mergeUnchangedCheckpoints: boolean
}

/** Browser-side shape of the new checkpoints Config fields. */
export interface CheckpointConfigValues {
  readonly enabled: boolean
  readonly autoCheckpoint: boolean
  readonly modelToolsEnabled: boolean
  readonly messageCheckpoint: CheckpointMessageCheckpointConfig
  readonly beforeTools: readonly string[]
  readonly afterTools: readonly string[]
}

/** Top-level config path of the checkpoints module (settings `store.set` contract). */
export const CHECKPOINT_CONFIG_PATH_PREFIX = ['checkpoints'] as const

/** Tool-name validation bound (host tool names are short identifiers). */
export const CHECKPOINT_TOOL_NAME_MAX_LENGTH = 64

/** Tool-name shape: identifier-ish (letters/digits/underscore/dot/dash). */
const CHECKPOINT_TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/u

/**
 * Sensible defaults for a fresh/legacy config snapshot (rc.6 has none of the
 * new fields — everything defaults on, matching the old always-on behaviour):
 * 消息边界默认「用户消息前 + 模型消息前」（afterMessages 关）；工具触发默认只勾
 * 写入后/应用差异后（afterTools）与执行命令前/删除前（beforeTools），不再全选。
 */
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfigValues = {
  enabled: true,
  autoCheckpoint: true,
  modelToolsEnabled: true,
  messageCheckpoint: {
    beforeMessages: ['user', 'model'],
    afterMessages: [],
    modelOuterLayerOnly: true,
    mergeUnchangedCheckpoints: true,
  },
  beforeTools: [...DSH_BEFORE_TOOL_DEFAULTS],
  afterTools: [...DSH_AFTER_TOOL_DEFAULTS],
}

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : []
}

function readMessageKinds(value: unknown): CheckpointMessageKind[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is CheckpointMessageKind => entry === 'user' || entry === 'model')
    : []
}

/**
 * Narrow an arbitrary host snapshot to {@link CheckpointConfigValues}.
 * Missing fields fall back to defaults; hostile values are dropped; a present
 * but empty `beforeMessages`/`afterMessages` stays empty (explicit "off").
 * `beforeTools`/`afterTools` follow the same convention: a present array is
 * kept as-is (empty = explicit "off"), missing or hostile values fall back to
 * the DSH 24-tool default list.
 * @param raw - raw config payload (e.g. `config.checkpoints`).
 */
export function normalizeCheckpointConfig(raw: unknown): CheckpointConfigValues {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const message =
    typeof record.messageCheckpoint === 'object' && record.messageCheckpoint !== null
      ? (record.messageCheckpoint as Record<string, unknown>)
      : undefined
  const defaults = DEFAULT_CHECKPOINT_CONFIG
  return {
    enabled: readBool(record.enabled, defaults.enabled),
    autoCheckpoint: readBool(record.autoCheckpoint, defaults.autoCheckpoint),
    modelToolsEnabled: readBool(record.modelToolsEnabled, defaults.modelToolsEnabled),
    messageCheckpoint: {
      beforeMessages:
        message === undefined ? [...defaults.messageCheckpoint.beforeMessages] : readMessageKinds(message.beforeMessages),
      afterMessages:
        message === undefined ? [...defaults.messageCheckpoint.afterMessages] : readMessageKinds(message.afterMessages),
      modelOuterLayerOnly: readBool(message?.modelOuterLayerOnly, defaults.messageCheckpoint.modelOuterLayerOnly),
      mergeUnchangedCheckpoints: readBool(
        message?.mergeUnchangedCheckpoints,
        defaults.messageCheckpoint.mergeUnchangedCheckpoints,
      ),
    },
    beforeTools: Array.isArray(record.beforeTools) ? readStringArray(record.beforeTools) : [...defaults.beforeTools],
    afterTools: Array.isArray(record.afterTools) ? readStringArray(record.afterTools) : [...defaults.afterTools],
  }
}

/**
 * The message positions the section exposes as toggles. Only host-backed
 * boundaries are offered: pre-step (新用户回合前 = beforeUser), agent/request
 * (模型调用前 = beforeModel) and turn-stopping (模型回合关闭后 = afterModel).
 * 「用户消息后」无宿主挂点，不提供。
 */
export type CheckpointConfigMessageSlot = 'beforeUser' | 'beforeModel' | 'afterModel'

/** Toggle state of one message slot ("on" = the list contains that kind). */
export function checkpointConfigMessageKindEnabled(
  config: CheckpointConfigValues,
  slot: CheckpointConfigMessageSlot,
): boolean {
  if (slot === 'beforeUser') return config.messageCheckpoint.beforeMessages.includes('user')
  if (slot === 'beforeModel') return config.messageCheckpoint.beforeMessages.includes('model')
  return config.messageCheckpoint.afterMessages.includes('model')
}

/**
 * Pure toggle update of one message slot: beforeUser/beforeModel edit
 * `messageCheckpoint.beforeMessages` membership, afterModel edits
 * `messageCheckpoint.afterMessages`. Other fields untouched.
 */
export function withCheckpointConfigMessageKind(
  config: CheckpointConfigValues,
  slot: CheckpointConfigMessageSlot,
  enabled: boolean,
): CheckpointConfigValues {
  if (slot === 'beforeUser' || slot === 'beforeModel') {
    const kind: CheckpointMessageKind = slot === 'beforeUser' ? 'user' : 'model'
    const beforeMessages: CheckpointMessageKind[] = enabled
      ? config.messageCheckpoint.beforeMessages.includes(kind)
        ? [...config.messageCheckpoint.beforeMessages]
        : [...config.messageCheckpoint.beforeMessages, kind]
      : config.messageCheckpoint.beforeMessages.filter(item => item !== kind)
    return { ...config, messageCheckpoint: { ...config.messageCheckpoint, beforeMessages } }
  }
  const afterMessages: CheckpointMessageKind[] = enabled
    ? config.messageCheckpoint.afterMessages.includes('model')
      ? [...config.messageCheckpoint.afterMessages]
      : [...config.messageCheckpoint.afterMessages, 'model']
    : config.messageCheckpoint.afterMessages.filter(kind => kind !== 'model')
  return { ...config, messageCheckpoint: { ...config.messageCheckpoint, afterMessages } }
}

/**
 * Expand a relative config path to the absolute settings-store form
 * (`['enabled']` → `['checkpoints', 'enabled']`). Already-absolute paths pass
 * through unchanged. Every commit the section emits uses this form.
 */
export function checkpointConfigAbsolutePath(path: readonly string[]): readonly string[] {
  return path[0] === CHECKPOINT_CONFIG_PATH_PREFIX[0] ? path : [...CHECKPOINT_CONFIG_PATH_PREFIX, ...path]
}

/**
 * Apply one path/value commit to a config snapshot (immutable). Accepts both
 * relative (`['enabled']`) and absolute (`['checkpoints', 'enabled']`) paths;
 * used by the local-draft fallback of the settings page. A path of length 0
 * replaces the whole block via normalization.
 */
export function setCheckpointConfigPath(
  config: CheckpointConfigValues,
  path: readonly string[],
  value: unknown,
): CheckpointConfigValues {
  const relative = path[0] === CHECKPOINT_CONFIG_PATH_PREFIX[0] ? path.slice(1) : path
  if (relative.length === 0) return normalizeCheckpointConfig(value)
  const next = structuredClone(config) as CheckpointConfigValues
  let cursor: Record<string, unknown> = next as unknown as Record<string, unknown>
  for (let index = 0; index < relative.length - 1; index += 1) {
    const part = relative[index]!
    const child = cursor[part]
    if (typeof child !== 'object' || child === null) cursor[part] = {}
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[relative[relative.length - 1]!] = value
  return next
}

/**
 * Parse one-name-per-line tool text into a trimmed, empty-filtered, order-
 * preserving, deduped array (the stored `beforeTools`/`afterTools` shape).
 */
export function checkpointConfigToolListFromText(text: string): string[] {
  const seen = new Set<string>()
  const tools: string[] = []
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.length === 0 || seen.has(line)) continue
    seen.add(line)
    tools.push(line)
  }
  return tools
}

/** Render a stored tool array back to one-name-per-line text. */
export function checkpointConfigTextFromToolList(tools: readonly string[]): string {
  return tools.join('\n')
}

/** Why a tool-name line is rejected (locale-agnostic; UI maps to copy). */
export type CheckpointConfigToolLineIssue = 'empty' | 'invalidChars' | 'tooLong'

/** One invalid tool line, with the offending text. */
export interface CheckpointConfigToolTextIssue {
  readonly line: string
  readonly issue: CheckpointConfigToolLineIssue
}

/**
 * Validate one tool-name line. Empty (after trim) → 'empty'; over the length
 * bound → 'tooLong'; anything not identifier-shaped → 'invalidChars'.
 */
export function validateCheckpointConfigToolLine(line: string): CheckpointConfigToolLineIssue | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return 'empty'
  if (trimmed.length > CHECKPOINT_TOOL_NAME_MAX_LENGTH) return 'tooLong'
  if (!CHECKPOINT_TOOL_NAME_PATTERN.test(trimmed)) return 'invalidChars'
  return null
}

/** Validate whole tool text (one entry per non-empty line). */
export function validateCheckpointConfigToolText(text: string): CheckpointConfigToolTextIssue[] {
  const issues: CheckpointConfigToolTextIssue[] = []
  for (const raw of text.split(/\r?\n/u)) {
    const issue = validateCheckpointConfigToolLine(raw)
    if (issue !== null) issues.push({ line: raw.trim(), issue })
  }
  return issues
}

/**
 * Loose translator over the `graycode.checkpointConfig` dictionaries.
 * Used by the settings page until the main session injects a bound seat
 * (`ctx.locale.bind(GRAYCODE_CHECKPOINT_CONFIG_NS)`); zh mirrors the locale
 * runtime's own fallback locale. Unknown keys return the key itself.
 */
export function createCheckpointConfigFallbackT(lang: 'zh' | 'en' = 'zh'): (key: string) => string {
  const dictionary = graycodeCheckpointConfigDictionaries[lang] as unknown as Record<string, string>
  return (key: string): string => dictionary[key] ?? key
}

/** Locale key for one tool-line issue (UI maps issue → copy key). */
export function checkpointConfigToolIssueLabelKey(issue: CheckpointConfigToolLineIssue): GrayCodeCheckpointConfigLocaleKey {
  switch (issue) {
    case 'empty':
      return 'config.toolsEmptyLine'
    case 'tooLong':
      return 'config.toolsTooLong'
    case 'invalidChars':
    default:
      return 'config.toolsInvalidChars'
  }
}

// ==================== Tool matrix (checkbox editor) ====================
//
// The raw one-name-per-line textareas were hostile to users (issue: 工具调用
// 前存档的设置 UI 极其不友好). The editor now renders the known DSH tool
// surface as a grouped checkbox matrix with 执行前/执行后 columns; unknown
// names from older configs stay editable as "custom tools" so no stored value
// is ever dropped. Old Gray presented the same concept as two phase labels
// (执行前/执行后) over its dangerous-tool surface — the matrix keeps that
// vocabulary.

/** Display group of a known tool (drives matrix section headers). */
export type CheckpointToolGroup = 'write' | 'shell' | 'search' | 'image' | 'workflow'

/** One known-tool row of the matrix. */
export interface CheckpointToolCatalogEntry {
  readonly name: string
  readonly group: CheckpointToolGroup
  /** Locale key of the one-line description shown under the tool name. */
  readonly descriptionKey: GrayCodeCheckpointConfigLocaleKey
}

/** Render order of the matrix groups (write first: highest-risk surface). */
export const CHECKPOINT_TOOL_GROUP_ORDER: readonly CheckpointToolGroup[] = ['write', 'shell', 'search', 'image', 'workflow']

/** The known DSH tool surface (mirrors DSH_TOOL_DEFAULTS, plus copy). */
export const CHECKPOINT_TOOL_CATALOG: readonly CheckpointToolCatalogEntry[] = [
  { name: 'write', group: 'write', descriptionKey: 'config.tool.write.description' },
  { name: 'edit', group: 'write', descriptionKey: 'config.tool.edit.description' },
  { name: 'str_replace_editor', group: 'write', descriptionKey: 'config.tool.str_replace_editor.description' },
  { name: 'delete_code', group: 'write', descriptionKey: 'config.tool.delete_code.description' },
  { name: 'insert_code', group: 'write', descriptionKey: 'config.tool.insert_code.description' },
  { name: 'bash', group: 'shell', descriptionKey: 'config.tool.bash.description' },
  { name: 'pwsh', group: 'shell', descriptionKey: 'config.tool.pwsh.description' },
  { name: 'grep', group: 'search', descriptionKey: 'config.tool.grep.description' },
  { name: 'glob', group: 'search', descriptionKey: 'config.tool.glob.description' },
  { name: 'list_files', group: 'search', descriptionKey: 'config.tool.list_files.description' },
  { name: 'search_in_files', group: 'search', descriptionKey: 'config.tool.search_in_files.description' },
  { name: 'crop_image', group: 'image', descriptionKey: 'config.tool.crop_image.description' },
  { name: 'resize_image', group: 'image', descriptionKey: 'config.tool.resize_image.description' },
  { name: 'rotate_image', group: 'image', descriptionKey: 'config.tool.rotate_image.description' },
  { name: 'generate_image', group: 'image', descriptionKey: 'config.tool.generate_image.description' },
  { name: 'remove_background', group: 'image', descriptionKey: 'config.tool.remove_background.description' },
  { name: 'create_plan', group: 'workflow', descriptionKey: 'config.tool.create_plan.description' },
  { name: 'update_plan', group: 'workflow', descriptionKey: 'config.tool.update_plan.description' },
  { name: 'create_design', group: 'workflow', descriptionKey: 'config.tool.create_design.description' },
  { name: 'update_design', group: 'workflow', descriptionKey: 'config.tool.update_design.description' },
  { name: 'create_progress', group: 'workflow', descriptionKey: 'config.tool.create_progress.description' },
  { name: 'update_progress', group: 'workflow', descriptionKey: 'config.tool.update_progress.description' },
  { name: 'record_progress_milestone', group: 'workflow', descriptionKey: 'config.tool.record_progress_milestone.description' },
  { name: 'create_review', group: 'workflow', descriptionKey: 'config.tool.create_review.description' },
  { name: 'record_review_milestone', group: 'workflow', descriptionKey: 'config.tool.record_review_milestone.description' },
  { name: 'finalize_review', group: 'workflow', descriptionKey: 'config.tool.finalize_review.description' },
  { name: 'reopen_review', group: 'workflow', descriptionKey: 'config.tool.reopen_review.description' },
]

/** Names present in either stored list but absent from the catalog. */
export function checkpointConfigUnknownTools(config: CheckpointConfigValues): string[] {
  const known = new Set(CHECKPOINT_TOOL_CATALOG.map(entry => entry.name))
  const seen = new Set<string>()
  const unknown: string[] = []
  for (const name of [...config.beforeTools, ...config.afterTools]) {
    if (known.has(name) || seen.has(name)) continue
    seen.add(name)
    unknown.push(name)
  }
  return unknown
}

/** One matrix column (which stored list a checkbox edits). */
export type CheckpointToolSlot = 'before' | 'after'

export type CheckpointToolProfile = 'recommended' | 'before-all' | 'before-and-after-all' | 'off' | 'custom'

function sameToolSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(name => right.includes(name))
}

/** Identify the compact preset represented by the two stored tool lists. */
export function checkpointToolProfile(config: CheckpointConfigValues): CheckpointToolProfile {
  const all = CHECKPOINT_TOOL_CATALOG.map(entry => entry.name)
  if (sameToolSet(config.beforeTools, DSH_BEFORE_TOOL_DEFAULTS) && sameToolSet(config.afterTools, DSH_AFTER_TOOL_DEFAULTS)) {
    return 'recommended'
  }
  if (sameToolSet(config.beforeTools, all) && config.afterTools.length === 0) return 'before-all'
  if (sameToolSet(config.beforeTools, all) && sameToolSet(config.afterTools, all)) return 'before-and-after-all'
  if (config.beforeTools.length === 0 && config.afterTools.length === 0) return 'off'
  return 'custom'
}

/** Replace the tool checkpoint policy with one of the user-facing presets. */
export function withCheckpointToolProfile(
  config: CheckpointConfigValues,
  profile: Exclude<CheckpointToolProfile, 'custom'>,
): CheckpointConfigValues {
  const all = CHECKPOINT_TOOL_CATALOG.map(entry => entry.name)
  switch (profile) {
    case 'recommended':
      return withCheckpointToolsReset(config)
    case 'before-all':
      return { ...config, beforeTools: all, afterTools: [] }
    case 'before-and-after-all':
      return { ...config, beforeTools: all, afterTools: [...all] }
    case 'off':
      return { ...config, beforeTools: [], afterTools: [] }
  }
}

/** Toggle one tool in one slot, preserving stored order (immutable). */
export function withCheckpointToolFlag(
  config: CheckpointConfigValues,
  tool: string,
  slot: CheckpointToolSlot,
  enabled: boolean,
): CheckpointConfigValues {
  const key = slot === 'before' ? 'beforeTools' : 'afterTools'
  const list = config[key]
  const has = list.includes(tool)
  if (enabled === has) return config
  const next = enabled ? [...list, tool] : list.filter(name => name !== tool)
  return { ...config, [key]: next }
}

/** Set EVERY known tool (custom tools untouched) in one slot on/off. */
export function withCheckpointKnownTools(
  config: CheckpointConfigValues,
  slot: CheckpointToolSlot,
  enabled: boolean,
): CheckpointConfigValues {
  let next = config
  for (const entry of CHECKPOINT_TOOL_CATALOG) {
    next = withCheckpointToolFlag(next, entry.name, slot, enabled)
  }
  return next
}

/** Remove a custom tool from both slots (immutable). */
export function withoutCheckpointTool(config: CheckpointConfigValues, tool: string): CheckpointConfigValues {
  return {
    ...config,
    beforeTools: config.beforeTools.filter(name => name !== tool),
    afterTools: config.afterTools.filter(name => name !== tool),
  }
}

/** Both slots back to the selective default lists (「恢复默认」= 写入后/差异后 + 命令前/删除前）。 */
export function withCheckpointToolsReset(config: CheckpointConfigValues): CheckpointConfigValues {
  return { ...config, beforeTools: [...DSH_BEFORE_TOOL_DEFAULTS], afterTools: [...DSH_AFTER_TOOL_DEFAULTS] }
}
