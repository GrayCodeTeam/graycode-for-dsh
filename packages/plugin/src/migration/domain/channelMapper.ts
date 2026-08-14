/**
 * GrayCode - migration channelConfigs → DSH llm-pi-ai provider profile 映射（纯函数）
 *
 * 老 Gray Code 渠道（settings 导出 channelConfigs）映射到 DSH 通用多 provider 适配器
 * `@deepseek-ai/dsh-llm-pi-ai` 的 settings 命名空间 `llm-pi-ai`：用户层写
 * `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers.<route>` 即热生效（每次请求重新解析）。
 *
 * 本模块只做确定性映射，不做任何 I/O（domain 层：不导入 cordis / DSH / node）：
 * - route 命名：优先 type 键（google/openai/anthropic）；同 type 多渠道时
 *   `type-<channelId 短后缀>`（后缀仍碰撞时再追加序号）；
 * - profile：只含 DSH 配置面有等价物的字段；apiKey 一律生成引用占位
 *   `GRAYCODE_<TYPE>_<ID>_API_KEY`（POSIX 标识符：大写字母数字下划线），
 *   明文 key 永不进入 profile；
 * - warnings：无 DSH 配置面等价的字段（temperature/top_p/max_tokens/stream/toolMode
 *   等）与无法安全映射的值（非法 reasoning 档位 / thinking format），逐条说明。
 *
 * 字段映射（§DSH 侦察结论）：
 *   url→baseURL、apiKey→apiKeyEnv 引用占位、models→models[]、
 *   timeout→timeoutMs、retryEnabled/count/interval→retryPolicy（interval→backoff.initialDelayMs）、
 *   options.reasoning.effort→reasoning（校验合法档位）、
 *   options.thinking.type→compat.thinkingFormat（仅 openai-completions 协议可承载）、
 *   customHeaders→headers（敏感头值已由 settingsParser 脱敏为占位，此处丢弃并警告；
 *   非敏感值明文写入，仅建议保留非敏感头）。
 *   temperature/top_p/max_tokens/stream/toolMode 无配置面等价 → 不映射，进警告。
 */

/** 老渠道 type → llm-pi-ai catalog 路由键（§DSH 侦察：catalog 含 deepseek/openai/anthropic/google） */
export const CHANNEL_TYPE_ROUTES: Readonly<Record<string, string>> = {
  gemini: 'google',
  openai: 'openai',
  'openai-responses': 'openai',
  anthropic: 'anthropic',
} as const

/**
 * 老渠道 type → wire 协议覆盖。catalog 路由省略 api 继承 catalog 模型协议：
 * google 模型自带 google-generative-ai、anthropic 自带 anthropic-messages、
 * openai 目录默认 openai-responses。老 type=openai 实际走 chat-completions，
 * 必须显式覆盖为 openai-completions；注意 supportedProtocols() 只有
 * [openai-completions, openai-responses, anthropic-messages]，google 协议不可显式书写。
 */
export const CHANNEL_TYPE_APIS: Readonly<Record<string, string | undefined>> = {
  gemini: undefined,
  openai: 'openai-completions',
  'openai-responses': undefined,
  anthropic: undefined,
} as const

/** 受支持的渠道 type（settingsParser 的 SUPPORTED_PROVIDERS 与这里同源） */
export const SUPPORTED_CHANNEL_TYPES: readonly string[] = ['gemini', 'openai', 'openai-responses', 'anthropic']

const SUPPORTED_CHANNEL_TYPE_SET = new Set(SUPPORTED_CHANNEL_TYPES)

export function isSupportedChannelType(type: string): boolean {
  return SUPPORTED_CHANNEL_TYPE_SET.has(type)
}

/** 脱敏占位（settingsParser 复用；域内唯一来源，避免两处常量漂移） */
export const REDACTED_PLACEHOLDER = '[REDACTED: 请在 DSH credentials 重新录入]'

/** pi-ai ModelThinkingLevel 合法档位（域内拷贝，避免 src 依赖 pi-ai 类型） */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** pi-ai compat.thinkingFormat 合法拼写（SUPPORTED_THINKING_FORMATS 域内拷贝） */
const SUPPORTED_THINKING_FORMATS = new Set([
  'openai',
  'openrouter',
  'deepseek',
  'together',
  'zai',
  'qwen',
  'string-thinking',
  'ant-ling',
])

/** 已映射的 options 键（其余 options/optionsEnabled 键 → 不迁移字段） */
const MAPPED_OPTION_KEYS = new Set(['reasoning', 'thinking'])

// ─── 输入/输出形状（ParsedChannel 结构兼容，见 settingsParser.ts） ─────────────

export interface ChannelModelSource {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

export interface ChannelMappingSource {
  id: string
  type: string
  name?: string
  model?: string
  url?: string
  /** 该渠道的 apiKey 是否被脱敏（需在 DSH credentials 重新录入） */
  apiKeyRedacted: boolean
  enabled: boolean
  models?: ChannelModelSource[]
  timeout?: number
  retryEnabled?: boolean
  retryCount?: number
  retryInterval?: number
  customHeaders?: Record<string, string>
  toolMode?: string
  options?: Record<string, unknown>
  optionsEnabled?: Record<string, boolean>
}

/** 只含 DSH 配置面可映射字段的 profile（llm-pi-ai PiAiProviderProfile 结构子集） */
export interface PiAiProfileLike {
  apiKeyEnv?: string
  displayName?: string
  api?: string
  baseURL?: string
  models?: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>
  compat?: { thinkingFormat?: string; supportsReasoningEffort?: boolean }
  headers?: Record<string, string>
  reasoning?: string
  timeoutMs?: number
  retryPolicy?: {
    mode: 'normal'
    maxRetries?: number
    retryableCodes?: string[]
    backoff?: { initialDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
  }
}

export interface ChannelMappingResult {
  channelId: string
  /** 空串 = 该渠道无 route（provider 不受支持，不写入） */
  route: string
  profile: PiAiProfileLike
  credentialRef: string
  warnings: string[]
}

// ─── 凭据引用 ─────────────────────────

/** apiKey 引用占位：GRAYCODE_<TYPE>_<ID>_API_KEY（POSIX 标识符：大写字母数字下划线） */
export function credentialRefFor(channel: Pick<ChannelMappingSource, 'id' | 'type'>): string {
  const type = sanitizeIdentifier(channel.type, 'CHANNEL')
  const id = sanitizeIdentifier(channel.id, `CH${channel.id.length}`)
  return `GRAYCODE_${type}_${id}_API_KEY`
}

/** 仅保留 [A-Za-z0-9_]（POSIX 标识符字符），其余转下划线；空则回退 fallback */
function sanitizeIdentifier(value: string, fallback: string): string {
  const clean = value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return clean.length > 0 ? clean : fallback
}

// ─── route 命名 ─────────────────────────

/** 同 type 多渠道时的短后缀：channelId 小写清洗 + 截尾 16 字符；纯符号 id 回退 ch<长度> */
function routeSuffix(id: string): string {
  const clean = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!clean) return `ch${id.length}`
  const slim = clean.length > 16 ? clean.slice(-16) : clean
  return slim.replace(/-+$/, '')
}

/**
 * 为一批渠道分配 route：优先 type 键（google/openai/anthropic）；同 type 多渠道时
 * `type-<channelId 短后缀>`；后缀仍碰撞时追加 `-2`/`-3`…。不受支持的 type 分配空串。
 * 返回 Map<channelId, route>，保持输入顺序。
 */
export function assignChannelRoutes(channels: readonly ChannelMappingSource[]): Map<string, string> {
  const assigned = new Map<string, string>()
  const used = new Map<string, number>()
  const taken = new Set<string>()
  for (const channel of channels) {
    const base = CHANNEL_TYPE_ROUTES[channel.type]
    if (!base) {
      assigned.set(channel.id, '')
      continue
    }
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    let route = base
    if (n > 1) {
      const suffix = routeSuffix(channel.id)
      route = `${base}-${suffix}`
      let k = 2
      while (taken.has(route)) route = `${base}-${suffix}-${k++}`
    }
    taken.add(route)
    assigned.set(channel.id, route)
  }
  return assigned
}

// ─── 不迁移字段（报告用） ─────────────────────────

/**
 * 该渠道中无 DSH 配置面等价、不迁移的字段名清单（settings 摘要/建议文件用）。
 * 与 mapChannelToPiAiProfile 的 warnings 同源：options/optionsEnabled 中
 * 非 reasoning/thinking 的键 + toolMode + options.thinking.budget_tokens。
 */
export function listUnmigratedChannelFields(channel: ChannelMappingSource): string[] {
  const names: string[] = []
  const options = asRecord(channel.options)
  const enabled = asRecord(channel.optionsEnabled)
  for (const key of Object.keys(options)) {
    if (MAPPED_OPTION_KEYS.has(key)) continue
    names.push(`options.${key}`)
  }
  for (const key of Object.keys(enabled)) {
    if (MAPPED_OPTION_KEYS.has(key) || key in options) continue
    names.push(`options.${key}`)
  }
  if (typeof channel.toolMode === 'string' && channel.toolMode.length > 0) names.push('toolMode')
  if (asRecord(options.thinking).budget_tokens !== undefined) names.push('options.thinking.budget_tokens')
  return names
}

// ─── 单渠道映射 ─────────────────────────

/**
 * 单渠道 → { route, profile, warnings }。route 缺省取 type 键；
 * 同 type 多渠道的冲突命名由 assignChannelRoutes / mapChannelsToPiAiProfiles 负责。
 * 不受支持的 type 返回 route=''（profile 仅含 apiKeyEnv 占位 + 警告），调用方不写入。
 */
export function mapChannelToPiAiProfile(
  channel: ChannelMappingSource,
  route: string = CHANNEL_TYPE_ROUTES[channel.type] ?? '',
): ChannelMappingResult {
  const warnings: string[] = []
  const credentialRef = credentialRefFor(channel)

  if (!route) {
    warnings.push(`provider 类型 "${channel.type}" 不受支持：无 llm-pi-ai route，不写入 DSH`)
    return { channelId: channel.id, route: '', profile: { apiKeyEnv: credentialRef }, credentialRef, warnings }
  }

  const type = channel.type
  const api = CHANNEL_TYPE_APIS[type]
  const profile: PiAiProfileLike = {
    apiKeyEnv: credentialRef,
    ...(typeof channel.name === 'string' && channel.name.length > 0 ? { displayName: channel.name } : {}),
    ...(api !== undefined ? { api } : {}),
    ...(typeof channel.url === 'string' && channel.url.length > 0 ? { baseURL: channel.url } : {}),
  }

  // models：channel.models 优先（maxOutputTokens 已由 parser 归一为 maxTokens），
  // 缺省回退单 model 字段；均缺省则不写（catalog 原样服务）
  const models = mapModels(channel)
  if (models.length > 0) profile.models = models

  // customHeaders → headers：脱敏占位值（敏感头）丢弃并警告；非敏感值明文写入
  const headers = mapHeaders(channel, warnings)
  if (Object.keys(headers).length > 0) {
    profile.headers = headers
    warnings.push('customHeaders 以明文写入 settings.yaml 的 headers，仅建议保留非敏感值')
  }

  // options.reasoning.effort → reasoning（校验合法档位）
  const options = asRecord(channel.options)
  const reasoning = asRecord(options.reasoning)
  const effort = typeof reasoning.effort === 'string' ? reasoning.effort : undefined
  if (effort !== undefined && effort.length > 0) {
    if (THINKING_LEVELS.has(effort)) {
      profile.reasoning = effort
    } else {
      warnings.push(
        `options.reasoning.effort="${effort}" 无法映射（合法档位: off/minimal/low/medium/high/xhigh/max），已跳过`,
      )
    }
  }

  // options.thinking.type → compat.thinkingFormat（仅 openai-completions 协议可承载）
  const thinking = asRecord(options.thinking)
  const thinkingType = typeof thinking.type === 'string' ? thinking.type : undefined
  if (thinkingType !== undefined && thinkingType.length > 0) {
    if (api === 'openai-completions' && SUPPORTED_THINKING_FORMATS.has(thinkingType)) {
      profile.compat = { thinkingFormat: thinkingType }
    } else if (api === 'openai-completions') {
      warnings.push(
        `options.thinking.type="${thinkingType}" 无法映射为 compat.thinkingFormat（合法值: openai/openrouter/deepseek/together/zai/qwen/string-thinking/ant-ling），已跳过`,
      )
    } else {
      warnings.push(`options.thinking 仅 openai-completions 协议可映射为 compat.thinkingFormat；${type} 渠道已跳过`)
    }
  }

  // timeout → timeoutMs
  if (typeof channel.timeout === 'number' && Number.isFinite(channel.timeout) && channel.timeout > 0) {
    profile.timeoutMs = channel.timeout
  }

  // retryEnabled/count/interval → retryPolicy（interval → backoff.initialDelayMs）
  const retryPolicy = mapRetryPolicy(channel)
  if (retryPolicy) profile.retryPolicy = retryPolicy

  // 无 DSH 配置面等价的字段（options 非映射键 / toolMode / budget_tokens）→ 逐条警告
  //（与 listUnmigratedChannelFields 同源，供报告审计）
  for (const name of listUnmigratedChannelFields(channel)) {
    warnings.push(`${name} 无 DSH 配置面等价，不迁移`)
  }

  return { channelId: channel.id, route, profile, credentialRef, warnings }
}

/** 批量映射：route 冲突命名（assignChannelRoutes）+ 凭据引用去重（同 sanitize id → _2/_3…） */
export function mapChannelsToPiAiProfiles(channels: readonly ChannelMappingSource[]): ChannelMappingResult[] {
  const routes = assignChannelRoutes(channels)
  const refs = new Set<string>()
  const out: ChannelMappingResult[] = []
  for (const channel of channels) {
    const route = routes.get(channel.id)
    if (!route) continue
    const mapped = mapChannelToPiAiProfile(channel, route)
    let ref = mapped.credentialRef
    let k = 2
    while (refs.has(ref)) ref = `${mapped.credentialRef}_${k++}`
    refs.add(ref)
    out.push(ref === mapped.credentialRef ? mapped : { ...mapped, credentialRef: ref, profile: { ...mapped.profile, apiKeyEnv: ref } })
  }
  return out
}

// ─── 内部小工具 ─────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function mapModels(channel: ChannelMappingSource): NonNullable<PiAiProfileLike['models']> {
  const source =
    Array.isArray(channel.models) && channel.models.length > 0
      ? channel.models
      : typeof channel.model === 'string' && channel.model.length > 0
        ? [{ id: channel.model }]
        : []
  const out: NonNullable<PiAiProfileLike['models']> = []
  const seen = new Set<string>()
  for (const m of source) {
    if (!m || typeof m.id !== 'string' || m.id.length === 0) continue
    if (seen.has(m.id)) continue
    seen.add(m.id)
    const entry: NonNullable<PiAiProfileLike['models']>[number] = { id: m.id }
    if (typeof m.name === 'string' && m.name.length > 0) entry.name = m.name
    if (typeof m.contextWindow === 'number' && Number.isFinite(m.contextWindow) && m.contextWindow > 0) {
      entry.contextWindow = m.contextWindow
    }
    if (typeof m.maxTokens === 'number' && Number.isFinite(m.maxTokens) && m.maxTokens > 0) {
      entry.maxTokens = m.maxTokens
    }
    out.push(entry)
  }
  return out
}

function mapHeaders(channel: ChannelMappingSource, warnings: string[]): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!channel.customHeaders) return headers
  let dropped = 0
  for (const [key, value] of Object.entries(channel.customHeaders)) {
    if (value === REDACTED_PLACEHOLDER) {
      dropped += 1
      continue
    }
    headers[key] = value
  }
  if (dropped > 0) {
    warnings.push(`customHeaders 中 ${dropped} 个敏感头已脱敏，未写入 headers；对应凭据请在 DSH credentials 重新录入`)
  }
  return headers
}

function mapRetryPolicy(channel: ChannelMappingSource): PiAiProfileLike['retryPolicy'] {
  const enabled = channel.retryEnabled !== false
  const count = typeof channel.retryCount === 'number' ? Math.floor(channel.retryCount) : 0
  if (!enabled || count <= 0) return undefined
  const policy: NonNullable<PiAiProfileLike['retryPolicy']> = { mode: 'normal', maxRetries: count }
  if (typeof channel.retryInterval === 'number' && Number.isFinite(channel.retryInterval) && channel.retryInterval > 0) {
    policy.backoff = { initialDelayMs: channel.retryInterval }
  }
  return policy
}
