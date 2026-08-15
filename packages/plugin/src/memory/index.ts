import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MemoryService } from './service.ts'
import { createMemoryTools } from './tools.ts'
import { createMemoryPreStepListener } from './autoInject.ts'
import { createMemoryRemoteHandlers } from './adapters/dsh/remote.ts'
import type { GrayRemoteService } from '../remote/service.ts'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'

export const name = 'graycode-memory'

export const inject = ['agents'] as const

/**
 * Permanent memory domain (OptMem-style log + tree summaries), scoped
 * globally and per workspace, persisted under the plugin-private data root.
 * The numeric knobs seed the shared memory config. On process startup an
 * existing memory_config file wins; a later in-process settings/HMR change
 * applies only changed knobs. memory_config overrides remain persisted.
 */
export interface Config {
  /** Plugin-private data root (resolved by the composition root). */
  dataRoot: string
  /** wake output line budget (default 96, ~8k tokens). */
  wakeLines: number
  /** Max bytes per memory (default 280, upper limit 1000). */
  entryChars: number
  /** Max characters per output part (default 20000). */
  partChars: number
  /** Max lines per output part (default 500). */
  partLines: number
  /** Tool install scope: roots (default), all agents, or disabled (no registration). */
  agentScope: AgentScopeMode
  /**
   * Master switch for the MEMORY prompt section (default true). `false` →
   * the prompt domain injects an empty MEMORY value (legacy parity with
   * contextSections.generateMemorySection: enabled === false → '').
   */
  enabled?: boolean
  /**
   * Custom MEMORY system prompt (default '' = built-in English note). The
   * prompt domain (promptInjector) reads it via the cross-domain service
   * `graycode.memoryPrompt`; empty/whitespace → built-in note.
   */
  systemPrompt?: string
}

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  wakeLines: z.number().step(1).min(1).max(10000).default(96),
  entryChars: z.number().step(1).min(1).max(1000).default(280),
  partChars: z.number().step(1).min(1).max(1000000).default(20000),
  partLines: z.number().step(1).min(1).max(100000).default(500),
  agentScope: agentScopeSchema,
  enabled: z.boolean().default(true),
  systemPrompt: z.string().default(''),
})

/**
 * Cross-domain service key: the prompt domain (promptInjector) reads the
 * MEMORY prompt configuration via `ctx.get` per assembly. Absent service
 * (prompt mounted standalone / tests without the memory domain) degrades to
 * the built-in static note.
 */
export const MEMORY_PROMPT_SERVICE = 'graycode.memoryPrompt'

/** Cross-domain service shape consumed by the prompt domain. */
export interface MemoryPromptService {
  /** Trimmed custom system prompt; '' means the built-in note is used. */
  getSystemPrompt(): string
  /** Master switch: false → the MEMORY value is '' (nothing injected). */
  isEnabled(): boolean
}

export function apply(ctx: Context, config: Config): void {
  const service = new MemoryService({
    dataRoot: config.dataRoot,
    wakeLines: config.wakeLines,
    entryChars: config.entryChars,
    partChars: config.partChars,
    partLines: config.partLines,
  })
  // Memory tools install per agent scope (roots by default); the fiber
  // unloads the registrations on dispose (service keeps no timers/handles).
  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  registrar.register(createMemoryTools(service))
  // Phase 4 host 侧 Remote 查询/命令层（memory 管理）：注册端点；grayRemote 是可选
  // 依赖——用 ctx.inject 声明，服务未 ACTIVE 时回调挂起、可用后自动补注册（修复
  // 组合根 LOADING 期间端点缺失导致的 GRAY_ENDPOINT_NOT_FOUND）。注销随 inject
  // 纤维自动回收（HMR 重载后同 key 可重新注册）。
  ctx.inject(['grayRemote'], (child) => {
    const grayRemote = child.get('grayRemote') as GrayRemoteService | undefined
    const disposeRemote = grayRemote?.register(createMemoryRemoteHandlers(service))
    child.effect(() => () => disposeRemote?.())
  })
  // Auto-injection is independent of the tool install scope: on the first
  // qualified pre-step of each agent (and again only when memory content
  // changes) a bounded snapshot enters the request; failures degrade to no
  // injection. The listener unregisters with this fiber.
  const detachInjector = ctx.on('agent/pre-step', createMemoryPreStepListener(service, ctx.logger))
  // Cross-domain service (prompt domain reads the MEMORY prompt text): the
  // prompt injector lazily fetches it per assembly via ctx.get, so HMR
  // restarts (settings changes) are picked up without re-registration.
  // Disposer follows this fiber (provide returns it; ctx.effect unwinds it).
  const disposeProvide = ctx.provide(MEMORY_PROMPT_SERVICE, {
    getSystemPrompt: () => config.systemPrompt?.trim() ?? '',
    isEnabled: () => config.enabled !== false,
  } satisfies MemoryPromptService)
  ctx.effect(() => () => {
    disposeProvide()
    registrar.dispose()
    detachInjector()
  })
}
