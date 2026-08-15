/**
 * Mock-LLM E2E：真实 DSH 服务组合 + ScriptedAdapter + @graycode/dsh-plugin。
 *
 * S1 消息→文本回复（同时断言 request/header.system 含 Gray persona —— 证明
 * Task A 的 persona 进入真实 loop 的 prompt 组装）
 * S2 工具调用→结果回传：memory_note 经 scoped 注册在真实 agent 上执行，并
 *    落盘到 <dataRoot>/memory-workspaces/*
 * S3 文件变更：create_design 写入 <workspace>/.graycode/design/*.md
 * S4 会话恢复/回放：重建 Context，以事件 seed 重放，deriveMessages 一致、
 *    工具调用卡片数据（tool/call + tool/result 对）逐条一致
 * S5 取消：脚本中途 pause，cancel({kind:"user"}) 后 turn/end reason=aborted
 */
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { Harness, listFilesRecursive, type HarnessOptions } from './harness.ts'

const TEMP_DIRS: string[] = []

async function makeHarness(script: HarnessOptions['script']): Promise<Harness> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'graycode-e2e-ws-'))
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'graycode-e2e-data-'))
  TEMP_DIRS.push(workspace, dataRoot)
  return Harness.create({ workspace, dataRoot, script })
}

async function disposeHarness(harness: Harness | undefined): Promise<void> {
  if (harness) await harness.dispose()
}

afterAll(async () => {
  await Promise.all(TEMP_DIRS.map(dir => rm(dir, { recursive: true, force: true })))
})

function assistantText(events: readonly SessionEvent[], expected?: string): string | undefined {
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (expected === undefined || text === expected) return text
  }
  return undefined
}

function toolCallArgs(events: readonly SessionEvent[], name: string): Array<{ callId: string; args: string }> {
  const out: Array<{ callId: string; args: string }> = []
  for (const event of events) {
    if (event.type !== 'tool/call' || event.data.name !== name) continue
    out.push({ callId: String(event.data.callId), args: event.data.arguments })
  }
  return out
}

function toolResultFor(events: readonly SessionEvent[], callId: string): SessionEvent<'tool/result'> | undefined {
  return events.find((event): event is SessionEvent<'tool/result'> =>
    event.type === 'tool/result' && String(event.data.message.source.callId) === callId,
  )
}

function headerSystem(events: readonly SessionEvent[]): string | undefined {
  return events.find(event => event.type === 'request/header')?.data.header.system
}

function headerTools(events: readonly SessionEvent[]): string[] {
  const header = events.find(event => event.type === 'request/header')
  return (header?.data.header.tools ?? []).map(tool => tool.name)
}

/**
 * 确定性等待：轮询会话事件直到谓词满足（F-12：替代固定 setTimeout 时间依赖）。
 * 超时抛错给出可诊断信息，避免测试静默挂起。
 */
async function waitForEvent(
  events: () => readonly SessionEvent[],
  predicate: (event: SessionEvent) => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (events().some(predicate)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

/** S5 驱动进入 running 的等待窗口：慢 CI 上首块文本可能晚于 5s 到达（3.19-M3），放宽到 30s。 */
const S5_DRIVE_TIMEOUT_MS = 30_000
/** S5 cancel 后回到 idle 的超时兜底：名义上应瞬时完成，15s 覆盖慢 CI 余量（3.19-M3）。 */
const S5_IDLE_TIMEOUT_MS = 15_000

/**
 * `agent.whenIdle()` 的超时兜底（3.19-M3）：取消未被 honor 或 loop 异常时，
 * 把无限挂起转为带诊断信息的失败，而非让测试超时挂死。
 */
async function whenIdleWithin(agent: Agent, label: string, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe('mock-LLM loop E2E', () => {
  it('S1 发消息→文本回复；真实请求头内已组装 Gray persona', async () => {
    let harness: Harness | undefined
    try {
      harness = await makeHarness([[{ type: 'text', text: 'Hello from echo' }]])
      const { agent } = await harness.createAgent('s1-session')
      await harness.followupAndIdle(agent, 'ping')

      const events = harness.eventsOf(agent)
      expect(assistantText(events, 'Hello from echo')).toBe('Hello from echo')

      // persona section 进入真实 loop 的 prompt 组装（Task A E2E 证据）
      expect(headerSystem(events)).toContain('GrayCode-enhanced')
      // memory 工具随 agentScope=roots 注册到 agent 作用域，进入请求头工具 schema
      expect(headerTools(events)).toContain('memory_note')
      expect(headerTools(events)).toContain('create_design')
    } finally {
      await disposeHarness(harness)
    }
  })

  it('S2 工具调用→结果回传：memory_note 执行并落盘到 dataRoot', async () => {
    let harness: Harness | undefined
    try {
      harness = await makeHarness([
        [{ type: 'tool-call', name: 'memory_note', arguments: JSON.stringify({ text: 'e2e-memory-marker' }) }],
        [{ type: 'text', text: 'Noted.' }],
      ])
      const { agent } = await harness.createAgent('s2-session')
      await harness.followupAndIdle(agent, 'remember this')

      const events = harness.eventsOf(agent)
      const calls = toolCallArgs(events, 'memory_note')
      expect(calls).toHaveLength(1)
      expect(calls[0]!.args).toContain('e2e-memory-marker')
      expect(toolResultFor(events, calls[0]!.callId)).toBeDefined()
      expect(assistantText(events, 'Noted.')).toBe('Noted.')

      // 工作区记忆写入 <dataRoot>/memory-workspaces/<hash16>/records.jsonl
      // （新 JSONL 格式，旧 LOG.txt 仅为只读导入源，不再由写入路径产生）；
      // 全局 memory/records.jsonl（auto-inject 预初始化）不在此轮写入，搜索全部 records.jsonl。
      const files = await listFilesRecursive(harness.dataRoot)
      const logFiles = files.filter(file => file.endsWith('/records.jsonl'))
      expect(logFiles.length).toBeGreaterThan(0)
      const contents = await Promise.all(logFiles.map(file => readFile(file, 'utf-8')))
      expect(contents.some(content => content.includes('e2e-memory-marker'))).toBe(true)
    } finally {
      await disposeHarness(harness)
    }
  })

  it('S3 文件变更：create_design 写入工作区 .graycode/design/*.md', async () => {
    let harness: Harness | undefined
    try {
      harness = await makeHarness([
        [
          {
            type: 'tool-call',
            name: 'create_design',
            arguments: JSON.stringify({ title: 'E2E Design', design: 'E2E design content' }),
          },
        ],
        [{ type: 'text', text: 'Created.' }],
      ])
      const { agent } = await harness.createAgent('s3-session')
      await harness.followupAndIdle(agent, 'write a design doc')

      const events = harness.eventsOf(agent)
      const calls = toolCallArgs(events, 'create_design')
      expect(calls).toHaveLength(1)
      expect(toolResultFor(events, calls[0]!.callId)).toBeDefined()

      const designDir = path.join(harness.workspace, '.graycode', 'design')
      const files = await listFilesRecursive(designDir)
      expect(files.length).toBeGreaterThan(0)
      expect(await readFile(files[0]!, 'utf-8')).toContain('E2E design content')
      expect((await stat(files[0]!)).isFile()).toBe(true)
    } finally {
      await disposeHarness(harness)
    }
  })

  it('S4 会话恢复/回放：重建 Context 后以事件 seed 重放，历史与工具卡片数据一致', async () => {
    let harness: Harness | undefined
    let originalEvents: readonly SessionEvent[] = []
    let originalMessages: unknown[] = []
    try {
      harness = await makeHarness([
        [{ type: 'tool-call', name: 'memory_note', arguments: JSON.stringify({ text: 'e2e-replay-marker' }) }],
        [{ type: 'text', text: 'Replayed.' }],
      ])
      const { agent } = await harness.createAgent('s4-session')
      await harness.followupAndIdle(agent, 'remember for replay')
      originalEvents = harness.eventsOf(agent)
      originalMessages = agent.session.deriveMessages()
      expect(toolCallArgs(originalEvents, 'memory_note')).toHaveLength(1)
      expect(assistantText(originalEvents, 'Replayed.')).toBe('Replayed.')
    } finally {
      await disposeHarness(harness)
    }

    // 重建 Context（同一 workspace/dataRoot，记忆仍在磁盘上），
    // 以原会话完整事件为 seed 重放。
    // 显式守卫（3.19-M4）：前序阶段失败时给出可诊断错误，而非 `harness!` 的晦涩 TypeError。
    if (!harness) {
      throw new Error('S4 前置失败：首个 harness 未创建成功（上一 try 内应已抛出原始异常）')
    }
    let replay: Harness | undefined
    try {
      const { workspace, dataRoot } = harness
      replay = await Harness.create({ workspace, dataRoot, script: [] })
      const options: CreateAgentOptions = {
        sessionId: SessionId('s4-replay'),
        seed: originalEvents,
        meta: { cwd: workspace },
        agentOptions: { provider: 'echo', model: 'echo-model' },
      }
      const handle = await replay.ctx.agents.create(options)
      const replayed = handle.agent
      try {
        // 事件序列一致（seed 重放会在尾部追加 session/end-seed 标记，前缀逐条相等）
        const replayedEvents = replayed.session.events
        expect(replayedEvents.slice(0, originalEvents.length).map(event => event.type)).toEqual(
          originalEvents.map(event => event.type),
        )
        // 派生消息历史一致（含 tool-call 块与 tool-result 消息）
        expect(replayed.session.deriveMessages()).toEqual(originalMessages)
        // 工具调用卡片数据逐条一致（callId/参数/结果内容）
        const originalCalls = toolCallArgs(originalEvents, 'memory_note')
        const replayedCalls = toolCallArgs(replayedEvents, 'memory_note')
        expect(replayedCalls).toEqual(originalCalls)
        const originalResult = toolResultFor(originalEvents, originalCalls[0]!.callId)
        const replayedResult = toolResultFor(replayedEvents, originalCalls[0]!.callId)
        expect(replayedResult?.data.message.content).toEqual(originalResult?.data.message.content)
        // scoped 工具在重放 agent 上同样可解析（registrar 在 agent/created 回填）
        expect(replay.toolOf(replayed, 'memory_note')).toBeDefined()
        // 会话仍可继续：followup 再走一轮（seed 之上续写）
        replayed.followup(
          createUserMessage({
            content: [{ type: 'text', text: 'continue' }],
            source: { kind: 'user' },
          }),
        )
        await replayed.whenIdle()
        expect(replayed.session.events.length).toBeGreaterThan(originalEvents.length)
      } finally {
        await handle.dispose()
      }
    } finally {
      await disposeHarness(replay)
    }
  })

  it('S5 取消：脚本中途 pause，cancel({kind:"user"}) 后 turn/end reason=aborted', async () => {
    let harness: Harness | undefined
    try {
      // pause 5s（原 30s）：轮询到首段文本即取消；若 cancel 未被 honor，5s 内失败而非挂 30s
      harness = await makeHarness([[{ type: 'text', text: 'part one' }, { type: 'pause', ms: 5_000 }]])
      const { agent } = await harness.createAgent('s5-session')
      // 不 await whenIdle（脚本 pause，会一直挂着）；发消息后确定性等待驱动进入
      // running（assistant/chunk 在 pause 步骤之前被 yield，证明驱动已开始流式输出）。
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: 'go' }],
          source: { kind: 'user' },
        }),
      )
      // M3：慢 CI 上首块文本可能晚于 5s 到达（waitForEvent 默认硬超时），显式放宽到 30s。
      await waitForEvent(
        () => harness!.eventsOf(agent),
        event =>
          event.type === 'assistant/chunk' &&
          event.data.chunk.type === 'text-delta' &&
          event.data.chunk.text === 'part one',
        "assistant/chunk 'part one'（驱动进入 running）",
        S5_DRIVE_TIMEOUT_MS,
      )
      agent.cancel({ kind: 'user' })
      // M3：whenIdle 无超时兜底，取消未被 honor / loop 异常时可能永久挂起。
      await whenIdleWithin(agent, 'S5 cancel 后 agent 回到 idle', S5_IDLE_TIMEOUT_MS)

      const events = harness.eventsOf(agent)
      const turnEnd = [...events].reverse().find(event => event.type === 'turn/end')
      expect(turnEnd).toBeDefined()
      expect(turnEnd!.data.reason.kind).toBe('aborted')
    } finally {
      await disposeHarness(harness)
    }
  })
})
