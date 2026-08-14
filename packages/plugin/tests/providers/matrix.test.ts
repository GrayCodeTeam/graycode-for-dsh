/**
 * Provider capability matrix 探针测试（Phase 2 收尾，docs/PLAN_V2.md §6.3）。
 *
 * 目标：不调用任何外部 API、不写入任何 API key，用真实 Context 挂载
 * `@deepseek-ai/dsh-llm-deepseek` 与 `@deepseek-ai/dsh-llm-pi-ai` 的
 * `apply(ctx, config)` 入口，验证：
 *   - 适配器注册面：ctx.llm.listProviders() 的 provider 路由集合覆盖
 *     DeepSeek（deepseek-official + pi-ai deepseek）、OpenAI-compatible
 *     （hand-declared openai-completions）、OpenAI Responses（catalog openai）、
 *     Anthropic（catalog anthropic）、Gemini（catalog google）；
 *   - 模型目录/容量/推理档位/输入模态元数据（纯内存解析，不发请求）；
 *   - 无 key 时的失败路径（MISSING_CREDENTIAL finish 块）与取消路径
 *     （aborted finish 块），两者都发生在任何网络 I/O 之前。
 *
 * 测试风格参照 tests/workflows/tools-e2e.test.ts：真实 Context、直接调入口、
 * 零外部服务。唯一的环境假设是被测机未导出相关 provider 的 API key
 * （beforeAll/afterAll 会清空并还原，避免误触网络；真实 key 补测见
 * docs/PROVIDER_MATRIX.md「如何补测真实 key」）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  LlmError,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  DeepSeekAdapter,
  PUBLIC_BASE_URL,
  apply as applyDeepSeek,
  resolveAdapterOptions,
  type DeepSeekAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import { PiAiAdapter, apply as applyPiAi, supportedProtocols } from '@deepseek-ai/dsh-llm-pi-ai'

/**
 * dsh-anonymous-user-id 的 AnonymousUserId 是 branded 类型且未作为本包直接依赖导出；
 * 从 DeepSeekAdapterOptions.resolveUserId 派生结构等价类型（精确等于该 branded 类型）。
 */
type AnonymousUserId = ReturnType<DeepSeekAdapterOptions['resolveUserId']>

/** 环境变量守卫：测试期间删除这些 key，确保任何路径都解析不到真实凭据。 */
const GUARDED_ENV = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
] as const

let savedEnv: Partial<Record<(typeof GUARDED_ENV)[number], string | undefined>>

beforeAll(() => {
  savedEnv = {}
  for (const key of GUARDED_ENV) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterAll(() => {
  for (const key of GUARDED_ENV) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** 挂载真实 LLM 注册表服务（同 tools-e2e 的 new LocalFileSystem 模式）。 */
function harness(): Context {
  const ctx = new Context()
  new LlmRuntime(ctx)
  return ctx
}

/** pi-ai 探针配置：5 条目标渠道路由（catalog 路由 + 一条 hand-declared OpenAI 兼容网关）。 */
const PI_AI_PROVIDERS = {
  openai: { apiKeyEnv: 'OPENAI_API_KEY' },
  anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
  google: { apiKeyEnv: 'GEMINI_API_KEY' },
  deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
  'openai-compat': {
    displayName: 'OpenAI Compatible Gateway',
    api: 'openai-completions',
    baseURL: 'https://gateway.example/v1',
    models: [{ id: 'gpt-4o-mini', contextWindow: 128_000, maxTokens: 16_384 }],
  },
}

/** 收集一次 stream 的全部 chunk；仅限会以 finish 块结束且不触网的路径。 */
async function collectChunks(ctx: Context, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
  return chunks
}

describe('provider capability matrix — 注册面与 provider 名（无网络）', () => {
  it('LlmRuntime 挂载后注册表为空', () => {
    const ctx = harness()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('dsh-llm-deepseek 注册 deepseek-official：目录、容量、推理档位', async () => {
    const ctx = harness()
    applyDeepSeek(ctx, {})

    const ids = ctx.llm.listProviders().map((p) => p.id)
    expect(ids).toEqual(['deepseek-official'])
    expect(ctx.llm.listProviders()[0]?.name).toBe('DeepSeek')

    const models = await ctx.llm.listModels('deepseek-official')
    expect(models.map((m) => m.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(models.every((m) => m.inputModalities?.includes('text'))).toBe(true)

    const info = await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-flash')
    expect(info.context?.contextWindow).toBe(1_000_000)
    expect(info.defaultMaxTokens).toBe(256_000)
    expect(info.reasoning?.efforts.map((e) => e.id)).toEqual(['off', 'high', 'max'])
    expect(info.reasoning?.defaultEffort).toBe('high')
  })

  it('dsh-llm-pi-ai 注册 5 条目标渠道路由（含 hand-declared openai-completions）', () => {
    const ctx = harness()
    applyPiAi(ctx, { providers: PI_AI_PROVIDERS })

    const providers = ctx.llm.listProviders()
    const ids = providers.map((p) => p.id)
    // 5 条 pi-ai 路由覆盖 5 个目标渠道（DeepSeek 渠道的另一条路由 deepseek-official
    // 由 dsh-llm-deepseek 提供，见「双路径共存」用例）：
    //   deepseek（pi-ai catalog）/ openai-compat（OpenAI-compatible）/
    //   openai（OpenAI Responses）/ anthropic / google（Gemini）
    expect(ids).toContain('deepseek')
    expect(ids).toContain('openai-compat')
    expect(ids).toContain('openai')
    expect(ids).toContain('anthropic')
    expect(ids).toContain('google')
    // 注册面无重复路由
    expect(new Set(ids).size).toBe(ids.length)
    // hand-declared 路由的显示名来自 profile.displayName
    expect(providers.find((p) => p.id === 'openai-compat')?.name).toBe('OpenAI Compatible Gateway')
  })

  it('pi-ai 目录路由的模型元数据无需网络（OpenAI Responses / Gemini / Anthropic）', async () => {
    const ctx = harness()
    applyPiAi(ctx, { providers: PI_AI_PROVIDERS })

    const oai = await ctx.llm.listModels('openai')
    expect(oai.length).toBeGreaterThan(0)
    expect(oai.some((m) => m.id === 'gpt-5')).toBe(true)

    const gpt5 = await ctx.llm.resolveModelInfo('openai', 'gpt-5')
    expect(gpt5.context?.contextWindow).toBe(400_000)
    expect(gpt5.inputModalities).toContain('image')
    expect(gpt5.reasoning?.efforts.length).toBeGreaterThan(0)

    const gemini = await ctx.llm.resolveModelInfo('google', 'gemini-2.5-pro')
    expect(gemini.context?.contextWindow).toBe(1_048_576)
    expect(gemini.inputModalities).toEqual(expect.arrayContaining(['text', 'image']))
    expect(gemini.reasoning?.efforts.map((e) => e.id)).toEqual(['off', 'minimal', 'low', 'medium', 'high'])

    const claude = await ctx.llm.resolveModelInfo('anthropic', 'claude-sonnet-4-5')
    expect(claude.context?.contextWindow).toBe(1_000_000)
    expect(claude.inputModalities).toContain('image')
  })

  it('休眠挂载：零路由但声明完整 catalog 目录（排除 OAuth-only 的 openai-codex）', () => {
    const ctx = harness()
    applyPiAi(ctx, {})

    expect(ctx.llm.listProviders()).toEqual([])
    const directory = ctx.llm.listConfigurableProviders().map((d) => d.provider)
    for (const wanted of ['deepseek', 'openai', 'anthropic', 'google']) {
      expect(directory).toContain(wanted)
    }
    // OAuth-only 提供商不进入目录：pi-ai 侧无 credential store、无登录流
    expect(directory).not.toContain('openai-codex')
  })

  it('hand-declared 路由在目录中标记 declared；catalog 路由无该标记', () => {
    const ctx = harness()
    applyPiAi(ctx, { providers: PI_AI_PROVIDERS })

    const directory = ctx.llm.listConfigurableProviders()
    const gateway = directory.find((d) => d.provider === 'openai-compat')
    expect(gateway?.declared).toBe(true)
    expect(gateway?.settingsPath).toEqual(['providers', 'openai-compat'])
    expect(directory.find((d) => d.provider === 'deepseek')?.declared).toBeFalsy()
  })

  it('deepseek-official 与 pi-ai 的 deepseek catalog 路由双路径共存', async () => {
    const ctx = harness()
    applyDeepSeek(ctx, {})
    applyPiAi(ctx, { providers: { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' } } })

    expect(ctx.llm.listProviders().map((p) => p.id).sort())
      .toEqual(['deepseek', 'deepseek-official'])
    expect((await ctx.llm.resolveModelInfo('deepseek', 'deepseek-v4-pro')).context?.contextWindow)
      .toBe(1_000_000)
    expect((await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-pro')).context?.contextWindow)
      .toBe(1_000_000)
  })

  it('supportedProtocols() 暴露三种可完整声明的 wire 协议', () => {
    expect(supportedProtocols())
      .toEqual(['openai-completions', 'openai-responses', 'anthropic-messages'])
  })

  it('PiAiAdapter / DeepSeekAdapter 实例化并满足 LlmAdapter 抽象契约', () => {
    // 类型面：实现唯一必须的抽象方法 stream(options): AsyncIterable<StreamChunk>
    class ProbeAdapter extends LlmAdapter {
      async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', index: 0, text: 'probe' }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    expect(new ProbeAdapter()).toBeInstanceOf(LlmAdapter)

    // 运行时面：用各包导出的真实适配器类验证构造与继承
    const piAi = new PiAiAdapter({
      profiles: () => new Map(),
      resolveApiKey: async () => undefined,
    })
    expect(piAi).toBeInstanceOf(LlmAdapter)

    const connection = resolveAdapterOptions({}, undefined)
    const deepSeek = new DeepSeekAdapter({
      options: () => connection,
      resolveApiKey: async () => '',
      resolveUserId: () => 'probe' as unknown as AnonymousUserId,
    })
    expect(deepSeek).toBeInstanceOf(LlmAdapter)
    // 端点事实：默认走公开 API，且可被自定义 baseURL 覆盖
    expect(PUBLIC_BASE_URL).toBe('https://api.deepseek.com')
  })
})

describe('provider capability matrix — 凭据与取消路径（无网络）', () => {
  it('无 key 时 deepseek-official 的 stream 产出 MISSING_CREDENTIAL finish 错误块', async () => {
    const ctx = harness()
    applyDeepSeek(ctx, {})

    const chunks = await collectChunks(ctx, {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    })
    const finish = chunks.at(-1)
    expect(finish?.type).toBe('finish')
    if (finish?.type !== 'finish') return
    expect(finish.reason.kind).toBe('error')
    if (finish.reason.kind !== 'error') return
    expect(finish.reason.failure.code).toBe('MISSING_CREDENTIAL')
    // 失败路径不产生任何内容块
    expect(chunks.filter((c) => c.type === 'text-delta')).toEqual([])
  })

  it('无 key 时 pi-ai 路由的 stream 同样产出 MISSING_CREDENTIAL finish 错误块', async () => {
    const ctx = harness()
    applyPiAi(ctx, { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } })

    const chunks = await collectChunks(ctx, {
      provider: 'openai',
      model: 'gpt-5',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    })
    const finish = chunks.at(-1)
    expect(finish?.type).toBe('finish')
    if (finish?.type !== 'finish') return
    expect(finish.reason.kind).toBe('error')
    if (finish.reason.kind !== 'error') return
    expect(finish.reason.failure.code).toBe('MISSING_CREDENTIAL')
  })

  it('预置 aborted 信号时 stream 产出 aborted finish 块（两条 DeepSeek 路径）', async () => {
    const ctx = harness()
    applyDeepSeek(ctx, {})
    applyPiAi(ctx, { providers: { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' } } })

    for (const provider of ['deepseek-official', 'deepseek']) {
      const controller = new AbortController()
      controller.abort()
      const chunks = await collectChunks(ctx, {
        provider,
        model: 'deepseek-v4-flash',
        messages: [],
        signal: controller.signal,
      })
      const finish = chunks.at(-1)
      expect(finish?.type).toBe('finish')
      if (finish?.type !== 'finish') continue
      expect(finish.reason.kind).toBe('aborted')
    }
  })

  it('LlmError 携带稳定 failure 事实', () => {
    const error = new LlmError('boom', 'RATE_LIMIT', { status: 429 })
    expect(error.failure).toMatchObject({ message: 'boom', code: 'RATE_LIMIT', status: 429 })
  })
})
