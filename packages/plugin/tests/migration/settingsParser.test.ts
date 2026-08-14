/**
 * settingsParser 解析器测试（settings 相关）
 *
 * 覆盖：url query 参数与 MCP command/args 凭据脱敏、openai-responses 受支持、
 * 渠道可映射字段（models/timeout/retryEnabled 等/customHeaders/options/optionsEnabled）、
 * 不迁移字段清单、disabled 渠道保留。
 */
import { describe, expect, test } from 'vitest'
import {
  REDACTED_PLACEHOLDER,
  parseSettingsExport,
} from '../../src/migration/adapters/legacy/settingsParser.ts'

describe('url query / CLI 凭据脱敏', () => {
  test('channel.url 的 ?key=xxx / ?api_key=xxx 值脱敏为 [REDACTED]，非敏感参数保留', () => {
    const parsed = parseSettingsExport(
      JSON.stringify({
        version: '1.0',
        graycodeVersion: '1.5.4',
        channelConfigs: [
          { id: 'ch1', type: 'gemini', apiKey: '', url: 'https://example.invalid/v1?apiKey=sk-live-1&token=tok-1&model=flash' },
        ],
      }),
      'graycode-settings.json',
    )
    expect(parsed.ok).toBe(true)
    expect(parsed.channels[0]?.url).toBe('https://example.invalid/v1?apiKey=[REDACTED]&token=[REDACTED]&model=flash')
    const json = JSON.stringify(parsed)
    expect(json).not.toContain('sk-live-1')
    expect(json).not.toContain('tok-1')
    // 脱敏发生在 url → 该渠道进入凭据重录清单
    expect(parsed.credentialReentryRequired).toContain('ch1')
  })

  test('accessKey / consumerKey / privateKey 形态的对象键值同样脱敏', () => {
    const parsed = parseSettingsExport(
      JSON.stringify({
        version: '1.0',
        graycodeVersion: '1.5.4',
        vscodeSettings: {
          'graycode.channelConfigs': [
            {
              id: 'ch-aws',
              type: 'openai',
              apiKey: '',
              headers: { accessKey: 'AKID-live-aws-1', consumerKey: 'ck-live-2', xConsumerKey: 'x-ck-3', privateKey: 'pk-live-4', acceptable: 'keep-me' },
            },
          ],
        },
      }),
      'graycode-settings.json',
    )
    expect(parsed.ok).toBe(true)
    const json = JSON.stringify(parsed)
    for (const secret of ['AKID-live-aws-1', 'ck-live-2', 'x-ck-3', 'pk-live-4']) {
      expect(json).not.toContain(secret)
    }
    // 非敏感键（acceptable 不含 secret 语义）原样保留
    expect(json).toContain('keep-me')
  })

  test('MCP transport command/args 的 --token=xxx / --api-key=xxx / auth=xxx 值脱敏', () => {
    const parsed = parseSettingsExport(
      JSON.stringify({
        version: '1.0',
        graycodeVersion: '1.5.4',
        mcpServers: [
          {
            id: 'm1',
            name: 'm1',
            transport: {
              type: 'stdio',
              command: 'node --token=cmd-secret',
              args: ['--token=abc123', '--api-key=xyz789', 'serve', 'auth=deadbeef', '--limit=10'],
            },
          },
        ],
      }),
      'graycode-settings.json',
    )
    expect(parsed.ok).toBe(true)
    const server = parsed.mcpServers[0]!
    expect(server.command).toBe('node --token=[REDACTED]')
    expect(server.args).toEqual(['--token=[REDACTED]', '--api-key=[REDACTED]', 'serve', 'auth=[REDACTED]', '--limit=10'])
    expect(server.cliRedacted).toBe(true)
    const json = JSON.stringify(parsed)
    for (const secret of ['cmd-secret', 'abc123', 'xyz789', 'deadbeef']) expect(json).not.toContain(secret)
    expect(parsed.credentialReentryRequired).toContain('mcp:m1')
  })

  test('非 secret 参数与命令原样保留', () => {
    const parsed = parseSettingsExport(
      JSON.stringify({
        version: '1.0',
        mcpServers: [{ id: 'm2', transport: { type: 'stdio', command: 'node', args: ['./s.js', '--model=gpt'] } }],
      }),
      'x.json',
    )
    expect(parsed.mcpServers[0]?.args).toEqual(['./s.js', '--model=gpt'])
    expect(parsed.mcpServers[0]?.cliRedacted).toBe(false)
    expect(parsed.credentialReentryRequired).not.toContain('mcp:m2')
  })
})

describe('渠道解析与 provider 支持', () => {
  test('openai-responses 渠道受支持（不进 disabledDraftChannels）', () => {
    const parsed = parseSettingsExport(
      JSON.stringify({
        version: '1.0',
        channelConfigs: [
          { id: 'ch-resp', type: 'openai-responses', apiKey: '', model: 'gpt-5' },
          { id: 'ch-ollama', type: 'ollama', apiKey: '', model: 'llama3' },
        ],
      }),
      'x.json',
    )
    expect(parsed.channels[0]?.providerSupported).toBe(true)
    expect(parsed.channels[1]?.providerSupported).toBe(false)
    expect(parsed.disabledDraftChannels).toEqual(['ch-ollama (ollama)'])
  })

  test('可映射字段完整解析：models(maxOutputTokens→maxTokens)/timeout/retry*/customHeaders/options/toolMode', () => {
    const parsed = parseSettingsExport(
      JSON.stringify({
        version: '1.0',
        channelConfigs: [
          {
            id: 'ch-full',
            type: 'gemini',
            apiKey: 'sk-abc',
            model: 'gemini-2.5-flash',
            url: 'https://example.invalid/v1',
            timeout: 120000,
            retryEnabled: true,
            retryCount: 3,
            retryInterval: 2000,
            toolMode: 'function_call',
            customHeaders: { Authorization: 'Bearer sk-xyz', 'X-Custom': 'v1' },
            models: [{ id: 'gemini-2.5-flash', name: 'Flash', contextWindow: 1048576, maxOutputTokens: 8192 }],
            options: { stream: true, temperature: 0.7, reasoning: { effort: 'high' } },
            optionsEnabled: { temperature: true },
          },
        ],
      }),
      'x.json',
    )
    const c = parsed.channels[0]!
    expect(c.url).toBe('https://example.invalid/v1')
    expect(c.timeout).toBe(120000)
    expect(c.retryEnabled).toBe(true)
    expect(c.retryCount).toBe(3)
    expect(c.retryInterval).toBe(2000)
    expect(c.toolMode).toBe('function_call')
    expect(c.models).toEqual([{ id: 'gemini-2.5-flash', name: 'Flash', contextWindow: 1048576, maxTokens: 8192 }])
    // 敏感头值脱敏、非敏感头保留
    expect(c.customHeaders).toEqual({ Authorization: REDACTED_PLACEHOLDER, 'X-Custom': 'v1' })
    expect(c.options).toMatchObject({ stream: true, temperature: 0.7, reasoning: { effort: 'high' } })
    expect(c.optionsEnabled).toEqual({ temperature: true })
    // apiKey + 敏感头 → 凭据重录
    expect(parsed.credentialReentryRequired).toContain('ch-full')
    // 不迁移字段清单（temperature/stream/toolMode；reasoning 已映射不进清单）
    expect(c.unmigratedFields).toContain('options.temperature')
    expect(c.unmigratedFields).toContain('options.stream')
    expect(c.unmigratedFields).toContain('toolMode')
    expect(c.unmigratedFields).not.toContain('options.reasoning')
    expect(parsed.unmigratedChannelFields['ch-full']).toEqual(c.unmigratedFields)
  })

  test('enabled:false 渠道保留标记（不注册 route 由 writer 决定）', () => {
    const parsed = parseSettingsExport(
      JSON.stringify({
        version: '1.0',
        channelConfigs: [{ id: 'ch-off', type: 'anthropic', apiKey: '', enabled: false }],
      }),
      'x.json',
    )
    expect(parsed.channels[0]?.enabled).toBe(false)
    expect(parsed.channels[0]?.providerSupported).toBe(true)
  })

  test('版本不支持：SETTINGS_UNSUPPORTED_VERSION（回归）', () => {
    const parsed = parseSettingsExport(JSON.stringify({ version: '2.0' }), 'x.json')
    expect(parsed.ok).toBe(false)
    expect(parsed.errorCode).toBe('SETTINGS_UNSUPPORTED_VERSION')
  })
})
