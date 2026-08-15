/** Standalone defaults used by settings-domain unit tests. */

import type { GrayCodeConfig } from './types.ts'
import { DEFAULT_AUTO_CHECKPOINT_TOOLS } from '../checkpoints/index.ts'

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
    beforeTools: [...DEFAULT_AUTO_CHECKPOINT_TOOLS],
    afterTools: [...DEFAULT_AUTO_CHECKPOINT_TOOLS],
    messageCheckpoint: {
      beforeMessages: ['user'],
      afterMessages: [],
      modelOuterLayerOnly: true,
      mergeUnchangedCheckpoints: true,
    },
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
