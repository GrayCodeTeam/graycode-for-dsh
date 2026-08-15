/**
 * GrayCode - summary 域纯逻辑（零宿主依赖，便于单测）。
 *
 * 移植自参考实现 SummarizeService（backend/modules/api/chat/services/
 * SummarizeService.ts + summarizeRangePlanner.ts）的手动总结语义，落地为
 * append-only 宿主可用的形态：
 * - 历史消息 → 文本转录（user/assistant/tool 消息取文本内容，思考/图片占位）；
 * - 总结输入裁剪：保留最近 keepRecentRounds 轮 + 按 keepRecentTokens 预算
 *   收缩（从最旧轮开始裁），返回可输入文本；
 * - 内置 6 段 system prompt 常量 + 含 {history} 占位的用户 prompt 模板常量；
 * - MIN_SUMMARY_LENGTH=50 质量校验（参考实现防「已总结/OK」占位文本的机制）。
 *
 * token 估算简化口径：字符数 / 4。DSH 派生消息（session.deriveMessages()）
 * 不携带 usage 元数据（usage 只在流式 chunk 上出现、不落日志），故无
 * usageMetadata 可用，统一用该估算。
 */

/** 内置总结 system prompt（参考实现原样移植：英文、渠道无关、6 段结构）。 */
export const SUMMARY_SYSTEM_PROMPT = `You are an expert conversation summarization assistant.
Always respond in English.
Produce a structured summary with clear, step-by-step sections.
Follow this exact structure:
1. User Goal
2. Completed Steps
3. Current Progress
4. Next Steps
5. Important Constraints
6. Open Questions / Risks
Use concise bullet points under each section.
Preserve exact technical details (file paths, function names, config keys, IDs, and numbers).`

/** 内置用户 prompt 模板（可配置覆盖；{history} 占位被转录文本替换）。 */
export const SUMMARY_USER_PROMPT_TEMPLATE = `Please summarize the following conversation history. Keep the key information and context points, and drop redundant content.

Conversation history:
{history}`

/** 历史占位符（模板中可自定义位置）。 */
export const SUMMARY_HISTORY_PLACEHOLDER = '{history}'

/** 总结文本最低长度（字符数）：低于该值的总结视为低质量（参考实现 MIN_SUMMARY_LENGTH）。 */
export const MIN_SUMMARY_LENGTH = 50

/** 默认保留最近轮数（下限保护，至少按 1 处理）。 */
export const DEFAULT_KEEP_RECENT_ROUNDS = 2

/** 默认保留预算（百分比；基数为全部历史估算 token 总量）。 */
export const DEFAULT_KEEP_RECENT_TOKENS = '50%'

// ==================== 结构镜像（deriveMessages 产物的可测子集） ====================

export interface SummaryContentBlockLike {
  readonly type?: string
  readonly text?: string
  /** tool-call 块：工具名。 */
  readonly name?: string
  /** tool-call 块：原始 JSON 参数串。 */
  readonly arguments?: string
  /** tool-result 块：嵌套内容块。 */
  readonly content?: readonly SummaryContentBlockLike[]
}

export interface SummaryMessageLike {
  readonly role?: string
  /** 消息来源（user/tool/model/plugin……，仅读取 kind）。 */
  readonly source?: { readonly kind?: string }
  readonly content?: readonly SummaryContentBlockLike[]
}

// ==================== token 估算 ====================

/** 简化 token 估算：字符数 / 4（向上取整）。 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ==================== 消息 → 文本 ====================

/**
 * 单块 → 文本：
 * - text → 原文；reasoning → 跳过（思考内容不进总结输入）；
 * - image → 文本占位符（总结模型无需图片字节）；
 * - tool-call → `tool <name>(<arguments>)`（工具名与参数串）；
 * - tool-result → 嵌套块文本递归拼接（'; ' 分隔）；
 * - 未知块型 → 跳过。
 */
export function blockToText(block: SummaryContentBlockLike): string {
  switch (block.type) {
    case 'text':
      return block.text ?? ''
    case 'reasoning':
      return ''
    case 'image':
      return '[image]'
    case 'tool-call': {
      const name = block.name ?? 'unknown'
      const args = block.arguments ?? ''
      return `tool ${name}(${args})`
    }
    case 'tool-result': {
      const parts = (block.content ?? []).map(blockToText).filter(text => text.length > 0)
      return parts.join('; ')
    }
    default:
      return ''
  }
}

/** 单条消息 → 文本（拼接非空块，行内换行保留）。 */
export function messageToText(message: SummaryMessageLike): string {
  return (message.content ?? []).map(blockToText).join('\n').trim()
}

/** 消息列表 → 转录文本：`<role>: <text>` 逐条、空消息跳过、'\n\n' 连接。 */
export function messagesToTranscript(messages: readonly SummaryMessageLike[]): string {
  const lines: string[] = []
  for (const message of messages) {
    const role = message.role ?? 'unknown'
    const text = messageToText(message)
    if (text.length === 0) continue
    lines.push(`${role}: ${text}`)
  }
  return lines.join('\n\n').trim()
}

// ==================== 轮次分组 ====================

/** 轮首判定：role 'user' 且 source.kind === 'user'（与 branches 域直发消息同口径）。 */
export function isRoundStart(message: SummaryMessageLike): boolean {
  return message.role === 'user' && message.source?.kind === 'user'
}

/** 一轮消息：转录文本 + 估算 token 数。 */
export interface SummaryRound {
  readonly messages: readonly SummaryMessageLike[]
  readonly text: string
  readonly tokens: number
}

/**
 * 把消息列表按真实用户消息分组为轮：
 * - 轮首 = 真实用户消息；轮内包含其后直到下一轮首之前的所有消息；
 * - 首轮之前的消息（system/注入前缀）并入第一轮；
 * - 没有任何真实用户消息时整段作为一轮（空转录 → 空轮列表）。
 */
export function groupRounds(messages: readonly SummaryMessageLike[]): readonly SummaryRound[] {
  const starts: number[] = []
  for (let index = 0; index < messages.length; index += 1) {
    if (isRoundStart(messages[index]!)) starts.push(index)
  }
  if (starts.length === 0) {
    const text = messagesToTranscript(messages)
    return text.length === 0
      ? []
      : [{ messages: [...messages], text, tokens: estimateTextTokens(text) }]
  }
  const rounds: SummaryRound[] = []
  for (let roundIndex = 0; roundIndex < starts.length; roundIndex += 1) {
    const begin = roundIndex === 0 ? 0 : starts[roundIndex]!
    const end = roundIndex + 1 < starts.length ? starts[roundIndex + 1]! : messages.length
    const slice = messages.slice(begin, end)
    const text = messagesToTranscript(slice)
    rounds.push({ messages: slice, text, tokens: estimateTextTokens(text) })
  }
  return rounds
}

// ==================== 保留预算解析 ====================

/**
 * 解析保留预算为具体 token 数：绝对数（number 或数字字符串）或百分比字符串
 * （基数 = 全部历史估算 token 总量，'50%' = 截断一半、保留一半，与参考实现
 * 的百分比语义一致）。缺失/非法 → 回落到内置默认 '50%'。
 */
export function resolveKeepRecentTokenBudget(
  raw: number | string | undefined,
  baseTokens: number
): number {
  const parsed = parseKeepRecentTokenBudget(raw, baseTokens)
  if (parsed !== undefined) return parsed
  return parseKeepRecentTokenBudget(DEFAULT_KEEP_RECENT_TOKENS, baseTokens) as number
}

function parseKeepRecentTokenBudget(
  raw: number | string | undefined,
  baseTokens: number
): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined
  }
  const text = raw.trim()
  if (!text) return undefined
  if (text.endsWith('%')) {
    const percent = Number.parseFloat(text.slice(0, -1))
    if (Number.isFinite(percent) && percent > 0 && percent <= 100) {
      return Math.floor((baseTokens * percent) / 100)
    }
    return undefined
  }
  const numeric = Number(text)
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric)
  return undefined
}

// ==================== 总结输入裁剪 ====================

export interface SummaryInputOptions {
  readonly messages: readonly SummaryMessageLike[]
  /** 保留最近 N 轮（下限保护，默认 2，至少按 1 处理）。 */
  readonly keepRecentRounds?: number
  /** 保留预算：绝对 token 数或百分比（默认 '50%'）。 */
  readonly keepRecentTokens?: number | string
}

export interface SummaryInputResult {
  /** 可输入文本（空串 = 没有可总结的内容）。 */
  readonly text: string
  /** 纳入总结输入的轮数。 */
  readonly summarizedRounds: number
  /** 未纳入总结输入的轮数（最近保留 + 预算收缩裁掉的最旧轮）。 */
  readonly excludedRounds: number
}

/**
 * 裁剪总结输入：
 * 1. 保留最后 keepRecentRounds 轮（参考实现 keepRecentRounds 语义：这些轮不
 *    参与总结，保持新鲜上下文）；
 * 2. 旧区（其余轮）超出保留预算时从最旧轮开始裁——旧区中较新的部分进入输入；
 *    旧区最新一轮无条件保留（哪怕单轮体积已超预算，也要保证有可总结内容）。
 * 轮数不足（全部落在保留窗口内）→ 返回空文本，由调用方报「没有可总结内容」。
 */
export function buildSummaryInput(options: SummaryInputOptions): SummaryInputResult {
  const rounds = groupRounds(options.messages)
  if (rounds.length === 0) {
    return { text: '', summarizedRounds: 0, excludedRounds: 0 }
  }
  const totalTokens = rounds.reduce((sum, round) => sum + round.tokens, 0)
  const minKeepRounds = Math.max(1, Math.floor(options.keepRecentRounds ?? DEFAULT_KEEP_RECENT_ROUNDS) || 1)
  const budget = resolveKeepRecentTokenBudget(options.keepRecentTokens, totalTokens)

  const keepCount = Math.min(minKeepRounds, rounds.length)
  const oldRounds = rounds.slice(0, rounds.length - keepCount)
  if (oldRounds.length === 0) {
    return { text: '', summarizedRounds: 0, excludedRounds: rounds.length }
  }

  // 从旧区最新一轮往前累计：装得下就纳入，装不下即停（最旧轮先被裁掉）。
  let accumulated = 0
  let includeFrom = oldRounds.length - 1
  for (let index = oldRounds.length - 1; index >= 0; index -= 1) {
    const tokens = oldRounds[index]!.tokens
    if (index < oldRounds.length - 1 && accumulated + tokens > budget) break
    accumulated += tokens
    includeFrom = index
  }
  const selected = oldRounds.slice(includeFrom)
  return {
    text: selected.map(round => round.text).join('\n\n'),
    summarizedRounds: selected.length,
    excludedRounds: rounds.length - selected.length,
  }
}

// ==================== prompt 组装 ====================

/**
 * 渲染用户 prompt：模板含 {history} 占位 → 替换；不含 → 历史追加在模板之后
 * （自定义模板未声明占位时的兜底，保证历史一定进入请求）。
 */
export function renderSummaryPrompt(template: string, history: string): string {
  if (template.includes(SUMMARY_HISTORY_PLACEHOLDER)) {
    return template.replaceAll(SUMMARY_HISTORY_PLACEHOLDER, history)
  }
  return `${template}\n\n${history}`
}

// ==================== 质量校验 ====================

export type SummaryValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'empty' | 'too-short'; readonly length: number }

/**
 * 总结文本质量校验：空文本拒绝；长度低于 MIN_SUMMARY_LENGTH（50）拒绝——
 * 防止模型返回「已总结」「OK」等占位文本（参考实现 LOW_QUALITY_SUMMARY 语义；
 * 本落地不截断历史，低质量文本直接不展示）。
 */
export function validateSummaryText(text: string): SummaryValidationResult {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'empty', length: 0 }
  if (trimmed.length < MIN_SUMMARY_LENGTH) {
    return { ok: false, reason: 'too-short', length: trimmed.length }
  }
  return { ok: true }
}
