/**
 * 工具层冒烟测试：轻量 ctx 组合（LocalFileSystem → SessionStore → AgentRegistry →
 * SystemPrompt → ToolRuntime → LlmRuntime → AgentLoop），真实挂载 staged-diff
 * 子插件（apply → createScopedToolRegistrar 注册），创建 agent 后经
 * ctx.tools.get(name, agent) 解析 scoped 工具并调用 stage/list/preview/accept/
 * reject 一次闭环；accept 走真实 ctx.fs（LocalFileSystem）落盘。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { ScriptedAdapter } from '../e2e/harness.ts'
import * as stagedDiff from '../../src/stagedDiff/adapters/dsh/index.ts'
import type { StagedEntry } from '../../src/stagedDiff/domain/types.ts'

interface ToolOutput extends Record<string, unknown> {
  success: boolean
  code?: string
  entry?: StagedEntry
}

let workspace: string
let dataRoot: string
let ctx: Context
let agent: Agent
let tools: Map<string, ToolDefinition>
const mounted: Array<{ dispose(): Promise<void> }> = []

function exec(): ToolRunContext {
  return {
    agent: agent as unknown as NonNullable<ToolRunContext['agent']>,
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
}

async function run(name: string, args: Record<string, unknown>): Promise<ToolOutput> {
  const tool = tools.get(name)!
  return (await tool.execute(args, exec())) as ToolOutput
}

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-staged-tools-ws-'))
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-staged-tools-data-'))
  ctx = new Context()
  mounted.push(await ctx.plugin(LocalFileSystem, { cwd: workspace }))
  mounted.push(await ctx.plugin(SessionStore))
  mounted.push(await ctx.plugin(AgentRegistry))
  mounted.push(await ctx.plugin(SystemPrompt))
  mounted.push(await ctx.plugin(ToolRuntime))
  mounted.push(await ctx.plugin(LlmRuntime))
  mounted.push(await ctx.plugin(AgentLoop, { agents: [] }))
  ctx.llm.registerAdapter(['echo'], new ScriptedAdapter([]))
  // 真实挂载 staged-diff 子插件（enabled: true → 工具注册；agentScope: all）
  mounted.push(await ctx.plugin(stagedDiff, { dataRoot, enabled: true, agentScope: 'all' }))
  const handle = await ctx.agents.create({
    sessionId: SessionId('staged-session'),
    meta: { cwd: workspace },
    agentOptions: { provider: 'echo', model: 'echo-model' },
  })
  agent = handle.agent
  tools = new Map(
    ['staged_diff_stage', 'staged_diff_list', 'staged_diff_preview', 'staged_diff_accept', 'staged_diff_reject'].map(
      name => [name, ctx.tools.get(name, agent)!]
    )
  )
})

afterAll(async () => {
  for (const fiber of mounted.reverse()) {
    await fiber.dispose()
  }
  await fs.rm(workspace, { recursive: true, force: true })
  await fs.rm(dataRoot, { recursive: true, force: true })
})

describe('staged_diff 工具闭环（真实 ctx.fs 落盘）', () => {
  it('stage → list → preview → accept：接受后才真实落盘', async () => {
    const staged = await run('staged_diff_stage', { path: 'notes.md', content: 'hello staged' })
    expect(staged.success).toBe(true)
    expect(staged.entry!.status).toBe('pending')
    expect(staged.entry!.path).toBe('notes.md')
    expect(staged.entry!.before).toBeNull()
    expect(staged.entry!.revision).toBe(1)

    // stage 只记录意图，不写盘
    await expect(fs.readFile(path.join(workspace, 'notes.md'))).rejects.toThrow()

    const listed = await run('staged_diff_list', {})
    expect(listed.success).toBe(true)
    const batch = listed.batch as { entries: StagedEntry[]; pendingCount: number; totalCount: number }
    expect(batch.totalCount).toBe(1)
    expect(batch.pendingCount).toBe(1)
    expect(batch.entries[0]!.id).toBe(staged.entry!.id)

    const preview = await run('staged_diff_preview', { entryId: staged.entry!.id })
    expect(preview.success).toBe(true)
    expect(preview.entry!.after).toBe('hello staged')
    expect(preview.entry!.path).toBe('notes.md')

    const accepted = await run('staged_diff_accept', { entryId: staged.entry!.id, expectedRevision: 1 })
    expect(accepted.success).toBe(true)
    expect(accepted.entry!.status).toBe('done')

    // 接受后才真实落盘
    expect(await fs.readFile(path.join(workspace, 'notes.md'), 'utf8')).toBe('hello staged')
    expect(await fs.readFile(path.join(dataRoot, 'staged-diff', 'entries.json'), 'utf8')).toContain('"done"')
  })

  it('stage → reject：拒绝不落盘', async () => {
    const staged = await run('staged_diff_stage', { path: 'rejected.md', content: 'never lands' })
    const rejected = await run('staged_diff_reject', { entryId: staged.entry!.id, expectedRevision: 1 })
    expect(rejected.success).toBe(true)
    expect(rejected.entry!.status).toBe('rejected')
    await expect(fs.stat(path.join(workspace, 'rejected.md'))).rejects.toThrow()
  })

  it('CAS：同条目第二次 accept 用陈旧 revision → GRAY_STAGED_REVISION_CONFLICT', async () => {
    const staged = await run('staged_diff_stage', { path: 'cas.md', content: 'v1' })
    const first = await run('staged_diff_accept', { entryId: staged.entry!.id, expectedRevision: 1 })
    expect(first.success).toBe(true)

    // 第二次用同一 expectedRevision（已过期）→ 冲突
    const second = await run('staged_diff_accept', { entryId: staged.entry!.id, expectedRevision: 1 })
    expect(second.success).toBe(false)
    expect(second.code).toBe('GRAY_STAGED_REVISION_CONFLICT')
    expect(second.entry!.status).toBe('done')
  })

  it('stage 幂等：同一 toolCallId+path 返回既有条目', async () => {
    const first = await run('staged_diff_stage', { path: 'idem.md', content: 'x', toolCallId: 'call-idem' })
    const second = await run('staged_diff_stage', { path: 'idem.md', content: 'x', toolCallId: 'call-idem' })
    expect(first.entry!.id).toBe(second.entry!.id)
    expect(second.entry!.status).toBe('pending')
  })

  it('headless stage（无 agent 会话）以 \'unknown\' 会话归组（3.17-M7）', async () => {
    // 与 stagedWriteHook 的 'unknown' 兜底一致：无 agent 会话的 exec 不得产生空串
    // sessionId（空串会被 createEntry 以 GRAY_INVALID_INPUT 拒绝），工具照常成功
    const stage = tools.get('staged_diff_stage')!
    const headlessExec = { signal: new AbortController().signal } as unknown as ToolRunContext
    const staged = (await stage.execute({ path: 'headless.md', content: 'x' }, headlessExec)) as ToolOutput
    expect(staged.success).toBe(true)
    expect(staged.entry!.sessionId).toBe('unknown')
  })

  it('路径穿越 → GRAY_STAGED_INVALID_PATH（工具层拒绝）', async () => {
    const result = await run('staged_diff_stage', { path: '../evil.md', content: 'x' })
    expect(result.success).toBe(false)
    expect(result.code).toBe('GRAY_STAGED_INVALID_PATH')
  })

  it('符号链接逃逸：accept 拒绝（GRAY_STAGED_PATH_ESCAPE），外部目录不被写入', async t => {
    // 探测在测试体内执行：runIf/skipIf 在定义时求值，beforeAll 探针无法生效；
    // Windows 未开开发者模式/无管理员权限时 symlink 抛 EPERM → 动态跳过
    const probe = path.join(workspace, '__symlink_probe__')
    try {
      await fs.symlink(workspace, probe, 'dir')
      await fs.rm(probe)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM') {
        console.warn(`[stagedDiff/tools] symbolic links unavailable (${detail}); test skipped`)
        t.skip()
        return
      }
      throw error
    }

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-staged-outside-'))
    try {
      await fs.symlink(outside, path.join(workspace, 'link'), 'dir')
      const staged = await run('staged_diff_stage', { path: 'link/evil.txt', content: 'evil' })
      expect(staged.success).toBe(true)

      const accepted = await run('staged_diff_accept', { entryId: staged.entry!.id, expectedRevision: 1 })
      expect(accepted.success).toBe(false)
      expect(accepted.code).toBe('GRAY_STAGED_PATH_ESCAPE')
      // 条目保持 accepted（落盘失败可重试），绝不假报完成
      expect(accepted.entry!.status).toBe('accepted')

      await expect(fs.readFile(path.join(outside, 'evil.txt'))).rejects.toThrow()
      await expect(fs.readFile(path.join(workspace, 'link', 'evil.txt'))).rejects.toThrow()
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})
