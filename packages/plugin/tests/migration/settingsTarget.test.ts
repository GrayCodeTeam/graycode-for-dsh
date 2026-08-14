/**
 * settingsTarget 写入侧测试（settings 直写 DSH + 建议文件）
 *
 * 用 mock ctx.settings / ctx.credentials 覆盖写路径：
 * - merge 语义不覆盖用户已有 route；同名 route 跳过并记冲突；
 * - settings 服务未挂载 / llm-pi-ai 命名空间未注册 → 回退建议文件-only；
 * - mutate 拒绝（settings-rejected）→ 回退建议文件，write 不抛出（失败隔离）；
 * - disabled / provider 不受支持渠道不注册 route；
 * - probe 路径段校验（只允许 runId 格式，防越界读）。
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { apply as applyPiAi } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  LLM_PI_AI_NAMESPACE,
  createSettingsTargetWriter,
  type DshHostContextLike,
} from '../../src/migration/adapters/storage/settingsTarget.ts'
import { parseSettingsExport } from '../../src/migration/adapters/legacy/settingsParser.ts'
import { mapChannelsToPiAiProfiles } from '../../src/migration/domain/channelMapper.ts'
import type { WriteTargetInput } from '../../src/migration/application/ports.ts'
import type { PlannedObject } from '../../src/migration/domain/types.ts'

type SettingsOp = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }

/** 测试样本：2 个可写渠道（gemini/openai）+ 1 个 disabled（anthropic）+ 1 个不受支持（ollama） */
const SETTINGS_RAW = JSON.stringify({
  version: '1.0',
  graycodeVersion: '1.5.4',
  channelConfigs: [
    { id: 'ch-gemini', type: 'gemini', name: 'Gemini', apiKey: 'sk-secret', model: 'gemini-2.5-flash', url: 'https://example.invalid/v1', enabled: true },
    { id: 'ch-gpt', type: 'openai', name: 'OpenAI', apiKey: '', model: 'gpt-4o', url: 'https://api.openai.com/v1', enabled: true },
    { id: 'ch-off', type: 'anthropic', name: 'Off', apiKey: '', model: 'claude-3-5-sonnet', enabled: false },
    { id: 'ch-ollama', type: 'ollama', name: 'Ollama', apiKey: '', model: 'llama3' },
  ],
})

function makeParsed(): ReturnType<typeof parseSettingsExport> {
  const parsed = parseSettingsExport(SETTINGS_RAW, 'graycode-settings.json')
  if (!parsed.ok) throw new Error('fixture parse failed')
  return parsed
}

function makeInput(runId = 'run_1'): WriteTargetInput {
  const object: PlannedObject = {
    domain: 'settings',
    objectType: 'settings',
    legacyId: 'graycode-settings.json',
    sourceHash: 'h',
    outcome: 'import',
    data: makeParsed(),
  }
  return { runId, object, sourceDir: '/tmp/src' }
}

interface SettingsMock {
  settings: {
    get(ns: string): unknown
    mutate(ns: string, ops: SettingsOp[]): Promise<void>
  }
  providers: Record<string, unknown>
  ops: SettingsOp[]
}

/** settings 服务 mock：registered=false 模拟 llm-pi-ai 未注册；mutateError 模拟校验拒绝 */
function makeSettingsMock(
  initial?: Record<string, unknown>,
  opts: { registered?: boolean; mutateError?: Error } = {},
): SettingsMock {
  const providers: Record<string, unknown> = { ...(initial ?? {}) }
  const ops: SettingsOp[] = []
  const settings = {
    get(ns: string): unknown {
      if (opts.registered === false) return undefined
      return ns === LLM_PI_AI_NAMESPACE ? { providers: { ...providers } } : undefined
    },
    async mutate(_ns: string, nextOps: SettingsOp[]): Promise<void> {
      if (opts.mutateError) throw opts.mutateError
      for (const op of nextOps) {
        ops.push(op)
        if (op.op === 'set' && op.path[0] === 'providers' && op.path[1] !== undefined) {
          providers[op.path[1]] = op.value
        }
      }
    },
  }
  return { settings, providers, ops }
}

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'migration-settings-target-'))
}

function readSuggested(importsRoot: string, runId: string): {
  dshWrite: {
    mode: string
    writtenRoutes: string[]
    conflictSkippedRoutes: string[]
    skippedChannels: string[]
    credentialRefs: string[]
    credentialStates?: Record<string, boolean>
    rejectionMessage?: string
  }
  channels: Array<{ id: string; route?: string; credentialRef?: string; unmigratedFields?: string[] }>
  [k: string]: unknown
} {
  const raw = fs.readFileSync(path.join(importsRoot, runId, 'settings.suggested.json'), 'utf-8')
  return JSON.parse(raw) as ReturnType<typeof readSuggested>
}

describe('DSH 直写（merge 语义）', () => {
  test('新 route 写入 llm-pi-ai.providers；已有 route 跳过不覆盖', async () => {
    const importsRoot = makeTempRoot()
    try {
      const mock = makeSettingsMock({ openai: { apiKeyEnv: 'EXISTING_OPENAI_KEY' } })
      const writer = createSettingsTargetWriter({ importsRoot, ctx: { settings: mock.settings } })
      const result = await writer.write(makeInput())

      // 已写入 google（gemini 渠道）；openai 已有 route 未覆盖
      expect(mock.providers.google).toMatchObject({
        apiKeyEnv: 'GRAYCODE_GEMINI_CH_GEMINI_API_KEY',
        baseURL: 'https://example.invalid/v1',
        displayName: 'Gemini',
      })
      expect(mock.providers.google).not.toHaveProperty('api')
      expect(mock.providers.openai).toEqual({ apiKeyEnv: 'EXISTING_OPENAI_KEY' })

      // mutate 只收到 google 一个 set（merge：不 restate 其他字段）
      expect(mock.ops).toHaveLength(1)
      expect(mock.ops[0]).toMatchObject({ op: 'set', path: ['providers', 'google'] })

      const suggested = readSuggested(importsRoot, 'run_1')
      expect(suggested.dshWrite.mode).toBe('direct')
      expect(suggested.dshWrite.writtenRoutes.some(r => r.includes('google'))).toBe(true)
      expect(suggested.dshWrite.conflictSkippedRoutes.some(r => r.includes('openai'))).toBe(true)
      // 凭据重录引用（apiKey 已脱敏）
      expect(suggested.dshWrite.credentialRefs).toContain('GRAYCODE_GEMINI_CH_GEMINI_API_KEY')

      const notes = result.notes ?? []
      expect(notes.join('\n')).toContain('llm-pi-ai.providers')
      expect(notes.join('\n')).toContain('不覆盖用户已有渠道')
      expect(notes.join('\n')).toContain('GRAYCODE_GEMINI_CH_GEMINI_API_KEY')
      expect(result.targetRef).toBe('artifact://settings/run_1/settings.suggested.json')
    } finally {
      fs.rmSync(importsRoot, { recursive: true, force: true })
    }
  })

  test('disabled 与 provider 不受支持的渠道不注册 route', async () => {
    const importsRoot = makeTempRoot()
    try {
      const mock = makeSettingsMock()
      const writer = createSettingsTargetWriter({ importsRoot, ctx: { settings: mock.settings } })
      await writer.write(makeInput())

      expect(Object.keys(mock.providers).sort()).toEqual(['google', 'openai'])
      expect(mock.providers.anthropic).toBeUndefined()
      expect(mock.providers.ollama).toBeUndefined()

      const suggested = readSuggested(importsRoot, 'run_1')
      expect(suggested.dshWrite.skippedChannels.some(s => s.includes('ch-off') && s.includes('enabled:false'))).toBe(true)
      expect(suggested.dshWrite.skippedChannels.some(s => s.includes('ch-ollama'))).toBe(true)
      // 建议文件渠道条目：disabled 渠道无 route 字段
      expect(suggested.channels.find(c => c.id === 'ch-off')?.route).toBeUndefined()
      expect(suggested.channels.find(c => c.id === 'ch-gemini')?.route).toBe('google')
    } finally {
      fs.rmSync(importsRoot, { recursive: true, force: true })
    }
  })
})

describe('降级回退', () => {
  test('settings 服务未挂载（无 ctx）→ 只出建议文件', async () => {
    const importsRoot = makeTempRoot()
    try {
      const writer = createSettingsTargetWriter({ importsRoot })
      const result = await writer.write(makeInput())
      const suggested = readSuggested(importsRoot, 'run_1')
      expect(suggested.dshWrite.mode).toBe('suggested-only')
      expect((result.notes ?? []).join('\n')).toContain('仅产出建议文件')
    } finally {
      fs.rmSync(importsRoot, { recursive: true, force: true })
    }
  })

  test('llm-pi-ai 命名空间未注册（get 返回 undefined）→ 回退建议文件-only，不调 mutate', async () => {
    const importsRoot = makeTempRoot()
    try {
      const mock = makeSettingsMock({}, { registered: false })
      const writer = createSettingsTargetWriter({ importsRoot, ctx: { settings: mock.settings } })
      await writer.write(makeInput())
      expect(mock.ops).toHaveLength(0)
      expect(readSuggested(importsRoot, 'run_1').dshWrite.mode).toBe('suggested-only')
    } finally {
      fs.rmSync(importsRoot, { recursive: true, force: true })
    }
  })

  test('mutate 被拒（settings-rejected）→ 回退建议文件，write 不抛出（失败隔离）', async () => {
    const importsRoot = makeTempRoot()
    try {
      const mock = makeSettingsMock(
        {},
        { mutateError: new Error('llm-pi-ai: provider "google" model "x" cannot be served') },
      )
      const writer = createSettingsTargetWriter({ importsRoot, ctx: { settings: mock.settings } })
      const result = await writer.write(makeInput()) // 不抛出
      const suggested = readSuggested(importsRoot, 'run_1')
      expect(suggested.dshWrite.mode).toBe('settings-rejected')
      expect(suggested.dshWrite.rejectionMessage).toContain('cannot be served')
      expect((result.notes ?? []).join('\n')).toContain('settings-rejected')
      // 任何渠道都未写入
      expect(Object.keys(mock.providers)).toHaveLength(0)
    } finally {
      fs.rmSync(importsRoot, { recursive: true, force: true })
    }
  })
})

describe('probe 路径校验', () => {
  test('只接受 runId 格式路径段；越界引用一律 false', async () => {
    const importsRoot = makeTempRoot()
    try {
      const writer = createSettingsTargetWriter({ importsRoot })
      // 本 writer 总是实现 probe（TargetWriterPort 接口上可选）
      const probe = writer.probe!
      expect(await probe('artifact://settings/../secret.txt')).toBe(false)
      expect(await probe('artifact://settings/..')).toBe(false)
      expect(await probe('artifact://settings/run_1/..%2Fevil/settings.suggested.json')).toBe(false)
      expect(await probe('artifact://settings/other/settings.suggested.json')).toBe(false)
      expect(await probe('artifact://settings/run_1/settings.suggested.json')).toBe(false)

      await writer.write(makeInput())
      expect(await probe('artifact://settings/run_1/settings.suggested.json')).toBe(true)
      expect(await probe('artifact://settings/run_2/settings.suggested.json')).toBe(false)
    } finally {
      fs.rmSync(importsRoot, { recursive: true, force: true })
    }
  })
})

describe('ctx.credentials 信息性探测', () => {
  test('credentials.describe 可用时写入建议文件（best-effort，失败不影响 write）', async () => {
    const importsRoot = makeTempRoot()
    try {
      const mock = makeSettingsMock()
      let describeCalls = 0
      const credentials = {
        async describe(ref: string): Promise<{ configured: boolean; writable: boolean }> {
          describeCalls += 1
          return { configured: ref === 'GRAYCODE_GEMINI_CH_GEMINI_API_KEY', writable: true }
        },
      }
      const writer = createSettingsTargetWriter({
        importsRoot,
        ctx: { settings: mock.settings, credentials } as DshHostContextLike,
      })
      await writer.write(makeInput())
      // 仅对需重录凭据的渠道探测（ch-gemini 有 apiKey）
      expect(describeCalls).toBe(1)
      expect(mock.providers.google).toBeDefined()
      const suggested = readSuggested(importsRoot, 'run_1')
      expect(suggested.dshWrite.credentialStates).toEqual({ GRAYCODE_GEMINI_CH_GEMINI_API_KEY: true })
    } finally {
      fs.rmSync(importsRoot, { recursive: true, force: true })
    }
  })
})

describe('mapper 产出可被真实 dsh-llm-pi-ai 服务（集成探针）', () => {
  test('映射 profile 挂载真实 pi-ai 适配器后注册对应 route（google/openai/anthropic）', () => {
    const parsed = makeParsed()
    const mapped = mapChannelsToPiAiProfiles(parsed.channels.filter(c => c.providerSupported && c.enabled))
    const providers: Record<string, unknown> = {}
    for (const m of mapped) providers[m.route] = m.profile
    expect(Object.keys(providers).sort()).toEqual(['google', 'openai'])

    const ctx = new Context()
    new LlmRuntime(ctx)
    // 与 tests/providers/matrix.test.ts 同模式：真实 apply 入口 + 无网络、无凭据
    expect(() => applyPiAi(ctx, { providers } as never)).not.toThrow()
    const ids = ctx.llm.listProviders().map(p => p.id)
    expect(ids).toContain('google')
    expect(ids).toContain('openai')
    expect(new Set(ids).size).toBe(ids.length)
  })
})
