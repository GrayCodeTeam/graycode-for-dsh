/**
 * subagents 薄适配层 - seam 守卫安装器测试（fake seam + fake 事件总线，零网络零模型）
 *
 * 生产装配把真实 ctx.subagents 强转为 SubagentsSeamLike 后传入 installSubagentsGuards；
 * 此处用同等形状的 fake seam 验证：
 * - G1：followup/reportFrom 外层 hop 熔断边界（≤5 放行、>5 拒绝、被拒不消耗预算、
 *   subagent/start 重置、subagent/end 清理、maxHopDepth=0 不限）；
 * - G3：start/startContinuable 委派前并发上限（超 maxConcurrent 拒绝、计数失败 fail-closed、
 *   maxConcurrent=0 不查询计数）、listChildren 计数口径；
 * - G2：sendToAgent 到直接父/（'main' 且父 root）走 reportFrom，其余 fail-closed；
 * - dispose 恢复原方法、事件注销。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { countRunningChildrenViaList } from '../../src/subagents/adapters/dsh/counting.ts'
import {
  installSubagentsGuards,
  type SubagentLifecycleEventsPort,
  type SubagentsGuard,
  type SubagentsGuardOptions,
} from '../../src/subagents/adapters/dsh/guard.ts'
import type {
  SubagentFollowupOptionsLike,
  SubagentReportOptionsLike,
  SubagentStartContinuableSpecLike,
  SubagentStartRequestLike,
  SubagentsSeamLike,
} from '../../src/subagents/adapters/dsh/seamTypes.ts'
import {
  ConcurrencyCheckError,
  HopDepthExceededError,
  MaxConcurrentSubagentsError,
  UnsupportedAddressingError,
} from '../../src/subagents/domain/errors.ts'

/* ------------------------------------------------------------------ *
 * 夹具                                                               *
 * ------------------------------------------------------------------ */

const sid = (id: string): SessionId => id as SessionId
const mid = (id: string): MessageId => id as MessageId

/** 最小 Agent 夹具（id = 会话 id；header 携带可选持久化父）。 */
function fakeAgent(id: string, parentSession?: string): Agent {
  return {
    id: sid(id),
    session: {
      id: sid(id),
      header: {
        version: 1,
        id: sid(id),
        createdAt: 0,
        ...(parentSession !== undefined ? { parentSession: sid(parentSession) } : {}),
      },
    },
  } as unknown as Agent
}

interface FakeSeam {
  seam: SubagentsSeamLike
  /** 调用追踪：数组元素为「原方法收到的实参」。 */
  calls: {
    followup: Array<[Agent, SessionId, unknown, SubagentFollowupOptionsLike]>
    reportFrom: Array<[Agent, unknown, SubagentReportOptionsLike]>
    start: Array<[string, SubagentStartRequestLike]>
    startContinuable: Array<[SubagentStartContinuableSpecLike]>
  }
  /** 安装前原方法（用于 dispose 恢复断言）。 */
  originals: { followup: SubagentsSeamLike['followup']; reportFrom: SubagentsSeamLike['reportFrom'] }
}

function fakeSeam(): FakeSeam {
  const calls: FakeSeam['calls'] = { followup: [], reportFrom: [], start: [], startContinuable: [] }
  const seam: SubagentsSeamLike = {
    followup: (parent, childId, content, options) => {
      calls.followup.push([parent, childId, content, options])
      return Promise.resolve(mid(`mid:${String(childId)}`))
    },
    reportFrom: (child, content, options) => {
      calls.reportFrom.push([child, content, options])
      return Promise.resolve(mid(`mid:${String(child.id)}`))
    },
    start: (name, request) => {
      calls.start.push([name, request])
      return Promise.resolve({ id: sid('run-1'), result: Promise.resolve({}), dispose: async () => {} })
    },
    startContinuable: (spec) => {
      calls.startContinuable.push([spec])
      return Promise.resolve({ childId: sid('child-1'), messageId: mid('mid:1') })
    },
    listChildren: async () => [],
  }
  return { seam, calls, originals: { followup: seam.followup, reportFrom: seam.reportFrom } }
}

function fakeEvents(): { port: SubagentLifecycleEventsPort; emit(event: string, info: { id: SessionId }): void; detached: boolean[] } {
  const listeners = new Map<string, Array<(info: { id: SessionId }) => void>>()
  const detached: boolean[] = []
  return {
    port: {
      on: (event, listener) => {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
        let active = true
        return () => {
          detached.push(active)
          active = false
        }
      },
    },
    emit(event, info) {
      for (const listener of listeners.get(event) ?? []) listener(info)
    },
    detached,
  }
}

function install(
  fake: { seam: FakeSeam['seam']; calls?: FakeSeam['calls'] },
  options: Partial<SubagentsGuardOptions>,
  events?: SubagentLifecycleEventsPort,
): SubagentsGuard {
  return installSubagentsGuards(fake.seam, {
    maxHopDepth: 5,
    maxConcurrent: 2,
    ...options,
  }, events)
}

const followupArgs = (content = 'hi'): [Agent, SessionId, Array<{ type: 'text'; text: string }>, SubagentFollowupOptionsLike] => {
  const parent = fakeAgent('parent-1')
  const childId = sid('child-1')
  return [parent, childId, [{ type: 'text', text: content }], { source: { kind: 'user' }, signal: new AbortController().signal }]
}

/* ------------------------------------------------------------------ *
 * G1：hop 熔断（followup / reportFrom 包装）                          *
 * ------------------------------------------------------------------ */

describe('G1 hop 熔断（seam 包装）', () => {
  it('followup ≤5 放行、>5 拒绝（maxHopDepth=5）', async () => {
    const { seam, calls } = fakeSeam()
    const guard = install({ seam, calls }, { maxHopDepth: 5 })
    const args = followupArgs()
    for (let i = 1; i <= 5; i++) {
      await expect(seam.followup(...args)).resolves.toBe('mid:child-1')
    }
    await expect(seam.followup(...args)).rejects.toBeInstanceOf(HopDepthExceededError)
    await expect(seam.followup(...args)).rejects.toMatchObject({
      threadId: 'child-1',
      attemptedHop: 6,
      maxHopDepth: 5,
    })
    // 原方法只收到 5 次（第 6、7 次在包装层被熔断，未达原方法）。
    expect(calls.followup).toHaveLength(5)
    guard.dispose()
  })

  it('reportFrom 同样受 hop 熔断（threadId 取子代理 id）', async () => {
    const { seam, calls } = fakeSeam()
    install({ seam, calls }, { maxHopDepth: 2 })
    const child = fakeAgent('child-9', 'parent-1')
    const opts: SubagentReportOptionsLike = { delivery: 'quiet', signal: new AbortController().signal }
    await expect(seam.reportFrom(child, [{ type: 'text', text: 'r1' }], opts)).resolves.toBe('mid:child-9')
    await expect(seam.reportFrom(child, [{ type: 'text', text: 'r2' }], opts)).resolves.toBe('mid:child-9')
    await expect(seam.reportFrom(child, [{ type: 'text', text: 'r3' }], opts)).rejects.toMatchObject({
      name: 'HopDepthExceededError',
      threadId: 'child-9',
      attemptedHop: 3,
      maxHopDepth: 2,
    })
    expect(calls.reportFrom).toHaveLength(2)
  })

  it('被拒投递不消耗预算：熔断后持续拒绝且原方法调用数不变', async () => {
    const { seam, calls } = fakeSeam()
    install({ seam, calls }, { maxHopDepth: 1 })
    const args = followupArgs()
    await expect(seam.followup(...args)).resolves.toBe('mid:child-1')
    for (let i = 0; i < 3; i++) {
      await expect(seam.followup(...args)).rejects.toBeInstanceOf(HopDepthExceededError)
    }
    expect(calls.followup).toHaveLength(1)
  })

  it('subagent/start 重置线程预算；subagent/end 清理后重新计数', async () => {
    const { seam, calls } = fakeSeam()
    const events = fakeEvents()
    install({ seam, calls }, { maxHopDepth: 2 }, events.port)
    const args = followupArgs()
    await seam.followup(...args)
    await seam.followup(...args)
    await expect(seam.followup(...args)).rejects.toBeInstanceOf(HopDepthExceededError)
    // 新激活纪元：预算重置，可继续投递。
    events.emit('subagent/start', { id: sid('child-1') })
    await expect(seam.followup(...args)).resolves.toBe('mid:child-1')
    // 结算：清理计数（内存回收 + 再起线程）。
    events.emit('subagent/end', { id: sid('child-1') })
    await expect(seam.followup(...args)).resolves.toBe('mid:child-1')
    expect(calls.followup).toHaveLength(4)
  })

  it('maxHopDepth=0 关闭熔断（不拦截）', async () => {
    const { seam, calls } = fakeSeam()
    install({ seam, calls }, { maxHopDepth: 0 })
    const args = followupArgs()
    for (let i = 0; i < 10; i++) {
      await expect(seam.followup(...args)).resolves.toBe('mid:child-1')
    }
    expect(calls.followup).toHaveLength(10)
  })
})

/* ------------------------------------------------------------------ *
 * G3：并发上限（start / startContinuable 包装）                       *
 * ------------------------------------------------------------------ */

describe('G3 并发上限（seam 包装）', () => {
  it('start 超 maxConcurrent=2 → MaxConcurrentSubagentsError，原方法未被调用', async () => {
    const { seam, calls } = fakeSeam()
    const countRunning = vi.fn(async () => 2)
    install({ seam, calls }, { maxConcurrent: 2, countRunning })
    const request = { parent: fakeAgent('parent-1'), signal: new AbortController().signal }
    await expect(seam.start('spawn', request)).rejects.toBeInstanceOf(MaxConcurrentSubagentsError)
    await expect(seam.start('spawn', request)).rejects.toMatchObject({
      parentSessionId: 'parent-1',
      running: 2,
      maxConcurrent: 2,
    })
    expect(countRunning).toHaveBeenCalledWith(sid('parent-1'))
    expect(calls.start).toHaveLength(0)
  })

  it('start 未超上限 → 放行并透传（原方法收到 name/request）', async () => {
    const { seam, calls } = fakeSeam()
    install({ seam, calls }, { maxConcurrent: 2, countRunning: async () => 1 })
    const request = { parent: fakeAgent('parent-1'), signal: new AbortController().signal }
    const run = await seam.start('fork', request)
    expect(run.id).toBe('run-1')
    expect(calls.start).toHaveLength(1)
    expect(calls.start[0]![0]).toBe('fork')
    expect(calls.start[0]![1]).toBe(request)
  })

  it('startContinuable 同样受并发上限', async () => {
    const { seam, calls } = fakeSeam()
    install({ seam, calls }, { maxConcurrent: 2, countRunning: async () => 2 })
    const spec: SubagentStartContinuableSpecLike = {
      provider: 'spawn',
      label: 'background worker',
      request: { parent: fakeAgent('parent-1') },
      signal: new AbortController().signal,
    }
    await expect(seam.startContinuable(spec)).rejects.toBeInstanceOf(MaxConcurrentSubagentsError)
    expect(calls.startContinuable).toHaveLength(0)

    const seam2 = fakeSeam()
    install(seam2, { maxConcurrent: 2, countRunning: async () => 0 })
    await expect(seam2.seam.startContinuable(spec)).resolves.toEqual({ childId: 'child-1', messageId: 'mid:1' })
    expect(seam2.calls.startContinuable).toHaveLength(1)
  })

  it('maxConcurrent=0 → 不限且不查询计数', async () => {
    const { seam, calls } = fakeSeam()
    const countRunning = vi.fn(async () => 999)
    install({ seam, calls }, { maxConcurrent: 0, countRunning })
    const request = { parent: fakeAgent('parent-1'), signal: new AbortController().signal }
    for (let i = 0; i < 3; i++) {
      await expect(seam.start('spawn', request)).resolves.toMatchObject({ id: 'run-1' })
    }
    expect(countRunning).not.toHaveBeenCalled()
    expect(calls.start).toHaveLength(3)
  })

  it('计数失败 → ConcurrencyCheckError（fail-closed，不静默放行）', async () => {
    const { seam, calls } = fakeSeam()
    install({ seam, calls }, { maxConcurrent: 2, countRunning: async () => { throw new Error('session store not mounted') } })
    const request = { parent: fakeAgent('parent-1'), signal: new AbortController().signal }
    await expect(seam.start('spawn', request)).rejects.toBeInstanceOf(ConcurrencyCheckError)
    await expect(seam.startContinuable({
      provider: 'spawn', label: 'x', request: { parent: fakeAgent('parent-1') }, signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ConcurrencyCheckError)
    expect(calls.start).toHaveLength(0)
    expect(calls.startContinuable).toHaveLength(0)
  })

  it('父会话缺 id → ConcurrencyCheckError（fail-closed）', async () => {
    const { seam, calls } = fakeSeam()
    install({ seam, calls }, { maxConcurrent: 2 })
    const noIdParent = { id: undefined, session: undefined } as unknown as Agent
    await expect(seam.start('spawn', { parent: noIdParent, signal: new AbortController().signal }))
      .rejects.toBeInstanceOf(ConcurrencyCheckError)
    expect(calls.start).toHaveLength(0)
  })

  it('countRunningChildrenViaList 口径：只计 kind=child 且 activity=running', async () => {
    const { seam } = fakeSeam()
    seam.listChildren = async () => [
      { kind: 'child', id: sid('c1'), activity: 'running', mode: 'continuable', label: 'a' },
      { kind: 'child', id: sid('c2'), activity: 'inactive', mode: 'one-shot' },
      { kind: 'diagnostic', id: sid('c3'), reason: 'corrupt' },
      { kind: 'child', id: sid('c4'), activity: 'running', mode: 'one-shot' },
    ] as never
    const count = countRunningChildrenViaList(seam)
    await expect(count(sid('parent-1'))).resolves.toBe(2)
  })
})

/* ------------------------------------------------------------------ *
 * G2：子→父寻址（sendToAgent，fail-closed）                           *
 * ------------------------------------------------------------------ */

describe('G2 子→父寻址（sendToAgent）', () => {
  const opts: SubagentReportOptionsLike = { delivery: 'wakeup', signal: new AbortController().signal }
  const content = [{ type: 'text', text: 'partial result' }] as never

  it('target = 持久化直接父会话 → 经 reportFrom 投递', async () => {
    const { seam, calls } = fakeSeam()
    const guard = install({ seam, calls }, {})
    const child = fakeAgent('child-1', 'parent-1')
    await expect(guard.sendToAgent(child, 'parent-1', content, opts)).resolves.toBe('mid:child-1')
    expect(calls.reportFrom).toHaveLength(1)
    expect(calls.reportFrom[0]![0]).toBe(child)
  })

  it("target='main' 且父为 root（主会话）→ 经 reportFrom 投递（老 Gray main 语义）", async () => {
    const { seam, calls } = fakeSeam()
    const guard = install({ seam, calls }, { isRootSession: (id) => id === 'main-session' })
    const child = fakeAgent('child-1', 'main-session')
    await expect(guard.sendToAgent(child, 'main', content, opts)).resolves.toBe('mid:child-1')
    expect(calls.reportFrom).toHaveLength(1)
  })

  it("target='main' 但父非 root → UnsupportedAddressingError（能力边界）", () => {
    const { seam } = fakeSeam()
    const guard = install({ seam }, { isRootSession: () => false })
    const child = fakeAgent('child-1', 'mid-tier-parent')
    expect(() => guard.sendToAgent(child, 'main', content, opts)).toThrowError(UnsupportedAddressingError)
    expect(() => guard.sendToAgent(child, 'main', content, opts)).toThrowError(/G2/)
  })

  it('任意 agent 名 / 非直接父会话 → UnsupportedAddressingError（fail-closed，不硬写 hack）', () => {
    const { seam } = fakeSeam()
    const guard = install({ seam }, { isRootSession: () => true })
    const child = fakeAgent('child-1', 'parent-1')
    expect(() => guard.sendToAgent(child, 'worker-b', content, opts)).toThrowError(UnsupportedAddressingError)
    expect(() => guard.sendToAgent(child, 'unrelated-session', content, opts)).toThrowError(UnsupportedAddressingError)
  })

  it('root 子代（无持久化父）向 main → UnsupportedAddressingError', () => {
    const { seam } = fakeSeam()
    const guard = install({ seam }, { isRootSession: () => true })
    const rootChild = fakeAgent('root-session')
    expect(() => guard.sendToAgent(rootChild, 'main', content, opts)).toThrowError(UnsupportedAddressingError)
  })

  it('sendToAgent 走已包装 reportFrom：G1 hop 熔断随之生效', async () => {
    const { seam } = fakeSeam()
    const guard = install({ seam }, { maxHopDepth: 1 })
    const child = fakeAgent('child-1', 'parent-1')
    await expect(guard.sendToAgent(child, 'parent-1', content, opts)).resolves.toBe('mid:child-1')
    await expect(guard.sendToAgent(child, 'parent-1', content, opts)).rejects.toBeInstanceOf(HopDepthExceededError)
  })
})

/* ------------------------------------------------------------------ *
 * dispose 恢复                                                       *
 * ------------------------------------------------------------------ */

describe('dispose 恢复', () => {
  it('恢复原方法引用并注销事件监听', async () => {
    const { seam, originals } = fakeSeam()
    const events = fakeEvents()
    const guard = install({ seam }, { maxHopDepth: 5 }, events.port)
    expect(seam.followup).not.toBe(originals.followup)
    expect(seam.reportFrom).not.toBe(originals.reportFrom)

    guard.dispose()
    expect(seam.followup).toBe(originals.followup)
    expect(seam.reportFrom).toBe(originals.reportFrom)
    expect(events.detached).toEqual([true, true])
    // dispose 幂等。
    guard.dispose()
  })

  it('重复安装同一 seam → 跳过二次包装（WeakSet 守卫），dispose 不破坏首次安装', async () => {
    const { seam, originals } = fakeSeam()
    const first = install({ seam }, { maxHopDepth: 2 })
    const second = install({ seam }, { maxHopDepth: 9 })
    // 第二次安装返回的 guard 不重包 seam。
    expect(seam.followup).not.toBe(originals.followup)
    // 熔断仍按首次配置（2）生效。
    const args = followupArgs()
    await seam.followup(...args)
    await seam.followup(...args)
    await expect(seam.followup(...args)).rejects.toMatchObject({ maxHopDepth: 2 })
    second.dispose()
    // 第二次 dispose 不应恢复原方法（首次安装仍持有包装）。
    expect(seam.followup).not.toBe(originals.followup)
    first.dispose()
    expect(seam.followup).toBe(originals.followup)
  })
})
