/**
 * P3D Staged-diff 决策门探针（packages/plugin/tests/spike/staged-diff.spec.ts）
 *
 * 目标：用真实 DSH 0.1.0-rc.6 流水线验证「延迟接受/拒绝文件改动」的四个产品场景，
 * 记录原生 diff/approval 的实际能力边界，作为 docs/ADR-0003.md 的事实依据。
 *
 * 方法：复用 tests/e2e/harness.ts 的组合（LocalFileSystem → SessionStore →
 * AgentRegistry → SystemPrompt → ToolRuntime → LlmRuntime → AgentLoop → graycode
 * 插件），在测试内注册探针写工具（probe_write / probe_write_multi：经 ctx.fs
 * 原子落盘，带 presentCall / presentationMeta / presentResult 的 diff 展示），
 * 挂 tools/pre-execute ask 门，并用 ctx.provide('approval', stub) 注入 stub
 * 审批服务（@deepseek-ai/dsh-user-approval 未安装，真实环境无 approval 服务时
 * ask 会退化为 deny，本探针两种路径都覆盖）。
 *
 * 探针结论（与 ADR-0003 互见；全部为对 DSH 实际行为的断言，不做能力伪装）：
 * - 场景 1 单文件接受：GAP —— ask 只能「写前批准/拒绝」；写后只有展示性 diff
 *   卡片，不存在「审阅后接受才落盘」；post-execute block 不回滚已写文件。
 * - 场景 2 部分文件拒绝：GAP —— 审批粒度是整次工具调用，无文件级 accept/reject。
 * - 场景 3 跨工具累计：GAP —— 每次调用即时落盘、独立审批；累计的只有会话日志
 *   （tool/call + tool/result + diff meta 可回放），无「合并待审集合」。
 * - 场景 4 会话重启后继续审阅：GAP —— 无 sessionPersistence backend 时
 *   AgentRegistry.resume 抛错；审批请求是进程内 request/response，无待审队列
 *   持久化；重启后只能回放已写历史，待审列表不存在。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { SessionEvent, JsonValue } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { Harness } from '../e2e/harness.ts'

const TEMP_DIRS: string[] = []

afterAll(async () => {
  await Promise.all(TEMP_DIRS.map(dir => rm(dir, { recursive: true, force: true })))
})

async function makeHarness(script: Parameters<typeof Harness.create>[0]['script']): Promise<Harness> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'graycode-spike-ws-'))
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'graycode-spike-data-'))
  TEMP_DIRS.push(workspace, dataRoot)
  return Harness.create({ workspace, dataRoot, script })
}

async function disposeHarness(harness: Harness | undefined): Promise<void> {
  if (!harness) return
  // graycode prompt 插件的懒加载（service.getCurrentMode → injector.refresh）可能在
  // dispose 之后才结算，届时 ctx.agents 已失效会抛 unhandled rejection；
  // 先让一个 macrotask 溜过，使该 promise 在活跃 context 上完成再拆 harness。
  await new Promise(resolve => setTimeout(resolve, 25))
  await harness.dispose()
}

/* ------------------------------------------------------------------ *
 * 探针工具：probe_write（单文件）与 probe_write_multi（多文件）        *
 * ------------------------------------------------------------------ */

const PROBE_TOOL_NAMES = new Set(['probe_write', 'probe_write_multi'])

interface ProbeWriteValue {
  written: string
  before?: string | null
  after: string
}

/** tool/result.meta 中的展示性 diff 载荷（由 presentationMeta 投影）。 */
interface ProbeDiffMeta {
  path: string
  before: string | null
  after: string
  /** JsonValue 兼容的 index signature：使该接口可作为 JsonValue 类型谓词目标。 */
  [key: string]: JsonValue
}

function isProbeDiffMeta(value: JsonValue | undefined): value is ProbeDiffMeta {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.path === 'string' &&
    (typeof record.before === 'string' || record.before === null) &&
    typeof record.after === 'string'
  )
}

function renderJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** 单文件写探针：立即经 ctx.fs 原子落盘，并投影 diff 展示数据到 tool/result.meta。 */
function createProbeWriteTool(fs: FileSystem): ToolDefinition {
  return defineTool({
    name: 'probe_write',
    description: 'Probe tool: write one workspace file immediately through ctx.fs.',
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace-relative file path' },
      content: { type: 'string', required: true, description: 'File content' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          written: { type: 'string', required: true },
          before: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          after: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: renderJson,
      presentationMeta(args, value: ProbeWriteValue): JsonValue {
        return { path: value.written, before: value.before ?? null, after: value.after }
      },
    },
    async execute(args, exec) {
      const target = await fs.resolve(args.path, { signal: exec.signal })
      const outcome = await fs.writeText(target, args.content, undefined, exec.signal)
      return { written: args.path, before: outcome.before, after: outcome.after }
    },
    presentCall(args) {
      return {
        card: 'diff',
        title: `Write ${args.path}`,
        diffs: [{ path: args.path, oldText: null, newText: args.content }],
      }
    },
    presentResult(_args, result) {
      if (!isProbeDiffMeta(result.meta)) return undefined
      return {
        card: 'diff',
        title: `Wrote ${result.meta.path}`,
        diffs: [{ path: result.meta.path, oldText: result.meta.before, newText: result.meta.after }],
      }
    },
  })
}

interface MultiFileArg {
  path: string
  content: string
}

/** 多文件写探针：一次调用写多个文件（检验审批粒度是否为「整次调用」）。 */
function createProbeWriteMultiTool(fs: FileSystem): ToolDefinition {
  return defineTool({
    name: 'probe_write_multi',
    description: 'Probe tool: write several workspace files in one call through ctx.fs.',
    parameters: {
      files: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', required: true },
            content: { type: 'string', required: true },
          },
          additionalProperties: false,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          written: { type: 'array', items: { type: 'string' }, required: true },
        },
        additionalProperties: false,
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const written: string[] = []
      for (const file of args.files) {
        const target = await fs.resolve(file.path, { signal: exec.signal })
        await fs.writeText(target, file.content, undefined, exec.signal)
        written.push(file.path)
      }
      return { written }
    },
  })
}

/* ------------------------------------------------------------------ *
 * stub approval 服务（dsh-user-approval 未安装，按 dsh-tools serviceAsk *
 * 调用契约实现进程内 stub）                                            *
 * ------------------------------------------------------------------ */

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

interface ApprovalRequestPayload {
  agent: unknown
  toolName: string
  callId: unknown
  reason?: string
  signal: AbortSignal
}

interface ApprovalStubService {
  request(payload: ApprovalRequestPayload): Promise<ApprovalOutcome>
}

interface ApprovalStub {
  service: ApprovalStubService
  requests: ApprovalRequestPayload[]
}

function makeApprovalStub(
  outcome: ApprovalOutcome | ((payload: ApprovalRequestPayload) => ApprovalOutcome),
): ApprovalStub {
  const requests: ApprovalRequestPayload[] = []
  const service: ApprovalStubService = {
    async request(payload) {
      requests.push(payload)
      return typeof outcome === 'function' ? outcome(payload) : outcome
    },
  }
  return { service, requests }
}

/* ------------------------------------------------------------------ *
 * 探针装配：注册工具 + 可选 ask 门 + 可选 approval stub                *
 * ------------------------------------------------------------------ */

interface ProbeSetupOptions {
  /** 挂 tools/pre-execute ask 门（仅对探针工具）。 */
  askGate?: boolean
  /** 提供 ctx.approval 服务（不提供时 ask 退化为 deny）。 */
  approval?: ApprovalStub
  /** 挂 tools/post-execute block（仅对探针工具）。 */
  postBlock?: boolean
}

function setupProbe(harness: Harness, tools: readonly ToolDefinition[], options: ProbeSetupOptions = {}): () => void {
  const disposers: Array<() => void> = []
  for (const tool of tools) disposers.push(harness.ctx.tools.register(tool))
  if (options.askGate) {
    disposers.push(
      harness.ctx.on('tools/pre-execute', async (exec, next) => {
        if (PROBE_TOOL_NAMES.has(exec.name)) return { kind: 'ask' }
        return next()
      }),
    )
  }
  if (options.postBlock) {
    disposers.push(
      harness.ctx.on('tools/post-execute', async (exec, _result, next) => {
        if (PROBE_TOOL_NAMES.has(exec.name)) {
          return { kind: 'block', feedback: [{ type: 'text', text: 'blocked by probe' }] }
        }
        return next()
      }),
    )
  }
  if (options.approval) disposers.push(harness.ctx.provide('approval', options.approval.service))
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/* ------------------------------------------------------------------ *
 * 事件与文件断言辅助                                                    *
 * ------------------------------------------------------------------ */

function toolCalls(events: readonly SessionEvent[], name: string): Array<{ callId: string; args: string }> {
  const out: Array<{ callId: string; args: string }> = []
  for (const event of events) {
    if (event.type !== 'tool/call' || event.data.name !== name) continue
    out.push({ callId: String(event.data.callId), args: event.data.arguments })
  }
  return out
}

function resultFor(events: readonly SessionEvent[], callId: string): SessionEvent<'tool/result'> | undefined {
  return events.find(
    (event): event is SessionEvent<'tool/result'> =>
      event.type === 'tool/result' && String(event.data.message.source.callId) === callId,
  )
}

function textOf(result: SessionEvent<'tool/result'> | undefined): string {
  if (!result) return ''
  // tool/result 的 message.content 是 [ToolResultBlock]（dsh-llm），正文在
  // block.content 里；逐层展开后取文本。
  return result.data.message.content
    .flatMap(block => (block.type === 'tool-result' ? block.content : [block]))
    .map(block => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('')
}

async function fileExists(fs: FileSystem, rel: string): Promise<boolean> {
  const target = await fs.resolve(rel)
  return (await fs.stat(target)) !== undefined
}

async function fileText(fs: FileSystem, rel: string): Promise<string> {
  const target = await fs.resolve(rel)
  return fs.readText(target)
}

const WRITE_ONE = (pathName: string, content: string) =>
  JSON.stringify({ path: pathName, content })

/* ================================================================== *
 * 场景 1：单文件接受                                                  *
 * ================================================================== */

describe('P3D 场景1 单文件接受', () => {
  it('1a [GAP] 无 approval 服务时 ask 退化为 deny，文件不落盘（写前拒绝，无写后接受）', async () => {
    let harness: Harness | undefined
    let detach: (() => void) | undefined
    try {
      harness = await makeHarness([
        [{ type: 'tool-call', name: 'probe_write', arguments: WRITE_ONE('a.txt', 'AAA') }],
        [{ type: 'text', text: 'done' }],
      ])
      detach = setupProbe(harness, [createProbeWriteTool(harness.ctx.fs)], { askGate: true })
      const { agent } = await harness.createAgent('p3d-1a')
      await harness.followupAndIdle(agent, 'write a.txt')

      const events = harness.eventsOf(agent)
      const call = toolCalls(events, 'probe_write')[0]
      expect(call).toBeDefined()
      const result = resultFor(events, call!.callId)
      // dsh-tools serviceAsk：ctx.get('approval') 为 undefined → deny
      // （dsh-user-approval 未安装）。拒绝发生在写之前，文件从未落盘。
      expect(textOf(result)).toContain('requires approval (not yet supported)')
      expect(await fileExists(harness.ctx.fs, 'a.txt')).toBe(false)
    } finally {
      detach?.()
      await disposeHarness(harness)
    }
  })

  it('1b allowed-once → 写前放行并落盘；diff 以 tool/result.meta 事后展示（非待审）', async () => {
    let harness: Harness | undefined
    let detach: (() => void) | undefined
    try {
      const stub = makeApprovalStub('allowed-once')
      harness = await makeHarness([
        [{ type: 'tool-call', name: 'probe_write', arguments: WRITE_ONE('a.txt', 'AAA') }],
        [{ type: 'text', text: 'done' }],
      ])
      detach = setupProbe(harness, [createProbeWriteTool(harness.ctx.fs)], { askGate: true, approval: stub })
      const { agent } = await harness.createAgent('p3d-1b')
      await harness.followupAndIdle(agent, 'write a.txt')

      const events = harness.eventsOf(agent)
      const call = toolCalls(events, 'probe_write')[0]
      expect(call).toBeDefined()
      const result = resultFor(events, call!.callId)
      // 成功：文件已写，结果含工具规范值
      expect(await fileText(harness.ctx.fs, 'a.txt')).toBe('AAA')
      expect(textOf(result)).toContain('a.txt')
      // 审批发生在写前：请求载荷携带调用身份，且只发生一次
      expect(stub.requests).toHaveLength(1)
      expect(stub.requests[0]!.toolName).toBe('probe_write')
      // 原生 diff 展示 = 写后投影（presentationMeta → tool/result.meta），可随日志回放；
      // 此时文件已落盘，该 meta 是「已应用变更的展示」，不是待审内容。
      expect(result?.data.meta).toEqual({ path: 'a.txt', before: null, after: 'AAA' })
    } finally {
      detach?.()
      await disposeHarness(harness)
    }
  })

  it('1c rejected → 写前拒绝，文件不落盘（拒绝只能先于写；无「拒绝已写文件」路径）', async () => {
    let harness: Harness | undefined
    let detach: (() => void) | undefined
    try {
      const stub = makeApprovalStub('rejected')
      harness = await makeHarness([
        [{ type: 'tool-call', name: 'probe_write', arguments: WRITE_ONE('a.txt', 'AAA') }],
        [{ type: 'text', text: 'done' }],
      ])
      detach = setupProbe(harness, [createProbeWriteTool(harness.ctx.fs)], { askGate: true, approval: stub })
      const { agent } = await harness.createAgent('p3d-1c')
      await harness.followupAndIdle(agent, 'write a.txt')

      const events = harness.eventsOf(agent)
      const call = toolCalls(events, 'probe_write')[0]
      expect(call).toBeDefined()
      const result = resultFor(events, call!.callId)
      expect(textOf(result)).toContain('rejected')
      expect(stub.requests).toHaveLength(1)
      expect(await fileExists(harness.ctx.fs, 'a.txt')).toBe(false)
    } finally {
      detach?.()
      await disposeHarness(harness)
    }
  })
})

/* ================================================================== *
 * 场景 2：部分文件拒绝                                                *
 * ================================================================== */

describe('P3D 场景2 部分文件拒绝', () => {
  const MULTI_ARGS = JSON.stringify({
    files: [
      { path: 'b1.txt', content: 'B1' },
      { path: 'b2.txt', content: 'B2' },
    ],
  })

  it('2a [GAP] 单调用写两文件：allowed-once 后两文件全部落盘，approval 仅一次（审批粒度=整次调用）', async () => {
    let harness: Harness | undefined
    let detach: (() => void) | undefined
    try {
      const stub = makeApprovalStub('allowed-once')
      harness = await makeHarness([
        [{ type: 'tool-call', name: 'probe_write_multi', arguments: MULTI_ARGS }],
        [{ type: 'text', text: 'done' }],
      ])
      detach = setupProbe(harness, [createProbeWriteMultiTool(harness.ctx.fs)], { askGate: true, approval: stub })
      const { agent } = await harness.createAgent('p3d-2a')
      await harness.followupAndIdle(agent, 'write b1 and b2')

      // 审批单元是整次调用：一次 ask 放行后两个文件全部立即落盘，
      // 没有任何「先接受一个、拒绝另一个」的文件级门。
      expect(stub.requests).toHaveLength(1)
      expect(await fileText(harness.ctx.fs, 'b1.txt')).toBe('B1')
      expect(await fileText(harness.ctx.fs, 'b2.txt')).toBe('B2')
    } finally {
      detach?.()
      await disposeHarness(harness)
    }
  })

  it('2b [GAP] post-execute block 只把结果转错误，已写文件不回滚（无部分拒绝/回滚机制）', async () => {
    let harness: Harness | undefined
    let detach: (() => void) | undefined
    try {
      const stub = makeApprovalStub('allowed-once')
      harness = await makeHarness([
        [{ type: 'tool-call', name: 'probe_write_multi', arguments: MULTI_ARGS }],
        [{ type: 'text', text: 'done' }],
      ])
      detach = setupProbe(harness, [createProbeWriteMultiTool(harness.ctx.fs)], {
        askGate: true,
        approval: stub,
        postBlock: true,
      })
      const { agent } = await harness.createAgent('p3d-2b')
      await harness.followupAndIdle(agent, 'write b1 and b2')

      const events = harness.eventsOf(agent)
      const call = toolCalls(events, 'probe_write_multi')[0]
      expect(call).toBeDefined()
      const result = resultFor(events, call!.callId)
      // block 在工具体执行之后：模型看到错误，但两个文件已经落盘且不回滚。
      expect(textOf(result)).toContain('blocked by probe')
      expect(await fileText(harness.ctx.fs, 'b1.txt')).toBe('B1')
      expect(await fileText(harness.ctx.fs, 'b2.txt')).toBe('B2')
    } finally {
      detach?.()
      await disposeHarness(harness)
    }
  })
})

/* ================================================================== *
 * 场景 3：跨工具累计修改                                              *
 * ================================================================== */

describe('P3D 场景3 跨工具累计', () => {
  it('3a [GAP] 两次调用各自即时落盘、独立审批；无跨调用合并待审集合', async () => {
    let harness: Harness | undefined
    let detach: (() => void) | undefined
    try {
      const stub = makeApprovalStub('allowed-once')
      harness = await makeHarness([
        [{ type: 'tool-call', name: 'probe_write', arguments: WRITE_ONE('c1.txt', 'C1') }],
        [{ type: 'text', text: 'one' }],
        [{ type: 'tool-call', name: 'probe_write', arguments: WRITE_ONE('c2.txt', 'C2') }],
        [{ type: 'text', text: 'two' }],
      ])
      detach = setupProbe(harness, [createProbeWriteTool(harness.ctx.fs)], { askGate: true, approval: stub })
      const { agent } = await harness.createAgent('p3d-3a')

      await harness.followupAndIdle(agent, 'write c1')
      // 第一次调用结束即落盘：不存在「跨工具累计的 pending 写」。
      expect(await fileText(harness.ctx.fs, 'c1.txt')).toBe('C1')
      expect(await fileExists(harness.ctx.fs, 'c2.txt')).toBe(false)
      expect(stub.requests).toHaveLength(1)

      await harness.followupAndIdle(agent, 'write c2')
      expect(await fileText(harness.ctx.fs, 'c2.txt')).toBe('C2')
      // 第二次调用走第二次独立审批：无「两笔合并一次审」。
      expect(stub.requests).toHaveLength(2)
      expect(stub.requests.map(request => request.toolName)).toEqual(['probe_write', 'probe_write'])

      // 累计的只有会话日志：两组成对的 call/result，各带写后投影的 diff meta。
      const events = harness.eventsOf(agent)
      expect(toolCalls(events, 'probe_write')).toHaveLength(2)
      const metas = events.filter(event => event.type === 'tool/result').map(event => event.data.meta)
      expect(metas).toHaveLength(2)
      expect(metas[0]).toEqual({ path: 'c1.txt', before: null, after: 'C1' })
      expect(metas[1]).toEqual({ path: 'c2.txt', before: null, after: 'C2' })
    } finally {
      detach?.()
      await disposeHarness(harness)
    }
  })
})

/* ================================================================== *
 * 场景 4：会话重启后继续审阅                                          *
 * ================================================================== */

describe('P3D 场景4 会话重启后继续审阅', () => {
  it('4a [GAP] 重启后无法 resume（无 sessionPersistence backend）；文件已即时提交；无待审状态', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'graycode-spike-ws-'))
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'graycode-spike-data-'))
    TEMP_DIRS.push(workspace, dataRoot)

    // 阶段 A：写 c3.txt（allowed-once 审批），随后整体 dispose（模拟会话结束）。
    let harness: Harness | undefined
    let detach: (() => void) | undefined
    try {
      const stub = makeApprovalStub('allowed-once')
      harness = await Harness.create({
        workspace,
        dataRoot,
        script: [
          [{ type: 'tool-call', name: 'probe_write', arguments: WRITE_ONE('c3.txt', 'C3') }],
          [{ type: 'text', text: 'ok' }],
        ],
      })
      detach = setupProbe(harness, [createProbeWriteTool(harness.ctx.fs)], { askGate: true, approval: stub })
      const { agent } = await harness.createAgent('p3d-4a')
      await harness.followupAndIdle(agent, 'write c3')
      expect(await fileText(harness.ctx.fs, 'c3.txt')).toBe('C3')
      expect(stub.requests).toHaveLength(1)
    } finally {
      detach?.()
      await disposeHarness(harness)
    }

    // 阶段 B：同一 workspace/dataRoot 重建 Context。
    let replay: Harness | undefined
    try {
      replay = await Harness.create({ workspace, dataRoot, script: [] })
      // 审批服务是进程内装配（dsh-user-approval 未安装；stub 随阶段 A 消失）：
      // 重启后不存在任何审批/待审服务。
      expect(replay.ctx.get('approval')).toBeUndefined()
      // resume 需要 sessionPersistence backend；本环境只有抽象 Service Definition，
      // AgentLoop.resume 明确抛错。
      await expect(
        replay.ctx.agents.resume({
          resumeSessionId: SessionId('p3d-4a'),
          agentOptions: { provider: 'echo', model: 'echo-model' },
        }),
      ).rejects.toThrow(/session persistence is not configured/)
      // 文件保持「调用时即提交」状态：没有 pending 区，也没有待审列表可恢复。
      expect(await fileText(replay.ctx.fs, 'c3.txt')).toBe('C3')
    } finally {
      await disposeHarness(replay)
    }
  })

  it('4b [GAP] 重启后只能回放已写历史（diff meta 一致）；待审列表不存在', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'graycode-spike-ws-'))
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'graycode-spike-data-'))
    TEMP_DIRS.push(workspace, dataRoot)

    let harness: Harness | undefined
    let detach: (() => void) | undefined
    let originalEvents: readonly SessionEvent[] = []
    try {
      const stub = makeApprovalStub('allowed-once')
      harness = await Harness.create({
        workspace,
        dataRoot,
        script: [
          [{ type: 'tool-call', name: 'probe_write', arguments: WRITE_ONE('c4.txt', 'C4') }],
          [{ type: 'text', text: 'ok' }],
        ],
      })
      detach = setupProbe(harness, [createProbeWriteTool(harness.ctx.fs)], { askGate: true, approval: stub })
      const { agent } = await harness.createAgent('p3d-4b')
      await harness.followupAndIdle(agent, 'write c4')
      originalEvents = harness.eventsOf(agent)
      expect(await fileText(harness.ctx.fs, 'c4.txt')).toBe('C4')
    } finally {
      detach?.()
      await disposeHarness(harness)
    }

    let replay: Harness | undefined
    try {
      replay = await Harness.create({ workspace, dataRoot, script: [] })
      // 与 loop.test.ts S4 相同的 seed 重放：会话历史（含 diff meta）可恢复，
      // 但恢复的是「已接受且已写」的日志，不是待审状态。
      const handle = await replay.ctx.agents.create({
        sessionId: SessionId('p3d-4b-replay'),
        seed: originalEvents,
        meta: { cwd: workspace },
        agentOptions: { provider: 'echo', model: 'echo-model' },
      })
      try {
        const replayedEvents = handle.agent.session.events
        const originalCall = toolCalls(originalEvents, 'probe_write')[0]
        const replayedCall = toolCalls(replayedEvents, 'probe_write')[0]
        expect(originalCall).toBeDefined()
        expect(replayedCall).toBeDefined()
        expect(replayedCall!.callId).toBe(originalCall!.callId)
        expect(resultFor(replayedEvents, replayedCall!.callId)?.data.meta).toEqual(
          resultFor(originalEvents, originalCall!.callId)?.data.meta,
        )
      } finally {
        await handle.dispose()
      }
    } finally {
      await disposeHarness(replay)
    }
  })
})
