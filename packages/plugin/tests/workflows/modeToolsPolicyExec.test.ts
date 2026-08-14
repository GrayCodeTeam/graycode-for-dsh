/**
 * 模式工具策略执行层测试（审计 R1-M3 / R3-H3，决策 D-4）。
 *
 * 覆盖：allowlist 放行/拦截、search_in_files replace 越权检查、
 * plan 模式 write_file 受控例外、自定义模式、enabled 开关关闭时零侵入、
 * 内置模式默认策略与旧版 BUILTIN_MODE_TOOL_POLICIES 对齐快照、
 * Windows 大小写不敏感路径回归（BUG-10）。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  BUILTIN_MODE_TOOL_POLICIES,
  GENERAL_FILE_WRITE_TOOLS,
  MEMORY_TOOL_NAMES,
  READONLY_MODE_COMMON_TOOLS,
  createModeToolPolicyGuard,
  evaluateModeToolPolicy,
  isDesignPathAllowed,
  isPlanPathAllowed,
  isProgressPathAllowed,
  isSearchInFilesReplaceForbidden,
  isToolAllowedByPolicy,
  resolveBuiltinModeToolPolicy,
  type ModeToolPolicyGuard,
} from '../../src/workflows/domain/modeToolsPolicy.ts'

/** 旧版（1.5.4）各内置模式 toolPolicy 快照（promptModes.ts:314-418，逐字）。 */
const LEGACY_DESIGN_POLICY = [
  ...READONLY_MODE_COMMON_TOOLS,
  'todo_write', 'todo_update',
  'create_progress', 'update_progress', 'record_progress_milestone', 'validate_progress_document',
  'create_design', 'update_design',
  ...MEMORY_TOOL_NAMES,
]
const LEGACY_PLAN_POLICY = [
  ...READONLY_MODE_COMMON_TOOLS,
  'todo_write', 'todo_update',
  'create_progress', 'update_progress', 'record_progress_milestone', 'validate_progress_document',
  'create_plan', 'update_plan',
  ...MEMORY_TOOL_NAMES,
]
const LEGACY_ASK_POLICY = [
  ...READONLY_MODE_COMMON_TOOLS,
  'todo_write', 'todo_update',
]

describe('isToolAllowedByPolicy (allowlist 放行/拦截)', () => {
  it('undefined / 空数组 = 未启用过滤，一律放行', () => {
    expect(isToolAllowedByPolicy('write_file', undefined)).toBe(true)
    expect(isToolAllowedByPolicy('execute_command', undefined)).toBe(true)
    expect(isToolAllowedByPolicy('write_file', [])).toBe(true)
    expect(isToolAllowedByPolicy('read_file', [])).toBe(true)
  })

  it('非空数组仅放行名单内工具', () => {
    const policy = ['read_file', 'search_in_files']
    expect(isToolAllowedByPolicy('read_file', policy)).toBe(true)
    expect(isToolAllowedByPolicy('search_in_files', policy)).toBe(true)
    expect(isToolAllowedByPolicy('write_file', policy)).toBe(false)
    expect(isToolAllowedByPolicy('apply_diff', policy)).toBe(false)
    expect(isToolAllowedByPolicy('execute_command', policy)).toBe(false)
  })

  it('自定义模式名单按字面匹配（大小写敏感，与旧版 includes 一致）', () => {
    const policy = ['READ_FILE']
    expect(isToolAllowedByPolicy('read_file', policy)).toBe(false)
    expect(isToolAllowedByPolicy('READ_FILE', policy)).toBe(true)
  })
})

describe('evaluateModeToolPolicy (执行判定)', () => {
  it('无 toolPolicy 时放行一切（含写工具与命令执行）', () => {
    expect(evaluateModeToolPolicy({ toolName: 'write_file' })).toBeUndefined()
    expect(evaluateModeToolPolicy({ toolName: 'execute_command' })).toBeUndefined()
    expect(evaluateModeToolPolicy({ toolName: 'read_file', toolPolicy: undefined })).toBeUndefined()
    expect(evaluateModeToolPolicy({ toolName: 'read_file', toolPolicy: [] })).toBeUndefined()
  })

  it('allowlist 拦截名单外工具，消息携带模式 id', () => {
    const reason = evaluateModeToolPolicy({
      toolName: 'write_file',
      toolPolicy: BUILTIN_MODE_TOOL_POLICIES.ask,
      modeId: 'ask',
    })
    expect(reason).toBe('Tool "write_file" is not allowed in mode "ask".')
  })

  it('allowlist 放行名单内工具', () => {
    expect(evaluateModeToolPolicy({
      toolName: 'read_file',
      toolPolicy: BUILTIN_MODE_TOOL_POLICIES.ask,
      modeId: 'ask',
    })).toBeUndefined()
    expect(evaluateModeToolPolicy({
      toolName: 'create_design',
      toolPolicy: BUILTIN_MODE_TOOL_POLICIES.design,
      modeId: 'design',
    })).toBeUndefined()
  })

  it('未知模式 id 时拒绝消息使用 unknown', () => {
    const reason = evaluateModeToolPolicy({
      toolName: 'write_file',
      toolPolicy: BUILTIN_MODE_TOOL_POLICIES.ask,
    })
    expect(reason).toBe('Tool "write_file" is not allowed in mode "unknown".')
  })

  it('search_in_files search 模式在只读模式下放行', () => {
    expect(evaluateModeToolPolicy({
      toolName: 'search_in_files',
      args: { mode: 'search' },
      toolPolicy: BUILTIN_MODE_TOOL_POLICIES.ask,
      modeId: 'ask',
    })).toBeUndefined()
  })

  it('search_in_files replace 模式在只读模式下被拒（越权检查）', () => {
    const reason = evaluateModeToolPolicy({
      toolName: 'search_in_files',
      args: { mode: 'replace' },
      toolPolicy: BUILTIN_MODE_TOOL_POLICIES.ask,
      modeId: 'ask',
    })
    expect(reason).toContain('only permits read-only search')
    expect(reason).toContain('mode "ask"')
  })

  it('search_in_files 无参数时不被误拒', () => {
    expect(evaluateModeToolPolicy({
      toolName: 'search_in_files',
      toolPolicy: BUILTIN_MODE_TOOL_POLICIES.ask,
      modeId: 'ask',
    })).toBeUndefined()
  })

  it('allowlist 同时授予 search_in_files 与通用写工具时 replace 放行', () => {
    expect(evaluateModeToolPolicy({
      toolName: 'search_in_files',
      args: { mode: 'replace' },
      toolPolicy: ['read_file', 'search_in_files', 'write_file', 'apply_diff'],
      modeId: 'custom',
    })).toBeUndefined()
  })

  it('code 模式（无策略）下 replace 放行', () => {
    expect(evaluateModeToolPolicy({
      toolName: 'search_in_files',
      args: { mode: 'replace' },
      toolPolicy: resolveBuiltinModeToolPolicy('code'),
      modeId: 'code',
    })).toBeUndefined()
  })

  it('plan 模式 write_file 受控例外：仅允许 .graycode/plans/**.md', () => {
    const planPolicyWithWrite = ['write_file', ...(BUILTIN_MODE_TOOL_POLICIES.plan ?? [])]
    expect(evaluateModeToolPolicy({
      toolName: 'write_file',
      args: { path: '.graycode/plans/foo.plan.md' },
      toolPolicy: planPolicyWithWrite,
      modeId: 'plan',
    })).toBeUndefined()
    expect(evaluateModeToolPolicy({
      toolName: 'write_file',
      args: { path: '.graycode/plans/sub/foo.md' },
      toolPolicy: planPolicyWithWrite,
      modeId: 'plan',
    })).toBeUndefined()

    const rejected = evaluateModeToolPolicy({
      toolName: 'write_file',
      args: { path: '.graycode/design/foo.md' },
      toolPolicy: planPolicyWithWrite,
      modeId: 'plan',
    })
    expect(rejected).toBe('In plan mode, write_file is only allowed to write ".graycode/plans/**.md". Rejected path: .graycode/design/foo.md')
  })

  it('plan 模式 write_file 路径大小写不敏感（Windows，BUG-10 回归）', () => {
    const planPolicyWithWrite = ['write_file', ...(BUILTIN_MODE_TOOL_POLICIES.plan ?? [])]
    expect(evaluateModeToolPolicy({
      toolName: 'write_file',
      args: { path: '.GRAYCODE/PLANS/foo.PLAN.MD' },
      toolPolicy: planPolicyWithWrite,
      modeId: 'plan',
    })).toBeUndefined()
    expect(evaluateModeToolPolicy({
      toolName: 'write_file',
      args: { path: '.GRAYCODE/DESIGN/foo.md' },
      toolPolicy: planPolicyWithWrite,
      modeId: 'plan',
    })).not.toBeUndefined()
  })

  it('plan 模式 write_file 空/非字符串 path 被拒', () => {
    const planPolicyWithWrite = ['write_file', ...(BUILTIN_MODE_TOOL_POLICIES.plan ?? [])]
    expect(evaluateModeToolPolicy({
      toolName: 'write_file',
      args: { path: '   ' },
      toolPolicy: planPolicyWithWrite,
      modeId: 'plan',
    })).toBe('In plan mode, write_file requires a non-empty "path" string.')
    expect(evaluateModeToolPolicy({
      toolName: 'write_file',
      args: {},
      toolPolicy: planPolicyWithWrite,
      modeId: 'plan',
    })).toBe('In plan mode, write_file requires a non-empty "path" string.')
  })

  it('plan 模式默认白名单不含 write_file：先被 allowlist 拒绝（与旧版一致）', () => {
    const reason = evaluateModeToolPolicy({
      toolName: 'write_file',
      args: { path: '.graycode/plans/foo.plan.md' },
      toolPolicy: BUILTIN_MODE_TOOL_POLICIES.plan,
      modeId: 'plan',
    })
    expect(reason).toBe('Tool "write_file" is not allowed in mode "plan".')
  })

  it('plan 模式 write_file 支持 multi-root 前缀（workspaceName 与首段一致时）', () => {
    const planPolicyWithWrite = ['write_file', ...(BUILTIN_MODE_TOOL_POLICIES.plan ?? [])]

    // 未提供 workspaceName 信息时保持原行为：带前缀路径仍拒绝
    expect(evaluateModeToolPolicy({
      toolName: 'write_file',
      args: { path: 'my-project/.graycode/plans/foo.md' },
      toolPolicy: planPolicyWithWrite,
      modeId: 'plan',
    })).toContain('only allowed to write')

    // workspaceName 与首段一致时接受 multi-root 前缀（与 workspace.ts
    // isScopedPathAllowedWithMultiRoot 的剥离口径一致）
    expect(evaluateModeToolPolicy({
      toolName: 'write_file',
      args: { path: 'my-project/.graycode/plans/foo.md' },
      toolPolicy: planPolicyWithWrite,
      modeId: 'plan',
      workspaceName: 'my-project',
    })).toBeUndefined()

    // 前缀与 workspace 名不匹配时仍拒绝
    expect(evaluateModeToolPolicy({
      toolName: 'write_file',
      args: { path: 'other/.graycode/plans/foo.md' },
      toolPolicy: planPolicyWithWrite,
      modeId: 'plan',
      workspaceName: 'my-project',
    })).toContain('only allowed to write')
  })
})

describe('createModeToolPolicyGuard (DSH 拦截器适配)', () => {
  /** 模拟 DSH ToolExecution 形状（超集字段不影响结构兼容）。 */
  const exec = (name: string, args?: unknown): Readonly<{ name: string; arguments?: unknown; callId: string }> => ({
    name,
    arguments: args,
    callId: `call-${name}`,
  })

  it('enabled: false 时零侵入：恒放行且不调用任何 resolve', () => {
    const resolveToolPolicy = vi.fn(() => BUILTIN_MODE_TOOL_POLICIES.ask)
    const resolveModeId = vi.fn(() => 'ask')
    const guard = createModeToolPolicyGuard({ enabled: false, resolveToolPolicy, resolveModeId })

    expect(guard(exec('write_file', { path: 'x' }))).toBeUndefined()
    expect(guard(exec('execute_command'))).toBeUndefined()
    expect(resolveToolPolicy).not.toHaveBeenCalled()
    expect(resolveModeId).not.toHaveBeenCalled()
  })

  it('无任何选项时放行一切（纯装饰性挂接）', () => {
    const guard = createModeToolPolicyGuard()
    expect(guard(exec('write_file'))).toBeUndefined()
    expect(guard(exec('execute_command'))).toBeUndefined()
  })

  it('按当前模式 allowlist 拦截/放行', () => {
    const guard = createModeToolPolicyGuard({
      resolveToolPolicy: () => BUILTIN_MODE_TOOL_POLICIES.ask,
      resolveModeId: () => 'ask',
    })

    expect(guard(exec('read_file', { path: 'a.md' }))).toBeUndefined()
    expect(guard(exec('write_file', { path: 'a.md' }))).toBe('Tool "write_file" is not allowed in mode "ask".')
    expect(guard(exec('search_in_files', { mode: 'replace' })))
      .toContain('only permits read-only search')
  })

  it('模式切换无需重新挂接：resolve 实时求值', () => {
    let policy: readonly string[] | undefined = BUILTIN_MODE_TOOL_POLICIES.ask
    const guard = createModeToolPolicyGuard({
      resolveToolPolicy: () => policy,
      resolveModeId: () => 'mode-x',
    })

    expect(guard(exec('write_file'))).toContain('not allowed in mode "mode-x"')

    // 模拟模式切换（ask → code 无策略）
    policy = resolveBuiltinModeToolPolicy('code')
    expect(guard(exec('write_file'))).toBeUndefined()
  })

  it('自定义模式策略：resolveToolPolicy 返回自定义名单', () => {
    const guard = createModeToolPolicyGuard({
      resolveToolPolicy: () => ['read_file', 'history_search', 'create_plan'],
      resolveModeId: () => 'my-mode',
    })
    expect(guard(exec('create_plan'))).toBeUndefined()
    expect(guard(exec('update_plan'))).toBe('Tool "update_plan" is not allowed in mode "my-mode".')
  })

  it('resolveToolPolicy 抛错时 fail-closed 拒绝（策略不可用不放行）', () => {
    const guard = createModeToolPolicyGuard({
      resolveToolPolicy: () => { throw new Error('store corrupt') },
      resolveModeId: () => 'ask',
    })
    const reason = guard(exec('read_file'))
    expect(reason).toContain('[graycode:mode-tool-policy] tool policy resolution failed')
    expect(reason).toContain('read_file')
  })

  it('arguments 非对象/缺省时按工具名判定（replace 检查需要 args.mode 才触发）', () => {
    const guard = createModeToolPolicyGuard({
      resolveToolPolicy: () => BUILTIN_MODE_TOOL_POLICIES.ask,
      resolveModeId: () => 'ask',
    })
    expect(guard(exec('search_in_files'))).toBeUndefined()
    expect(guard(exec('search_in_files', 'not-an-object'))).toBeUndefined()
  })

  it('createModeToolPolicyGuard 支持 resolveWorkspaceName 解析 multi-root 前缀', () => {
    const guard = createModeToolPolicyGuard({
      resolveToolPolicy: () => ['write_file'],
      resolveModeId: () => 'plan',
      resolveWorkspaceName: () => 'my-project',
    })
    expect(guard(exec('write_file', { path: 'my-project/.graycode/plans/foo.md' }))).toBeUndefined()
    expect(guard(exec('write_file', { path: '.graycode/plans/foo.md' }))).toBeUndefined()
    expect(guard(exec('write_file', { path: '.graycode/design/foo.md' }))).toContain('only allowed to write')
  })
})

describe('BUILTIN_MODE_TOOL_POLICIES（与旧版 promptModes.ts 对齐快照）', () => {
  it('design 名单与旧版逐字一致', () => {
    expect(BUILTIN_MODE_TOOL_POLICIES.design).toEqual(LEGACY_DESIGN_POLICY)
  })

  it('plan 名单与旧版逐字一致', () => {
    expect(BUILTIN_MODE_TOOL_POLICIES.plan).toEqual(LEGACY_PLAN_POLICY)
  })

  it('ask 名单与旧版逐字一致（最严格：无写/进度/记忆工具）', () => {
    expect(BUILTIN_MODE_TOOL_POLICIES.ask).toEqual(LEGACY_ASK_POLICY)
  })

  it('review 名单与旧版逐字一致（另含新插件只读工具 compare_review_documents）', () => {
    expect(BUILTIN_MODE_TOOL_POLICIES.review).toEqual([
      ...READONLY_MODE_COMMON_TOOLS,
      'create_review',
      'validate_review_document',
      'compare_review_documents',
      'create_progress',
      'update_progress',
      'record_progress_milestone',
      'validate_progress_document',
      'record_review_milestone',
      'finalize_review',
      'reopen_review',
      ...MEMORY_TOOL_NAMES,
    ])
  })

  it('code 模式不在表内（旧版 CODE_PROMPT_MODE 无 toolPolicy）', () => {
    expect(BUILTIN_MODE_TOOL_POLICIES.code).toBeUndefined()
    expect(Object.keys(BUILTIN_MODE_TOOL_POLICIES).sort()).toEqual(['ask', 'design', 'plan', 'review'])
  })

  it('resolveBuiltinModeToolPolicy：内置模式返回名单，code/未知/自定义/undefined 返回 undefined', () => {
    expect(resolveBuiltinModeToolPolicy('design')).toBe(BUILTIN_MODE_TOOL_POLICIES.design)
    expect(resolveBuiltinModeToolPolicy('plan')).toBe(BUILTIN_MODE_TOOL_POLICIES.plan)
    expect(resolveBuiltinModeToolPolicy('ask')).toBe(BUILTIN_MODE_TOOL_POLICIES.ask)
    expect(resolveBuiltinModeToolPolicy('review')).toBe(BUILTIN_MODE_TOOL_POLICIES.review)
    expect(resolveBuiltinModeToolPolicy('code')).toBeUndefined()
    expect(resolveBuiltinModeToolPolicy('my-custom-mode')).toBeUndefined()
    expect(resolveBuiltinModeToolPolicy(undefined)).toBeUndefined()
  })

  it('只读安全不变量：design/plan/ask/review 名单均不含任何通用文件写工具', () => {
    for (const modeId of ['design', 'plan', 'ask', 'review'] as const) {
      for (const writeTool of GENERAL_FILE_WRITE_TOOLS) {
        expect(BUILTIN_MODE_TOOL_POLICIES[modeId]).not.toContain(writeTool)
      }
      expect(BUILTIN_MODE_TOOL_POLICIES[modeId]).not.toContain('execute_command')
    }
  })

  it('只读安全不变量：ask 名单不含进度/设计/审查域工具', () => {
    expect(BUILTIN_MODE_TOOL_POLICIES.ask).not.toContain('create_progress')
    expect(BUILTIN_MODE_TOOL_POLICIES.ask).not.toContain('update_progress')
    expect(BUILTIN_MODE_TOOL_POLICIES.ask).not.toContain('create_design')
    expect(BUILTIN_MODE_TOOL_POLICIES.ask).not.toContain('create_review')
    expect(BUILTIN_MODE_TOOL_POLICIES.ask).not.toContain('memory_wake')
  })

  it('内置只读名单与 isSearchInFilesReplaceForbidden 协同：replace 越权被拒绝', () => {
    for (const modeId of ['design', 'plan', 'ask', 'review'] as const) {
      expect(isSearchInFilesReplaceForbidden(BUILTIN_MODE_TOOL_POLICIES[modeId])).toBe(true)
    }
  })

  it('GENERAL_FILE_WRITE_TOOLS 完整性（与 tools/subagents/presets.ts 的 WRITE_TOOLS 口径一致）', () => {
    expect([...GENERAL_FILE_WRITE_TOOLS].sort()).toEqual([
      'apply_diff',
      'create_directory',
      'delete_code',
      'delete_file',
      'insert_code',
      'write_file',
    ])
  })
})

describe('Windows 大小写不敏感路径回归（BUG-10，审计修复回归确认）', () => {
  it('路径白名单接受大小写变体', () => {
    expect(isDesignPathAllowed('.GRAYCODE/DESIGN/FOO.MD')).toBe(true)
    expect(isPlanPathAllowed('.GrayCode/Plans/X.PLAN.MD')).toBe(true)
    expect(isProgressPathAllowed('.GRAYCODE/PROGRESS.MD')).toBe(true)
  })

  it('大小写归一不影响拒绝规则', () => {
    expect(isDesignPathAllowed('.GRAYCODE/PLANS/foo.md')).toBe(false)
    expect(isPlanPathAllowed('.graycode/design/foo.md')).toBe(false)
    expect(isProgressPathAllowed('.GRAYCODE/PROGRESS2.MD')).toBe(false)
    expect(isDesignPathAllowed('.graycode/design/..')).toBe(false)
  })

  it('guard 拦截器在只读模式下对大小写变体路径的 plan 例外仍正确', () => {
    // 通过 evaluateModeToolPolicy 间接覆盖：guard 内部走同一判定
    const guard: ModeToolPolicyGuard = createModeToolPolicyGuard({
      resolveToolPolicy: () => ['write_file'],
      resolveModeId: () => 'plan',
    })
    expect(guard({ name: 'write_file', arguments: { path: '.GRAYCODE/PLANS/x.md' } })).toBeUndefined()
    expect(guard({ name: 'write_file', arguments: { path: '.graycode/design/x.md' } }))
      .toContain('Rejected path')
  })
})
