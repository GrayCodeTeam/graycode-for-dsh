import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MemoryService } from './service.ts'
import { createMemoryTools } from './tools.ts'
import { createMemoryPreStepListener } from './autoInject.ts'
import { createMemoryRemoteHandlers } from './adapters/dsh/remote.ts'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'

export const name = 'graycode-memory'

export const inject = ['agents'] as const

/**
 * Permanent memory domain (OptMem-style log + tree summaries), scoped
 * globally and per workspace, persisted under the plugin-private data root.
 * The numeric knobs seed the shared memory config; the memory_config tool
 * may override them at runtime (persisted to <dataRoot>/memory/config).
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
}

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  wakeLines: z.number().step(1).min(1).max(10000).default(96),
  entryChars: z.number().step(1).min(1).max(1000).default(280),
  partChars: z.number().step(1).min(1).max(1000000).default(20000),
  partLines: z.number().step(1).min(1).max(100000).default(500),
  agentScope: agentScopeSchema,
})

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
  // Phase 4 host 侧 Remote 查询/命令层（memory 管理）：注册端点；
  // 独立挂载（无 grayRemote）时静默跳过，工具行为不受影响。注销函数随本 fiber
  // 卸载（HMR：旧端点先注销，新实例同 key 可重新注册）。
  const disposeRemote = ctx.grayRemote?.register(createMemoryRemoteHandlers(service))
  // Auto-injection is independent of the tool install scope: on the first
  // qualified pre-step of each agent (and again only when memory content
  // changes) a bounded snapshot enters the request; failures degrade to no
  // injection. The listener unregisters with this fiber.
  const detachInjector = ctx.on('agent/pre-step', createMemoryPreStepListener(service, ctx.logger))
  ctx.effect(() => () => {
    disposeRemote?.()
    registrar.dispose()
    detachInjector()
  })
}
