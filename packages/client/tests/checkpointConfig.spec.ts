/**
 * P4-06 checkpoint config section — pure-model tests.
 *
 * Covers the config values shape (defaults, defensive normalization of host
 * snapshots), the message-slot toggle semantics ("开 = 列表含该消息类型"),
 * tool-list text parse/format/validation, and the commit path contract
 * (absolute `['checkpoints', ...]` paths — the same contract the settings
 * `store.set` channel uses, which is what the section's save calls exercise).
 *
 * React is intentionally not imported (node environment; the section
 * component is a thin shell over these helpers).
 */
import { describe, expect, it } from 'vitest'
import {
  CHECKPOINT_CONFIG_PATH_PREFIX,
  CHECKPOINT_TOOL_CATALOG,
  CHECKPOINT_TOOL_GROUP_ORDER,
  CHECKPOINT_TOOL_NAME_MAX_LENGTH,
  DEFAULT_CHECKPOINT_CONFIG,
  checkpointConfigAbsolutePath,
  checkpointConfigMessageKindEnabled,
  checkpointConfigUnknownTools,
  checkpointConfigTextFromToolList,
  checkpointConfigToolIssueLabelKey,
  checkpointConfigToolListFromText,
  createCheckpointConfigFallbackT,
  normalizeCheckpointConfig,
  setCheckpointConfigPath,
  validateCheckpointConfigToolLine,
  validateCheckpointConfigToolText,
  withCheckpointConfigMessageKind,
  withCheckpointKnownTools,
  withCheckpointToolFlag,
  withCheckpointToolsReset,
  withoutCheckpointTool,
  type CheckpointConfigValues,
} from '../src/client/checkpointList/configModel.ts'
import { DSH_AFTER_TOOL_DEFAULTS, DSH_BEFORE_TOOL_DEFAULTS, DSH_TOOL_DEFAULTS } from '../src/client/settings/defaults.ts'

// ---------------------------------------------------------------------------
// Defaults / normalization
// ---------------------------------------------------------------------------

describe('checkpoint config defaults and normalization', () => {
  it('defaults mirror the host checkpoints Config (message defaults + DSH tool list)', () => {
    expect(DEFAULT_CHECKPOINT_CONFIG.enabled).toBe(true)
    expect(DEFAULT_CHECKPOINT_CONFIG.autoCheckpoint).toBe(true)
    expect(DEFAULT_CHECKPOINT_CONFIG.modelToolsEnabled).toBe(true)
    expect(DEFAULT_CHECKPOINT_CONFIG.messageCheckpoint.beforeMessages).toEqual(['user', 'model'])
    // The plugin default has the after-model slot off; tool lists are the
    // selective defaults (before: 命令前/删除前; after: 写入后/差异后), not all 24.
    expect(DEFAULT_CHECKPOINT_CONFIG.messageCheckpoint.afterMessages).toEqual([])
    expect(DEFAULT_CHECKPOINT_CONFIG.beforeTools).toEqual([...DSH_BEFORE_TOOL_DEFAULTS])
    expect(DEFAULT_CHECKPOINT_CONFIG.afterTools).toEqual([...DSH_AFTER_TOOL_DEFAULTS])
    expect(DSH_TOOL_DEFAULTS).toHaveLength(24)
  })

  it('normalizes missing / hostile snapshots to defaults (legacy config)', () => {
    const normalized = normalizeCheckpointConfig(undefined)
    expect(normalized).toEqual(DEFAULT_CHECKPOINT_CONFIG)
    expect(normalizeCheckpointConfig('junk')).toEqual(DEFAULT_CHECKPOINT_CONFIG)
    expect(normalizeCheckpointConfig({ enabled: 'yes', autoCheckpoint: 1, beforeTools: 'nope' })).toEqual(
      DEFAULT_CHECKPOINT_CONFIG,
    )
  })

  it('passes through valid values and drops hostile entries', () => {
    const normalized = normalizeCheckpointConfig({
      enabled: false,
      autoCheckpoint: false,
      modelToolsEnabled: false,
      messageCheckpoint: {
        beforeMessages: ['user', 'bogus', 'model'],
        afterMessages: ['model', 42],
        modelOuterLayerOnly: false,
        mergeUnchangedCheckpoints: false,
      },
      beforeTools: ['checkpoint_create', '', 7],
      afterTools: ['checkpoint_restore'],
    })
    expect(normalized.enabled).toBe(false)
    expect(normalized.autoCheckpoint).toBe(false)
    expect(normalized.modelToolsEnabled).toBe(false)
    expect(normalized.messageCheckpoint.beforeMessages).toEqual(['user', 'model'])
    expect(normalized.messageCheckpoint.afterMessages).toEqual(['model'])
    expect(normalized.messageCheckpoint.modelOuterLayerOnly).toBe(false)
    expect(normalized.messageCheckpoint.mergeUnchangedCheckpoints).toBe(false)
    expect(normalized.beforeTools).toEqual(['checkpoint_create'])
    expect(normalized.afterTools).toEqual(['checkpoint_restore'])
  })

  it('a present but empty message list stays empty (explicit "off")', () => {
    const normalized = normalizeCheckpointConfig({ messageCheckpoint: { beforeMessages: [], afterMessages: [] } })
    expect(normalized.messageCheckpoint.beforeMessages).toEqual([])
    expect(normalized.messageCheckpoint.afterMessages).toEqual([])
  })

  it('a present but empty tool list stays empty (explicit "off")', () => {
    const normalized = normalizeCheckpointConfig({ beforeTools: [], afterTools: [] })
    expect(normalized.beforeTools).toEqual([])
    expect(normalized.afterTools).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Message-slot toggles (save semantics: 开 = 列表含该消息类型)
// ---------------------------------------------------------------------------

describe('message checkpoint slots', () => {
  it('derives toggle state from list membership (three host-backed slots)', () => {
    expect(checkpointConfigMessageKindEnabled(DEFAULT_CHECKPOINT_CONFIG, 'beforeUser')).toBe(true)
    expect(checkpointConfigMessageKindEnabled(DEFAULT_CHECKPOINT_CONFIG, 'beforeModel')).toBe(true)
    // The plugin default has afterMessages off, so the after-model slot is off.
    expect(checkpointConfigMessageKindEnabled(DEFAULT_CHECKPOINT_CONFIG, 'afterModel')).toBe(false)
    const off = normalizeCheckpointConfig({ messageCheckpoint: { beforeMessages: [], afterMessages: [] } })
    expect(checkpointConfigMessageKindEnabled(off, 'beforeUser')).toBe(false)
    expect(checkpointConfigMessageKindEnabled(off, 'beforeModel')).toBe(false)
    expect(checkpointConfigMessageKindEnabled(off, 'afterModel')).toBe(false)
  })

  it('turning a slot on appends the kind (idempotent) without clobbering other members', () => {
    const next = withCheckpointConfigMessageKind(DEFAULT_CHECKPOINT_CONFIG, 'beforeUser', true)
    expect(next.messageCheckpoint.beforeMessages).toEqual(['user', 'model'])
    const afterModel = withCheckpointConfigMessageKind(next, 'afterModel', true)
    expect(afterModel.messageCheckpoint.afterMessages).toEqual(['model'])
    const beforeModel = withCheckpointConfigMessageKind(next, 'beforeModel', true)
    expect(beforeModel.messageCheckpoint.beforeMessages).toEqual(['user', 'model'])
  })

  it('turning a slot off removes only that kind and leaves the other members intact', () => {
    const next = withCheckpointConfigMessageKind(DEFAULT_CHECKPOINT_CONFIG, 'beforeUser', false)
    expect(next.messageCheckpoint.beforeMessages).toEqual(['model'])
    expect(next.messageCheckpoint.afterMessages).toEqual([])
    expect(next.enabled).toBe(true)
    const bothOff = withCheckpointConfigMessageKind(next, 'afterModel', false)
    expect(bothOff.messageCheckpoint.afterMessages).toEqual([])
    expect(bothOff.messageCheckpoint.beforeMessages).toEqual(['model'])
    const modelOff = withCheckpointConfigMessageKind(DEFAULT_CHECKPOINT_CONFIG, 'beforeModel', false)
    expect(modelOff.messageCheckpoint.beforeMessages).toEqual(['user'])
  })

  it('re-enabling a slot after removal restores membership', () => {
    const off = withCheckpointConfigMessageKind(DEFAULT_CHECKPOINT_CONFIG, 'beforeUser', false)
    expect(off.messageCheckpoint.beforeMessages).toEqual(['model'])
    const on = withCheckpointConfigMessageKind(off, 'beforeUser', true)
    expect(on.messageCheckpoint.beforeMessages).toEqual(['model', 'user'])
  })
})

// ---------------------------------------------------------------------------
// Tool-list text transform + validation (input validation)
// ---------------------------------------------------------------------------

describe('tool-list text transform and validation', () => {
  it('round-trips tool arrays through one-name-per-line text', () => {
    const tools = ['checkpoint_create', 'checkpoint_restore', 'checkpoints.list']
    expect(checkpointConfigTextFromToolList(tools)).toBe('checkpoint_create\ncheckpoint_restore\ncheckpoints.list')
    expect(checkpointConfigToolListFromText('checkpoint_create\ncheckpoint_restore\ncheckpoints.list')).toEqual(tools)
    expect(checkpointConfigTextFromToolList([])).toBe('')
  })

  it('parses text: trims, drops empty lines and dedupes preserving order', () => {
    expect(checkpointConfigToolListFromText('  a  \n\nb\nb\n c \n')).toEqual(['a', 'b', 'c'])
    expect(checkpointConfigToolListFromText('   \n\t\n')).toEqual([])
    expect(checkpointConfigToolListFromText('')).toEqual([])
  })

  it('accepts identifier-shaped tool names', () => {
    expect(validateCheckpointConfigToolLine('checkpoint_create')).toBeNull()
    expect(validateCheckpointConfigToolLine('checkpoints.list')).toBeNull()
    expect(validateCheckpointConfigToolLine('_private.tool-1')).toBeNull()
    expect(validateCheckpointConfigToolLine('  checkpoint_create  ')).toBeNull()
  })

  it('rejects empty, over-long and non-identifier lines', () => {
    expect(validateCheckpointConfigToolLine('   ')).toBe('empty')
    expect(validateCheckpointConfigToolLine('')).toBe('empty')
    expect(validateCheckpointConfigToolLine('bad tool!')).toBe('invalidChars')
    expect(validateCheckpointConfigToolLine('中文工具名')).toBe('invalidChars')
    expect(validateCheckpointConfigToolLine('-leading-dash')).toBe('invalidChars')
    expect(validateCheckpointConfigToolLine('1number-led')).toBe('invalidChars')
    expect(validateCheckpointConfigToolLine('a'.repeat(CHECKPOINT_TOOL_NAME_MAX_LENGTH + 1))).toBe('tooLong')
    expect(validateCheckpointConfigToolLine('a'.repeat(CHECKPOINT_TOOL_NAME_MAX_LENGTH))).toBeNull()
  })

  it('collects one issue per invalid line with the offending text', () => {
    const longName = 'x'.repeat(CHECKPOINT_TOOL_NAME_MAX_LENGTH + 1)
    const issues = validateCheckpointConfigToolText(`ok_tool\nbad tool!\n\n${longName}`)
    expect(issues).toContainEqual({ line: 'bad tool!', issue: 'invalidChars' })
    expect(issues).toContainEqual({ line: '', issue: 'empty' })
    expect(issues).toContainEqual({ line: longName, issue: 'tooLong' })
    expect(issues).toHaveLength(3)
  })

  it('maps tool-line issues to locale keys', () => {
    expect(checkpointConfigToolIssueLabelKey('empty')).toBe('config.toolsEmptyLine')
    expect(checkpointConfigToolIssueLabelKey('tooLong')).toBe('config.toolsTooLong')
    expect(checkpointConfigToolIssueLabelKey('invalidChars')).toBe('config.toolsInvalidChars')
  })
})

// ---------------------------------------------------------------------------
// Commit path contract (save calls: absolute ['checkpoints', ...] paths)
// ---------------------------------------------------------------------------

describe('checkpoint config commit paths', () => {
  it('the config module lives at the top-level checkpoints path', () => {
    expect(CHECKPOINT_CONFIG_PATH_PREFIX).toEqual(['checkpoints'])
  })

  it('expands relative paths to the absolute settings-store form', () => {
    expect(checkpointConfigAbsolutePath(['enabled'])).toEqual(['checkpoints', 'enabled'])
    expect(checkpointConfigAbsolutePath(['messageCheckpoint', 'beforeMessages'])).toEqual([
      'checkpoints',
      'messageCheckpoint',
      'beforeMessages',
    ])
    // Already-absolute paths pass through unchanged.
    expect(checkpointConfigAbsolutePath(['checkpoints', 'enabled'])).toEqual(['checkpoints', 'enabled'])
  })

  it('applies top-level commits (relative and absolute) immutably', () => {
    const base = normalizeCheckpointConfig({})
    const relative = setCheckpointConfigPath(base, ['enabled'], false)
    expect(relative.enabled).toBe(false)
    expect(base.enabled).toBe(true)
    expect(relative).not.toBe(base)

    const absolute = setCheckpointConfigPath(base, ['checkpoints', 'autoCheckpoint'], false)
    expect(absolute.autoCheckpoint).toBe(false)
    expect(base.autoCheckpoint).toBe(true)
  })

  it('applies nested commits (messageCheckpoint) and tool arrays', () => {
    const base = normalizeCheckpointConfig({})
    const next = setCheckpointConfigPath(base, ['messageCheckpoint', 'beforeMessages'], [])
    expect(next.messageCheckpoint.beforeMessages).toEqual([])
    expect(next.messageCheckpoint.afterMessages).toEqual([])
    expect(base.messageCheckpoint.beforeMessages).toEqual(['user', 'model'])

    const tools = setCheckpointConfigPath(next, ['checkpoints', 'beforeTools'], ['checkpoint_create'])
    expect(tools.beforeTools).toEqual(['checkpoint_create'])
    expect(tools.messageCheckpoint.beforeMessages).toEqual([])
  })

  it('replaces the whole block on an empty path via normalization', () => {
    const next = setCheckpointConfigPath(DEFAULT_CHECKPOINT_CONFIG, [], { enabled: false })
    expect(next.enabled).toBe(false)
    expect(next.autoCheckpoint).toBe(true)
  })

  it('full commit pipeline matches what the section emits for a save call', () => {
    // Simulate the section's edit → commit flow: toggle beforeUser off, then
    // commit a parsed beforeTools list through the absolute path contract.
    let config: CheckpointConfigValues = DEFAULT_CHECKPOINT_CONFIG
    const slotOff = withCheckpointConfigMessageKind(config, 'beforeUser', false)
    config = setCheckpointConfigPath(config, checkpointConfigAbsolutePath(['messageCheckpoint', 'beforeMessages']), slotOff.messageCheckpoint.beforeMessages)
    const parsed = checkpointConfigToolListFromText('checkpoint_create\ncheckpoint_verify\n')
    config = setCheckpointConfigPath(config, checkpointConfigAbsolutePath(['beforeTools']), parsed)
    expect(config.messageCheckpoint.beforeMessages).toEqual(['model'])
    expect(config.beforeTools).toEqual(['checkpoint_create', 'checkpoint_verify'])
    expect(config.afterTools).toEqual([...DSH_AFTER_TOOL_DEFAULTS])
    expect(config.enabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Fallback translator
// ---------------------------------------------------------------------------

describe('checkpoint config fallback translator', () => {
  it('resolves known keys from the zh/en dictionaries', () => {
    expect(createCheckpointConfigFallbackT('zh')('config.title')).toBe('存档设置')
    expect(createCheckpointConfigFallbackT('en')('config.title')).toBe('Checkpoint settings')
    expect(createCheckpointConfigFallbackT()('config.enabled')).toBe('启用存档点')
  })

  it('returns the raw key for unknown keys', () => {
    expect(createCheckpointConfigFallbackT('zh')('config.nope')).toBe('config.nope')
  })
})

// ---------------------------------------------------------------------------
// Tool matrix (checkbox editor) pure semantics
// ---------------------------------------------------------------------------

describe('tool matrix helpers', () => {
  const sparse: CheckpointConfigValues = {
    ...DEFAULT_CHECKPOINT_CONFIG,
    beforeTools: ['write', 'my_mcp_tool'],
    afterTools: [],
  }

  it('toggles one tool in one slot, preserving order and immutability', () => {
    const on = withCheckpointToolFlag(sparse, 'bash', 'after', true)
    expect(on.afterTools).toEqual(['bash'])
    expect(on.beforeTools).toEqual(sparse.beforeTools)
    expect(sparse.afterTools).toEqual([])
    const off = withCheckpointToolFlag(sparse, 'write', 'before', false)
    expect(off.beforeTools).toEqual(['my_mcp_tool'])
    // 同值幂等：返回原引用。
    expect(withCheckpointToolFlag(sparse, 'write', 'before', true)).toBe(sparse)
  })

  it('sets every known tool in one slot without touching custom names', () => {
    const cleared = withCheckpointKnownTools(sparse, 'before', false)
    expect(cleared.beforeTools).toEqual(['my_mcp_tool'])
    const all = withCheckpointKnownTools(cleared, 'after', true)
    // 全选按目录序追加（分组顺序），与默认清单只比集合不比顺序。
    expect([...all.afterTools].sort()).toEqual([...DSH_TOOL_DEFAULTS].sort())
    expect(all.beforeTools).toEqual(['my_mcp_tool'])
  })

  it('collects unknown stored names across both slots, deduped in order', () => {
    expect(checkpointConfigUnknownTools(sparse)).toEqual(['my_mcp_tool'])
    const both = { ...sparse, afterTools: ['my_mcp_tool', 'another_tool'] } as CheckpointConfigValues
    expect(checkpointConfigUnknownTools(both)).toEqual(['my_mcp_tool', 'another_tool'])
    expect(checkpointConfigUnknownTools(DEFAULT_CHECKPOINT_CONFIG)).toEqual([])
  })

  it('removes a custom tool from both slots', () => {
    const next = withoutCheckpointTool(sparse, 'my_mcp_tool')
    expect(next.beforeTools).toEqual(['write'])
    expect(next.afterTools).toEqual([])
  })

  it('resets both slots to the selective default lists (before: 命令前/删除前; after: 写入后/差异后)', () => {
    const next = withCheckpointToolsReset(sparse)
    expect(next.beforeTools).toEqual([...DSH_BEFORE_TOOL_DEFAULTS])
    expect(next.afterTools).toEqual([...DSH_AFTER_TOOL_DEFAULTS])
  })

  it('catalog covers the default tool surface exactly', () => {
    expect([...CHECKPOINT_TOOL_CATALOG.map(entry => entry.name)].sort()).toEqual([...DSH_TOOL_DEFAULTS].sort())
    expect(CHECKPOINT_TOOL_GROUP_ORDER).toContain('write')
  })
})
