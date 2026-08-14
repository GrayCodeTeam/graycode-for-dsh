/**
 * subagents 薄适配层 - Config（Schemastery）校验测试
 *
 * 断言 root Config 嵌套 `subagents: subagents.Config` 的默认值与边界：
 * - maxHopDepth 默认 5（老 Gray MAX_HOP_DEPTH），maxConcurrent 默认 2（老 Gray
 *   subagents.maxConcurrent）；0 表示关闭对应守卫；
 * - 负值 / 非整数被 schemastery 拒绝。
 */
import { describe, expect, it } from 'vitest'
import { Config, type Config as SubagentsConfig } from '../../src/subagents/index.ts'

describe('subagents Config（Schemastery）', () => {
  it('缺省：maxHopDepth=5（老 Gray MAX_HOP_DEPTH）、maxConcurrent=2（老 Gray subagents.maxConcurrent）', () => {
    expect(Config({} as SubagentsConfig)).toEqual({ maxHopDepth: 5, maxConcurrent: 2 })
  })

  it('显式覆盖生效', () => {
    expect(Config({ maxHopDepth: 3, maxConcurrent: 4 } as SubagentsConfig)).toEqual({ maxHopDepth: 3, maxConcurrent: 4 })
    // 0 = 关闭对应守卫。
    expect(Config({ maxHopDepth: 0, maxConcurrent: 0 } as SubagentsConfig)).toEqual({ maxHopDepth: 0, maxConcurrent: 0 })
  })

  it('负值 / 非整数被拒绝', () => {
    expect(() => Config({ maxHopDepth: -1, maxConcurrent: 2 } as unknown as SubagentsConfig)).toThrow()
    expect(() => Config({ maxHopDepth: 5, maxConcurrent: -1 } as unknown as SubagentsConfig)).toThrow()
    expect(() => Config({ maxHopDepth: 1.5, maxConcurrent: 2 } as unknown as SubagentsConfig)).toThrow()
    expect(() => Config({ maxHopDepth: 5, maxConcurrent: 2.5 } as unknown as SubagentsConfig)).toThrow()
  })
})
