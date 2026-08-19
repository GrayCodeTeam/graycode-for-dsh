import type { AgentScope, GrayCodeConfig } from './types.ts'

export const AGENT_SCOPES: readonly AgentScope[] = ['roots', 'all', 'disabled']

/** Kept for the generic field primitive; GrayCode does not expose diagnostics here. */
export const DIAGNOSTIC_SEVERITIES: readonly { value: string; labelKey: string }[] = []

/** DSH + Gray Code 兼容工具全集（存档触发矩阵目录）。 */
export const DSH_TOOL_DEFAULTS: readonly string[] = [
  'write',
  'edit',
  'str_replace_editor',
  'bash',
  'pwsh',
  'grep',
  'glob',
  'delete_code',
  'insert_code',
  'list_files',
  'search_in_files',
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

/**
 * 默认「执行前」白名单（用户指定：只勾 执行命令前 + 删除前）：
 * bash / pwsh（执行命令前）、delete_code（删除前）。写入/差异类默认只在执行后存档。
 */
export const DSH_BEFORE_TOOL_DEFAULTS: readonly string[] = ['bash', 'pwsh', 'delete_code']

/**
 * 默认「执行后」白名单（用户指定：只勾 写入后 + 应用差异后）：
 * write / insert_code（写入后）、edit / str_replace_editor / search_in_files
 * （应用差异或批量替换后）。
 */
export const DSH_AFTER_TOOL_DEFAULTS: readonly string[] = [
  'write',
  'edit',
  'str_replace_editor',
  'insert_code',
  'search_in_files',
]

export const DEFAULTS: GrayCodeConfig = {
  workflows: { dataRoot: '', documentRoot: '.graycode', agentScope: 'roots' },
  memory: {
    dataRoot: '',
    enabled: true,
    wakeLines: 96,
    entryChars: 280,
    partChars: 20_000,
    partLines: 500,
    agentScope: 'roots',
    systemPrompt: '',
  },
  checkpoints: {
    dataRoot: '',
    enabled: true,
    maxCheckpoints: -1,
    excludeProfiles: {},
    excludePatterns: [],
    maxFileSizeBytes: 50 * 1024 * 1024,
    blobGracePeriodDays: 7,
    restoreProtectionPoint: true,
    autoCheckpoint: true,
    modelToolsEnabled: true,
    messageCheckpoint: {
      beforeMessages: ['user', 'model'],
      afterMessages: [],
      modelOuterLayerOnly: true,
      mergeUnchangedCheckpoints: true,
    },
    beforeTools: [...DSH_BEFORE_TOOL_DEFAULTS],
    afterTools: [...DSH_AFTER_TOOL_DEFAULTS],
    agentScope: 'roots',
  },
  images: {
    enabled: false,
    agentScope: 'roots',
    url: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: '',
    model: 'gemini-3-pro-image-preview',
    enableAspectRatio: false,
    defaultAspectRatio: undefined,
    enableImageSize: false,
    defaultImageSize: undefined,
    maxBatchTasks: 5,
    maxImagesPerTask: 1,
  },
  // Mirror of the plugin summary domain defaults (settings/defaults.ts):
  // enabled on, keep the last 2 rounds / 50% token budget, built-in prompt.
  summary: {
    enabled: true,
    keepRecentRounds: 2,
    keepRecentTokens: '50%',
    summarizePrompt: '',
  },
  branches: { dataRoot: '', agentScope: 'roots', retentionDays: 30 },
  persona: { enabled: true, agentScope: 'roots', template: '' },
  prompt: {
    dataRoot: '',
  },
  migration: { dataRoot: '', enabled: false },
  stagedDiff: { dataRoot: '', enabled: false, agentScope: 'roots' },
  activity: { dataRoot: '', enabled: true, agentScope: 'roots', sampleIntervalMs: 60_000 },
  media: { enabled: true, agentScope: 'roots', maxBatch: 10 },
  file: { enabled: true, agentScope: 'roots' },
  todo: { enabled: true, agentScope: 'roots' },
  subagents: { generalWorkerEnabled: true, maxHopDepth: 5, maxConcurrent: 3, defaultMaxIterations: 80, queueTimeoutSeconds: 600, defaultMaxRuntimeSeconds: 1800, customAgents: [] },
  notifications: { enabled: true, agentScope: 'roots', windowsToast: true },
  thoughts: { sendHistoryThoughts: true },
}
