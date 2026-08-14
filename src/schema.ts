/**
 * Gray Code settings namespace schema (schemastery). Every leaf carries a
 * default so the namespace resolves even with an empty user section; the
 * plugin's `base` layer (shared/defaults) supplies the full default document.
 *
 * The namespace is registered host-side for persistence and host reads. The
 * browser panel does NOT use the native settings wire (see README, "host
 * boundary"): the api-proxy serve-list (`WEB_SETTINGS_NAMESPACES`) has no
 * third-party extension point, so an unlisted namespace answers
 * `settings-not-exposed`. The panel reads/writes through the plugin's own
 * `/graycode` RPC channel instead.
 */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  CHANNEL_TYPES,
  DIAGNOSTIC_SEVERITIES,
  TOOL_MODES,
} from '../shared/defaults.ts'
import type { GrayCodeConfig } from '../shared/config.ts'

/** Settings namespace owned by the Gray Code plugin (`graycode:` in settings.yaml). */
export const GRAYCODE_SETTINGS_NAMESPACE: SettingsNamespace = settingsNamespace('graycode')

const select = <T extends readonly string[]>(values: T) => z.union([...values])

const channelSchema = z.object({
  id: z.string().required(),
  name: z.string().required(),
  type: select(CHANNEL_TYPES).default('openai'),
  enabled: z.boolean().default(true),
  description: z.string(),
  baseUrl: z.string(),
  apiKey: z.string().role('secret'),
  model: z.string(),
  apiVersion: z.string(),
  timeout: z.number().step(1).min(0),
  maxContextTokens: z.number().step(1).min(0),
  preferStream: z.boolean(),
  toolMode: select(TOOL_MODES),
  temperature: z.number().step(0.01).min(0),
  maxOutputTokens: z.number().step(1).min(1),
  topP: z.number().step(0.01).min(0).max(1),
  topK: z.number().step(1).min(1),
})

const mcpServerSchema = z.object({
  id: z.string().required(),
  name: z.string().required(),
  description: z.string(),
  transport: select(['stdio', 'sse', 'streamable-http'] as const).default('stdio'),
  command: z.string(),
  args: z.array(z.string()).default([]),
  url: z.string(),
  env: z.dict(z.string()).default({}),
  enabled: z.boolean().default(true),
  autoConnect: z.boolean().default(false),
  timeout: z.number().step(1).min(0).default(30000),
})

const subagentSchema = z.object({
  id: z.string().required(),
  name: z.string().required(),
  description: z.string(),
  systemPrompt: z.string(),
  enabled: z.boolean().default(true),
  maxIterations: z.number().step(1).min(1),
  maxRuntimeSeconds: z.number().step(1).min(0),
})

const tokenCountProviderSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().default(''),
  apiKey: z.string().role('secret'),
  model: z.string().default(''),
})

const tokenCountSchema = z.object({
  gemini: tokenCountProviderSchema,
  'gemini-interactions': tokenCountProviderSchema,
  openai: tokenCountProviderSchema,
  anthropic: tokenCountProviderSchema,
  'openai-responses': tokenCountProviderSchema,
})

export const GrayCodeSchema: z<GrayCodeConfig> = z.object({
  activeChannelId: z.string().default(''),
  channels: z.array(channelSchema).default([]),
  defaultToolMode: select(TOOL_MODES).default('function_call'),
  maxToolIterations: z.number().step(1).min(-1).default(200),
  toolsEnabled: z.dict(z.boolean()).default({}),
  toolAutoExec: z.dict(z.boolean()).default({}),
  mcpServers: z.array(mcpServerSchema).default([]),
  checkpoint: z.object({
    enabled: z.boolean().default(true),
    maxCheckpoints: z.number().step(1).min(-1).default(-1),
  }),
  summarize: z.object({
    keepRecentRounds: z.number().step(1).min(0).default(2),
    keepRecentTokens: z.union([z.number().step(1).min(0), z.string()]).default('50%'),
    useSeparateModel: z.boolean().default(false),
    summarizeChannelId: z.string().default(''),
    summarizeModelId: z.string().default(''),
    maxAutoSummarizeAttemptsPerTurn: z.number().step(1).min(1).max(5).default(2),
    summarizeMaxInputRatio: z.number().step(0.05).min(0.05).max(0.95).default(0.5),
  }),
  imageGen: z.object({
    url: z.string().default('https://generativelanguage.googleapis.com/v1beta'),
    apiKey: z.string().role('secret'),
    model: z.string().default('gemini-3-pro-image-preview'),
    maxBatchTasks: z.number().step(1).min(1).default(5),
    maxImagesPerTask: z.number().step(1).min(1).default(1),
    returnImageToAI: z.boolean().default(false),
  }),
  context: z.object({
    includeWorkspaceFiles: z.boolean().default(true),
    maxFileDepth: z.number().step(1).min(-1).default(2),
    includeOpenTabs: z.boolean().default(true),
    maxOpenTabs: z.number().step(1).min(-1).default(20),
    includeActiveEditor: z.boolean().default(true),
    diagnostics: z.object({
      enabled: z.boolean().default(false),
      includeSeverities: z.array(select(DIAGNOSTIC_SEVERITIES.map(s => s.value)))
        .default(['error', 'warning']),
      workspaceOnly: z.boolean().default(true),
      openFilesOnly: z.boolean().default(false),
      maxDiagnosticsPerFile: z.number().step(1).min(1).default(10),
      maxFiles: z.number().step(1).min(1).default(20),
    }),
  }),
  prompt: z.object({
    currentModeId: z.string().default('code'),
    template: z.string().default(''),
    dynamicTemplateEnabled: z.boolean().default(true),
    dynamicTemplate: z.string().default(''),
    customPrefix: z.string().default(''),
    customSuffix: z.string().default(''),
  }),
  tokenCount: tokenCountSchema,
  sound: z.object({
    enabled: z.boolean().default(false),
    volume: z.number().step(1).min(0).max(100).default(60),
    cooldownMs: z.number().step(1).min(0).max(60000).default(800),
    theme: select(['beep', 'soft'] as const).default('beep'),
    cues: z.object({
      warning: z.boolean().default(true),
      error: z.boolean().default(true),
      taskComplete: z.boolean().default(true),
      taskError: z.boolean().default(true),
      subagentWarning: z.boolean().default(true),
      subagentError: z.boolean().default(true),
      subagentTaskComplete: z.boolean().default(true),
      subagentTaskError: z.boolean().default(true),
    }),
  }),
  appearance: z.object({
    theme: select(['light', 'dark', 'auto'] as const).default('auto'),
    language: select(['auto', 'zh-CN', 'en', 'ja'] as const).default('auto'),
    smoothStreaming: select(['off', 'smooth', 'balanced', 'silky'] as const).default('balanced'),
    splashEnabled: z.boolean().default(true),
    tpsBarEnabled: z.boolean().default(true),
    selectionContextEnabled: z.boolean().default(true),
    loadingText: z.string().default(''),
  }),
  memory: z.object({
    enabled: z.boolean().default(true),
    wakeLines: z.number().step(1).min(0).default(96),
    entryChars: z.number().step(1).min(0).default(280),
    partChars: z.number().step(1).min(0).default(20000),
    partLines: z.number().step(1).min(0).default(500),
  }),
  subagents: z.object({
    agents: z.array(subagentSchema).default([]),
    maxConcurrentAgents: z.number().step(1).min(-1).default(3),
    failureModeAfterRetries: select(['fail_parent_tool', 'wait_for_monitor_action'] as const)
      .default('fail_parent_tool'),
    generalWorkerEnabled: z.boolean().default(true),
    defaultMaxIterations: z.number().step(1).min(1).default(80),
    queueTimeoutSeconds: z.number().step(1).min(0).default(600),
    defaultMaxRuntimeSeconds: z.number().step(1).min(0).default(1800),
  }),
  proxy: z.object({
    enabled: z.boolean().default(false),
    url: z.string(),
  }),
  general: z.object({
    checkForUpdates: z.boolean().default(true),
    updateChannel: select(['stable', 'nightly'] as const).default('stable'),
    proxy: z.object({
      enabled: z.boolean().default(false),
      url: z.string(),
    }),
    customDataPath: z.string().default(''),
  }),
})
