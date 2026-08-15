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
 * new fields — everything defaults on, matching the old always-on behaviour).
 */
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfigValues = {
  enabled: true,
  autoCheckpoint: true,
  modelToolsEnabled: true,
  messageCheckpoint: {
    beforeMessages: ['user'],
    afterMessages: ['model'],
    modelOuterLayerOnly: true,
    mergeUnchangedCheckpoints: true,
  },
  beforeTools: [],
  afterTools: [],
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
    beforeTools: readStringArray(record.beforeTools),
    afterTools: readStringArray(record.afterTools),
  }
}

/** The two message positions the section exposes as toggles. */
export type CheckpointConfigMessageSlot = 'beforeUser' | 'afterModel'

/** Toggle state of one message slot ("on" = the list contains that kind). */
export function checkpointConfigMessageKindEnabled(
  config: CheckpointConfigValues,
  slot: CheckpointConfigMessageSlot,
): boolean {
  return slot === 'beforeUser'
    ? config.messageCheckpoint.beforeMessages.includes('user')
    : config.messageCheckpoint.afterMessages.includes('model')
}

/**
 * Pure toggle update of one message slot: 'beforeUser' edits
 * `messageCheckpoint.beforeMessages` (user membership), 'afterModel' edits
 * `messageCheckpoint.afterMessages` (model membership). Other fields untouched.
 */
export function withCheckpointConfigMessageKind(
  config: CheckpointConfigValues,
  slot: CheckpointConfigMessageSlot,
  enabled: boolean,
): CheckpointConfigValues {
  if (slot === 'beforeUser') {
    const beforeMessages: CheckpointMessageKind[] = enabled
      ? config.messageCheckpoint.beforeMessages.includes('user')
        ? [...config.messageCheckpoint.beforeMessages]
        : [...config.messageCheckpoint.beforeMessages, 'user']
      : config.messageCheckpoint.beforeMessages.filter(kind => kind !== 'user')
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
