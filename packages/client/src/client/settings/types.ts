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

/** F3 automatic checkpoint policy (mirror of the plugin's auto-checkpoints entry). */
export interface AutoCheckpointsConfig {
  enabled: boolean
  beforeUserMessage: boolean
  beforeMajorChange: boolean
  majorChangeTools: string[]
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

export interface GrayCodeConfig {
  workflows: DataRootConfig & ScopedConfig & { documentRoot: string }
  memory: DataRootConfig & ScopedConfig & {
    wakeLines: number
    entryChars: number
    partChars: number
    partLines: number
    /** 自定义记忆说明（MEMORY 动态上下文）；留空使用默认说明。 */
    systemPrompt?: string
  }
  checkpoints: DataRootConfig & ScopedConfig & {
    maxCheckpoints: number
    excludeProfiles: Record<string, boolean>
    excludePatterns: string[]
    maxFileSizeBytes: number
    blobGracePeriodDays: number
    restoreProtectionPoint: boolean
  }
  autoCheckpoints: AutoCheckpointsConfig
  images: ImagesConfig
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
