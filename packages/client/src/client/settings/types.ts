/**
 * Gray Code 设置面板的配置模型 — 结构性镜像。
 *
 * 面板数据不走 DSH 原生 settings 传输（第三方 namespace 命中 api-proxy 白名单
 * `settings-not-exposed`），而是走插件自定义 `/graycode` Connection RPC 通道。
 * 宿主侧拥有权威 schema 与持久化（`$DSH_HOME/settings.yaml`）；本目录不 import
 * `@graycode/dsh-plugin`（跨包值导入被 bundle 纯度门禁止），只在这里镜像
 * 配置文档的形状——真实宿主视图天然满足该结构，无需适配层（与
 * settingsContribution/types.ts 同一先例）。
 *
 * 形状对齐 Gray-Code 的 `GlobalSettings` 子集，按面板的 17 个分类组织：
 * channel / tools / autoExec / mcp / subagents / checkpoint / summarize /
 * imageGen / dependencies / context / prompt / tokenCount / sound /
 * appearance / memory / general / usage。
 */

/** 渠道/提供商家族（Gray-Code 对齐）。 */
export type ChannelType =
  | 'gemini'
  | 'gemini-interactions'
  | 'openai'
  | 'anthropic'
  | 'openai-responses'

/** 渠道向模型暴露工具的方式。 */
export type ToolMode = 'function_call' | 'xml' | 'json'

/** 一条模型渠道（Gray-Code「渠道」）。 */
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

/** 一台 MCP 服务器（Gray-Code `McpServerConfig` 对齐）。 */
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

/** 子代理重试耗尽后的处理方式。 */
export type SubagentFailureMode = 'fail_parent_tool' | 'wait_for_monitor_action'

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

/** 诊断信息（Gray-Code `context_awareness` 对齐）。 */
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

/** 图像生成页（Gray-Code `generate_image` 对齐）。 */
export interface ImageGenConfig {
  url: string
  apiKey: string
  model: string
  maxBatchTasks: number
  maxImagesPerTask: number
  returnImageToAI: boolean
}

/** Token 计数页：每家提供商一个区块。 */
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

/** 存档点页（Gray-Code `checkpoint` 对齐，简化）。 */
export interface CheckpointConfig {
  enabled: boolean
  maxCheckpoints: number
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

/** 通用页（Gray-Code `general` 对齐）。 */
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

/** 顶层键的浅补丁（settings update 载荷）。 */
export type GrayCodePatch = { [K in keyof GrayCodeConfig]?: GrayCodeConfig[K] }

/** 表单层使用的递归 Partial。 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}
