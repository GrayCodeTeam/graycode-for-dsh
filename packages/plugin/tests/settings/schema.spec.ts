/**
 * GrayCode settings 领域 —— schema 默认值解析测试。
 *
 * 锁定契约：
 * - 空输入解析出完整文档（所有叶子带 default），顶层结构与 DEFAULTS 对齐；
 * - DEFAULTS（base 层文档）能原样通过 schema（register({base: DEFAULTS}) 的解析前提）；
 * - 部分输入与默认值合并；channels 数组元素缺失字段按叶子默认补齐；
 * - 非法值被拒绝；apiKey 字段带 role('secret') 元数据。
 */
import { describe, expect, it } from 'vitest'
import { GrayCodeSchema } from '../../src/settings/schema.ts'
import { DEFAULTS } from '../../src/settings/defaults.ts'
import type { GrayCodeConfig, GrayCodePatch } from '../../src/settings/types.ts'

/** 部分输入经 schema 解析（schema 入参是完整文档类型，测试用补丁形状）。 */
function resolve(patch: GrayCodePatch): GrayCodeConfig {
  return GrayCodeSchema(patch as GrayCodeConfig)
}

describe('GrayCodeSchema 默认值解析', () => {
  it('空输入解析出完整文档（所有叶子带 default）', () => {
    const resolved = GrayCodeSchema()
    expect(Object.keys(resolved).sort()).toEqual(Object.keys(DEFAULTS).sort())
    // 嵌套 section 由叶子默认值补齐（嵌套对象无 .default({}) 也可解析）
    expect(resolved.checkpoint).toEqual({ enabled: true, maxCheckpoints: -1 })
    expect(resolved.summarize.keepRecentTokens).toBe('50%')
    expect(resolved.sound.volume).toBe(60)
    expect(resolved.sound.cues.taskError).toBe(true)
    expect(resolved.appearance.theme).toBe('auto')
    expect(resolved.memory.wakeLines).toBe(96)
    expect(resolved.subagents.maxConcurrentAgents).toBe(3)
    expect(resolved.context.diagnostics.includeSeverities).toEqual(['error', 'warning'])
    expect(resolved.tokenCount.gemini.enabled).toBe(false)
    expect(resolved.general.proxy.url).toBe('')
  })

  it('DEFAULTS（base 层文档）原样通过 schema', () => {
    expect(GrayCodeSchema(DEFAULTS)).toEqual(DEFAULTS)
  })

  it('部分输入与默认值合并', () => {
    const resolved = resolve({ activeChannelId: 'chan-1', maxToolIterations: 50 })
    expect(resolved.activeChannelId).toBe('chan-1')
    expect(resolved.maxToolIterations).toBe(50)
    expect(resolved.defaultToolMode).toBe('function_call')
    // 嵌套部分覆盖：未提及字段保持默认
    const nested = resolve({ sound: { volume: 30 } as unknown as GrayCodeConfig['sound'] })
    expect(nested.sound.volume).toBe(30)
    expect(nested.sound.enabled).toBe(false)
    expect(nested.sound.cooldownMs).toBe(800)
  })

  it('channels 数组元素缺失字段时按叶子默认补齐', () => {
    const resolved = resolve({ channels: [{ id: 'c1', name: '测试渠道' }] as unknown as GrayCodeConfig['channels'] })
    expect(resolved.channels).toEqual([
      {
        id: 'c1',
        name: '测试渠道',
        type: 'openai',
        enabled: true,
        description: '',
        baseUrl: '',
        apiKey: '',
        model: '',
        apiVersion: '',
        timeout: 60000,
        maxContextTokens: 0,
        preferStream: false,
        toolMode: 'function_call',
        temperature: 0,
        maxOutputTokens: 1,
        topP: 1,
        topK: 1,
      },
    ])
  })

  it('非法值被拒绝', () => {
    expect(() => resolve({ maxToolIterations: -2 })).toThrow()
    expect(() => resolve({ channels: [{ id: 1 as unknown as string }] as unknown as GrayCodeConfig['channels'] })).toThrow()
    expect(() => resolve({ summarize: { keepRecentRounds: -1 } as unknown as GrayCodeConfig['summarize'] })).toThrow()
    expect(() => resolve({ defaultToolMode: 'bad' as never })).toThrow()
    expect(() =>
      resolve({ tokenCount: { openai: { enabled: 'yes' as never } } as unknown as GrayCodeConfig['tokenCount'] }),
    ).toThrow()
  })

  it('apiKey 类字段带 role("secret") 元数据', () => {
    const imageGen = GrayCodeSchema.dict!['imageGen']!
    expect(imageGen.dict!['apiKey']!.meta.role).toBe('secret')
    const tokenCount = GrayCodeSchema.dict!['tokenCount']!
    expect(tokenCount.dict!['openai']!.dict!['apiKey']!.meta.role).toBe('secret')
    const channels = GrayCodeSchema.dict!['channels']!
    expect(channels.inner!.dict!['apiKey']!.meta.role).toBe('secret')
  })
})
