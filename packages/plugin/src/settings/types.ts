/**
 * Gray Code 设置文档类型模型 —— Host 侧 schema、默认值与 /graycode 通道的共享契约。
 *
 * 结构复刻 Gray-Code `GlobalSettings` 子集，按设置面板分类对齐：
 * 渠道 / 工具 / 自动执行 / MCP / 子代理 / 存档点 / 总结 / 图像生成 / 上下文 /
 * 提示词 / Token 计数 / 通知系统 / 外观 / 记忆 / 通用。
 */

/** 模型渠道/provider 家族（与 Gray-Code 一致）。 */
export type ChannelType =
  | 'gemini'
  | 'gemini-interactions'
  | 'openai'
  | 'anthropic'
  | 'openai-responses'

/** 渠道向模型暴露工具的方式。 */
export type ToolMode = 'function_call' | 'xml' | 'json'

/** 一个模型渠道（Gray-Code「渠道」）。 */
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

/** 一个 MCP server 定义（Gray-Code `McpServerConfig` 对齐）。 */
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

/** 一个子代理定义（Gray-Code `subagents.agents[]` 对齐）。 */
export interface SubagentConfig {
  id: string
  name: string
  description?: string
  systemPrompt?: string
  enabled: boolean
  maxIterations?: number
  maxRuntimeSeconds?: number
}

/** 子代理重试耗尽后的失败处理方式。 */
export type SubagentFailureMode = 'fail_parent_tool' | 'wait_for_monitor_action'

/** 存档点页（Gray-Code `checkpoint` 对齐，简化）。 */
export interface CheckpointConfig {
  enabled: boolean
  maxCheckpoints: number
}

/** 总结页（Gray-Code `summarize` 对齐）。 */
export interface SummarizeConfig {
  keepRecentRounds: number
  keepRecentTokens: number | string
  useSeparateModel: boolean
  summarizeChannelId: string
  summarizeModelId: string
  maxAutoSummarizeAttemptsPerTurn: number
  summarizeMaxInputRatio: number
}

/** 图像生成页（Gray-Code `generate_image` 对齐）。 */
export interface ImageGenConfig {
  url: string
  apiKey: string
  model: string
  maxBatchTasks: number
  maxImagesPerTask: number
  returnImageToAI: boolean
}

/** 上下文感知页（Gray-Code `context_awareness` 对齐）。 */
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

/** 提示词页（Gray-Code `system_prompt` 对齐，简化）。 */
export interface PromptConfig {
  currentModeId: string
  template: string
  dynamicTemplateEnabled: boolean
  dynamicTemplate: string
  customPrefix: string
  customSuffix: string
}

/** Token 计数页：每个 provider 家族一个 section。 */
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

/** 通知系统页（Gray-Code `ui.sound` 对齐）。 */
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

/** 外观页（Gray-Code `ui.appearance` 对齐）。 */
export interface AppearanceConfig {
  theme: 'light' | 'dark' | 'auto'
  language: 'auto' | 'zh-CN' | 'en' | 'ja'
  smoothStreaming: 'off' | 'smooth' | 'balanced' | 'silky'
  splashEnabled: boolean
  tpsBarEnabled: boolean
  selectionContextEnabled: boolean
  loadingText: string
}

/** 永久记忆页（Gray-Code `memory` 对齐）。 */
export interface MemoryConfig {
  enabled: boolean
  wakeLines: number
  entryChars: number
  partChars: number
  partLines: number
}

/** 子代理页（Gray-Code `subagents` 对齐）。 */
export interface SubagentsConfig {
  agents: SubagentConfig[]
  maxConcurrentAgents: number
  failureModeAfterRetries: SubagentFailureMode
  generalWorkerEnabled: boolean
  defaultMaxIterations: number
  queueTimeoutSeconds: number
  defaultMaxRuntimeSeconds: number
}

/** 代理页（Gray-Code `general.proxy` 对齐）。 */
export interface ProxyConfig {
  enabled: boolean
  url?: string
}

/** 通用页（Gray-Code `general` 对齐）。 */
export interface GeneralConfig {
  checkForUpdates: boolean
  updateChannel: 'stable' | 'nightly'
  proxy: ProxyConfig
  customDataPath: string
}

/** 本插件拥有的完整 Gray Code 设置文档。 */
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

/** 顶层 key 的浅补丁（settings update 的载荷形状）。 */
export type GrayCodePatch = { [K in keyof GrayCodeConfig]?: GrayCodeConfig[K] }
