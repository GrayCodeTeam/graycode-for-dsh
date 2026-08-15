/**
 * GrayCode - prompt modes plugin (V2 §P3F, D-11 = c)
 *
 * Mounts the prompt settings service, the agent-scoped injector and the three
 * prompt tools. The injector re-registers the current mode section on live
 * agents whenever the service reports a change (mode switch / store edits)
 * and once the lazy store load resolves. Per targeted agent it also installs
 * the host prompt override waterfall (system-prompt/assemble) and the dynamic
 * contexts (graycode.todo / graycode.memory), whose snapshots the DSH host
 * persists into history and the client renders automatically.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'
import {
  createModeToolPolicyGuard,
  resolveModeToolPolicy,
} from '../workflows/domain/modeToolsPolicy.ts'
import { PromptSettingsService } from './service.ts'
import { createPromptInjector } from './promptInjector.ts'
import { createPromptRemoteHandlers } from './remote.ts'
import type { GrayRemoteService } from '../remote/service.ts'
import { createPromptTools } from './tools.ts'

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
 * `sendHistoryThoughts` is the fake-thought gate. Old Gray stripped fake
 * thoughts at the channel send side by a per-channel switch; rc.6 exposes no
 * such switch to plugins (P0-15 SPIKE), so the gate moved to the thoughts
 * domain (graycode-thoughts projects fakeThought as a typed reasoning block)
 * and defaults to `true` here.
 */
export interface Config {
  /** Plugin-private data root (resolved by the composition root). */
  dataRoot: string
  /** Master switch for the whole prompt domain. */
  enabled: boolean
  /** Section + tool install scope: roots (default), all, or disabled. */
  agentScope: AgentScopeMode
  /** Fake-thought gate (default true, see comment above). */
  sendHistoryThoughts: boolean
  /**
   * D-4 mode toolPolicy enforcement switch (default true = legacy preflight
   * semantics): built-in design/plan/ask/review modes force their allowlist,
   * code and custom modes stay unfiltered. `false` skips guard registration
   * entirely (zero intrusion).
   */
  modeToolPolicy: boolean
  /**
   * A1 request layer (default true): user/assistant preset entries are NOT
   * rendered as system-text context paragraphs — the thoughts plugin
   * (graycode-thoughts) injects them as real messages at the request layer
   * (llm/stream), so they arrive as genuine messages instead of labeled
   * system paragraphs. Pair with `thoughts.enabled` for the full A1 subset;
   * entries are otherwise injected as real messages only (see
   * domain/entries.ts requestLayer notes).
   */
  requestLayer: boolean
  /**
   * Host prompt override (default true via schema): the injector's
   * `system-prompt/assemble` waterfall keeps only the `graycode:persona` and
   * `graycode:prompt` sections and folds every other host section into
   * `{{graycode_dsh_prompt}}` (host contexts are dropped unless they belong
   * to graycode). `false` leaves the host prompt untouched — the mode section
   * simply joins it. The tool manifest (`{{graycode_tools}}`) is always
   * provided either way. Optional so settings/defaults.ts projections stay
   * valid; the schema materializes the default at plugin load.
   */
  overrideHostPrompt?: boolean
  /** Dynamic context: `graycode.todo` TODO snapshot (default true via schema). */
  dynamicTodo?: boolean
  /** Dynamic context: `graycode.memory` capability note (default true via schema). */
  dynamicMemory?: boolean
}

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  enabled: z.boolean().default(true),
  agentScope: agentScopeSchema,
  sendHistoryThoughts: z.boolean().default(true),
  modeToolPolicy: z.boolean().default(true),
  requestLayer: z.boolean().default(true),
  overrideHostPrompt: z.boolean().default(true),
  dynamicTodo: z.boolean().default(true),
  dynamicMemory: z.boolean().default(true),
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
    overrideHostPrompt: config.overrideHostPrompt,
    dynamicTodo: config.dynamicTodo,
    dynamicMemory: config.dynamicMemory,
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
  // 内置 design/plan/ask/review 强制白名单；code 与自定义模式无过滤（旧版语义对齐）；
  // 自定义模式的 toolPolicyCustomized 优先于内置表（resolveModeToolPolicy 语义）。
  // modeToolPolicy=false 时不注册（零侵入）；disposer 挂 ctx.effect 随插件卸载注销。
  if (config.modeToolPolicy) {
    ctx.effect(() =>
      ctx.tools.guard(
        createModeToolPolicyGuard({
          // resolveModeToolPolicy(mode)（workflows/domain/modeToolsPolicy.ts）：
          // mode.toolPolicyCustomized === true 时用 mode.toolPolicy，否则回退
          // 内置表（resolveBuiltinModeToolPolicy）。每次执行实时求值，模式切换
          // 无需重新挂接 guard。
          resolveToolPolicy: () => resolveModeToolPolicy(service.currentModeSnapshot()),
          resolveModeId: () => service.currentModeSnapshot()?.id,
        }),
      ),
    )
  }

  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  // M2：把 A1 requestLayer 状态传给工具层，预览与真实注入同源
  registrar.register(createPromptTools(
    service,
    () => config.sendHistoryThoughts,
    () => config.requestLayer,
  ))

  // Phase 4 host 侧 Remote 层（浏览器设置 UI 经 /graycode Connection RPC 通道操作
  // prompt 模式）：向根装配的 ctx.grayRemote 注册 prompt/modes.* 端点。
  // 用 ctx.inject 声明可选依赖（而非顶层 inject / 一次性 ctx.get）：组合根装配时
  // grayRemote 服务可能尚未 ACTIVE（strict ctx.get 返回 undefined），若此时静默跳过
  // 端点注册，浏览器面板会收到 GRAY_ENDPOINT_NOT_FOUND（remote endpoint not found:
  // prompt/modes.list）。inject 等依赖 ACTIVE 后自动补注册，服务卸载/重装时随
  // inject 纤维自动注销/重注册（HMR 安全，同 key 不重复注册）。
  ctx.inject(['grayRemote'], (child) => {
    const grayRemote = child.get('grayRemote') as GrayRemoteService | undefined
    const disposeRemote = grayRemote?.register(createPromptRemoteHandlers(service))
    child.effect(() => () => disposeRemote?.())
  })

  return () => {
    unsubscribe()
    registrar.dispose()
    injector.dispose()
  }
}
