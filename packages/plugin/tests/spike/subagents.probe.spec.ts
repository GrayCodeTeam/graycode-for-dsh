/**
 * DSH subagent 能力覆盖探针（packages/plugin/tests/spike/subagents.probe.spec.ts）
 *
 * 目的：验证「老 Gray 的 subagents / agent_send_message 由 DSH subagent 工具族覆盖」
 * 这一侦察结论，并把证据固化下来。只断言 DSH 包的导出面与注册面（零网络、零模型），
 * 不真跑子代理（真跑需要模型与完整 base 层组合）。
 *
 * 证据链：
 * 1. 本探针直接 import 真实安装的 `@deepseek-ai/dsh-subagent@0.1.0-rc.6`
 *    （packages/plugin devDependencies），验证 `ctx.subagents` 服务 seam：
 *    - 导出面：SubagentRuntime / SubagentError / SubagentDepthError /
 *      assertSubagentMaxDepth / delegationDepthOf / resolveChildDepth / settleRun；
 *    - 注册面：named-provider 注册表（registerProvider/getProvider/list）、
 *      DUPLICATE_PROVIDER / NO_PROVIDER 失败路径；
 *    - 深度限制配置面：maxDepth 校验（assertSubagentMaxDepth）与 capability 门禁
 *      （请求 maxDepth 而 provider 无 depthLimit capability → UNSUPPORTED_CAPABILITY）；
 *    - 深度语义：resolveChildDepth（parent 深度 + 1 > maxDepth → SubagentDepthError），
 *      持久化 header 为单调下限（delegationDepthOf = max(header, runtime)）。
 * 2. 工具族（subagent / subagent_fork / send_message / interrupt_agent / list_agents /
 *    report）由 DSH base 层 bundle 挂载（A:\api\deepseek-harness\packages\bundle\base\
 *    cordis.patch.yml 的 subagent 行族），本仓库的 @graycode/dsh bundle 是 base 之上的
 *    增量层，不重复挂载。探针把 base 行族钉为常量表（对照 harness 源码走查），并守卫
 *    @graycode/dsh 的 cordis.patch.yml 不复制这些行（防止未来重复挂载导致分层漂移）。
 * 3. 真实 ctx.tools 发现（工具注册到 tool registry）需要 base 层插件
 *    （@deepseek-ai/dsh-tool-subagent 等）在场，本仓库 node_modules 未安装这些包，
 *    该部分用 describe.skip 标注并给出手动验证步骤（见文末）。
 *
 * 结论互见：docs/SUBAGENTS_VERIFICATION.md（语义对照表 + 缺口清单）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as subagentPkg from '@deepseek-ai/dsh-subagent'
import SubagentRuntime, {
  SubagentDepthError,
  SubagentError,
  SubagentRunId,
  assertSubagentMaxDepth,
  delegationDepthOf,
  resolveChildDepth,
  settleRun,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'

/* ------------------------------------------------------------------ *
 * 常量与夹具                                                          *
 * ------------------------------------------------------------------ */

/** DSH base 层 bundle 挂载的 subagent 行族（harness 源码走查证据，见 docs/SUBAGENTS_VERIFICATION.md）。 */
const BASE_SUBAGENT_ROWS = [
  { id: 'subagent', package: '@deepseek-ai/dsh-subagent', registers: 'ctx.subagents 服务 seam' },
  { id: 'subagent-spawn-in-process', package: '@deepseek-ai/dsh-subagent-spawn-in-process', registers: "provider 'spawn'" },
  { id: 'subagent-fork-in-process', package: '@deepseek-ai/dsh-subagent-fork-in-process', registers: "provider 'fork'" },
  { id: 'tool-subagent-control', package: '@deepseek-ai/dsh-tool-subagent-control', registers: 'send_message / interrupt_agent' },
  { id: 'tool-subagent-list-agents', package: '@deepseek-ai/dsh-tool-subagent-control/list-agents', registers: 'list_agents' },
  { id: 'tool-subagent', package: '@deepseek-ai/dsh-tool-subagent', registers: 'subagent（provider spawn，continuable，maxDepth 默认 3）' },
  { id: 'tool-subagent-fork', package: '@deepseek-ai/dsh-tool-subagent', registers: 'subagent_fork（provider fork，one-shot）' },
  { id: 'tool-subagent-report', package: '@deepseek-ai/dsh-tool-subagent-report', registers: 'report（仅 continuable 子代理作用域内注册）' },
] as const

/** 老 Gray subagents 工具族 → DSH 覆盖映射（对照表见 docs/SUBAGENTS_VERIFICATION.md §3）。 */
const LEGACY_TO_DSH = [
  { legacy: 'subagents（按名派生子代理）', dsh: 'subagent / subagent_fork' },
  { legacy: 'agent_send_message（父→子）', dsh: 'send_message（仅直接父代理，更严格）' },
  { legacy: 'agent_send_message（子→父/主会话）', dsh: 'report（框架化：仅直接父代理，不可寻址任意代理）' },
  { legacy: 'threadId + hopDepth 防循环（MAX_HOP_DEPTH=5）', dsh: '无 hop 计数器；由 maxDepth 深度上限 + 父代理授权 + FIFO inbox 约束' },
  { legacy: '嵌套深度上限（MAX_SUBAGENT_NESTING_DEPTH=2）', dsh: 'maxDepth（默认 3）+ 持久化 delegationDepth 单调下限' },
  { legacy: '子代理 transcript 落盘（subagents/{runId}.json）', dsh: 'child session log（session-persistence）+ send_message 冷恢复' },
] as const

const NO_CAPABILITIES: SubagentCapabilities = {
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
}

/** 构造一个最小 stub provider：start 永远不该被服务层之外调用（探针只测门禁与注册面）。 */
function stubProvider(name: string, capabilities: SubagentCapabilities = NO_CAPABILITIES): SubagentProvider {
  return {
    name,
    capabilities,
    inheritsParentContext: false,
    start: async () => {
      throw new Error(`probe: provider "${name}".start() must not be reached`)
    },
  }
}

/** 最小 parent 夹具：只携带 delegationDepth 相关字段（delegationDepthOf 只读这两处）。 */
function fakeParent(depth?: { header?: number; runtime?: number }): Agent {
  return {
    options: depth?.runtime !== undefined ? { subagentDepth: depth.runtime } : {},
    session: { header: depth?.header !== undefined ? { delegationDepth: depth.header } : {} },
  } as unknown as Agent
}

/** 构造带 maxDepth 的 one-shot 请求（仅用于门禁/失败路径，不会真正派生子代理）。 */
function requestWithMaxDepth(maxDepth: number): SubagentStartRequest {
  return {
    label: 'probe',
    prompt: [{ type: 'text', text: 'probe prompt' }],
    parent: fakeParent(),
    maxDepth,
    signal: new AbortController().signal,
  }
}

/** 挂载真实 SubagentRuntime 服务 seam（同 matrix.test.ts 的 new LlmRuntime 模式）。 */
function harness(): Context {
  const ctx = new Context()
  new SubagentRuntime(ctx)
  return ctx
}

/* ------------------------------------------------------------------ *
 * 探针用例                                                           *
 * ------------------------------------------------------------------ */

describe('DSH subagent 包导出面（@deepseek-ai/dsh-subagent@0.1.0-rc.6）', () => {
  it('核心导出齐全：Runtime 类、深度校验、错误类型、run 标识、settle 工具', () => {
    expect(typeof SubagentRuntime).toBe('function')
    expect(SubagentRuntime.name).toBe('SubagentRuntime')
    expect(typeof assertSubagentMaxDepth).toBe('function')
    expect(typeof delegationDepthOf).toBe('function')
    expect(typeof resolveChildDepth).toBe('function')
    expect(typeof settleRun).toBe('function')
    expect(typeof SubagentRunId).toBe('function')
    expect(SubagentRunId('run-1')).toBe('run-1')
    expect(SubagentDepthError.name).toBe('SubagentDepthError')
    expect(SubagentError.name).toBe('SubagentError')
  })

  it('default 导出即 SubagentRuntime 类', () => {
    expect(subagentPkg.default).toBe(SubagentRuntime)
    expect(subagentPkg.SubagentRuntime).toBe(SubagentRuntime)
  })
})

describe('ctx.subagents 注册面（真实 Context，零网络）', () => {
  it('new SubagentRuntime(ctx) 挂载 ctx.subagents；初始注册表为空', () => {
    const ctx = harness()
    expect(ctx.subagents).toBeInstanceOf(SubagentRuntime)
    expect(ctx.subagents.list()).toEqual([])
    expect(ctx.subagents.getProvider('spawn')).toBeUndefined()
  })

  it('registerProvider / getProvider / list 往返；disposer 注销', () => {
    const ctx = harness()
    const provider = stubProvider('spawn')
    const dispose = ctx.subagents.registerProvider(provider)
    expect(ctx.subagents.list()).toEqual(['spawn'])
    expect(ctx.subagents.getProvider('spawn')).toBe(provider)
    dispose()
    expect(ctx.subagents.list()).toEqual([])
    expect(ctx.subagents.getProvider('spawn')).toBeUndefined()
  })

  it('重复注册同名 provider → SubagentError(DUPLICATE_PROVIDER)', () => {
    const ctx = harness()
    ctx.subagents.registerProvider(stubProvider('spawn'))
    let caught: unknown
    try {
      ctx.subagents.registerProvider(stubProvider('spawn'))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SubagentError)
    expect((caught as SubagentError).code).toBe('DUPLICATE_PROVIDER')
  })

  it('start() 未知名 provider → SubagentError(NO_PROVIDER)', async () => {
    const ctx = harness()
    await expect(ctx.subagents.start('ghost', requestWithMaxDepth(3))).rejects.toMatchObject({
      code: 'NO_PROVIDER',
    })
  })
})

describe('深度限制配置面（preset/maxDepth）', () => {
  it('assertSubagentMaxDepth 接受 undefined / 0 / 3', () => {
    expect(() => assertSubagentMaxDepth(undefined)).not.toThrow()
    expect(() => assertSubagentMaxDepth(0)).not.toThrow()
    expect(() => assertSubagentMaxDepth(3)).not.toThrow()
  })

  it('assertSubagentMaxDepth 拒绝非负安全整数之外的输入', () => {
    for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, -0, '3', Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => assertSubagentMaxDepth(bad), `maxDepth=${String(bad)}`).toThrow(TypeError)
    }
  })

  it('请求 maxDepth 而 provider 无 depthLimit capability → UNSUPPORTED_CAPABILITY（门禁在 seam 层）', async () => {
    const ctx = harness()
    ctx.subagents.registerProvider(stubProvider('no-depth'))
    await expect(ctx.subagents.start('no-depth', requestWithMaxDepth(3))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    })
  })

  it('resolveChildDepth：parent 深度 + 1 超过 maxDepth → SubagentDepthError(attempted, max)', () => {
    // 顶层 parent（深度 0）→ child 深度 1；maxDepth=0 即禁止一切委派。
    expect(() => resolveChildDepth(fakeParent(), 0)).toThrowError(SubagentDepthError)
    try {
      resolveChildDepth(fakeParent(), 0)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(SubagentDepthError)
      expect((error as SubagentDepthError).attemptedDepth).toBe(1)
      expect((error as SubagentDepthError).maxDepth).toBe(0)
    }
    // maxDepth=2 时顶层委派合法。
    expect(resolveChildDepth(fakeParent(), 2)).toBe(1)
    // maxDepth 缺省 = 不限（由调用方/tool 配置决定是否传）。
    expect(resolveChildDepth(fakeParent(), undefined)).toBe(1)
  })

  it('delegationDepthOf：持久化 header 是单调下限，runtime 只能加深不能回退', () => {
    // header 2 + runtime 1 → 2（resume 后 runtime 缺失/变浅也不回退）。
    expect(delegationDepthOf(fakeParent({ header: 2, runtime: 1 }))).toBe(2)
    // header 1 + runtime 3 → 3（runtime 可加深）。
    expect(delegationDepthOf(fakeParent({ header: 1, runtime: 3 }))).toBe(3)
    // 均缺省 → 0（顶层）。
    expect(delegationDepthOf(fakeParent())).toBe(0)
    // runtime 非法 → TypeError。
    expect(() => delegationDepthOf(fakeParent({ runtime: -1 }))).toThrow(TypeError)
  })
})

describe('bundle 挂载守卫（@graycode/dsh 不重复挂载 base 行族）', () => {
  const bundlePatch = readFileSync(
    fileURLToPath(new URL('../../../bundle/cordis.patch.yml', import.meta.url)),
    'utf8',
  )

  it('graycode bundle 只钉 graycode 插件行（增量 patch 风格）', () => {
    expect(bundlePatch).toContain("name: '@graycode/dsh-plugin'")
    expect(bundlePatch).toContain("name: '@graycode/dsh-client'")
  })

  it('graycode bundle 不复制 base 层的 subagent 行族（base 已挂载，避免分层漂移）', () => {
    for (const row of BASE_SUBAGENT_ROWS) {
      expect(bundlePatch, `row id ${row.id} 不应出现在 @graycode/dsh patch 中`).not.toContain(`- id: ${row.id}`)
    }
  })

  it('base 行族常量表与老 Gray→DSH 映射表保持可审计（走查证据见 docs/SUBAGENTS_VERIFICATION.md）', () => {
    expect(BASE_SUBAGENT_ROWS.map((row) => row.id)).toEqual([
      'subagent',
      'subagent-spawn-in-process',
      'subagent-fork-in-process',
      'tool-subagent-control',
      'tool-subagent-list-agents',
      'tool-subagent',
      'tool-subagent-fork',
      'tool-subagent-report',
    ])
    expect(LEGACY_TO_DSH.length).toBeGreaterThanOrEqual(6)
  })
})

/**
 * 工具族真实注册进 ctx.tools 的验证需要 base 层插件在场
 * （@deepseek-ai/dsh-tool-subagent / -control / -report 等），本仓库 node_modules
 * 只安装了 seam 包（@deepseek-ai/dsh-subagent），故此处跳过并给出手动验证步骤。
 *
 * 手动验证（完整 DSH profile，含模型或 scripted provider）：
 * 1. `dsh plugin --profile graycode add ./graycode-dsh-0.1.0.tgz` 后
 *    `dsh --profile graycode` 启动（base 层自动挂载 subagent 行族）。
 * 2. 在 profile 内挂一个 10 行探针插件：
 *    ```ts
 *    import { Context } from '@deepseek-ai/cordis'
 *    export const name = 'probe-tools'
 *    export function apply(ctx: Context): void {
 *      ctx.on('ready', () => {
 *        for (const tool of ['subagent', 'subagent_fork', 'send_message',
 *                            'interrupt_agent', 'list_agents']) {
 *          ctx.logger.info(`probe tool ${tool}: ${ctx.tools.get(tool) !== undefined}`)
 *        }
 *      })
 *    }
 *    ```
 *    预期 5 行均 true（report 只在子代理作用域注册，root 上查不到属预期）。
 * 3. 或直接开一个会话让模型调用 `list_agents` / `send_message`，确认工具可发现且
 *    send_message 对深度>1 的后代返回明确拒绝（见 docs/SUBAGENTS_VERIFICATION.md §3）。
 */
describe.skip('DSH 工具族 live 注册（需完整 base 层组合，本仓库无模型环境跳过）', () => {
  it('subagent / subagent_fork / send_message / interrupt_agent / list_agents 经 ctx.tools 可发现', () => {
    expect.unreachable('见上方手动验证步骤')
  })
})
