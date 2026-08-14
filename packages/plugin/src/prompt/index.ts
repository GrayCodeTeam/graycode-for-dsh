/**
 * GrayCode - prompt modes plugin (V2 §P3F, D-11 = c)
 *
 * Mounts the prompt settings service, the agent-scoped injector and the three
 * prompt tools. The injector re-registers the current mode section on live
 * agents whenever the service reports a change (mode switch / store edits)
 * and once the lazy store load resolves.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'
import { PromptSettingsService } from './service.ts'
import { createPromptInjector } from './promptInjector.ts'
import { createPromptTools } from './tools.ts'
import { createModeToolPolicyGuard, resolveBuiltinModeToolPolicy } from '../workflows/domain/modeToolsPolicy.ts'

export const name = 'graycode-prompt'

/**
 * Cross-domain service key: exposes the live prompt-mode service to other
 * domains (e.g. graycode-thoughts reads the current mode to build its
 * request-layer injections). Provided by prompt's apply, consumed lazily via
 * `ctx.get` so a missing service degrades to no-op instead of failing.
 */
export const PROMPT_MODES_SERVICE = 'graycode.promptModes'

export const inject = ['agents', 'tools'] as const

/**
 * Prompt mode configuration.
 *
 * `sendHistoryThoughts` is the D-11 = c fake-thought gate. Old Gray stripped
 * fake thoughts at the channel send side by a per-channel switch whose default
 * was disputed (base.ts comment "true" vs formatter `?? false`); rc.6 exposes
 * no such switch to plugins (P0-15 SPIKE), so the gate moved to injection
 * time and defaults to `false` — fake thoughts are never written unless
 * explicitly enabled (known D-11 = c degradation, see domain/entries.ts).
 */
export interface Config {
  /** Plugin-private data root (resolved by the composition root). */
  dataRoot: string
  /** Master switch for the whole prompt domain. */
  enabled: boolean
  /** Section + tool install scope: roots (default), all, or disabled. */
  agentScope: AgentScopeMode
  /** D-11 = c fake-thought gate (default false, see comment above). */
  sendHistoryThoughts: boolean
  /**
   * D-4 mode toolPolicy enforcement switch (default true = legacy preflight
   * semantics): built-in design/plan/ask/review modes force their allowlist,
   * code and custom modes stay unfiltered. `false` skips guard registration
   * entirely (zero intrusion).
   */
  modeToolPolicy: boolean
  /**
   * A1 request layer (default false = D-11 = c as-is): when true, the
   * injector skips user/assistant context paragraphs because the thoughts
   * plugin (graycode-thoughts) injects them as real messages at the
   * request-construction layer. Pair with `thoughts.enabled` for the full
   * A1 subset; paragraphs are otherwise double-injected (see
   * domain/entries.ts requestLayer notes).
   */
  requestLayer: boolean
}

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  enabled: z.boolean().default(true),
  agentScope: agentScopeSchema,
  sendHistoryThoughts: z.boolean().default(false),
  modeToolPolicy: z.boolean().default(true),
  requestLayer: z.boolean().default(false),
})

export function apply(ctx: Context, config: Config): () => void {
  if (!config.enabled) return () => {}

  const service = new PromptSettingsService({ dataRoot: config.dataRoot })
  // Cross-domain service (A1): thoughts reads the current mode snapshot to
  // build request-layer injections; absent consumers degrade to no-op.
  ctx.provide(PROMPT_MODES_SERVICE, service)
  const injector = createPromptInjector(ctx, config.agentScope, () => ({
    mode: service.currentModeSnapshot(),
    sendHistoryThoughts: config.sendHistoryThoughts,
    requestLayer: config.requestLayer,
  }))

  // Store edits / mode switches re-inject live agents synchronously (the
  // service updates its in-memory snapshot before emitting).
  const unsubscribe = service.subscribe(() => injector.refresh())

  // Lazy store load: once the current mode is known, backfill every agent.
  void service.getCurrentMode().then(
    () => injector.refresh(),
    (error: unknown) => {
      ctx.logger.warn('prompt modes store unavailable; prompt mode injection disabled', error)
    },
  )

  // D-4：模式 toolPolicy 执行链（探针 VERIFIED，实现见 workflows/domain/modeToolsPolicy.ts）。
  // ctx.tools.guard() 是 DSH 的单调拥有方守卫：返回 reason 即拒绝，监听器顺序无法把
  // 拒绝翻回放行，适合做安全边界；resolveToolPolicy 抛错时 fail-closed（拒绝而非放行）。
  // 模式切换无需重新挂接：resolve 每次执行实时求值（与注入器的 refresh 机制解耦）。
  // 内置 design/plan/ask/review 强制白名单；code 与自定义模式无过滤（旧版语义对齐）。
  // modeToolPolicy=false 时不注册（零侵入）；disposer 挂 ctx.effect 随插件卸载注销。
  if (config.modeToolPolicy) {
    ctx.effect(() =>
      ctx.tools.guard(
        createModeToolPolicyGuard({
          resolveToolPolicy: () => resolveBuiltinModeToolPolicy(service.currentModeSnapshot()?.id),
          resolveModeId: () => service.currentModeSnapshot()?.id,
        }),
      ),
    )
  }

  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  registrar.register(createPromptTools(service, () => config.sendHistoryThoughts))

  return () => {
    unsubscribe()
    registrar.dispose()
    injector.dispose()
  }
}
