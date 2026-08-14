/**
 * Gray Code 设置文档默认值 —— 作为 settings 注册的 `base` 层（schema 默认值之下、
 * 用户 section 之上）。取值移植自 Gray-Code `GlobalSettings` 默认值，面板打开时
 * 即为 Gray-Code 用户熟悉的初始状态。
 */

import type {
  ChannelType,
  GrayCodeConfig,
  TokenCountProviderConfig,
  ToolMode,
} from './types.ts'

/** 模型渠道/provider 家族（schema 的 union 取值来源）。 */
export const CHANNEL_TYPES: readonly ChannelType[] = [
  'gemini',
  'gemini-interactions',
  'openai',
  'anthropic',
  'openai-responses',
]

/** 工具暴露模式（schema 的 union 取值来源）。 */
export const TOOL_MODES: readonly ToolMode[] = ['function_call', 'xml', 'json']

/** Gray-Code 默认：仅 delete_file 与 execute_command 需要确认。 */
export const DEFAULT_TOOL_AUTO_EXEC: Record<string, boolean> = {
  delete_file: false,
  execute_command: false,
}

/** Token 计数 provider 家族清单（前端渲染顺序与 schema 显式字段对齐）。 */
export const TOKEN_COUNT_PROVIDERS: readonly (keyof GrayCodeConfig['tokenCount'])[] = [
  'gemini',
  'gemini-interactions',
  'openai',
  'anthropic',
  'openai-responses',
]

export const TOKEN_COUNT_DEFAULTS: Record<keyof GrayCodeConfig['tokenCount'], TokenCountProviderConfig> = {
  gemini: {
    enabled: false,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:countTokens?key={key}',
    apiKey: '',
    model: 'gemini-2.5-pro',
  },
  'gemini-interactions': {
    enabled: false,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:countTokens?key={key}',
    apiKey: '',
    model: 'gemini-2.5-pro',
  },
  openai: {
    enabled: false,
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'gpt-5',
  },
  anthropic: {
    enabled: false,
    baseUrl: 'https://api.anthropic.com/v1/messages/count_tokens',
    apiKey: '',
    model: 'claude-sonnet-4-5',
  },
  'openai-responses': {
    enabled: false,
    baseUrl: 'https://api.openai.com/v1/responses/input_tokens',
    apiKey: '',
    model: 'gpt-5',
  },
}

/** 诊断严重级别清单（schema 的 array union 取值来源）。 */
export const DIAGNOSTIC_SEVERITIES: readonly { value: string; labelKey: string }[] = [
  { value: 'error', labelKey: 'options.severity.error' },
  { value: 'warning', labelKey: 'options.severity.warning' },
  { value: 'information', labelKey: 'options.severity.information' },
  { value: 'hint', labelKey: 'options.severity.hint' },
]

export const DEFAULTS: GrayCodeConfig = {
  activeChannelId: '',
  channels: [],
  defaultToolMode: 'function_call',
  maxToolIterations: 200,
  toolsEnabled: {},
  toolAutoExec: { ...DEFAULT_TOOL_AUTO_EXEC },
  mcpServers: [],
  checkpoint: {
    enabled: true,
    maxCheckpoints: -1,
  },
  summarize: {
    keepRecentRounds: 2,
    keepRecentTokens: '50%',
    useSeparateModel: false,
    summarizeChannelId: '',
    summarizeModelId: '',
    maxAutoSummarizeAttemptsPerTurn: 2,
    summarizeMaxInputRatio: 0.5,
  },
  imageGen: {
    url: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: '',
    model: 'gemini-3-pro-image-preview',
    maxBatchTasks: 5,
    maxImagesPerTask: 1,
    returnImageToAI: false,
  },
  context: {
    includeWorkspaceFiles: true,
    maxFileDepth: 2,
    includeOpenTabs: true,
    maxOpenTabs: 20,
    includeActiveEditor: true,
    diagnostics: {
      enabled: false,
      includeSeverities: ['error', 'warning'],
      workspaceOnly: true,
      openFilesOnly: false,
      maxDiagnosticsPerFile: 10,
      maxFiles: 20,
    },
  },
  prompt: {
    currentModeId: 'code',
    template: '',
    dynamicTemplateEnabled: true,
    dynamicTemplate: '',
    customPrefix: '',
    customSuffix: '',
  },
  tokenCount: { ...TOKEN_COUNT_DEFAULTS },
  sound: {
    enabled: false,
    volume: 60,
    cooldownMs: 800,
    theme: 'beep',
    cues: {
      warning: true,
      error: true,
      taskComplete: true,
      taskError: true,
      subagentWarning: true,
      subagentError: true,
      subagentTaskComplete: true,
      subagentTaskError: true,
    },
  },
  appearance: {
    theme: 'auto',
    language: 'auto',
    smoothStreaming: 'balanced',
    splashEnabled: true,
    tpsBarEnabled: true,
    selectionContextEnabled: true,
    loadingText: '',
  },
  memory: {
    enabled: true,
    wakeLines: 96,
    entryChars: 280,
    partChars: 20000,
    partLines: 500,
  },
  subagents: {
    agents: [],
    maxConcurrentAgents: 3,
    failureModeAfterRetries: 'fail_parent_tool',
    generalWorkerEnabled: true,
    defaultMaxIterations: 80,
    queueTimeoutSeconds: 600,
    defaultMaxRuntimeSeconds: 1800,
  },
  proxy: {
    enabled: false,
    // 与 schema 叶子默认值保持一致（'' = 未设置），保证 base 层不引入 undefined
    url: '',
  },
  general: {
    checkForUpdates: true,
    updateChannel: 'stable',
    proxy: {
      enabled: false,
      url: '',
    },
    customDataPath: '',
  },
}
