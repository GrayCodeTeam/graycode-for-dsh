/**
 * Gray Code settings 命名空间 schema（schemastery）。
 *
 * 所有叶子字段都带 default：空用户 section（`replace({})`）时命名空间仍能完整解析。
 * 嵌套对象不调用 `.default({})`（类型不兼容），由叶子默认值保证整体可解析。
 * apiKey 类字段标 `.role('secret')`，经 `redactSecrets` 描述时从线路上抹除。
 *
 * 命名空间 host 侧注册用于持久化（$DSH_HOME/settings.yaml 的 `graycode:` section）
 * 与 host 侧读取。浏览器面板不直接走原生 settings 线（api-proxy 的第三方命名空间
 * 白名单无扩展点，未列出的命名空间会答 `settings-not-exposed`），改经本插件的
 * `/graycode` RPC 通道读写（见 rpc.ts）。
 */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { CHANNEL_TYPES, TOOL_MODES, DIAGNOSTIC_SEVERITIES } from './defaults.ts'
import type { GrayCodeConfig } from './types.ts'

/** Gray Code 插件拥有的 settings 命名空间（settings.yaml 中 `graycode:` section）。 */
export const GRAYCODE_SETTINGS_NAMESPACE: SettingsNamespace = settingsNamespace('graycode')

/** 把字符串字面量数组转成 string union schema。 */
const select = <T extends readonly string[]>(values: T) => z.union([...values])

const channelSchema = z.object({
  id: z.string().default(''),
  name: z.string().default(''),
  type: select(CHANNEL_TYPES).default('openai'),
  enabled: z.boolean().default(true),
  description: z.string().default(''),
  baseUrl: z.string().default(''),
  apiKey: z.string().role('secret').default(''),
  model: z.string().default(''),
  apiVersion: z.string().default(''),
  timeout: z.number().step(1).min(0).default(60000),
  maxContextTokens: z.number().step(1).min(0).default(0),
  preferStream: z.boolean().default(false),
  toolMode: select(TOOL_MODES).default('function_call'),
  temperature: z.number().step(0.01).min(0).default(0),
  maxOutputTokens: z.number().step(1).min(1).default(1),
  topP: z.number().step(0.01).min(0).max(1).default(1),
  topK: z.number().step(1).min(1).default(1),
})

const mcpServerSchema = z.object({
  id: z.string().default(''),
  name: z.string().default(''),
  description: z.string().default(''),
  transport: select(['stdio', 'sse', 'streamable-http'] as const).default('stdio'),
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  url: z.string().default(''),
  env: z.dict(z.string()).default({}),
  enabled: z.boolean().default(true),
  autoConnect: z.boolean().default(false),
  timeout: z.number().step(1).min(0).default(30000),
})

const subagentSchema = z.object({
  id: z.string().default(''),
  name: z.string().default(''),
  description: z.string().default(''),
  systemPrompt: z.string().default(''),
  enabled: z.boolean().default(true),
  maxIterations: z.number().step(1).min(1).default(20),
  maxRuntimeSeconds: z.number().step(1).min(0).default(300),
})

const tokenCountProviderSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().default(''),
  apiKey: z.string().role('secret').default(''),
  model: z.string().default(''),
})

// tokenCount 用显式对象（不用 Object.fromEntries）：
// fromEntries 推断不出逐 provider 的字面量 key，`z<GrayCodeConfig>` 标注会失配。
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
    apiKey: z.string().role('secret').default(''),
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
      includeSeverities: z
        .array(select(DIAGNOSTIC_SEVERITIES.map((s) => s.value)))
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
    url: z.string().default(''),
  }),
  general: z.object({
    checkForUpdates: z.boolean().default(true),
    updateChannel: select(['stable', 'nightly'] as const).default('stable'),
    proxy: z.object({
      enabled: z.boolean().default(false),
      url: z.string().default(''),
    }),
    customDataPath: z.string().default(''),
  }),
})
