import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CheckpointService } from './service.ts'
import { createCheckpointToolDefinitions } from './tools.ts'
import { createCheckpointsRemoteHandlers } from './adapters/dsh/remote.ts'
import type { GrayRemoteService } from '../remote/service.ts'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'
import { createDshFsRestoreWorkspaceWriter } from './domain/RestoreWorkspaceWriter.ts'
import {
  createAutoCheckpointEngine,
  type AutoCheckpointConfig,
} from './autoCheckpoint.ts'

export const name = 'graycode-checkpoints'

export const inject = ['agents', 'fs'] as const

/**
 * Workspace checkpoint domain: full/incremental snapshots with exclusion
 * rules, chain protection, preview-first restore, and content-addressed
 * blob storage under the plugin-private data root (V2 §7.6 layout:
 * checkpoints/<workspace-id>/{blobs,manifests,staging,quarantine}).
 *
 * 自动存档（对齐审计 C-01/C-02/C-03，host 侧）：
 * - `tools/execute` beforeTools/afterTools 工具执行前后存档；
 * - `agent/pre-step` 新用户回合存档（messageCheckpoint.beforeMessages 含 'user'）；
 * - `agent/turn-stopping` 模型回合关闭存档（afterMessages 含 'model'）；
 * - 全部自动存档 origin='auto'（client 列表以徽标区分）；失败降级 warn 不阻断。
 * 详细语义见 README.md 与 autoCheckpoint.ts。
 */
export interface MessageCheckpointConfig {
  /** pre-step 回合边界存档的消息种类（'user' 有挂点；缺省 ['user']）。 */
  beforeMessages?: Array<'user' | 'model'>
  /** turn-stopping 存档的消息种类（'model' 有挂点；缺省 []）。 */
  afterMessages?: Array<'user' | 'model'>
  /** 仅根 agent 自动存档（缺省 true）。 */
  modelOuterLayerOnly?: boolean
  /** 无变更不重复建档（创建后判定并回滚；缺省 true）。 */
  mergeUnchangedCheckpoints?: boolean
}

export interface Config {
  /** Plugin-private data root (resolved by the composition root). */
  dataRoot: string
  /** Maximum retained checkpoints per workspace (<= 0 = unlimited). */
  maxCheckpoints: number
  /** Default exclusion profile toggles (profileId -> enabled; {} = all defaults). */
  excludeProfiles: Record<string, boolean>
  /** Custom exclusion patterns (gitignore syntax; `!` negation cannot override forced exclusions). */
  excludePatterns: string[]
  /** Per-file size cap in bytes (<= 0 = unlimited; default 50 MiB). */
  maxFileSizeBytes: number
  /** Blob GC grace period in days (<= 0 = collect orphans immediately). */
  blobGracePeriodDays: number
  /** Create a rollback checkpoint before restore (best effort). */
  restoreProtectionPoint: boolean
  /** Tool install scope: roots (default), all agents, or disabled (no registration). */
  agentScope: AgentScopeMode
  /**
   * 域总开关（缺省 true）：false → 自动存档停 + 7 个 checkpoint 模型工具不注册
   * （remote 查询/命令端点不受影响，client 列表仍可用）。
   */
  enabled?: boolean
  /** 自动存档开关（enabled 子开关，只控自动存档；缺省 true）。 */
  autoCheckpoint?: boolean
  /** 7 个 checkpoint 模型工具开关（缺省 true；false → 工具不注册，自动存档仍可用）。 */
  modelToolsEnabled?: boolean
  /** 工具执行前自动存档的工具名白名单（缺省 DSH 版 24 工具，见 DEFAULT_AUTO_CHECKPOINT_TOOLS）。 */
  beforeTools?: string[]
  /** 工具执行后自动存档的工具名白名单（缺省同上）。 */
  afterTools?: string[]
  /** 消息边界自动存档配置（缺省见各字段）。 */
  messageCheckpoint?: MessageCheckpointConfig
}

/**
 * 默认 beforeTools/afterTools（DSH 版 24 工具）：
 * - 7 个 DSH host 内建工具（deepseek-harness 源码核实）：write / edit /
 *   str_replace_editor / bash / pwsh / grep / glob；
 * - 本插件注册工具（modeToolsPolicy 白名单同名核实）：delete_code（file 域）、
 *   media 5 工具、workflows 11 工具。
 * 原插件 insert_code/create_directory/delete_file/search_in_files/execute_command
 * 在 DSH 无同名工具，由上述 DSH 内建/替代工具承担对应语义。
 */
export const DEFAULT_AUTO_CHECKPOINT_TOOLS: readonly string[] = [
  'write',
  'edit',
  'str_replace_editor',
  'bash',
  'pwsh',
  'grep',
  'glob',
  'delete_code',
  'crop_image',
  'resize_image',
  'rotate_image',
  'generate_image',
  'remove_background',
  'create_plan',
  'update_plan',
  'create_design',
  'update_design',
  'create_progress',
  'update_progress',
  'record_progress_milestone',
  'create_review',
  'record_review_milestone',
  'finalize_review',
  'reopen_review',
]

const MESSAGE_KIND_SCHEMA = z.union(['user', 'model'] as const)

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  maxCheckpoints: z.number().default(-1),
  excludeProfiles: z.dict(z.boolean()).default({}),
  excludePatterns: z.array(z.string()).default([]),
  maxFileSizeBytes: z.number().default(50 * 1024 * 1024),
  blobGracePeriodDays: z.number().default(7),
  restoreProtectionPoint: z.boolean().default(true),
  agentScope: agentScopeSchema,
  enabled: z.boolean().default(true),
  autoCheckpoint: z.boolean().default(true),
  modelToolsEnabled: z.boolean().default(true),
  beforeTools: z.array(z.string()).default([...DEFAULT_AUTO_CHECKPOINT_TOOLS]),
  afterTools: z.array(z.string()).default([...DEFAULT_AUTO_CHECKPOINT_TOOLS]),
  messageCheckpoint: z
    .object({
      beforeMessages: z.array(MESSAGE_KIND_SCHEMA).default(['user']),
      afterMessages: z.array(MESSAGE_KIND_SCHEMA).default([]),
      modelOuterLayerOnly: z.boolean().default(true),
      mergeUnchangedCheckpoints: z.boolean().default(true),
    })
    .default({
      beforeMessages: ['user'],
      afterMessages: [],
      modelOuterLayerOnly: true,
      mergeUnchangedCheckpoints: true,
    }),
})

/** Config（TS 面字段可缺省，schema 已给默认值）→ 引擎消费的已解析配置。 */
export function resolveAutoCheckpointConfig(config: Config): AutoCheckpointConfig {
  const messageCheckpoint = config.messageCheckpoint ?? {}
  return {
    beforeTools: config.beforeTools ?? DEFAULT_AUTO_CHECKPOINT_TOOLS,
    afterTools: config.afterTools ?? DEFAULT_AUTO_CHECKPOINT_TOOLS,
    messageCheckpoint: {
      beforeMessages: messageCheckpoint.beforeMessages ?? ['user'],
      afterMessages: messageCheckpoint.afterMessages ?? [],
      modelOuterLayerOnly: messageCheckpoint.modelOuterLayerOnly ?? true,
      mergeUnchangedCheckpoints: messageCheckpoint.mergeUnchangedCheckpoints ?? true,
    },
  }
}

export async function apply(ctx: Context, config: Config): Promise<() => void> {
  // P0-08：恢复向用户 workspace 写文件必须经 DSH fs 路径——注入 ctx.fs（writeText 原子写、
  // 经过 fs/write-intent 策略缝、可携带 sandboxPolicy）；插件私有 blob root 仍由服务 node fs 管理。
  const service = new CheckpointService(config, createDshFsRestoreWorkspaceWriter(ctx.fs))
  // 初始化失败交给 Cordis fiber；成功前不注册任何可调用表面。
  await service.initialize()

  // 域门控（C-01/C-02/C-03）：enabled 总开关；autoCheckpoint / modelToolsEnabled 为
  // enabled 子开关，各自独立控制自动存档与 7 个模型工具（remote 端点不受影响）。
  const enabled = config.enabled ?? true
  const modelToolsEnabled = enabled && (config.modelToolsEnabled ?? true)
  const autoCheckpoint = enabled && (config.autoCheckpoint ?? true)

  let registrar: ReturnType<typeof createScopedToolRegistrar> | undefined
  if (modelToolsEnabled) {
    registrar = createScopedToolRegistrar(ctx, config.agentScope)
    registrar.register(createCheckpointToolDefinitions(service))
  }
  // Phase 4 host 侧 Remote 查询/命令层（checkpoint 列表/恢复预览）：注册端点；
  // grayRemote 是可选依赖——用 ctx.inject 声明，服务未 ACTIVE 时回调挂起、可用后
  // 自动补注册（修复组合根 LOADING 期间端点缺失导致的 GRAY_ENDPOINT_NOT_FOUND）。
  // 注销随 inject 纤维自动回收（HMR 重载后同 key 可重新注册）。
  ctx.inject(['grayRemote'], (child) => {
    const grayRemote = child.get('grayRemote') as GrayRemoteService | undefined
    const disposeRemote = grayRemote?.register(createCheckpointsRemoteHandlers(service))
    child.effect(() => () => disposeRemote?.())
  })

  // 自动存档引擎（独立于模型工具注册）：默认挂接 tools/execute + agent/pre-step +
  // agent/turn-stopping；modelOuterLayerOnly 时仅根 agent 存档。
  let detachAutoCheckpoint: (() => void) | undefined
  if (autoCheckpoint) {
    const engine = createAutoCheckpointEngine(service, resolveAutoCheckpointConfig(config), {
      isRoot: agent => ctx.agents.roots().some(root => root.id === agent.id),
      logger: ctx.logger,
    })
    detachAutoCheckpoint = engine.attach(ctx)
  }

  return () => {
    detachAutoCheckpoint?.()
    registrar?.dispose()
    service.dispose()
  }
}
