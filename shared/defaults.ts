/**
 * Default values for the Gray Code settings document. The Host plugin uses
 * this object as the settings `base` layer; the browser panel uses it as the
 * fallback shape before the first successful `config.get`.
 *
 * Values are ported from Gray-Code's `GlobalSettings` defaults so the panel
 * opens in a state a Gray-Code user recognizes.
 */

import type {
  ChannelConfig,
  ChannelType,
  GrayCodeConfig,
  McpServerConfig,
  SubagentConfig,
  TokenCountProviderConfig,
  ToolMode,
} from './config.ts'

export const CHANNEL_TYPES: readonly ChannelType[] = [
  'gemini',
  'gemini-interactions',
  'openai',
  'anthropic',
  'openai-responses',
]

export const TOOL_MODES: readonly ToolMode[] = ['function_call', 'xml', 'json']

/** Tools listed on the Tools page (Gray-Code's builtin tool set). */
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

/** Tools that can require confirmation before running (autoExec page). */
export const CONFIRMABLE_TOOLS: readonly string[] = [
  'delete_file',
  'execute_command',
  'apply_diff',
  'write_file',
  'generate_image',
  'subagents',
  'mcp_tools',
]

/** Gray-Code default: only delete_file and execute_command confirm by default. */
export const DEFAULT_TOOL_AUTO_EXEC: Record<string, boolean> = {
  delete_file: false,
  execute_command: false,
}

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

export const PROMPT_MODES: readonly { id: string; labelKey: string }[] = [
  { id: 'code', labelKey: 'options.promptMode.code' },
  { id: 'design', labelKey: 'options.promptMode.design' },
  { id: 'plan', labelKey: 'options.promptMode.plan' },
  { id: 'ask', labelKey: 'options.promptMode.ask' },
  { id: 'review', labelKey: 'options.promptMode.review' },
]

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
