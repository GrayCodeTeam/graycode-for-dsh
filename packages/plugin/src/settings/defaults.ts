/** Standalone defaults used by settings-domain unit tests. */

import type { GrayCodeConfig } from './types.ts'
import { DEFAULT_AUTO_CHECKPOINT_AFTER_TOOLS, DEFAULT_AUTO_CHECKPOINT_BEFORE_TOOLS } from '../checkpoints/index.ts'
import { DEFAULT_IMAGE_API_URL, DEFAULT_IMAGE_MODEL } from '../images/domain/types.ts'
import { DEFAULT_KEEP_RECENT_ROUNDS, DEFAULT_KEEP_RECENT_TOKENS } from '../summary/policy.ts'

export const DEFAULTS: GrayCodeConfig = {
  workflows: { dataRoot: '', documentRoot: '.graycode', agentScope: 'roots' },
  memory: { dataRoot: '', wakeLines: 96, entryChars: 280, partChars: 20_000, partLines: 500, agentScope: 'roots', enabled: true, systemPrompt: '' },
  checkpoints: {
    dataRoot: '',
    maxCheckpoints: -1,
    excludeProfiles: {},
    excludePatterns: [],
    maxFileSizeBytes: 50 * 1024 * 1024,
    blobGracePeriodDays: 7,
    restoreProtectionPoint: true,
    agentScope: 'roots',
    enabled: true,
    autoCheckpoint: true,
    modelToolsEnabled: true,
    beforeTools: [...DEFAULT_AUTO_CHECKPOINT_BEFORE_TOOLS],
    afterTools: [...DEFAULT_AUTO_CHECKPOINT_AFTER_TOOLS],
    messageCheckpoint: {
      beforeMessages: ['user', 'model'],
      afterMessages: [],
      modelOuterLayerOnly: true,
      mergeUnchangedCheckpoints: true,
    },
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
  images: {
    enabled: false,
    agentScope: 'roots',
    url: DEFAULT_IMAGE_API_URL,
    apiKey: '',
    model: DEFAULT_IMAGE_MODEL,
    enableAspectRatio: false,
    defaultAspectRatio: undefined,
    enableImageSize: false,
    defaultImageSize: undefined,
    maxBatchTasks: 5,
    maxImagesPerTask: 1,
  },
  summary: {
    enabled: true,
    keepRecentRounds: DEFAULT_KEEP_RECENT_ROUNDS,
    keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
    summarizePrompt: '',
  },
}
