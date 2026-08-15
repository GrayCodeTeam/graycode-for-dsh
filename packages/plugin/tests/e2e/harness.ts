/**
 * GrayCode mock-LLM E2E harness (Phase 2 closure)
 *
 * Composes the real DSH services into one in-process harness with a scripted
 * LLM adapter (`echo` provider), then mounts `@graycode/dsh-plugin` from
 * source. Everything lives under caller-supplied temporary directories
 * (workspace cwd + plugin dataRoot); `dispose()` stops the Context and the
 * caller removes the temp roots.
 *
 * Mounted services, in dependency order:
 * - LocalFileSystem  (@deepseek-ai/dsh-fs-local)     -> ctx.fs (cwd = workspace)
 * - SessionStore     (@deepseek-ai/dsh-session)      -> ctx.sessions
 * - AgentRegistry    (@deepseek-ai/dsh-agent)        -> ctx.agents
 * - SystemPrompt     (@deepseek-ai/dsh-system-prompt)-> ctx.systemPrompt
 * - ToolRuntime      (@deepseek-ai/dsh-tools)        -> ctx.tools (needs systemPrompt)
 * - LlmRuntime       (@deepseek-ai/dsh-llm)          -> ctx.llm
 * - AgentLoop        (@deepseek-ai/dsh-agent-loop)   -> ctx.agentLoop + the
 *   agent factory (`ctx.agents.setFactory`); its only required runtime deps
 *   are the five services above (settings/persistence are optional seams).
 * - graycode plugin  (../../src/index.ts)            -> scoped tools + persona
 *
 * No session-persistence backend is mounted: rc.6 ships only the abstract
 * `SessionPersistence` service definition here, and agent-loop only needs it
 * for `resume` (creation uses the live SessionStore). Session recovery/replay
 * is therefore exercised through re-seeding (S4) instead of a restart.
 */
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionStore, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { AgentRegistry, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import {
  LlmRuntime,
  LlmAdapter,
  CallId,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as graycode from '../../src/index.ts'
import type { Config as GraycodeConfig } from '../../src/index.ts'

/** One scripted adapter emission step. */
export type ScriptStep =
  | { type: 'text'; text: string; delayMs?: number }
  | { type: 'tool-call'; name: string; arguments: string; id?: string; delayMs?: number }
  | { type: 'pause'; ms: number }

/** A script = one phase per model request, or a function over the request. */
export type Script =
  | readonly (readonly ScriptStep[])[]
  | ((options: GenerateOptions) => AsyncIterable<StreamChunk>)

export interface ScriptedAdapterOptions {
  /** Provider/model identity the adapter reports; defaults to echo/echo-model. */
  provider?: string
  model?: string
}

/**
 * `LlmAdapter` that replays a scripted chunk stream instead of talking to a
 * provider. The array form consumes one phase per `stream()` call (so a
 * tool-call step followed by a text step is served by two sequential model
 * requests); a function form gets the full assembled request and yields
 * chunks directly. `options.signal` is honored between steps (S5 cancel).
 */
export class ScriptedAdapter extends LlmAdapter {
  readonly provider: string
  readonly model: string
  private readonly script: Script
  private cursor = 0

  constructor(script: Script, options: ScriptedAdapterOptions = {}) {
    super()
    this.script = script
    this.provider = options.provider ?? 'echo'
    this.model = options.model ?? 'echo-model'
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (typeof this.script === 'function') {
      yield* this.script(options)
      return
    }
    const phase = this.script[this.cursor++] ?? [{ type: 'text', text: '' }]
    yield* ScriptedAdapter.renderPhase(phase, options.signal)
  }

  static async *renderPhase(steps: readonly ScriptStep[], signal?: AbortSignal): AsyncIterable<StreamChunk> {
    const toolCalls = steps.filter(step => step.type === 'tool-call')
    const textParts = steps.filter(step => step.type === 'text').map(step => step.text).join('')
    if (textParts.length > 0) {
      const index = 0
      yield { type: 'block-start', index, blockType: 'text' }
      if (signal?.aborted) return
      yield { type: 'text-delta', index, text: textParts }
      yield { type: 'block-end', index, block: { type: 'text', text: textParts } }
    }
    for (const step of steps) {
      if (step.type === 'pause') {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, step.ms)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
        })
        if (signal?.aborted) return
      }
    }
    if (toolCalls.length > 0) {
      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i]!
        const index = textParts.length > 0 ? i + 1 : i
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index,
          id: CallId(call.id ?? `echo-call-${i}`),
          name: call.name,
          argumentsDelta: call.arguments,
        }
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: CallId(call.id ?? `echo-call-${i}`), name: call.name, arguments: call.arguments },
        }
      }
      yield {
        type: 'finish',
        reason: { kind: 'tool-calls' },
      }
      return
    }
    yield {
      type: 'usage',
      usage: { inputTokens: 1, outputTokens: textParts.length || 1 },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export interface HarnessOptions {
  /** Absolute workspace path the session runs in (LocalFileSystem cwd + session meta.cwd). */
  workspace: string
  /** Absolute plugin data root (memory / checkpoints / branches). */
  dataRoot: string
  /** Adapter script for `echo`; overrides are honored for per-test setups. */
  script?: Script
  /** Extra graycode config overrides (persona, agentScope, ...). */
  graycodeConfig?: Partial<GraycodeConfig>
}

export interface HarnessAgent {
  agent: Agent
  handle: AgentHandle
  sessionId: string
}

/**
 * One composed harness instance. Build with `Harness.create(options)` (plugin
 * fibers load asynchronously); `dispose()` disposes every mounted plugin fiber
 * in reverse order (agents and the agent-loop factory unwind through their
 * registered teardowns); temp roots stay for the caller to inspect/remove.
 */
export class Harness {
  readonly ctx: Context
  readonly workspace: string
  readonly dataRoot: string
  readonly adapter: ScriptedAdapter
  private readonly fibers: Array<{ dispose(): Promise<void> }> = []

  private constructor(options: HarnessOptions) {
    this.workspace = options.workspace
    this.dataRoot = options.dataRoot
    this.ctx = new Context()
    this.adapter = new ScriptedAdapter(options.script ?? [])
  }

  static async create(options: HarnessOptions): Promise<Harness> {
    const harness = new Harness(options)
    const ctx = harness.ctx
    const mounted: Array<{ dispose(): Promise<void> }> = []

    mounted.push(await ctx.plugin(LocalFileSystem, { cwd: harness.workspace }))
    mounted.push(await ctx.plugin(SessionStore))
    mounted.push(await ctx.plugin(AgentRegistry))
    mounted.push(await ctx.plugin(SystemPrompt))
    mounted.push(await ctx.plugin(ToolRuntime))
    mounted.push(await ctx.plugin(LlmRuntime))
    mounted.push(await ctx.plugin(AgentLoop, { agents: [] }))
    mounted.push(
      await ctx.plugin(graycode, {
        dataRoot: harness.dataRoot,
        workflows: { dataRoot: harness.dataRoot, agentScope: 'roots' },
        memory: { dataRoot: harness.dataRoot, agentScope: 'roots' },
        checkpoints: { dataRoot: harness.dataRoot, agentScope: 'roots' },
        branches: { dataRoot: harness.dataRoot, agentScope: 'roots' },
        persona: { enabled: true, agentScope: 'roots' },
        ...options.graycodeConfig,
      } as GraycodeConfig),
    )
    ctx.llm.registerAdapter([harness.adapter.provider], harness.adapter)
    harness.fibers.push(...mounted)
    return harness
  }

  /** Create an agent in the harness; agentOptions route to the echo adapter. */
  async createAgent(sessionId: string, cwd?: string): Promise<HarnessAgent> {
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: cwd ?? this.workspace },
      agentOptions: { provider: this.adapter.provider, model: this.adapter.model },
    })
    return { agent: handle.agent, handle, sessionId }
  }

  /** Queue one user message and wait until the agent reaches quiescence. */
  async followupAndIdle(agent: Agent, text: string): Promise<void> {
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    )
    await agent.whenIdle()
  }

  /** All events of a session log, in seq order. */
  eventsOf(agent: Agent): readonly SessionEvent[] {
    return agent.session.events
  }

  /** Resolve a tool as the agent's scope sees it (scoped shadowing applies). */
  toolOf(agent: Agent, name: string) {
    return this.ctx.tools.get(name, agent)
  }

  async dispose(): Promise<void> {
    for (const fiber of this.fibers.reverse()) {
      await fiber.dispose()
    }
  }
}

/** 可容忍的枚举失败：不可读目录（EACCES/EPERM）、并发清理（ENOENT/ENOTDIR）、悬空链接（ELOOP）。 */
const SKIP_FS_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP'])

function isSkippableFsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    SKIP_FS_CODES.has((error as { code: string }).code)
  )
}

/** Recursively collect every file path under a root. */
export async function listFilesRecursive(root: string): Promise<string[]> {
  const { readdir, stat } = await import('node:fs/promises')
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    // 4.19-L2：不可读/已消失的目录跳过而非中断整个列举（test-only 枚举工具，
    // 无法访问的分支不应让其余可读目录的收集一起失败）。
    const entries = await readdir(dir).catch((error: unknown) => {
      if (!isSkippableFsError(error)) throw error
      return undefined
    })
    if (entries === undefined) return
    for (const entry of entries) {
      const full = `${dir}/${entry}`
      // 条目在 walk 中途消失（含悬空 symlink）：跳过而非中断。
      const info = await stat(full).catch((error: unknown) => {
        if (!isSkippableFsError(error)) throw error
        return undefined
      })
      if (info === undefined) continue
      if (info.isDirectory()) await walk(full)
      else out.push(full)
    }
  }
  await walk(root)
  return out
}
