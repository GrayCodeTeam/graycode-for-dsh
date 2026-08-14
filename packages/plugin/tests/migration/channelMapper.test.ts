/**
 * channelMapper 纯函数单测（渠道 → DSH llm-pi-ai provider profile 映射）
 *
 * 覆盖：type→route/api 映射、route 冲突命名、凭据引用（POSIX 标识符 + 去重）、
 * models/timeout/retry/customHeaders/reasoning/thinking 映射、不可映射字段 warnings。
 */
import { describe, expect, test } from 'vitest'
import {
  CHANNEL_TYPE_APIS,
  CHANNEL_TYPE_ROUTES,
  REDACTED_PLACEHOLDER,
  assignChannelRoutes,
  credentialRefFor,
  listUnmigratedChannelFields,
  mapChannelToPiAiProfile,
  mapChannelsToPiAiProfiles,
  type ChannelMappingSource,
} from '../../src/migration/domain/channelMapper.ts'

const POSIX_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function ch(id: string, type: string, extra: Partial<ChannelMappingSource> = {}): ChannelMappingSource {
  return { id, type, apiKeyRedacted: false, enabled: true, ...extra }
}

describe('type → route / api 映射', () => {
  test('gemini → route google；api 省略（catalog google 模型自带 google-generative-ai 协议）', () => {
    const mapped = mapChannelToPiAiProfile(
      ch('ch-demo', 'gemini', { name: 'Demo Gemini', url: 'https://example.invalid/v1' }),
    )
    expect(mapped.route).toBe('google')
    expect(mapped.profile.api).toBeUndefined()
    expect(mapped.profile.baseURL).toBe('https://example.invalid/v1')
    expect(mapped.profile.displayName).toBe('Demo Gemini')
    expect(mapped.profile.apiKeyEnv).toBe('GRAYCODE_GEMINI_CH_DEMO_API_KEY')
  })

  test('openai → route openai 且 api=openai-completions（老渠道实际走 chat-completions）', () => {
    const mapped = mapChannelToPiAiProfile(ch('ch-gpt', 'openai'))
    expect(mapped.route).toBe('openai')
    expect(mapped.profile.api).toBe('openai-completions')
  })

  test('openai-responses → route openai 且 api 省略（catalog 默认即 openai-responses）', () => {
    const mapped = mapChannelToPiAiProfile(ch('ch-resp', 'openai-responses'))
    expect(mapped.route).toBe('openai')
    expect(mapped.profile.api).toBeUndefined()
  })

  test('anthropic → route anthropic 且 api 省略（catalog 模型自带 anthropic-messages）', () => {
    const mapped = mapChannelToPiAiProfile(ch('ch-claude', 'anthropic'))
    expect(mapped.route).toBe('anthropic')
    expect(mapped.profile.api).toBeUndefined()
  })

  test('不受支持的 type：单渠道返回 route="" + 警告；批量映射跳过', () => {
    const single = mapChannelToPiAiProfile(ch('ch-ollama', 'ollama'))
    expect(single.route).toBe('')
    expect(single.warnings.some(w => w.includes('不受支持'))).toBe(true)

    const batch = mapChannelsToPiAiProfiles([ch('ch-ok', 'gemini'), ch('ch-ollama', 'ollama')])
    expect(batch).toHaveLength(1)
    expect(batch[0]!.channelId).toBe('ch-ok')
  })

  test('route 命名表与 api 覆盖表覆盖全部受支持 type', () => {
    for (const type of ['gemini', 'openai', 'openai-responses', 'anthropic']) {
      expect(CHANNEL_TYPE_ROUTES[type]).toBeTruthy()
      expect(CHANNEL_TYPE_APIS[type] === undefined || typeof CHANNEL_TYPE_APIS[type] === 'string').toBe(true)
    }
  })
})

describe('route 冲突命名', () => {
  test('同 type 多渠道：第二个渠道 route = type-<channelId 短后缀>', () => {
    const routes = assignChannelRoutes([
      ch('channel_demo_gemini', 'gemini'),
      ch('channel_work_gemini', 'gemini'),
    ])
    expect(routes.get('channel_demo_gemini')).toBe('google')
    expect(routes.get('channel_work_gemini')).toMatch(/^google-[a-z0-9-]+$/)
    expect(routes.get('channel_work_gemini')).not.toBe('google')
  })

  test('不同 type 的渠道互不挤占 route', () => {
    const routes = assignChannelRoutes([ch('a', 'gemini'), ch('b', 'anthropic'), ch('c', 'openai'), ch('d', 'openai-responses')])
    expect(routes.get('a')).toBe('google')
    expect(routes.get('b')).toBe('anthropic')
    expect(routes.get('c')).toBe('openai')
    expect(routes.get('d')).toMatch(/^openai-/)
  })

  test('同后缀碰撞：追加序号保证唯一', () => {
    // 两个 id 清洗后同后缀（a_b / a-b → a-b），第二个带 -2
    const routes = assignChannelRoutes([ch('a_b', 'gemini'), ch('a-b', 'gemini'), ch('a-b', 'gemini')])
    const values = [...routes.values()]
    expect(new Set(values).size).toBe(values.length)
    expect(values.some(v => /-2$/.test(v))).toBe(true)
  })
})

describe('凭据引用', () => {
  test('格式：GRAYCODE_<TYPE>_<ID>_API_KEY，POSIX 标识符（大写字母数字下划线）', () => {
    for (const [id, type, expected] of [
      ['ch-demo', 'gemini', 'GRAYCODE_GEMINI_CH_DEMO_API_KEY'],
      ['channel_demo_gemini', 'gemini', 'GRAYCODE_GEMINI_CHANNEL_DEMO_GEMINI_API_KEY'],
      ['ch-gpt', 'openai-responses', 'GRAYCODE_OPENAI_RESPONSES_CH_GPT_API_KEY'],
      ['a.b/c', 'anthropic', 'GRAYCODE_ANTHROPIC_A_B_C_API_KEY'],
    ] as const) {
      const ref = credentialRefFor(ch(id, type))
      expect(ref).toBe(expected)
      expect(POSIX_REF_RE.test(ref)).toBe(true)
    }
  })

  test('批量映射：sanitize 后同引用的渠道追加 _2 去重', () => {
    const batch = mapChannelsToPiAiProfiles([ch('a-b', 'gemini'), ch('a_b', 'gemini')])
    const refs = batch.map(m => m.credentialRef)
    expect(refs).toContain('GRAYCODE_GEMINI_A_B_API_KEY')
    expect(refs).toContain('GRAYCODE_GEMINI_A_B_API_KEY_2')
    expect(new Set(refs).size).toBe(refs.length)
    for (const ref of refs) expect(POSIX_REF_RE.test(ref)).toBe(true)
  })

  test('profile.apiKeyEnv 与结果 credentialRef 一致', () => {
    const mapped = mapChannelToPiAiProfile(ch('ch-x', 'gemini'))
    expect(mapped.profile.apiKeyEnv).toBe(mapped.credentialRef)
  })
})

describe('字段映射', () => {
  test('models：channel.models 映射 id/name/contextWindow/maxTokens；缺省回退单 model 字段', () => {
    const mapped = mapChannelToPiAiProfile(
      ch('ch-m', 'openai', {
        models: [
          { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxTokens: 16384 },
          { id: 'gpt-4o' }, // 去重
        ],
      }),
    )
    expect(mapped.profile.models).toEqual([{ id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxTokens: 16384 }])

    const fallback = mapChannelToPiAiProfile(ch('ch-f', 'gemini', { model: 'gemini-2.5-flash' }))
    expect(fallback.profile.models).toEqual([{ id: 'gemini-2.5-flash' }])

    const none = mapChannelToPiAiProfile(ch('ch-n', 'gemini'))
    expect(none.profile.models).toBeUndefined()
  })

  test('timeout → timeoutMs；retryEnabled/count/interval → retryPolicy', () => {
    const mapped = mapChannelToPiAiProfile(
      ch('ch-r', 'gemini', { timeout: 120000, retryEnabled: true, retryCount: 3, retryInterval: 2000 }),
    )
    expect(mapped.profile.timeoutMs).toBe(120000)
    expect(mapped.profile.retryPolicy).toEqual({ mode: 'normal', maxRetries: 3, backoff: { initialDelayMs: 2000 } })

    const disabled = mapChannelToPiAiProfile(ch('ch-r2', 'gemini', { retryEnabled: false, retryCount: 3 }))
    expect(disabled.profile.retryPolicy).toBeUndefined()

    const noCount = mapChannelToPiAiProfile(ch('ch-r3', 'gemini', { retryEnabled: true }))
    expect(noCount.profile.retryPolicy).toBeUndefined()
  })

  test('customHeaders：脱敏占位值丢弃并警告；非敏感值明文保留', () => {
    const mapped = mapChannelToPiAiProfile(
      ch('ch-h', 'gemini', { customHeaders: { Authorization: REDACTED_PLACEHOLDER, 'X-Custom': 'v1' } }),
    )
    expect(mapped.profile.headers).toEqual({ 'X-Custom': 'v1' })
    expect(mapped.warnings.some(w => w.includes('敏感头已脱敏'))).toBe(true)
    expect(mapped.warnings.some(w => w.includes('明文'))).toBe(true)
  })

  test('options.reasoning.effort → reasoning（合法档位）；非法值警告且跳过', () => {
    const ok = mapChannelToPiAiProfile(ch('ch-e', 'gemini', { options: { reasoning: { effort: 'high' } } }))
    expect(ok.profile.reasoning).toBe('high')

    const bad = mapChannelToPiAiProfile(ch('ch-e2', 'gemini', { options: { reasoning: { effort: 'ultra' } } }))
    expect(bad.profile.reasoning).toBeUndefined()
    expect(bad.warnings.some(w => w.includes('options.reasoning.effort'))).toBe(true)
  })

  test('options.thinking.type → compat.thinkingFormat（仅 openai-completions 协议）', () => {
    const oai = mapChannelToPiAiProfile(ch('ch-t', 'openai', { options: { thinking: { type: 'deepseek' } } }))
    expect(oai.profile.compat).toEqual({ thinkingFormat: 'deepseek' })

    // gemini（非 completions 协议）：警告且不写 compat
    const gemini = mapChannelToPiAiProfile(ch('ch-t2', 'gemini', { options: { thinking: { type: 'deepseek' } } }))
    expect(gemini.profile.compat).toBeUndefined()
    expect(gemini.warnings.some(w => w.includes('openai-completions'))).toBe(true)

    // 非法 format：警告且跳过
    const bad = mapChannelToPiAiProfile(ch('ch-t3', 'openai', { options: { thinking: { type: 'qwen-chat-template' } } }))
    expect(bad.profile.compat).toBeUndefined()
    expect(bad.warnings.some(w => w.includes('compat.thinkingFormat'))).toBe(true)
  })
})

describe('不可映射字段（不迁移清单）', () => {
  test('temperature/top_p/max_tokens/stream/toolMode 全部进 warnings 与 listUnmigratedChannelFields', () => {
    const source = ch('ch-u', 'gemini', {
      toolMode: 'function_call',
      options: { stream: true, temperature: 0.7, top_p: 0.95, max_tokens: 8192 },
      optionsEnabled: { temperature: true },
    })
    const mapped = mapChannelToPiAiProfile(source)
    for (const field of ['options.temperature', 'options.top_p', 'options.max_tokens', 'options.stream', 'toolMode']) {
      expect(mapped.warnings.some(w => w.includes(field) && w.includes('不迁移'))).toBe(true)
    }
    const names = listUnmigratedChannelFields(source)
    for (const field of ['options.temperature', 'options.top_p', 'options.max_tokens', 'options.stream', 'toolMode']) {
      expect(names).toContain(field)
    }
    // reasoning/thinking 已映射，不进清单
    expect(names).not.toContain('options.reasoning')
    expect(names).not.toContain('options.thinking')
  })

  test('thinking.budget_tokens 无配置面等价 → 进清单', () => {
    const names = listUnmigratedChannelFields(
      ch('ch-b', 'gemini', { options: { thinking: { type: 'disabled', budget_tokens: 4096 } } }),
    )
    expect(names).toContain('options.thinking.budget_tokens')
  })
})
