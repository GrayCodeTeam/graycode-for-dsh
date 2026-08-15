/** Structural browser mirror of the host's real child-plugin configuration. */

export type AgentScope = 'roots' | 'all' | 'disabled'

export interface DataRootConfig { dataRoot: string }
export interface ScopedConfig { agentScope: AgentScope }
export interface ToggleScopedConfig extends ScopedConfig { enabled: boolean }

/** S2 custom subagent (mirror of the plugin's `customAgents` domain entry). */
export interface CustomAgentConfig {
  id: string
  name: string
  description: string
  systemPrompt: string
  enabled: boolean
}

/** 消息级自动存档策略（checkpoints.messageCheckpoint）。 */
export interface CheckpointMessagePolicy {
  /** 在哪些角色消息之前自动创建存档点。 */
  beforeMessages: Array<'user' | 'model'>
  /** 在哪些角色消息之后自动创建存档点。 */
  afterMessages: Array<'user' | 'model'>
  /** 仅对模型最外层消息应用消息存档策略（内部工具循环消息除外）。 */
  modelOuterLayerOnly: boolean
  /** 内容未变化的相邻存档点合并为一个。 */
  mergeUnchangedCheckpoints: boolean
}

/** Image generation (mirror of the plugin's images entry). */
export interface ImagesConfig {
  enabled: boolean
  agentScope: AgentScope
  url: string
  apiKey: string
  model: string
  enableAspectRatio: boolean
  defaultAspectRatio?: string
  enableImageSize: boolean
  defaultImageSize?: string
  maxBatchTasks: number
  maxImagesPerTask: number
}

/** Summary domain (mirror of the plugin's summary entry). */
export interface SummaryConfig {
  /** 总开关（默认 true：挂载即启用）。 */
  enabled: boolean
  /** 保留最近 N 轮不参与总结（下限保护；默认 2，1-10）。 */
  keepRecentRounds: number
  /** 保留预算：绝对 token 数或百分比（百分比基数为历史总量；默认 '50%'）。 */
  keepRecentTokens: string | number
  /** 用户 prompt 模板（可含 {history} 占位；空 = 内置模板）。 */
  summarizePrompt: string
}

export interface GrayCodeConfig {
  workflows: DataRootConfig & ScopedConfig & { documentRoot: string }
  memory: DataRootConfig & ScopedConfig & {
    /** 记忆域总开关（默认 true）；关闭后记忆工具不可用且不再注入 MEMORY 提示词。 */
    enabled: boolean
    wakeLines: number
    entryChars: number
    partChars: number
    partLines: number
    /** 自定义记忆说明（MEMORY 动态上下文）；留空使用默认说明。 */
    systemPrompt?: string
  }
  checkpoints: DataRootConfig & ScopedConfig & {
    /** 存档点域总开关（默认 true）。 */
    enabled: boolean
    maxCheckpoints: number
    excludeProfiles: Record<string, boolean>
    excludePatterns: string[]
    maxFileSizeBytes: number
    blobGracePeriodDays: number
    restoreProtectionPoint: boolean
    /** 工具执行/消息前后自动创建存档点（默认 true）。 */
    autoCheckpoint: boolean
    /** 模型是否可调用 checkpoint_* 工具（默认 true）；自动存档不受影响。 */
    modelToolsEnabled: boolean
    /** 消息级自动存档策略。 */
    messageCheckpoint: CheckpointMessagePolicy
    /** 执行前自动存档的工具名列表（默认 DSH 版 24 工具）。 */
    beforeTools: string[]
    /** 执行后自动存档的工具名列表（默认 DSH 版 24 工具）。 */
    afterTools: string[]
  }
  images: ImagesConfig
  summary: SummaryConfig
  branches: DataRootConfig & ScopedConfig
  persona: ToggleScopedConfig & { template?: string }
  prompt: DataRootConfig & ToggleScopedConfig & {
    sendHistoryThoughts: boolean
    modeToolPolicy: boolean
    requestLayer: boolean
    /** 覆盖 DSH 自带系统提示词（宿主内容以 {{graycode_dsh_prompt}} 变量可引用）。 */
    overrideHostPrompt: boolean
    /** 注入 TODO 动态上下文（以宿主注入上下文行显示）。 */
    dynamicTodo: boolean
    /** 注入 MEMORY 说明动态上下文。 */
    dynamicMemory: boolean
  }
  migration: DataRootConfig & {
    enabled: boolean
    allowLegacyReaders: boolean
  }
  stagedDiff: DataRootConfig & ToggleScopedConfig
  activity: DataRootConfig & ToggleScopedConfig & { sampleIntervalMs: number }
  media: ToggleScopedConfig & { maxBatch: number }
  file: ToggleScopedConfig
  todo: ToggleScopedConfig
  subagents: { maxHopDepth: number; maxConcurrent: number; customAgents: CustomAgentConfig[] }
  notifications: ToggleScopedConfig & { windowsToast: boolean }
  thoughts: { enabled: boolean; sendHistoryThoughts: boolean }
}

export type GrayCodePatch = { [K in keyof GrayCodeConfig]?: GrayCodeConfig[K] }

export interface GrayRemoteFailure {
  code: string
  message: string
  details: Readonly<Record<string, unknown>>
}

export type GrayRemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GrayRemoteFailure }

export type GrayRemoteInvoke = <T>(
  namespace: string,
  method: string,
  args?: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<GrayRemoteResult<T>>

export interface CheckpointItem {
  id: string
  conversationId: string
  messageIndex: number
  toolName: string
  phase: 'before' | 'after'
  timestamp: number
  type: 'full' | 'incremental'
  fileCount: number
  backupBytes: number
  excludedCount: number
  baseCheckpointId?: string
  verifyState?: 'unknown' | 'ok' | 'failed'
}

export interface CheckpointListResult {
  items: CheckpointItem[]
  total: number
  nextCursor?: string
}

export interface CheckpointVerifyResult {
  ok: boolean
  checkpointId: string
  issues: string[]
  checkedFiles: number
  chainLength: number
  filesRevisionPaired: boolean
}

export interface RestorePreview {
  success: boolean
  restored: number
  deleted: number
  deletedIfUnconfirmed: number
  skipped: number
  deletablePaths: string[]
  untrackedPaths: string[]
  legacy?: boolean
  error?: string
  [key: string]: unknown
}

export interface CheckpointPreviewOutcome {
  preview: RestorePreview
  previewToken?: string
  baselineDigest?: string
}

export interface CheckpointGcResult {
  dryRun: boolean
  removedBlobs: string[]
  removedBytes: number
  pendingBlobs: Array<{ hash: string; orphanedSince: number; ageMs: number }>
  blobsScanned: number
  issue?: string
}
