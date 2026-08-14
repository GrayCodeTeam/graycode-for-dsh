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
 * - 机器作用域键（proxy、storagePath）跳过（§7.2.1/§4.3）；
 * - channel provider 不受支持 → disabled-draft 标记（§7.5）。
 */

import { MIGRATION_ERROR_CODES } from '../../domain/types.ts'

export interface ParsedChannel {
  id: string
  type: string
  name?: string
  model?: string
  url?: string
  /** 该渠道的 apiKey 是否被脱敏（需在 DSH credentials 重新录入） */
  apiKeyRedacted: boolean
  /** provider 是否受支持；false → disabled-draft（§7.5） */
  providerSupported: boolean
  enabled: boolean
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
  suggestedConfigNote: string
}

const MACHINE_KEYS = new Set(['proxy', 'storagePath'])

/** 已知受支持的 provider（§7.5 之外的渠道 → disabled-draft） */
const SUPPORTED_PROVIDERS = new Set(['gemini', 'openai', 'anthropic'])

const SECRET_KEY_RE = /api[_-]?key|token|secret|authorization|password|credential/i

export const REDACTED_PLACEHOLDER = '[REDACTED: 请在 DSH credentials 重新录入]'

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
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
  const rawChannels = Array.isArray(root.channelConfigs) ? root.channelConfigs : []
  for (const item of rawChannels) {
    const channel = asRecord(item)
    const id = typeof channel.id === 'string' ? channel.id : ''
    if (!id) continue
    const type = typeof channel.type === 'string' ? channel.type : 'unknown'
    const apiKey = typeof channel.apiKey === 'string' ? channel.apiKey : ''
    const apiKeyRedacted = apiKey.length > 0 && apiKey !== REDACTED_PLACEHOLDER
    if (apiKeyRedacted) credentialReentryRequired.push(id)
    const providerSupported = SUPPORTED_PROVIDERS.has(type)
    if (!providerSupported) disabledDraftChannels.push(`${id} (${type})`)
    channels.push({
      id,
      type,
      ...(typeof channel.name === 'string' ? { name: channel.name } : {}),
      ...(typeof channel.model === 'string' ? { model: channel.model } : {}),
      ...(typeof channel.url === 'string' ? { url: channel.url } : {}),
      apiKeyRedacted,
      providerSupported,
      enabled: channel.enabled !== false,
    })
  }

  // mcpServers（env 脱敏；命令/参数保留结构）
  const mcpServers: ParsedMcpServer[] = []
  const rawMcp = Array.isArray(root.mcpServers) ? root.mcpServers : []
  for (const item of rawMcp) {
    const server = asRecord(item)
    const id = typeof server.id === 'string' ? server.id : ''
    if (!id) continue
    const transport = asRecord(server.transport)
    const env = asRecord(transport.env)
    const envKeys = Object.keys(env)
    if (envKeys.length > 0) credentialReentryRequired.push(`mcp:${id}`)
    mcpServers.push({
      id,
      ...(typeof server.name === 'string' ? { name: server.name } : {}),
      ...(typeof transport.type === 'string' ? { transportType: transport.type } : {}),
      ...(typeof transport.command === 'string' ? { command: transport.command } : {}),
      args: Array.isArray(transport.args) ? transport.args.filter((a): a is string => typeof a === 'string') : [],
      envKeys,
      envRedacted: envKeys.length > 0,
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
    suggestedConfigNote:
      'DSH 配置未被修改：请按本摘要手动配置 dsh settings / credentials（凭据重新录入，密钥不迁移）。',
  }
}
