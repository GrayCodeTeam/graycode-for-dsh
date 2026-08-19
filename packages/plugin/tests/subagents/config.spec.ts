/**
 * subagents 薄适配层 - Config（Schemastery）校验测试
 *
 * 断言 root Config 嵌套 `subagents: subagents.Config` 的默认值与边界：
 * - maxHopDepth 默认 5（老 Gray MAX_HOP_DEPTH），maxConcurrent 默认 3（老 Gray
 *   subagents.maxConcurrentAgents=3），queueTimeoutSeconds 默认 600（老 Gray
 *   subagents.queueTimeoutSeconds），defaultMaxRuntimeSeconds 默认 1800（老 Gray
 *   subagents.defaultMaxRuntimeSeconds）；0/-1 语义见各字段注释；
 * - customAgents 默认空数组（S2 自定义子代理）；
 * - 负值 / 非整数被 schemastery 拒绝；customAgents 条目缺 id/name 被拒绝。
 */
import { describe, expect, it } from 'vitest'
import { Config, GENERAL_WORKER_AGENT, validateCustomAgentConfig, type Config as SubagentsConfig } from '../../src/subagents/index.ts'

describe('subagents Config（Schemastery）', () => {
  it('缺省：通用子代理启用，守卫使用安全默认值，customAgents=[]', () => {
    expect(Config({} as SubagentsConfig)).toEqual({
      generalWorkerEnabled: true,
      maxHopDepth: 5,
      maxConcurrent: 3,
      queueTimeoutSeconds: 600,
      defaultMaxRuntimeSeconds: 1800,
      customAgents: [],
    })
    expect(GENERAL_WORKER_AGENT).toMatchObject({ name: 'general', enabled: true, toolMode: 'all' })
  })

  it('显式覆盖生效', () => {
    expect(Config({ maxHopDepth: 3, maxConcurrent: 4 } as SubagentsConfig)).toEqual({
      generalWorkerEnabled: true,
      maxHopDepth: 3,
      maxConcurrent: 4,
      queueTimeoutSeconds: 600,
      defaultMaxRuntimeSeconds: 1800,
      customAgents: [],
    })
    // 0 = 关闭对应守卫（并发/排队/预算均不限）。
    expect(Config({ maxHopDepth: 0, maxConcurrent: 0, queueTimeoutSeconds: -1, defaultMaxRuntimeSeconds: -1 } as SubagentsConfig)).toEqual({
      generalWorkerEnabled: true,
      maxHopDepth: 0,
      maxConcurrent: 0,
      queueTimeoutSeconds: -1,
      defaultMaxRuntimeSeconds: -1,
      customAgents: [],
    })
  })

  it('负值 / 非整数被拒绝', () => {
    expect(() => Config({ maxHopDepth: -1, maxConcurrent: 2 } as unknown as SubagentsConfig)).toThrow()
    expect(() => Config({ maxHopDepth: 5, maxConcurrent: -1 } as unknown as SubagentsConfig)).toThrow()
    expect(() => Config({ maxHopDepth: 1.5, maxConcurrent: 2 } as unknown as SubagentsConfig)).toThrow()
    expect(() => Config({ maxHopDepth: 5, maxConcurrent: 2.5 } as unknown as SubagentsConfig)).toThrow()
  })

  it('customAgents 条目默认字段补齐；缺 id / name 被拒绝', () => {
    const agent = Config({ customAgents: [{ id: 'agent-1', name: 'Reviewer' }] } as unknown as SubagentsConfig)
    expect(agent.customAgents).toEqual([{
      id: 'agent-1',
      name: 'Reviewer',
      description: '',
      systemPrompt: '',
      enabled: true,
      toolMode: 'all',
      tools: [],
    }])
    expect(() => Config({ customAgents: [{}] } as unknown as SubagentsConfig)).toThrow()
    expect(() => Config({ customAgents: [{ id: '' }] } as unknown as SubagentsConfig)).toThrow()
    expect(() => Config({ customAgents: [{ id: 'agent-1' }] } as unknown as SubagentsConfig)).toThrow()
  })

  it('customAgents 校验 id 唯一性与可 slug 化性（M2：非法配置明确报错而非运行时退化）', () => {
    // schemastery 3.x 无 schema 级自定义校验 API，M2 校验以导出纯函数
    // validateCustomAgentConfig 提供（apply 前强制调用，此处直接测纯函数）。
    // 重复 id → 整体拒绝（不再等到运行时 DUPLICATE_PROVIDER）。
    expect(() => validateCustomAgentConfig([
      { id: 'agent-1', name: 'A', description: '', systemPrompt: '', enabled: true },
      { id: 'agent-1', name: 'B', description: '', systemPrompt: '', enabled: true },
    ])).toThrow(/duplicate/)
    // 同形 id（slug 化后撞派生 provider 名）→ 整体拒绝。
    expect(() => validateCustomAgentConfig([
      { id: 'a b', name: 'A', description: '', systemPrompt: '', enabled: true },
      { id: 'a-b', name: 'B', description: '', systemPrompt: '', enabled: true },
    ])).toThrow(/duplicate/)
    // 纯非 ASCII id（slug 化结果为空）→ 拒绝（不再空 slug 退化）。
    expect(() => validateCustomAgentConfig([
      { id: '中文', name: '审查', description: '', systemPrompt: '', enabled: true },
    ])).toThrow(/slug-able/)
    // 空 id → 拒绝。
    expect(() => validateCustomAgentConfig([
      { id: '', name: 'A', description: '', systemPrompt: '', enabled: true },
    ])).toThrow(/slug-able/)
    expect(() => validateCustomAgentConfig([
      { id: 'limited', name: 'Limited', description: '', systemPrompt: '', enabled: true, toolMode: 'allow', tools: [] },
    ])).toThrow(/names no tools/)
    // 合法配置通过。
    expect(() => validateCustomAgentConfig([
      { id: 'agent-1', name: 'A', description: '', systemPrompt: '', enabled: true },
    ])).not.toThrow()
  })
})
