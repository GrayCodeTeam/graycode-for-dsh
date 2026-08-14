/**
 * GrayCode - migration legacy settings 只读解析器
 *
 * 解析 graycode-settings.json / limcode-settings.json（§4，docs/legacy-format.md）。
 * 关键职责：
 * - 版本校验（version === '1.0'，否则 SETTINGS_UNSUPPORTED_VERSION）；
 * - LimCode 旧格式兼容：limcodeVersion → graycodeVersion；`limcode.*` 键 → `graycode.*`；
 *   skills source user-limcode/project-limcode → user-graycode/project-graycode；
 * - 脱敏（§7.2.8「凭据默认不迁移」）：明文 secret 只生成「重新录入」占位；
 *   apiKey / token / secret / authorization / env 值 / customHeaders 值一律替换；
 *   url query 参数（?key=xxx）与 MCP transport command/args（--token=xxx）同样脱敏；
 * - 机器作用域键（proxy、storagePath）跳过（§7.2.1/§4.3）；
 * - channel provider 不受支持 → disabled-draft 标记（§7.5）；
 * - 渠道保留可映射字段（models/timeout/retry* / customHeaders/toolMode/options/
 *   optionsEnabled）供 channelMapper 生成 DSH llm-pi-ai provider profile；
 *   无 DSH 配置面等价的字段进 unmigratedChannelFields 报告。
 */

import { MIGRATION_ERROR_CODES } from '../../domain/types.ts'
import {
  REDACTED_PLACEHOLDER,
  isSupportedChannelType,
  listUnmigratedChannelFields,
  type ChannelMappingSource,
} from '../../domain/channelMapper.ts'

export { REDACTED_PLACEHOLDER } from '../../domain/channelMapper.ts'

export interface ParsedChannelModel {
  id: string
  name?: string
  contextWindow?: number
  /** 归一化自旧字段 maxOutputTokens（channelMapper 的 maxTokens 语义） */
  maxTokens?: number
}

export interface ParsedChannel {
  id: string
  type: string
  name?: string
  model?: string
  /** 已脱敏（url query 凭据 → [REDACTED]）；缺省 = 源未提供 */
  url?: string
  /** 该渠道的 apiKey 是否被脱敏（需在 DSH credentials 重新录入） */
  apiKeyRedacted: boolean
  /** provider 是否受支持；false → disabled-draft（§7.5） */
  providerSupported: boolean
  enabled: boolean
  /** 可映射字段（供 channelMapper；值已脱敏） */
  models?: ParsedChannelModel[]
  timeout?: number
  retryEnabled?: boolean
  retryCount?: number
  retryInterval?: number
  /** 敏感头值已脱敏为占位；非敏感值原样保留（mapper 明文写入 headers 仅建议非敏感值） */
  customHeaders?: Record<string, string>
  toolMode?: string
  options?: Record<string, unknown>
  optionsEnabled?: Record<string, boolean>
  /** 该渠道中无 DSH 配置面等价、不迁移的字段名（channelMapper 同源计算） */
  unmigratedFields: string[]
}

export interface ParsedMcpServer {
  id: string
  name?: string
  transportType?: string
  command?: string
  args: string[]
  /** env 键名（值已脱敏） */
  envKeys: string[]
  envRedacted: boolean
  /** command/args 中是否含被脱敏的 CLI 凭据（--token=xxx） */
  cliRedacted: boolean
  enabled: boolean
}

export interface ParsedSkill {
  id: string
  name: string
  source: string
  enabled: boolean
  contentLength: number
}

export interface ParsedSettingsExport {
  ok: boolean
  errorCode?: string
  errorMessage?: string
  sourceFile: string
  version: string
  graycodeVersion?: string
  limcodeMigrated: boolean
  /** 跳过未导出的机器作用域键（proxy/storagePath） */
  machineKeysSkipped: string[]
  /** 脱敏后的 vscodeSettings（键已做 limcode→graycode 映射；值无明文 secret） */
  vscodeSettings: Record<string, unknown>
  channels: ParsedChannel[]
  mcpServers: ParsedMcpServer[]
  skills: ParsedSkill[]
  /** 需在 DSH credentials 重新录入的渠道 id / MCP server id */
  credentialReentryRequired: string[]
  /** 不支持的 provider（导入为 disabled 草稿） */
  disabledDraftChannels: string[]
  /** 同名同 hash 去重的 skill 数量 */
  deduplicatedSkills: number
  /** 每渠道无 DSH 配置面等价、不迁移的字段名（temperature 等） */
  unmigratedChannelFields: Record<string, string[]>
  suggestedConfigNote: string
}

const MACHINE_KEYS = new Set(['proxy', 'storagePath'])

const SECRET_KEY_RE = /api[_-]?key|token|secret|authorization|password|credential/i

/** url query 凭据脱敏标记（保持 URL 可读；完整占位文本只用于值型字段） */
const URL_REDACTED_MARK = '[REDACTED]'

/** CLI 参数凭据脱敏标记 */
const CLI_REDACTED_MARK = '[REDACTED]'

/**
 * 匹配 `--token=xxx` / `-t-key=xxx` / `token=xxx`（裸 key=value）形式的 CLI 凭据参数
 * （键名含 secret 语义）。M5：--token=xxx 与 key=value 形态都做正则脱敏。
 */
const CLI_SECRET_ARG_RE = /^(-{0,2}[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|credential|authorization|auth)[A-Za-z0-9_-]*)=(.+)$/i

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key)
}

/** 字符串脱敏：非空且非占位符时替换 */
function redactValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  if (value.length === 0 || value === REDACTED_PLACEHOLDER) return value
  return REDACTED_PLACEHOLDER
}

/** 对象内敏感键脱敏（apiKey/customHeaders/env 等） */
function redactObjectSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactObjectSecrets)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      out[key] = redactValue(child)
    } else if (key === 'env' && child && typeof child === 'object' && !Array.isArray(child)) {
      // MCP transport env：值全部脱敏，键保留（报告只列键名）
      const env: Record<string, unknown> = {}
      for (const [envKey, envValue] of Object.entries(child as Record<string, unknown>)) {
        env[envKey] = typeof envValue === 'string' && envValue.length > 0 ? REDACTED_PLACEHOLDER : envValue
      }
      out[key] = env
    } else if (key === 'customHeaders' && child && typeof child === 'object' && !Array.isArray(child)) {
      const headers: Record<string, unknown> = {}
      for (const [headerKey, headerValue] of Object.entries(child as Record<string, unknown>)) {
        headers[headerKey] = redactValue(headerValue)
      }
      out[key] = headers
    } else {
      out[key] = redactObjectSecrets(child)
    }
  }
  return out
}

/**
 * url query 参数凭据脱敏：`?key=xxx` / `?api_key=xxx` 等敏感键的值替换为
 * [REDACTED]（键保留，结构可读）。返回是否发生脱敏。
 */
function redactUrlQueryCredentials(url: string): { value: string; redacted: boolean } {
  const qIndex = url.indexOf('?')
  if (qIndex < 0) return { value: url, redacted: false }
  const base = url.slice(0, qIndex)
  const query = url.slice(qIndex + 1)
  let redacted = false
  const parts = query.split('&').map(p => {
    const eq = p.indexOf('=')
    if (eq <= 0) return p
    const key = p.slice(0, eq)
    const value = p.slice(eq + 1)
    if (isSecretKey(key) && value.length > 0 && value !== URL_REDACTED_MARK) {
      redacted = true
      return `${key}=${URL_REDACTED_MARK}`
    }
    return p
  })
  return redacted ? { value: `${base}?${parts.join('&')}`, redacted: true } : { value: url, redacted: false }
}

/** CLI 字符串（command/args）凭据脱敏：`--token=xxx` 值替换为 [REDACTED] */
function redactCliSecrets(value: string): { value: string; redacted: boolean } {
  let redacted = false
  const next = value.replace(CLI_SECRET_ARG_RE, (_match, name: string) => {
    redacted = true
    return `${name}=${CLI_REDACTED_MARK}`
  })
  return { value: next, redacted }
}

/** command 串内嵌凭据脱敏（非整串锚定）：`node --token=xxx main.js` → 值替换 */
const CLI_EMBEDDED_SECRET_RE =
  /(-{1,2}[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|credential|authorization|auth)[A-Za-z0-9_-]*=)([^\s]+)/gi

function redactCliCommand(value: string): { value: string; redacted: boolean } {
  let redacted = false
  const next = value.replace(CLI_EMBEDDED_SECRET_RE, (_match, prefix: string) => {
    redacted = true
    return `${prefix}${CLI_REDACTED_MARK}`
  })
  return { value: next, redacted }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 渠道 models[] 归一化：maxOutputTokens → maxTokens；按 id 去重；无 id 跳过 */
function parseChannelModels(channel: Record<string, unknown>): ParsedChannelModel[] {
  const raw = Array.isArray(channel.models) ? channel.models : []
  const out: ParsedChannelModel[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const model = asRecord(item)
    const id = typeof model.id === 'string' ? model.id : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const entry: ParsedChannelModel = { id }
    if (typeof model.name === 'string' && model.name.length > 0) entry.name = model.name
    const contextWindow = typeof model.contextWindow === 'number' ? model.contextWindow : undefined
    if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) {
      entry.contextWindow = contextWindow
    }
    const maxOutputTokens =
      typeof model.maxOutputTokens === 'number' ? model.maxOutputTokens : typeof model.maxTokens === 'number' ? model.maxTokens : undefined
    if (typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
      entry.maxTokens = maxOutputTokens
    }
    out.push(entry)
  }
  return out
}

/** 渠道 customHeaders：敏感头值脱敏为占位；非敏感值原样保留 */
function parseChannelHeaders(channel: Record<string, unknown>): { headers?: Record<string, string>; hasSecret: boolean } {
  const raw = channel.customHeaders
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { hasSecret: false }
  const headers: Record<string, string> = {}
  let hasSecret = false
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue
    if (isSecretKey(key) && value.length > 0 && value !== REDACTED_PLACEHOLDER) {
      headers[key] = REDACTED_PLACEHOLDER
      hasSecret = true
    } else {
      headers[key] = value
    }
  }
  return { headers, hasSecret }
}

function parseFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 解析设置导出文件（结构见 docs/legacy-format.md §4.2） */
export function parseSettingsExport(raw: string, sourceFile: string): ParsedSettingsExport {
  const fail = (errorCode: string, errorMessage: string): ParsedSettingsExport => ({
    ok: false,
    errorCode,
    errorMessage,
    sourceFile,
    version: '',
    limcodeMigrated: false,
    machineKeysSkipped: [],
    vscodeSettings: {},
    channels: [],
    mcpServers: [],
    skills: [],
    credentialReentryRequired: [],
    disabledDraftChannels: [],
    deduplicatedSkills: 0,
    unmigratedChannelFields: {},
    suggestedConfigNote: '',
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fail(MIGRATION_ERROR_CODES.SETTINGS_PARSE_ERROR, `settings 文件不是合法 JSON: ${sourceFile}`)
  }
  const root = asRecord(parsed)
  const version = typeof root.version === 'string' ? root.version : ''
  if (version !== '1.0') {
    return fail(MIGRATION_ERROR_CODES.SETTINGS_UNSUPPORTED_VERSION, `不支持的导出版本: ${version ?? '(缺失)'}`)
  }

  // LimCode 兼容迁移（§4.2：limcodeVersion → graycodeVersion；limcode.* 键 → graycode.*）
  const limcodeMigrated = typeof root.limcodeVersion === 'string'
  const graycodeVersion =
    typeof root.graycodeVersion === 'string'
      ? root.graycodeVersion
      : typeof root.limcodeVersion === 'string'
        ? root.limcodeVersion
        : undefined

  // vscodeSettings：去 machine 键 + limcode.* → graycode.*
  const machineKeysSkipped: string[] = []
  const rawVscode = asRecord(root.vscodeSettings)
  const vscodeSettings: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rawVscode)) {
    if (MACHINE_KEYS.has(key)) {
      machineKeysSkipped.push(key)
      continue
    }
    const mappedKey = key.startsWith('limcode.') ? `graycode.${key.slice('limcode.'.length)}` : key
    vscodeSettings[mappedKey] = redactObjectSecrets(value)
  }

  // channelConfigs
  const channels: ParsedChannel[] = []
  const credentialReentryRequired: string[] = []
  const disabledDraftChannels: string[] = []
  const unmigratedChannelFields: Record<string, string[]> = {}
  const rawChannels = Array.isArray(root.channelConfigs) ? root.channelConfigs : []
  for (const item of rawChannels) {
    const channel = asRecord(item)
    const id = typeof channel.id === 'string' ? channel.id : ''
    if (!id) continue
    const type = typeof channel.type === 'string' ? channel.type : 'unknown'
    const apiKey = typeof channel.apiKey === 'string' ? channel.apiKey : ''
    const apiKeyRedacted = apiKey.length > 0 && apiKey !== REDACTED_PLACEHOLDER
    if (apiKeyRedacted) credentialReentryRequired.push(id)
    const providerSupported = isSupportedChannelType(type)
    if (!providerSupported) disabledDraftChannels.push(`${id} (${type})`)

    // url：query 参数中的凭据脱敏（?key=xxx / ?api_key=xxx）
    let url: string | undefined
    if (typeof channel.url === 'string' && channel.url.length > 0) {
      const redacted = redactUrlQueryCredentials(channel.url)
      url = redacted.value
      if (redacted.redacted) credentialReentryRequired.push(id)
    }

    // customHeaders：敏感头值脱敏；非敏感值保留（mapper 明文写入仅建议非敏感值）
    const { headers: customHeaders, hasSecret: headerSecret } = parseChannelHeaders(channel)
    if (headerSecret) credentialReentryRequired.push(id)

    const models = parseChannelModels(channel)
    const timeout = parseFiniteNumber(channel.timeout)
    const retryEnabled = typeof channel.retryEnabled === 'boolean' ? channel.retryEnabled : undefined
    const retryCount = parseFiniteNumber(channel.retryCount)
    const retryInterval = parseFiniteNumber(channel.retryInterval)
    const toolMode = typeof channel.toolMode === 'string' && channel.toolMode.length > 0 ? channel.toolMode : undefined
    const options =
      channel.options && typeof channel.options === 'object' && !Array.isArray(channel.options)
        ? { ...(channel.options as Record<string, unknown>) }
        : undefined
    const optionsEnabled =
      channel.optionsEnabled && typeof channel.optionsEnabled === 'object' && !Array.isArray(channel.optionsEnabled)
        ? { ...(channel.optionsEnabled as Record<string, boolean>) }
        : undefined

    const parsedChannel: ParsedChannel = {
      id,
      type,
      ...(typeof channel.name === 'string' && channel.name.length > 0 ? { name: channel.name } : {}),
      ...(typeof channel.model === 'string' && channel.model.length > 0 ? { model: channel.model } : {}),
      ...(url ? { url } : {}),
      apiKeyRedacted,
      providerSupported,
      enabled: channel.enabled !== false,
      ...(models.length > 0 ? { models } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(retryEnabled !== undefined ? { retryEnabled } : {}),
      ...(retryCount !== undefined ? { retryCount } : {}),
      ...(retryInterval !== undefined ? { retryInterval } : {}),
      ...(customHeaders && Object.keys(customHeaders).length > 0 ? { customHeaders } : {}),
      ...(toolMode ? { toolMode } : {}),
      ...(options ? { options } : {}),
      ...(optionsEnabled ? { optionsEnabled } : {}),
      unmigratedFields: [],
    }
    parsedChannel.unmigratedFields = listUnmigratedChannelFields(parsedChannel as ChannelMappingSource)
    unmigratedChannelFields[id] = parsedChannel.unmigratedFields
    channels.push(parsedChannel)
  }

  // mcpServers（env 脱敏；command/args 中的 --token=xxx 凭据脱敏；命令/参数保留结构）
  const mcpServers: ParsedMcpServer[] = []
  const rawMcp = Array.isArray(root.mcpServers) ? root.mcpServers : []
  for (const item of rawMcp) {
    const server = asRecord(item)
    const id = typeof server.id === 'string' ? server.id : ''
    if (!id) continue
    const transport = asRecord(server.transport)
    const env = asRecord(transport.env)
    const envKeys = Object.keys(env)
    let credentialFound = envKeys.length > 0

    let command: string | undefined
    if (typeof transport.command === 'string' && transport.command.length > 0) {
      const redacted = redactCliCommand(transport.command)
      command = redacted.value
      if (redacted.redacted) credentialFound = true
    }
    const args: string[] = []
    let cliRedacted = false
    if (Array.isArray(transport.args)) {
      for (const arg of transport.args) {
        if (typeof arg !== 'string') continue
        const redacted = redactCliSecrets(arg)
        args.push(redacted.value)
        if (redacted.redacted) cliRedacted = true
      }
    }
    if (cliRedacted) credentialFound = true
    if (credentialFound) credentialReentryRequired.push(`mcp:${id}`)

    mcpServers.push({
      id,
      ...(typeof server.name === 'string' && server.name.length > 0 ? { name: server.name } : {}),
      ...(typeof transport.type === 'string' && transport.type.length > 0 ? { transportType: transport.type } : {}),
      ...(command ? { command } : {}),
      args,
      envKeys,
      envRedacted: envKeys.length > 0,
      cliRedacted,
      enabled: server.enabled !== false,
    })
  }

  // skills（source 迁移 + 同名同 hash 去重）
  const skills: ParsedSkill[] = []
  let deduplicatedSkills = 0
  const seen = new Set<string>()
  const rawSkills = Array.isArray(root.skills) ? root.skills : []
  for (const item of rawSkills) {
    const skill = asRecord(item)
    const id = typeof skill.id === 'string' ? skill.id : ''
    const name = typeof skill.name === 'string' ? skill.name : id
    if (!id && !name) continue
    let source = typeof skill.source === 'string' ? skill.source : ''
    if (limcodeMigrated) {
      source = source.replace(/^user-limcode$/, 'user-graycode').replace(/^project-limcode$/, 'project-graycode')
    }
    const content = typeof skill.content === 'string' ? skill.content : ''
    const dedupeKey = `${name}|${content}`
    if (seen.has(dedupeKey)) {
      deduplicatedSkills += 1
      continue
    }
    seen.add(dedupeKey)
    skills.push({ id, name, source, enabled: skill.enabled !== false, contentLength: content.length })
  }

  return {
    ok: true,
    sourceFile,
    version,
    ...(graycodeVersion ? { graycodeVersion } : {}),
    limcodeMigrated,
    machineKeysSkipped,
    vscodeSettings,
    channels,
    mcpServers,
    skills,
    credentialReentryRequired,
    disabledDraftChannels,
    deduplicatedSkills,
    unmigratedChannelFields,
    suggestedConfigNote:
      '建议配置已生成供人工核对；apply 时若 DSH settings（llm-pi-ai）/ credentials 可用将直接写入（凭据重新录入，明文密钥不迁移）。',
  }
}
