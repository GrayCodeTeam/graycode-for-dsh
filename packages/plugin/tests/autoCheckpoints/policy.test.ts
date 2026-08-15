/**
 * autoCheckpoints 纯逻辑测试：配置默认值、shouldCreate 判定（enabled/开关/
 * tool 命中）、标题/notes、轮次推导与同 turn 去重。
 */
import { describe, expect, it } from 'vitest'
import {
  AutoCheckpointDedupe,
  checkpointKindKey,
  checkpointNotesFor,
  checkpointTitleFor,
  currentTurnOf,
  dedupeKeyFor,
  isDirectUserMessage,
  shouldCreateToolCheckpoint,
  shouldCreateUserCheckpoint,
} from '../../src/autoCheckpoints/policy.ts'
import { Config as AutoCheckpointsSchema, DEFAULT_MAJOR_CHANGE_TOOLS } from '../../src/autoCheckpoints/index.ts'
import { DEFAULTS } from '../../src/settings/defaults.ts'

describe('autoCheckpoints 配置默认值', () => {
  it('settings DEFAULTS 带 autoCheckpoints（全部关闭 + 默认工具清单）', () => {
    expect(DEFAULTS.autoCheckpoints).toEqual({
      enabled: false,
      beforeUserMessage: false,
      beforeMajorChange: false,
      majorChangeTools: [...DEFAULT_MAJOR_CHANGE_TOOLS],
    })
  })

  it('schemastery schema 默认值一致', () => {
    const resolved = AutoCheckpointsSchema() as {
      enabled: boolean
      beforeUserMessage: boolean
      beforeMajorChange: boolean
      majorChangeTools: string[]
    }
    expect(resolved.enabled).toBe(false)
    expect(resolved.beforeUserMessage).toBe(false)
    expect(resolved.beforeMajorChange).toBe(false)
    expect(resolved.majorChangeTools).toEqual([...DEFAULT_MAJOR_CHANGE_TOOLS])
  })

  it('默认大改动工具清单为文件修改类 8 项', () => {
    expect(DEFAULT_MAJOR_CHANGE_TOOLS).toEqual([
      'apply_diff',
      'write_file',
      'insert_code',
      'delete_file',
      'delete_code',
      'create_directory',
      'execute_command',
      'edit_file',
    ])
  })
})

describe('shouldCreate 判定', () => {
  const base = {
    enabled: true,
    beforeUserMessage: true,
    beforeMajorChange: true,
    majorChangeTools: [...DEFAULT_MAJOR_CHANGE_TOOLS],
  }

  it('用户消息前：enabled 与 beforeUserMessage 同时为 true 才建', () => {
    expect(shouldCreateUserCheckpoint(base)).toBe(true)
    expect(shouldCreateUserCheckpoint({ ...base, enabled: false })).toBe(false)
    expect(shouldCreateUserCheckpoint({ ...base, beforeUserMessage: false })).toBe(false)
  })

  it('大改动前：enabled + beforeMajorChange + 工具命中才建', () => {
    expect(shouldCreateToolCheckpoint(base, 'apply_diff')).toBe(true)
    expect(shouldCreateToolCheckpoint(base, 'edit_file')).toBe(true)
    // 未命中清单
    expect(shouldCreateToolCheckpoint(base, 'read_file')).toBe(false)
    // 开关关闭
    expect(shouldCreateToolCheckpoint({ ...base, beforeMajorChange: false }, 'apply_diff')).toBe(false)
    expect(shouldCreateToolCheckpoint({ ...base, enabled: false }, 'apply_diff')).toBe(false)
    // 空清单
    expect(shouldCreateToolCheckpoint({ ...base, majorChangeTools: [] }, 'apply_diff')).toBe(false)
  })
})

describe('标题 / notes / 去重键', () => {
  it('checkpointTitleFor：user message 与 tool 两种形态', () => {
    expect(checkpointTitleFor({ type: 'user-message' })).toBe('auto: user message before')
    expect(checkpointTitleFor({ type: 'tool', toolName: 'apply_diff' })).toBe('auto: tool apply_diff before')
  })

  it('checkpointNotesFor：携带会话 id 与轮次', () => {
    expect(checkpointNotesFor('s1', 2)).toBe('session: s1, turn: 2')
    expect(checkpointNotesFor('s1', undefined)).toBe('session: s1')
  })

  it('dedupeKeyFor：turnKey + type', () => {
    expect(dedupeKeyFor('s1', 2, { type: 'user-message' })).toBe('s1:2:user')
    expect(dedupeKeyFor('s1', 2, { type: 'tool', toolName: 'apply_diff' })).toBe('s1:2:tool:apply_diff')
    // 轮次未知时用 open 兜底
    expect(dedupeKeyFor('s1', undefined, { type: 'user-message' })).toBe('s1:open:user')
    expect(checkpointKindKey({ type: 'tool', toolName: 'x' })).toBe('tool:x')
  })
})

describe('AutoCheckpointDedupe（同一 turn 同类型只建一次）', () => {
  it('同 (session, turn, kind) 重复 claim 为 false，跨 turn/跨类型放行', () => {
    const dedupe = new AutoCheckpointDedupe()
    expect(dedupe.claim('s1', 2, { type: 'user-message' })).toBe(true)
    expect(dedupe.claim('s1', 2, { type: 'user-message' })).toBe(false)
    // 不同 turn
    expect(dedupe.claim('s1', 3, { type: 'user-message' })).toBe(true)
    // 不同类型（同一 turn 的 tool 与 user 各自独立）
    expect(dedupe.claim('s1', 2, { type: 'tool', toolName: 'apply_diff' })).toBe(true)
    expect(dedupe.claim('s1', 2, { type: 'tool', toolName: 'apply_diff' })).toBe(false)
    // 不同工具名
    expect(dedupe.claim('s1', 2, { type: 'tool', toolName: 'write_file' })).toBe(true)
    // 不同会话
    expect(dedupe.claim('s2', 2, { type: 'user-message' })).toBe(true)
  })
})

describe('currentTurnOf / isDirectUserMessage', () => {
  it('取最后一条 turn/start 的轮次；无轮次返回 undefined', () => {
    expect(currentTurnOf([])).toBeUndefined()
    expect(currentTurnOf([{ type: 'user/message', data: {} }])).toBeUndefined()
    expect(
      currentTurnOf([
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'turn/end', data: { turn: 1 } },
        { type: 'turn/start', data: { turn: 2 } },
        { type: 'user/message', data: {} },
      ])
    ).toBe(2)
  })

  it('isDirectUserMessage：直接用户消息（source.kind === user）才为 true', () => {
    expect(isDirectUserMessage({ type: 'user/message', data: { source: { kind: 'user' } } })).toBe(true)
    expect(isDirectUserMessage({ type: 'user/message', data: { source: { kind: 'inject' } } })).toBe(false)
    expect(isDirectUserMessage({ type: 'turn/start', data: { source: { kind: 'user' } } })).toBe(false)
    expect(isDirectUserMessage({ type: 'user/message', data: {} })).toBe(false)
  })
})
