/**
 * Mock-LLM E2E（thoughts 域 B1）：真实 DSH 服务 + 真实 agent-loop + 预置模式。
 *
 * 验证「预设条目只在本回合第一个 step 注入」：
 * - 首步（用户主动发消息）请求 messages 含注入的 user/assistant 预置条目，
 *   位置正确（before-history 锚点：消息列表头部）；
 * - 工具迭代 step（工具调用 → 结果回传后的第二次模型请求）不再注入（B1）。
 *
 * 组合说明：与 tests/e2e/harness.ts 的差异只有一点——LlmRuntime 直接构造在根
 * Context 上（`new LlmRuntime(ctx)`，服务注册在根 fiber），使 graycode 子插件
 * fiber 链（graycode → thoughts）能通过 `ctx.llm` 属性访问并重入 llm/stream
 * waterfall。harness.ts 用 `ctx.plugin(LlmRuntime)` 挂载时 llm 落在兄弟 fiber 上，
 * thoughts adapter 的 `ctx.llm.stream()` 会抛 "cannot get property \"llm\" without
 * inject"（cordis 服务解析只沿 fiber 父链向上找）。其余组合与 harness 完全一致。
 * 因此本文件自带组合函数（compose），不改动 harness.ts。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import {
  CallId,
  LlmRuntime,
  createUserMessage,
  type GenerateOptions,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as graycode from '../../src/index.ts'
import { ScriptedAdapter } from './harness.ts'

const TEMP_DIRS: string[] = []

afterAll(async () => {
  await Promise.all(TEMP_DIRS.map(dir => rm(dir, { recursive: true, force: true })))
})

/**
 * 预置模式：user 条目 + assistant 条目（fakeThought）+ chat_history 标记。
 * 条目 order 均小于 chat_history order → before-history 注入（消息列表头部）。
 */
const MODES_JSON = {
  version: 1,
  currentModeId: 'thoughts-e2e',
  modes: [
    {
      id: 'thoughts-e2e',
      name: 'Thoughts E2E',
      kind: 'custom',
      template: 'You are a test agent.',
      promptEntries: [
        { id: 'e1', role: 'user', order: 1, enabled: true, content: 'preset-user-entry' },
        { id: 'e2', role: 'assistant', order: 2, enabled: true, content: 'preset-assistant-entry', fakeThought: 'preset-thought' },
        { id: 'e3', role: 'chat_history', order: 3, enabled: true, content: 'history' },
      ],
    },
  ],
}

/** 与 harness.ts 相同的服务组合，但 LlmRuntime 构造在根 Context（见文件头注释）。 */
async function compose(): Promise<{
  ctx: Context
  llm: LlmRuntime
  workspace: string
  dataRoot: string
  dispose(): Promise<void>
}> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'graycode-thoughts-ws-'))
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'graycode-thoughts-data-'))
  TEMP_DIRS.push(workspace, dataRoot)
  // 预写模式存储：harness 启动前 seed 一个带 user/assistant 预置条目的模式
  await mkdir(path.join(dataRoot, 'prompt'), { recursive: true })
  await writeFile(path.join(dataRoot, 'prompt', 'modes.json'), JSON.stringify(MODES_JSON, null, 2), 'utf8')

  const ctx = new Context()
  const mounted: Array<{ dispose(): Promise<void> }> = []
  mounted.push(await ctx.plugin(LocalFileSystem, { cwd: workspace }))
  mounted.push(await ctx.plugin(SessionStore))
  mounted.push(await ctx.plugin(AgentRegistry))
  mounted.push(await ctx.plugin(SystemPrompt))
  mounted.push(await ctx.plugin(ToolRuntime))
  const llm = new LlmRuntime(ctx)
  mounted.push(await ctx.plugin(AgentLoop, { agents: [] }))
  mounted.push(
    await ctx.plugin(graycode, {
      dataRoot,
      workflows: { dataRoot, agentScope: 'roots' },
      memory: { dataRoot, agentScope: 'roots' },
      checkpoints: { dataRoot, agentScope: 'roots' },
      branches: { dataRoot, agentScope: 'roots' },
      persona: { enabled: true, agentScope: 'roots' },
    } as graycode.Config),
  )
  return {
    ctx,
    llm,
    workspace,
    dataRoot,
    dispose: async () => {
      for (const fiber of mounted.reverse()) await fiber.dispose()
    },
  }
}

/** 全部文本（含 reasoning 块）拼成一条字符串，便于断言注入内容。 */
function allText(messages: readonly Message[]): string {
  const parts: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text' || block.type === 'reasoning') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function presetEntryCount(messages: readonly Message[]): number {
  return messages.filter(m => m.source.kind === 'plugin' && m.source.plugin === 'graycode-thoughts').length
}

describe('thoughts B1 mock-LLM loop E2E', () => {
  it('S6 首步注入预置条目（位置正确）；工具迭代 step 不再注入', async () => {
    const { ctx, llm, workspace, dispose } = await compose()
    try {
      const seen: GenerateOptions[] = []
      let call = 0
      const adapter = new ScriptedAdapter((options: GenerateOptions): AsyncIterable<StreamChunk> => {
        seen.push(options)
        call += 1
        return {
          async *[Symbol.asyncIterator]() {
            if (call === 1) {
              // 首步：工具调用（memory_note 会写工作区记忆，触发迭代 step 2）
              yield { type: 'block-start', index: 0, blockType: 'tool-call' }
              yield {
                type: 'tool-call-delta',
                index: 0,
                id: CallId('thoughts-call-1'),
                name: 'memory_note',
                argumentsDelta: JSON.stringify({ text: 'b1-marker' }),
              }
              yield {
                type: 'block-end',
                index: 0,
                block: { type: 'tool-call', id: CallId('thoughts-call-1'), name: 'memory_note', arguments: JSON.stringify({ text: 'b1-marker' }) },
              }
              yield { type: 'finish', reason: { kind: 'tool-calls' } }
            } else {
              yield { type: 'finish', reason: { kind: 'stop' } }
            }
          },
        }
      })
      llm.registerAdapter(['echo'], adapter)
      // 等模式存储加载完成，消除首请求竞态（load 完成后 currentModeSnapshot 才可用）
      const service = ctx.get('graycode.promptModes', false) as { getCurrentMode(): Promise<unknown> } | undefined
      await service?.getCurrentMode()

      const handle = await ctx.agents.create({
        sessionId: SessionId('s6-session'),
        meta: { cwd: workspace },
        agentOptions: { provider: 'echo', model: 'echo-model' },
      })
      handle.agent.followup(
        createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
      )
      await handle.agent.whenIdle()
      await handle.dispose()

      // 恰好两次模型请求：首步 + 工具迭代 step
      expect(seen).toHaveLength(2)

      // ── 首步：注入发生 ──
      const first = seen[0]!
      const firstText = allText(first.messages)
      // user 预置条目注入为真实消息（before-history：消息列表头部）
      expect(first.messages[0]!.content).toEqual([{ type: 'text', text: 'preset-user-entry' }])
      expect(presetEntryCount(first.messages)).toBe(1)
      // assistant 预置条目：reasoning 块（fakeThought，sendHistoryThoughts 默认开）+ 文本
      const assistant = first.messages.find(m => m.role === 'assistant')
      expect(assistant).toBeDefined()
      const thought = assistant!.content.find(b => b.type === 'reasoning')
      expect(thought).toBeDefined()
      expect((thought as { text: string }).text).toBe('preset-thought')
      expect(firstText).toContain('preset-assistant-entry')
      // 注入不吞真实输入；用户输入位于预置条目之后（before-history 语义）
      expect(firstText).toContain('hello')
      const inputIndex = first.messages.findIndex(m => m.source.kind === 'user')
      expect(inputIndex).toBeGreaterThan(0)

      // ── 工具迭代 step：不再注入（B1）──
      const second = seen[1]!
      expect(presetEntryCount(second.messages)).toBe(0)
      expect(allText(second.messages)).not.toContain('preset-user-entry')
      expect(allText(second.messages)).not.toContain('preset-assistant-entry')
      expect(allText(second.messages)).not.toContain('preset-thought')
      // 第二 step 确实携带工具结果回传（证明是迭代 step，而非请求漏发）
      expect(second.messages.some(m => m.source.kind === 'tool')).toBe(true)
    } finally {
      await dispose()
    }
  })

  it('S7 新回合首步再次注入（每回合一次，而非每 agent 一次）', async () => {
    const { ctx, llm, workspace, dispose } = await compose()
    try {
      const seen: GenerateOptions[] = []
      const adapter = new ScriptedAdapter((options: GenerateOptions): AsyncIterable<StreamChunk> => {
        seen.push(options)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      })
      llm.registerAdapter(['echo'], adapter)
      const service = ctx.get('graycode.promptModes', false) as { getCurrentMode(): Promise<unknown> } | undefined
      await service?.getCurrentMode()

      const handle = await ctx.agents.create({
        sessionId: SessionId('s7-session'),
        meta: { cwd: workspace },
        agentOptions: { provider: 'echo', model: 'echo-model' },
      })
      try {
        const followup = (text: string) => {
          handle.agent.followup(
            createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
          )
          return handle.agent.whenIdle()
        }
        await followup('turn one')
        await followup('turn two')
        expect(seen).toHaveLength(2)
        for (const request of seen) {
          // 每个用户回合的首步都注入一次（历史里没有预置条目——重写只发生在请求层）
          expect(presetEntryCount(request.messages)).toBe(1)
          expect(allText(request.messages)).toContain('preset-user-entry')
        }
        // 第二轮请求确实携带了两条用户输入（证明是第二个回合，而非同回合多 step）
        expect(seen[1]!.messages.filter(m => m.source.kind === 'user')).toHaveLength(2)
      } finally {
        await handle.dispose()
      }
    } finally {
      await dispose()
    }
  })
})
