/**
 * subagents 薄适配层 - domain 纯 TS 逻辑测试（零网络零模型）
 *
 * 覆盖 G1（hop 熔断边界）、G3（并发上限判定）、G2（寻址能力边界）的纯函数层，
 * 以及类型化错误的消息内容。适配层（seam 包装）见 guard.spec.ts。
 */
import { describe, expect, it } from 'vitest'
import { resolveChildToParentTarget } from '../../src/subagents/domain/addressing.ts'
import { shouldAllowDelegation } from '../../src/subagents/domain/concurrencyPolicy.ts'
import {
  ConcurrencyCheckError,
  HopDepthExceededError,
  MaxConcurrentSubagentsError,
  UnsupportedAddressingError,
} from '../../src/subagents/domain/errors.ts'
import { ThreadHopCounter } from '../../src/subagents/domain/hopPolicy.ts'

describe('G1 ThreadHopCounter（hop 熔断边界）', () => {
  it('≤5 放行、>5 拒绝（maxHopDepth=5，参照老 Gray MAX_HOP_DEPTH）', () => {
    const counter = new ThreadHopCounter(5)
    for (let hop = 1; hop <= 5; hop++) {
      expect(counter.tryAdvance('thread-A')).toEqual({ allowed: true, hop })
    }
    expect(counter.tryAdvance('thread-A')).toEqual({ allowed: false, hop: 6 })
    expect(counter.peek('thread-A')).toBe(5)
  })

  it('不同线程互相独立（threadId 由 subagent_id 派生，互不串扰）', () => {
    const counter = new ThreadHopCounter(1)
    expect(counter.tryAdvance('child-1')).toEqual({ allowed: true, hop: 1 })
    expect(counter.tryAdvance('child-2')).toEqual({ allowed: true, hop: 1 })
    expect(counter.tryAdvance('child-1')).toEqual({ allowed: false, hop: 2 })
  })

  it('被拒的跳数不消耗预算（拒投 = 未投递，与老 Gray 一致）', () => {
    const counter = new ThreadHopCounter(2)
    counter.tryAdvance('thread-A') // 1
    counter.tryAdvance('thread-A') // 2
    expect(counter.tryAdvance('thread-A')).toEqual({ allowed: false, hop: 3 })
    // 上限仍卡在 2，后续尝试依旧拒绝且不增长。
    expect(counter.tryAdvance('thread-A')).toEqual({ allowed: false, hop: 3 })
    expect(counter.peek('thread-A')).toBe(2)
  })

  it('maxHopDepth=0 关闭熔断（不限）', () => {
    const counter = new ThreadHopCounter(0)
    for (let i = 0; i < 100; i++) {
      expect(counter.tryAdvance('thread-A').allowed).toBe(true)
    }
  })

  it('reset 重置线程预算（subagent/start 新激活纪元）；clear 清理（subagent/end）', () => {
    const counter = new ThreadHopCounter(2)
    counter.tryAdvance('child-1')
    counter.tryAdvance('child-1')
    expect(counter.tryAdvance('child-1').allowed).toBe(false)
    counter.reset('child-1')
    expect(counter.tryAdvance('child-1')).toEqual({ allowed: true, hop: 1 })
    counter.clear('child-1')
    expect(counter.peek('child-1')).toBe(0)
    expect(counter.tryAdvance('child-1')).toEqual({ allowed: true, hop: 1 })
  })
})

describe('G3 shouldAllowDelegation（maxConcurrent 上限）', () => {
  it('running < maxConcurrent 放行；≥ maxConcurrent 拒绝', () => {
    expect(shouldAllowDelegation(0, 2)).toBe(true)
    expect(shouldAllowDelegation(1, 2)).toBe(true)
    expect(shouldAllowDelegation(2, 2)).toBe(false)
    expect(shouldAllowDelegation(3, 2)).toBe(false)
  })

  it('maxConcurrent=0 表示不限（守卫连计数都不做）', () => {
    expect(shouldAllowDelegation(0, 0)).toBe(true)
    expect(shouldAllowDelegation(99, 0)).toBe(true)
  })
})

describe('G2 resolveChildToParentTarget（子→父寻址能力边界，fail-closed）', () => {
  it('target = 持久化直接父会话 → direct-parent（含 session:// 前缀写法）', () => {
    expect(resolveChildToParentTarget('parent-1', 'child-1', 'parent-1', false)).toEqual({
      kind: 'direct-parent',
      parentSessionId: 'parent-1',
    })
    expect(resolveChildToParentTarget('session://parent-1', 'child-1', 'parent-1', false)).toEqual({
      kind: 'direct-parent',
      parentSessionId: 'parent-1',
    })
    expect(resolveChildToParentTarget('parent-1', 'child-1', 'session://parent-1', false)).toEqual({
      kind: 'direct-parent',
      parentSessionId: 'session://parent-1',
    })
  })

  it("target='main' 且父为 root（主会话）→ direct-parent（老 Gray main 的唯一合法对应）", () => {
    expect(resolveChildToParentTarget('main', 'child-1', 'main-session', true)).toEqual({
      kind: 'direct-parent',
      parentSessionId: 'main-session',
    })
  })

  it("target='main' 但父非 root → unsupported（子代理的直接父不是主会话，无法寻址）", () => {
    expect(resolveChildToParentTarget('main', 'child-1', 'parent-agent', false)).toEqual({
      kind: 'unsupported',
      target: 'main',
      origin: 'child-1',
    })
  })

  it('任意 agent 名 / 非直接父会话 → unsupported（能力边界，fail-closed）', () => {
    expect(resolveChildToParentTarget('some-other-agent', 'child-1', 'parent-1', false)).toEqual({
      kind: 'unsupported',
      target: 'some-other-agent',
      origin: 'child-1',
    })
    expect(resolveChildToParentTarget('unrelated-session', 'child-1', 'parent-1', true)).toEqual({
      kind: 'unsupported',
      target: 'unrelated-session',
      origin: 'child-1',
    })
  })

  it('root 子代（无持久化父）向任意 target → unsupported', () => {
    expect(resolveChildToParentTarget('main', 'root-session', undefined, true)).toEqual({
      kind: 'unsupported',
      target: 'main',
      origin: 'root-session',
    })
  })
})

describe('类型化拒绝错误', () => {
  it('HopDepthExceededError 携带 threadId/attemptedHop/maxHopDepth 与明确消息', () => {
    const error = new HopDepthExceededError('child-9', 6, 5)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('HopDepthExceededError')
    expect(error.threadId).toBe('child-9')
    expect(error.attemptedHop).toBe(6)
    expect(error.maxHopDepth).toBe(5)
    expect(error.message).toContain('child-9')
    expect(error.message).toContain('6')
    expect(error.message).toContain('5')
    expect(error.message).toContain('MAX_HOP_DEPTH')
  })

  it('MaxConcurrentSubagentsError 携带父会话/运行数/上限', () => {
    const error = new MaxConcurrentSubagentsError('parent-1', 2, 2)
    expect(error.name).toBe('MaxConcurrentSubagentsError')
    expect(error.parentSessionId).toBe('parent-1')
    expect(error.running).toBe(2)
    expect(error.maxConcurrent).toBe(2)
    expect(error.message).toContain('maxConcurrent=2')
  })

  it('UnsupportedAddressingError 说明能力边界（G2 fail-closed 文案）', () => {
    const error = new UnsupportedAddressingError('main', 'child-1')
    expect(error.name).toBe('UnsupportedAddressingError')
    expect(error.target).toBe('main')
    expect(error.origin).toBe('child-1')
    expect(error.message).toContain('G2')
    expect(error.message).toContain('direct parent')
  })

  it('ConcurrencyCheckError 携带原因（G3 fail-closed）', () => {
    const error = new ConcurrencyCheckError(new Error('session store not mounted'))
    expect(error.name).toBe('ConcurrencyCheckError')
    expect(error.message).toContain('fail-closed')
    expect((error.cause as Error).message).toBe('session store not mounted')
  })
})
