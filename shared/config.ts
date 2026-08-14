/**
 * Gray Code configuration model — the shared contract between the DSH Host
 * plugin (schema + persistence) and the browser settings panel.
 *
 * The shape mirrors Gray-Code's `GlobalSettings` subset, grouped by the
 * 17 settings categories the panel aligns to:
 * channel / tools / autoExec / mcp / subagents / checkpoint / summarize /
 * imageGen / dependencies / context / prompt / tokenCount / sound /
 * appearance / memory / general / usage.
 */

/** Model channel/provider families (Gray-Code parity). */
export type ChannelType =
  | 'gemini'
  | 'gemini-interactions'
  | 'openai'
  | 'anthropic'
  | 'openai-responses'

/** How a channel exposes tools to the model. */
export type ToolMode = 'function_call' | 'xml' | 'json'

/** One model channel (a Gray-Code "渠道"). */
export interface ChannelConfig {
  id: string
  name: string
  type: ChannelType
  enabled: boolean
  description?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  apiVersion?: string
  timeout?: number
  maxContextTokens?: number
  preferStream?: boolean
  toolMode?: ToolMode
  temperature?: number
  maxOutputTokens?: number
  topP?: number
  topK?: number
}

/** One MCP server definition (Gray-Code `McpServerConfig` parity). */
export interface McpServerConfig {
  id: string
  name: string
  description?: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  enabled: boolean
  autoConnect?: boolean
  timeout?: number
}

/** One subagent definition (Gray-Code `subagents.agents[]` parity). */
export interface SubagentConfig {
  id: string
  name: string
  description?: string
  systemPrompt?: string
  enabled: boolean
  maxIterations?: number
  maxRuntimeSeconds?: number
}

/** Failure handling after a subagent exhausts its retries. */
export type SubagentFailureMode = 'fail_parent_tool' | 'wait_for_monitor_action'

/** Summarize page (Gray-Code `summarize` parity). */
export interface SummarizeConfig {
  keepRecentRounds: number
  keepRecentTokens: number | string
  useSeparateModel: boolean
  summarizeChannelId: string
  summarizeModelId: string
  maxAutoSummarizeAttemptsPerTurn: number
  summarizeMaxInputRatio: number
}

/** Context-awareness page (Gray-Code `context_awareness` parity). */
export interface DiagnosticsConfig {
  enabled: boolean
  includeSeverities: string[]
  workspaceOnly: boolean
  openFilesOnly: boolean
  maxDiagnosticsPerFile: number
  maxFiles: number
}

export interface ContextConfig {
  includeWorkspaceFiles: boolean
  maxFileDepth: number
  includeOpenTabs: boolean
  maxOpenTabs: number
  includeActiveEditor: boolean
  diagnostics: DiagnosticsConfig
}

/** Prompt page (Gray-Code `system_prompt` parity, simplified). */
export interface PromptConfig {
  currentModeId: string
  template: string
  dynamicTemplateEnabled: boolean
  dynamicTemplate: string
  customPrefix: string
  customSuffix: string
}

/** Image-generation page (Gray-Code `generate_image` parity). */
export interface ImageGenConfig {
  url: string
  apiKey: string
  model: string
  maxBatchTasks: number
  maxImagesPerTask: number
  returnImageToAI: boolean
}

/** Token-count page: one section per provider family. */
export interface TokenCountProviderConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
}

export interface TokenCountConfig {
  gemini: TokenCountProviderConfig
  'gemini-interactions': TokenCountProviderConfig
  openai: TokenCountProviderConfig
  anthropic: TokenCountProviderConfig
  'openai-responses': TokenCountProviderConfig
}

/** Notification-system page (Gray-Code `ui.sound` parity). */
export interface SoundCuesConfig {
  warning: boolean
  error: boolean
  taskComplete: boolean
  taskError: boolean
  subagentWarning: boolean
  subagentError: boolean
  subagentTaskComplete: boolean
  subagentTaskError: boolean
}

export interface SoundConfig {
  enabled: boolean
  volume: number
  cooldownMs: number
  theme: 'beep' | 'soft'
  cues: SoundCuesConfig
}

/** Appearance page (Gray-Code `ui.appearance` parity). */
export interface AppearanceConfig {
  theme: 'light' | 'dark' | 'auto'
  language: 'auto' | 'zh-CN' | 'en' | 'ja'
  smoothStreaming: 'off' | 'smooth' | 'balanced' | 'silky'
  splashEnabled: boolean
  tpsBarEnabled: boolean
  selectionContextEnabled: boolean
  loadingText: string
}

/** Permanent-memory page (Gray-Code `memory` parity). */
export interface MemoryConfig {
  enabled: boolean
  wakeLines: number
  entryChars: number
  partChars: number
  partLines: number
}

/** Checkpoint page (Gray-Code `checkpoint` parity, simplified). */
export interface CheckpointConfig {
  enabled: boolean
  maxCheckpoints: number
}

/** Subagents page (Gray-Code `subagents` parity). */
export interface SubagentsConfig {
  agents: SubagentConfig[]
  maxConcurrentAgents: number
  failureModeAfterRetries: SubagentFailureMode
  generalWorkerEnabled: boolean
  defaultMaxIterations: number
  queueTimeoutSeconds: number
  defaultMaxRuntimeSeconds: number
}

/** General page (Gray-Code `general` parity). */
export interface ProxyConfig {
  enabled: boolean
  url?: string
}

export interface GeneralConfig {
  checkForUpdates: boolean
  updateChannel: 'stable' | 'nightly'
  proxy: ProxyConfig
  customDataPath: string
}

/** The full Gray Code settings document owned by this plugin. */
export interface GrayCodeConfig {
  activeChannelId: string
  channels: ChannelConfig[]
  defaultToolMode: ToolMode
  maxToolIterations: number
  toolsEnabled: Record<string, boolean>
  toolAutoExec: Record<string, boolean>
  mcpServers: McpServerConfig[]
  checkpoint: CheckpointConfig
  summarize: SummarizeConfig
  imageGen: ImageGenConfig
  context: ContextConfig
  prompt: PromptConfig
  tokenCount: TokenCountConfig
  sound: SoundConfig
  appearance: AppearanceConfig
  memory: MemoryConfig
  subagents: SubagentsConfig
  proxy: ProxyConfig
  general: GeneralConfig
}

/** Shallow patch over top-level config keys (the settings update payload). */
export type GrayCodePatch = { [K in keyof GrayCodeConfig]?: GrayCodeConfig[K] }

/** Recursive partial used by the browser form layer. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}
