/** Structural browser mirror of the host's real child-plugin configuration. */

export type AgentScope = 'roots' | 'all' | 'disabled'

export interface DataRootConfig { dataRoot: string }
export interface ScopedConfig { agentScope: AgentScope }
export interface ToggleScopedConfig extends ScopedConfig { enabled: boolean }

export interface GrayCodeConfig {
  workflows: DataRootConfig & ScopedConfig & { documentRoot: string }
  memory: DataRootConfig & ScopedConfig & {
    wakeLines: number
    entryChars: number
    partChars: number
    partLines: number
  }
  checkpoints: DataRootConfig & ScopedConfig & {
    maxCheckpoints: number
    excludeProfiles: Record<string, boolean>
    excludePatterns: string[]
    maxFileSizeBytes: number
    blobGracePeriodDays: number
    restoreProtectionPoint: boolean
  }
  branches: DataRootConfig & ScopedConfig
  persona: ToggleScopedConfig & { template?: string }
  prompt: DataRootConfig & ToggleScopedConfig & {
    sendHistoryThoughts: boolean
    modeToolPolicy: boolean
    requestLayer: boolean
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
  subagents: { maxHopDepth: number; maxConcurrent: number }
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
  refsVerified: number
  issue?: string
}
