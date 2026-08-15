/**
 * subagents 薄适配层 - Config（Schemastery）校验测试
 *
 * 断言 root Config 嵌套 `subagents: subagents.Config` 的默认值与边界：
 * - maxHopDepth 默认 5（老 Gray MAX_HOP_DEPTH），maxConcurrent 默认 2（老 Gray
 *   subagents.maxConcurrent）；0 表示关闭对应守卫；
 * - customAgents 默认空数组（S2 自定义子代理）；
 * - 负值 / 非整数被 schemastery 拒绝；customAgents 条目缺 id/name 被拒绝。
 */
import { describe, expect, it } from 'vitest'
import { Config, validateCustomAgentConfig, type Config as SubagentsConfig } from '../../src/subagents/index.ts'

describe('subagents Config（Schemastery）', () => {
  it('缺省：maxHopDepth=5（老 Gray MAX_HOP_DEPTH）、maxConcurrent=2（老 Gray subagents.maxConcurrent）、customAgents=[]', () => {
    expect(Config({} as SubagentsConfig)).toEqual({ maxHopDepth: 5, maxConcurrent: 2, customAgents: [] })
  })

  it('显式覆盖生效', () => {
    expect(Config({ maxHopDepth: 3, maxConcurrent: 4 } as SubagentsConfig)).toEqual({ maxHopDepth: 3, maxConcurrent: 4, customAgents: [] })
    // 0 = 关闭对应守卫。
    expect(Config({ maxHopDepth: 0, maxConcurrent: 0 } as SubagentsConfig)).toEqual({ maxHopDepth: 0, maxConcurrent: 0, customAgents: [] })
  })

  it('负值 / 非整数被拒绝', () => {
    expect(() => Config({ maxHopDepth: -1, maxConcurrent: 2 } as unknown as SubagentsConfig)).toThrow()
    expect(() => Config({ maxHopDepth: 5, maxConcurrent: -1 } as unknown as SubagentsConfig)).toThrow()
    expect(() => Config({ maxHopDepth: 1.5, maxConcurrent: 2 } as unknown as SubagentsConfig)).toThrow()
    expect(() => Config({ maxHopDepth: 5, maxConcurrent: 2.5 } as unknown as SubagentsConfig)).toThrow()
  })

  it('customAgents 条目默认字段补齐；缺 id / name 被拒绝', () => {
    const agent = Config({ customAgents: [{ id: 'agent-1', name: 'Reviewer' }] } as unknown as SubagentsConfig)
    expect(agent.customAgents).toEqual([{ id: 'agent-1', name: 'Reviewer', description: '', systemPrompt: '', enabled: true }])
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
    // 合法配置通过。
    expect(() => validateCustomAgentConfig([
      { id: 'agent-1', name: 'A', description: '', systemPrompt: '', enabled: true },
    ])).not.toThrow()
  })
})
