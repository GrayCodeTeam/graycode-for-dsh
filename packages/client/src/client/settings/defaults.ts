/**
 * Gray Code 设置面板的默认值注册表（宿主 `base` 层的浏览器侧镜像）。
 *
 * 面板在首次 `config.get` 成功前，用这里的默认值兜底渲染；宿主侧的权威
 * 默认值在 plugin 包中（本目录不 import 跨包值——见 types.ts 的结构镜像
 * 说明）。数值移植自 Gray-Code 的 `GlobalSettings` 默认值，让面板打开时的
 * 状态与 Gray-Code 用户所见一致。
 */

import type {
  ChannelConfig,
  ChannelType,
  GrayCodeConfig,
  McpServerConfig,
  SubagentConfig,
  TokenCountProviderConfig,
  ToolMode,
} from './types.ts'

/** 渠道/提供商家族（与分类页 options 对齐）。 */
export const CHANNEL_TYPES: readonly ChannelType[] = [
  'gemini',
  'gemini-interactions',
  'openai',
  'anthropic',
  'openai-responses',
]

/** 工具调用模式。 */
export const TOOL_MODES: readonly ToolMode[] = ['function_call', 'xml', 'json']

/** 工具页列出的内置工具集（Gray-Code 内置工具全集）。 */
export const KNOWN_TOOLS: readonly string[] = [
  'read_file',
  'write_file',
  'list_files',
  'find_files',
  'search_in_files',
  'apply_diff',
  'delete_file',
  'execute_command',
  'generate_image',
  'checkpoint',
  'summarize',
  'context_awareness',
  'pinned_files',
  'skills',
  'subagents',
  'mcp_tools',
  'todo',
  'goal',
  'web_search',
  'plan',
  'design',
  'progress',
  'review',
]

/** 自动执行页可配置「需确认」的工具。 */
export const CONFIRMABLE_TOOLS: readonly string[] = [
  'delete_file',
  'execute_command',
  'apply_diff',
  'write_file',
  'generate_image',
  'subagents',
  'mcp_tools',
]

/** Gray-Code 默认：只有 delete_file 与 execute_command 需要确认。 */
export const DEFAULT_TOOL_AUTO_EXEC: Record<string, boolean> = {
  delete_file: false,
  execute_command: false,
}

/** Token 计数页的提供商顺序。 */
export const TOKEN_COUNT_PROVIDERS: readonly (keyof GrayCodeConfig['tokenCount'])[] = [
  'gemini',
  'gemini-interactions',
  'openai',
  'anthropic',
  'openai-responses',
]

/** 每家提供商的 Token 计数默认配置。 */
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

/** 提示词页的预设模式。 */
export const PROMPT_MODES: readonly { id: string; labelKey: string }[] = [
  { id: 'code', labelKey: 'options.promptMode.code' },
  { id: 'design', labelKey: 'options.promptMode.design' },
  { id: 'plan', labelKey: 'options.promptMode.plan' },
  { id: 'ask', labelKey: 'options.promptMode.ask' },
  { id: 'review', labelKey: 'options.promptMode.review' },
]

/** 诊断严重级别多选。 */
export const DIAGNOSTIC_SEVERITIES: readonly { value: string; labelKey: string }[] = [
  { value: 'error', labelKey: 'options.severity.error' },
  { value: 'warning', labelKey: 'options.severity.warning' },
  { value: 'information', labelKey: 'options.severity.information' },
  { value: 'hint', labelKey: 'options.severity.hint' },
]

/** 完整默认配置（面板兜底形状）。 */
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
    url: undefined,
  },
  general: {
    checkForUpdates: true,
    updateChannel: 'stable',
    proxy: {
      enabled: false,
      url: undefined,
    },
    customDataPath: '',
  },
}

/** 新建渠道的初始形状（id 由 ObjectListEditor 补全）。 */
export function createEmptyChannel(name = 'New Channel'): ChannelConfig {
  return {
    id: '',
    name,
    type: 'openai',
    enabled: true,
    baseUrl: undefined,
    apiKey: undefined,
    model: undefined,
  }
}

/** 新建 MCP 服务器的初始形状。 */
export function createEmptyMcpServer(name = 'New MCP Server'): McpServerConfig {
  return {
    id: '',
    name,
    transport: 'stdio',
    command: undefined,
    args: [],
    enabled: true,
    autoConnect: false,
    timeout: 30000,
  }
}

/** 新建子代理的初始形状。 */
export function createEmptySubagent(name = 'New Sub-Agent'): SubagentConfig {
  return {
    id: '',
    name,
    description: undefined,
    systemPrompt: undefined,
    enabled: true,
    maxIterations: 20,
    maxRuntimeSeconds: 300,
  }
}
