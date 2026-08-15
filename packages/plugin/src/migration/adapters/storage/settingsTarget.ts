/**
 * GrayCode - migration settings 写入侧适配
 *
 * settings 域「双轨写入」：
 * 1. 建议配置（保留，永远产出）：`<dataRoot>/migration/imports/<runId>/settings/<legacyId>`
 *    —— 已脱敏摘要 + 渠道 → DSH llm-pi-ai provider profile 映射 + 凭据引用 + 直写结果；
 *    按 legacy 文件名键控（4.14-L3：同一 run 多个 settings 导出文件各自落独立文件，
 *    避免后者覆盖前者、台账多条目同 targetRef）；
 * 2. DSH 直写（尽力而为）：宿主挂载了 settings 服务且 `llm-pi-ai` 命名空间已注册
 *    （= @deepseek-ai/dsh-llm-pi-ai 已加载，其 apply 经 installSettingsSection 注册）时，
 *    用 `ctx.settings.mutate('llm-pi-ai', [{op:'set', path:['providers', route], value: profile}])`
 *    把每个可服务渠道写成 `llm-pi-ai.providers.<route>`。路径编辑 = merge 语义：
 *    不覆盖用户已有 route（已存在的同名 route 跳过并记冲突）；每次请求热解析，无需重启。
 *
 * 降级与失败隔离：
 * - settings 服务未挂载 / `llm-pi-ai` 命名空间未注册 / get 抛错 → 回退「只出建议文件」；
 * - mutate 被拒（schema 或 assertServiceable 校验失败，即 settings-rejected）→ 回退
 *   建议文件并记录拒绝信息；
 * - 任何 DSH 写失败都不抛出 write()：settings 域失败不影响其他域导入
 *   （逐域提交点语义不变）。
 *
 * 凭据：明文 apiKey 一律不写入 DSH——profile.apiKeyEnv 是引用占位
 * `GRAYCODE_<TYPE>_<ID>_API_KEY`（POSIX 标识符），值需用户在 DSH credentials 录入
 * （ctx.credentials 可用时 best-effort describe 上报是否已配置，仅信息性）。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type { TargetWriterPort, WriteTargetInput, WriteTargetResult } from '../../application/ports.ts'
import type { ParsedChannel, ParsedSettingsExport } from '../legacy/settingsParser.ts'
import {
  REDACTED_PLACEHOLDER,
  mapChannelsToPiAiProfiles,
  type ChannelMappingResult,
} from '../../domain/channelMapper.ts'

/** llm-pi-ai settings 命名空间（@deepseek-ai/dsh-llm-pi-ai 注册，settingsNamespace('llm-pi-ai')） */
export const LLM_PI_AI_NAMESPACE = 'llm-pi-ai'

/**
 * ctx.settings 的结构化子集（dsh-settings 为 devDep，src 不直接依赖；
 * 与 conversationTarget 的 SessionPersistenceLike 同模式）。
 */
export interface SettingsProviderLike {
  /** 已注册命名空间的解析值；未注册返回 undefined */
  get(ns: string): unknown
  /** 路径编辑：merge 语义写入 user section，校验通过后持久化并热生效 */
  mutate(
    ns: string,
    ops: ReadonlyArray<
      | { op: 'set'; path: readonly string[]; value: unknown }
      | { op: 'unset'; path: readonly string[] }
    >,
    expectedRevision?: number,
  ): Promise<void>
}

/** ctx.credentials 的结构化子集（describe 信息性上报 + set 凭据一键迁移 B1） */
export interface CredentialsProviderLike {
  describe(ref: string): Promise<{ configured: boolean; writable: boolean }>
  set(ref: string, value: string): Promise<void>
}

/** DSH 宿主上下文的结构化子集（compose.ts 注入完整 Context，结构兼容） */
export interface DshHostContextLike {
  settings?: SettingsProviderLike
  credentials?: CredentialsProviderLike
}

export interface SettingsTargetWriterOptions {
  /** artifact 根（<dataRoot>/migration/imports；建议文件落盘位置） */
  importsRoot: string
  /** DSH 宿主上下文（可选）：提供 ctx.settings / ctx.credentials；缺省 = 只出建议文件 */
  ctx?: DshHostContextLike
  /**
   * runId 段校验模式（3.14-M5）：缺省 `run_[A-Za-z0-9_-]+`（与缺省 runIdFactory 对齐）。
   * 注入自定义 runIdFactory 时必须传入与其产物匹配的模式，否则 probe 会把合法
   * targetRef 误判为不可达（settings 校验误报）。
   */
  runIdPattern?: RegExp
}

/** DSH 直写结果（写入建议文件 + notes） */
export interface DshWriteOutcome {
  mode: 'direct' | 'suggested-only' | 'settings-rejected'
  /** 已写入的 route（含渠道 id） */
  writtenRoutes: string[]
  /** 同名 route 已存在、跳过的清单（含渠道 id） */
  conflictSkippedRoutes: string[]
  /** 未注册 route 的渠道（provider 不受支持 / enabled:false） */
  skippedChannels: string[]
  /** 本次生成的凭据引用（需用户在 DSH credentials 录入值） */
  credentialRefs: string[]
  /** 凭据一键迁移（B1）：已写入 ctx.credentials 的引用（仅 ref 名，无明文） */
  migratedCredentialRefs: string[]
  /** 凭据迁移失败的引用（保留「需重录」状态；失败隔离，不抛出） */
  credentialMigrationErrors?: string[]
  /** best-effort describe 结果：ref → 是否已配置（credentials 服务不可用时缺省） */
  credentialStates?: Record<string, boolean>
  rejectionMessage?: string
}

export function createSettingsTargetWriter(options: SettingsTargetWriterOptions): TargetWriterPort {
  const { importsRoot, ctx } = options
  // 3.14-M5：probe 的 runId 段可配置（非捕获组包裹，避免调用方模式内的捕获组
  // 影响路径段捕获）；文件段收窄到安全字符（无 '/'、无 '..' 穿越）。
  const runIdSource = options.runIdPattern?.source ?? 'run_[A-Za-z0-9_-]+'
  const ARTIFACT_REF_RE = new RegExp(`^artifact://settings/((?:${runIdSource})/settings/[A-Za-z0-9_.-]+)$`)
  return {
    kind: 'settings',
    async write(input: WriteTargetInput): Promise<WriteTargetResult> {
      const parsed = input.object.data as ParsedSettingsExport | undefined
      if (!parsed || !parsed.ok) throw new Error(`settings 负载缺失: ${input.object.legacyId}`)

      // 渠道 → DSH llm-pi-ai provider profile（纯函数；route 冲突命名 + 凭据引用去重）。
      // 仅对「provider 受支持且 enabled」的渠道分配 route：disabled/不受支持的渠道
      // 不占 route 名，也不写入 DSH。
      const candidates = parsed.channels.filter(c => c.providerSupported && c.enabled)
      const mapped = mapChannelsToPiAiProfiles(candidates)
      const byChannelId = new Map(mapped.map(m => [m.channelId, m]))

      // DSH 直写（best-effort：任何失败回退建议文件-only，不抛出）
      const dsh = await writeDshProviders(parsed, byChannelId, ctx)

      const suggested = {
        note: parsed.suggestedConfigNote,
        sourceFile: parsed.sourceFile,
        graycodeVersion: parsed.graycodeVersion,
        limcodeMigrated: parsed.limcodeMigrated,
        machineKeysSkipped: parsed.machineKeysSkipped,
        // 键已做 limcode→graycode 映射且值已脱敏（无明文 secret）
        vscodeSettings: parsed.vscodeSettings,
        channels: parsed.channels.map(c => ({
          id: c.id,
          type: c.type,
          name: c.name,
          model: c.model,
          url: c.url,
          // 明文 apiKey 不进入建议配置：只留重新录入标记
          apiKey: c.apiKeyRedacted ? REDACTED_PLACEHOLDER : undefined,
          providerSupported: c.providerSupported,
          enabled: c.enabled,
          // DSH 映射（仅 provider 受支持且 enabled 的渠道有 route）
          ...(byChannelId.get(c.id) ? { route: byChannelId.get(c.id)!.route } : {}),
          ...(byChannelId.get(c.id) ? { credentialRef: byChannelId.get(c.id)!.credentialRef } : {}),
          ...(c.unmigratedFields.length > 0 ? { unmigratedFields: c.unmigratedFields } : {}),
        })),
        mcpServers: parsed.mcpServers.map(m => ({
          id: m.id,
          name: m.name,
          transportType: m.transportType,
          command: m.command,
          args: m.args,
          envKeys: m.envKeys,
          envRedacted: m.envRedacted,
          cliRedacted: m.cliRedacted,
          enabled: m.enabled,
        })),
        skills: parsed.skills.map(s => ({
          id: s.id,
          name: s.name,
          source: s.source,
          enabled: s.enabled,
          contentLength: s.contentLength,
        })),
        credentialReentryRequired: parsed.credentialReentryRequired,
        disabledDraftChannels: parsed.disabledDraftChannels,
        deduplicatedSkills: parsed.deduplicatedSkills,
        unmigratedChannelFields: parsed.unmigratedChannelFields,
        dshWrite: {
          mode: dsh.mode,
          writtenRoutes: dsh.writtenRoutes,
          conflictSkippedRoutes: dsh.conflictSkippedRoutes,
          skippedChannels: dsh.skippedChannels,
          credentialRefs: dsh.credentialRefs,
          migratedCredentialRefs: dsh.migratedCredentialRefs,
          ...(dsh.credentialMigrationErrors ? { credentialMigrationErrors: dsh.credentialMigrationErrors } : {}),
          ...(dsh.credentialStates ? { credentialStates: dsh.credentialStates } : {}),
          ...(dsh.rejectionMessage ? { rejectionMessage: dsh.rejectionMessage } : {}),
        },
      }

      const dir = path.join(importsRoot, input.runId)
      // 4.14-L3：按 legacy 文件名键控建议文件（safeId 收窄到安全字符），
      // 同一 run 的多个 settings 导出（graycode/limcode/settings.json）不再互相覆盖
      const safeId = input.object.legacyId.replace(/[^A-Za-z0-9_.-]/g, '_')
      const target = path.join(dir, 'settings', safeId)
      await fs.mkdir(path.dirname(target), { recursive: true })
      const tmp = `${target}.tmp`
      await fs.writeFile(tmp, JSON.stringify(suggested, null, 2), 'utf-8')
      await fs.rename(tmp, target)

      const notes = buildNotes(parsed, dsh, mapped, `settings/${safeId}`)
      return {
        targetRef: `artifact://settings/${input.runId}/settings/${safeId}`,
        notes,
        // B2：写时结果（脱敏）供最终报告合流到 settingsSummary.writeResult
        summary: {
          dshWrite: {
            mode: dsh.mode,
            writtenRoutes: dsh.writtenRoutes,
            conflictSkippedRoutes: dsh.conflictSkippedRoutes,
            skippedChannels: dsh.skippedChannels,
            credentialRefs: dsh.credentialRefs,
            migratedCredentialRefs: dsh.migratedCredentialRefs,
            ...(dsh.credentialMigrationErrors ? { credentialMigrationErrors: dsh.credentialMigrationErrors } : {}),
            ...(dsh.credentialStates ? { credentialStates: dsh.credentialStates } : {}),
            ...(dsh.rejectionMessage ? { rejectionMessage: dsh.rejectionMessage } : {}),
          },
        },
      }
    },
    async probe(targetRef: string): Promise<boolean> {
      // 只允许 runId 格式的路径段 + settings/<文件>（防越界读：runId 段仅
      // [A-Za-z0-9_-]，文件段仅安全字符，不含 '.'/'..' 穿越；再做 resolved 路径
      // 包含性校验兜底）
      const match = targetRef.match(ARTIFACT_REF_RE)
      if (!match?.[1]) return false
      try {
        const root = path.resolve(importsRoot)
        const resolved = path.resolve(root, match[1])
        if (resolved !== root && !resolved.startsWith(root + path.sep)) return false
        await fs.access(resolved)
        return true
      } catch {
        return false
      }
    },
  }
}

// ─── DSH 直写（best-effort） ─────────────────────────

async function writeDshProviders(
  parsed: ParsedSettingsExport,
  byChannelId: ReadonlyMap<string, ChannelMappingResult>,
  ctx: DshHostContextLike | undefined,
): Promise<DshWriteOutcome> {
  const settings = ctx?.settings
  const credentialRefs = collectCredentialRefs(parsed, byChannelId)
  const credentialStates = await probeCredentialStates(ctx, credentialRefs)
  // B1：凭据一键迁移独立于 settings 直写（授权模式 parsed.credentialSecrets 才有值；
  // 写入失败隔离，不抛出、不影响其他域；明文只在局部变量中流转，写入后丢弃）
  const { migratedRefs, failedRefs } = await migrateCredentials(parsed, byChannelId, ctx)
  const migratedExtra = migratedRefs.length > 0 ? { migratedCredentialRefs: migratedRefs } : {}
  const failedExtra = failedRefs.length > 0 ? { credentialMigrationErrors: failedRefs } : {}
  const outcomeBase = (extra: Partial<DshWriteOutcome>): DshWriteOutcome => ({
    mode: 'suggested-only',
    writtenRoutes: [],
    conflictSkippedRoutes: [],
    skippedChannels: [],
    credentialRefs,
    migratedCredentialRefs: migratedRefs,
    ...(Object.keys(credentialStates).length > 0 ? { credentialStates } : {}),
    ...migratedExtra,
    ...failedExtra,
    ...extra,
  })

  if (!settings) {
    return outcomeBase({ skippedChannels: skippedChannelList(parsed.channels, byChannelId) })
  }

  // 探测：llm-pi-ai 命名空间已注册且能解析出对象（get 返回 undefined = 未注册）
  let current: unknown
  try {
    current = settings.get(LLM_PI_AI_NAMESPACE)
  } catch {
    current = undefined
  }
  if (typeof current !== 'object' || current === null) {
    return outcomeBase({ skippedChannels: skippedChannelList(parsed.channels, byChannelId) })
  }

  const existingProviders = asRecord((current as Record<string, unknown>).providers)
  const ops: Array<{ op: 'set'; path: readonly string[]; value: unknown }> = []
  const writtenRoutes: string[] = []
  const conflictSkippedRoutes: string[] = []
  const skippedChannels: string[] = []

  for (const channel of parsed.channels) {
    if (!channel.providerSupported) {
      skippedChannels.push(`${channel.id} (${channel.type}：provider 不受支持，不写入)`)
      continue
    }
    if (!channel.enabled) {
      skippedChannels.push(`${channel.id} (enabled:false，不注册 route)`)
      continue
    }
    const mappedChannel = byChannelId.get(channel.id)
    if (!mappedChannel || !mappedChannel.route) {
      skippedChannels.push(`${channel.id} (无 llm-pi-ai route，不写入)`)
      continue
    }
    if (existingProviders[mappedChannel.route] !== undefined) {
      conflictSkippedRoutes.push(`${mappedChannel.route} (${channel.id})`)
      continue
    }
    ops.push({ op: 'set', path: ['providers', mappedChannel.route], value: mappedChannel.profile })
    writtenRoutes.push(`${mappedChannel.route} (${channel.id})`)
  }

  if (ops.length > 0) {
    try {
      await settings.mutate(LLM_PI_AI_NAMESPACE, ops)
    } catch (err) {
      // settings.validate / schema 拒绝（不可服务 profile）→ settings-rejected 回退
      return outcomeBase({
        mode: 'settings-rejected',
        conflictSkippedRoutes,
        skippedChannels,
        credentialRefs,
        rejectionMessage: (err as Error).message,
      })
    }
  }

  return {
    mode: 'direct',
    writtenRoutes,
    conflictSkippedRoutes,
    skippedChannels,
    credentialRefs,
    migratedCredentialRefs: migratedRefs,
    ...migratedExtra,
    ...failedExtra,
    ...(Object.keys(credentialStates).length > 0 ? { credentialStates } : {}),
  }
}

/**
 * B1：凭据一键迁移——把授权模式下解析到的渠道明文 apiKey 写入
 * `ctx.credentials.set(ref, apiKey)`（引用名 GRAYCODE_<TYPE>_<ID>_API_KEY）。
 * 只处理有 credentialRef 的渠道（provider 受支持且 enabled）；无 ref 的渠道
 * （disabled/不受支持）保持「需重录」状态。单 ref 失败隔离：失败项返回清单，
 * 不抛出、不影响其余迁移与 settings 直写。
 */
async function migrateCredentials(
  parsed: ParsedSettingsExport,
  byChannelId: ReadonlyMap<string, ChannelMappingResult>,
  ctx: DshHostContextLike | undefined,
): Promise<{ migratedRefs: string[]; failedRefs: string[] }> {
  const credentials = ctx?.credentials
  const secrets = parsed.credentialSecrets
  if (!credentials?.set || !secrets || secrets.length === 0) {
    return { migratedRefs: [], failedRefs: [] }
  }
  const migratedRefs: string[] = []
  const failedRefs: string[] = []
  for (const secret of secrets) {
    const mapped = byChannelId.get(secret.channelId)
    const ref = mapped?.credentialRef
    if (!ref) continue // 无 route/ref（disabled/不受支持）→ 保持重录清单
    try {
      await credentials.set(ref, secret.apiKey)
      migratedRefs.push(ref)
    } catch {
      failedRefs.push(ref)
    }
  }
  return { migratedRefs, failedRefs }
}

/** best-effort：describe 每个需重录凭据的引用（失败不影响写入） */
async function probeCredentialStates(
  ctx: DshHostContextLike | undefined,
  refs: readonly string[],
): Promise<Record<string, boolean>> {
  const credentials = ctx?.credentials
  const states: Record<string, boolean> = {}
  if (!credentials?.describe || refs.length === 0) return states
  for (const ref of refs) {
    try {
      const info = await credentials.describe(ref)
      states[ref] = info.configured
    } catch {
      // describe 失败（只读层/服务抖动）→ 该 ref 不记录，不影响写入
    }
  }
  return states
}

/** 未注册 route 的渠道清单（settings 不可用场景的兜底） */
function skippedChannelList(
  channels: readonly ParsedChannel[],
  byChannelId: ReadonlyMap<string, ChannelMappingResult>,
): string[] {
  const out: string[] = []
  for (const channel of channels) {
    if (!channel.providerSupported) {
      out.push(`${channel.id} (${channel.type}：provider 不受支持，不写入)`)
    } else if (!channel.enabled) {
      out.push(`${channel.id} (enabled:false，不注册 route)`)
    } else if (!byChannelId.get(channel.id)?.route) {
      out.push(`${channel.id} (无 llm-pi-ai route，不写入)`)
    }
  }
  return out
}

/** 需要重新录入凭据的渠道对应的引用占位（与 parsed.credentialReentryRequired 同源） */
function collectCredentialRefs(
  parsed: ParsedSettingsExport,
  byChannelId: ReadonlyMap<string, ChannelMappingResult>,
): string[] {
  const reentry = new Set(parsed.credentialReentryRequired)
  const refs = new Set<string>()
  for (const channel of parsed.channels) {
    if (!reentry.has(channel.id)) continue
    const ref = byChannelId.get(channel.id)?.credentialRef
    if (ref) refs.add(ref)
  }
  return [...refs]
}

function buildNotes(
  parsed: ParsedSettingsExport,
  dsh: DshWriteOutcome,
  mapped: ChannelMappingResult[],
  artifactName: string,
): string[] {
  const notes: string[] = []
  if (dsh.mode === 'direct') {
    if (dsh.writtenRoutes.length > 0) {
      notes.push(`DSH settings 已写入 llm-pi-ai.providers（每次请求热解析）: ${dsh.writtenRoutes.join(', ')}`)
    }
    if (dsh.conflictSkippedRoutes.length > 0) {
      notes.push(`同名 route 已存在，跳过（不覆盖用户已有渠道）: ${dsh.conflictSkippedRoutes.join(', ')}`)
    }
    if (dsh.skippedChannels.length > 0) {
      notes.push(`未注册 route: ${dsh.skippedChannels.join('; ')}`)
    }
  } else if (dsh.mode === 'suggested-only') {
    notes.push('DSH settings 不可用（settings 服务未挂载或 llm-pi-ai 命名空间未加载），仅产出建议文件')
  } else {
    notes.push(
      `DSH settings 拒绝该 profile（settings-rejected）: ${dsh.rejectionMessage ?? '未知原因'}；已回退建议文件`,
    )
  }
  if (dsh.credentialRefs.length > 0) {
    if (dsh.migratedCredentialRefs.length > 0) {
      notes.push(
        `凭据已一键迁移到 DSH credentials（引用: ${dsh.migratedCredentialRefs.join(', ')}；` +
          '注意旧 key 可能已过期/轮换，首次调用失败时请重新录入）',
      )
    }
    if (dsh.credentialMigrationErrors && dsh.credentialMigrationErrors.length > 0) {
      notes.push(`凭据迁移失败（保留「需重录」状态）: ${dsh.credentialMigrationErrors.join(', ')}`)
    }
    const pending = dsh.credentialRefs.filter(ref => !dsh.migratedCredentialRefs.includes(ref))
    if (pending.length > 0) {
      notes.push(`凭据引用已生成（明文 key 未迁移，请在 DSH credentials 录入值）: ${pending.join(', ')}`)
    }
  }
  const warnings = [...new Set(mapped.flatMap(m => m.warnings))]
  if (warnings.length > 0) {
    const shown = warnings.slice(0, 5)
    const more = warnings.length > shown.length ? `（另有 ${warnings.length - shown.length} 条）` : ''
    notes.push(`映射警告: ${shown.join('; ')}${more}`)
  }
  notes.push(
    `需重新录入凭据: ${parsed.credentialReentryRequired.join(', ') || '无'}`,
    `建议配置已落盘供人工核对: ${artifactName}`,
  )
  return notes
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
