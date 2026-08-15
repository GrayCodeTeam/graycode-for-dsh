import type { AgentScope, GrayCodeConfig } from './types.ts'

export const AGENT_SCOPES: readonly AgentScope[] = ['roots', 'all', 'disabled']

/** Kept for the generic field primitive; GrayCode does not expose diagnostics here. */
export const DIAGNOSTIC_SEVERITIES: readonly { value: string; labelKey: string }[] = []

export const DEFAULTS: GrayCodeConfig = {
  workflows: { dataRoot: '', documentRoot: '.graycode', agentScope: 'roots' },
  memory: {
    dataRoot: '',
    wakeLines: 96,
    entryChars: 280,
    partChars: 20_000,
    partLines: 500,
    agentScope: 'roots',
    systemPrompt: '',
  },
  checkpoints: {
    dataRoot: '',
    maxCheckpoints: -1,
    excludeProfiles: {},
    excludePatterns: [],
    maxFileSizeBytes: 50 * 1024 * 1024,
    blobGracePeriodDays: 7,
    restoreProtectionPoint: true,
    agentScope: 'roots',
  },
  autoCheckpoints: {
    enabled: false,
    beforeUserMessage: false,
    beforeMajorChange: false,
    majorChangeTools: [
      'apply_diff',
      'write_file',
      'insert_code',
      'delete_file',
      'delete_code',
      'create_directory',
      'execute_command',
      'edit_file',
    ],
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
  branches: { dataRoot: '', agentScope: 'roots' },
  persona: { enabled: true, agentScope: 'roots', template: '' },
  prompt: {
    dataRoot: '',
    enabled: true,
    agentScope: 'roots',
    sendHistoryThoughts: true,
    modeToolPolicy: true,
    requestLayer: true,
    overrideHostPrompt: true,
    dynamicTodo: true,
    dynamicMemory: true,
  },
  migration: { dataRoot: '', enabled: false, allowLegacyReaders: false },
  stagedDiff: { dataRoot: '', enabled: false, agentScope: 'roots' },
  activity: { dataRoot: '', enabled: true, agentScope: 'roots', sampleIntervalMs: 60_000 },
  media: { enabled: true, agentScope: 'roots', maxBatch: 10 },
  file: { enabled: true, agentScope: 'roots' },
  todo: { enabled: true, agentScope: 'roots' },
  subagents: { maxHopDepth: 5, maxConcurrent: 2, customAgents: [] },
  notifications: { enabled: true, agentScope: 'roots', windowsToast: true },
  thoughts: { enabled: true, sendHistoryThoughts: true },
}
