/**
 * subagents 薄适配层 - seam 守卫安装器测试（fake seam + fake 事件总线，零网络零模型）
 *
 * 生产装配把真实 ctx.subagents 强转为 SubagentsSeamLike 后传入 installSubagentsGuards；
 * 此处用同等形状的 fake seam 验证：
 * - G1：followup/reportFrom 外层 hop 熔断边界（≤5 放行、>5 拒绝、被拒不消耗预算、
 *   subagent/start 重置、subagent/end 清理、maxHopDepth=0 不限）；
 * - G3：start/startContinuable 委派前并发准入——超 maxConcurrent 进入每父会话 FIFO
 *   队列等待（老 Gray 排队语义，不拒绝）：release/subagent/end 唤醒、FIFO 顺序、
 *   排队超时（SubagentQueueTimeoutError）、排队中 signal 中止与 dispose 清队
 *   （SubagentQueueCancelledError）、计数失败 fail-closed（直接与唤醒路径）、
 *   maxConcurrent=0 不查询计数、one-shot 默认运行时间预算（到时 dispose）；
 * - G2：sendToAgent 到直接父/（'main' 且父 root）走 reportFrom，其余 fail-closed；
 * - dispose 恢复原方法、事件注销。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  SubagentRunLike,
  SubagentStartContinuableSpecLike,
  SubagentStartRequestLike,
  SubagentsSeamLike,
} from '../../src/subagents/adapters/dsh/seamTypes.ts'
import {
  ConcurrencyCheckError,
  HopDepthExceededError,
  SubagentQueueCancelledError,
  SubagentQueueTimeoutError,
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

/** 手动结算的 promise（控制 run.result 的落定时机）。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** 断言 promise 仍处于 pending（排队的委派未结算、原方法未收到调用）。 */
async function assertPending(promise: Promise<unknown>): Promise<void> {
  await expect(Promise.race([promise.then(() => 'settled', () => 'settled'), Promise.resolve('pending')])).resolves.toBe('pending')
}

/** fake-timer 下冲一轮微任务（串行准入链是纯 microtask 链，无真实定时器）。 */
async function flushAdmission(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

afterEach(() => {
  vi.useRealTimers()
})

/** 可控 run 的 fake seam.start（每个 run 的 result/dispose 均可手动驱动）。 */
interface ScriptedRun {
  result: Promise<unknown>
  resolveResult: () => void
  dispose: ReturnType<typeof vi.fn>
}
function scriptedStart(fake: FakeSeam): ScriptedRun[] {
  const runs: ScriptedRun[] = []
  fake.seam.start = ((name: string, request: SubagentStartRequestLike) => {
    fake.calls.start.push([name, request])
    const deferredResult = deferred<unknown>()
    const dispose = vi.fn(async () => {})
    runs.push({ result: deferredResult.promise, resolveResult: () => deferredResult.resolve({ stopReason: 'completed' }), dispose })
    const run: SubagentRunLike = { id: sid(`run-${runs.length}`), result: deferredResult.promise, dispose }
    return Promise.resolve(run)
  }) as SubagentsSeamLike['start']
  return runs
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

  it('L3：无 id 子代理按实例独立 hop 预算（不共用退化 "" 桶）', async () => {
    const { seam, calls } = fakeSeam()
    install({ seam, calls }, { maxHopDepth: 1 })
    const opts: SubagentReportOptionsLike = { delivery: 'quiet', signal: new AbortController().signal }
    const content = [{ type: 'text' as const, text: 'r' }]
    const a = { id: undefined, session: undefined } as unknown as Agent
    const b = { id: undefined, session: undefined } as unknown as Agent
    // a 用尽自己的预算。
    await expect(seam.reportFrom(a, content, opts)).resolves.toBe('mid:undefined')
    await expect(seam.reportFrom(a, content, opts)).rejects.toBeInstanceOf(HopDepthExceededError)
    // b 是独立线程：第一跳仍放行，不共享 a 的预算。
    await expect(seam.reportFrom(b, content, opts)).resolves.toBe('mid:undefined')
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

  it('subagent/start 仅重置无活跃预算的线程（resume 不绕开 hop 熔断，L4）；subagent/end 清理', async () => {
    const { seam, calls } = fakeSeam()
    const events = fakeEvents()
    install({ seam, calls }, { maxHopDepth: 2 }, events.port)
    const args = followupArgs()
    await seam.followup(...args)
    await seam.followup(...args)
    await expect(seam.followup(...args)).rejects.toBeInstanceOf(HopDepthExceededError)
    // 活跃线程的再次 start 是 resume：预算不得被重置（否则 resume+ping-pong 无限绕开熔断）。
    events.emit('subagent/start', { id: sid('child-1') })
    await expect(seam.followup(...args)).rejects.toBeInstanceOf(HopDepthExceededError)
    // 结算：清理计数（内存回收 + 再起线程）；后续 start 因无活跃预算而拿到干净预算。
    events.emit('subagent/end', { id: sid('child-1') })
    events.emit('subagent/start', { id: sid('child-1') })
    await expect(seam.followup(...args)).resolves.toBe('mid:child-1')
    expect(calls.followup).toHaveLength(3)
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

describe('G3 并发准入与 FIFO 排队（seam 包装）', () => {
  it('start 超 maxConcurrent → 排队等待而非拒绝；名额释放后 FIFO 唤醒并透传', async () => {
    vi.useFakeTimers()
    const fake = fakeSeam()
    const runs = scriptedStart(fake)
    install({ seam: fake.seam, calls: fake.calls }, { maxConcurrent: 1, countRunning: async () => 0 })
    const request = { parent: fakeAgent('parent-1'), signal: new AbortController().signal }
    // 第一次：准入（occupied 1/1）。
    await expect(fake.seam.start('spawn', request)).resolves.toMatchObject({ id: 'run-1' })
    // 第二次：超限 → 排队（老 Gray 语义：排队而不是拒绝），原方法未被调用。
    const queued = fake.seam.start('fork', request)
    await flushAdmission()
    expect(fake.calls.start).toHaveLength(1)
    await assertPending(queued)
    // 第一次结算 → release → 唤醒排队者 → 原方法收到第二个委派。
    runs[0]!.resolveResult()
    await flushAdmission()
    await expect(queued).resolves.toMatchObject({ id: 'run-2' })
    expect(fake.calls.start).toHaveLength(2)
    expect(fake.calls.start[1]![0]).toBe('fork')
  })

  it('FIFO 顺序：多个排队者按到达顺序被唤醒，不插队', async () => {
    vi.useFakeTimers()
    const fake = fakeSeam()
    const runs = scriptedStart(fake)
    install({ seam: fake.seam, calls: fake.calls }, { maxConcurrent: 1, countRunning: async () => 0 })
    const request = { parent: fakeAgent('parent-1'), signal: new AbortController().signal }
    await expect(fake.seam.start('spawn', request)).resolves.toMatchObject({ id: 'run-1' })
    const second = fake.seam.start('spawn', request)
    const third = fake.seam.start('spawn', request)
    await flushAdmission()
    expect(fake.calls.start).toHaveLength(1)
    runs[0]!.resolveResult()
    await flushAdmission()
    // 队首 second 先准入；third 仍排队（容量 1/1 又被 second 占用）。
    await expect(second).resolves.toMatchObject({ id: 'run-2' })
    await assertPending(third)
    expect(fake.calls.start).toHaveLength(2)
    runs[1]!.resolveResult()
    await flushAdmission()
    await expect(third).resolves.toMatchObject({ id: 'run-3' })
    expect(fake.calls.start).toHaveLength(3)
  })

  it('排队超过 queueTimeoutSeconds → SubagentQueueTimeoutError（失败结算，原方法未被调用）', async () => {
    vi.useFakeTimers()
    const fake = fakeSeam()
    const runs = scriptedStart(fake)
    install({ seam: fake.seam, calls: fake.calls }, { maxConcurrent: 1, countRunning: async () => 0, queueTimeoutSeconds: 5 })
    const request = { parent: fakeAgent('parent-1'), signal: new AbortController().signal }
    await expect(fake.seam.start('spawn', request)).resolves.toMatchObject({ id: 'run-1' })
    const queued = fake.seam.start('spawn', request)
    // 提前挂断言：超时定时器在 advance 内部触发，先 attach handler 避免 unhandled。
    const queuedRejection = expect(queued).rejects.toBeInstanceOf(SubagentQueueTimeoutError)
    await flushAdmission()
    await vi.advanceTimersByTimeAsync(5_000)
    await queuedRejection
    await expect(queued).rejects.toMatchObject({
      parentSessionId: 'session://parent-1',
      queueTimeoutSeconds: 5,
    })
    expect(fake.calls.start).toHaveLength(1)
    // 超时的等待者已出队：名额释放后不会复活。
    runs[0]!.resolveResult()
    await flushAdmission()
    expect(fake.calls.start).toHaveLength(1)
  })

  it('queueTimeoutSeconds=-1（缺省同）→ 无限等待（不设排队定时器）', async () => {
    vi.useFakeTimers()
    const fake = fakeSeam()
    scriptedStart(fake)
    // 缺省 queueTimeoutSeconds = 不限。
    install({ seam: fake.seam, calls: fake.calls }, { maxConcurrent: 1, countRunning: async () => 0 })
    const request = { parent: fakeAgent('parent-1'), signal: new AbortController().signal }
    await expect(fake.seam.start('spawn', request)).resolves.toMatchObject({ id: 'run-1' })
    const queued = fake.seam.start('spawn', request)
    await flushAdmission()
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1)
    await assertPending(queued)
    expect(fake.calls.start).toHaveLength(1)
  })

  it('排队中 signal 中止 → SubagentQueueCancelledError（signal），原方法未被调用', async () => {
    vi.useFakeTimers()
    const fake = fakeSeam()
    scriptedStart(fake)
    install({ seam: fake.seam, calls: fake.calls }, { maxConcurrent: 1, countRunning: async () => 0 })
    const controller = new AbortController()
    await expect(fake.seam.start('spawn', { parent: fakeAgent('parent-1'), signal: controller.signal }))
      .resolves.toMatchObject({ id: 'run-1' })
    const queued = fake.seam.start('spawn', { parent: fakeAgent('parent-1'), signal: controller.signal })
    await flushAdmission()
    controller.abort()
    await expect(queued).rejects.toBeInstanceOf(SubagentQueueCancelledError)
    await expect(queued).rejects.toMatchObject({ reason: 'signal' })
    expect(fake.calls.start).toHaveLength(1)
  })

  it('dispose 清空队列：挂起等待者以 SubagentQueueCancelledError（guard-disposed）结算', async () => {
    vi.useFakeTimers()
    const fake = fakeSeam()
    scriptedStart(fake)
    const guard = install({ seam: fake.seam, calls: fake.calls }, { maxConcurrent: 1, countRunning: async () => 0 })
    const request = { parent: fakeAgent('parent-1'), signal: new AbortController().signal }
    await expect(fake.seam.start('spawn', request)).resolves.toMatchObject({ id: 'run-1' })
    // 同一父会话的后续委派全部排队（占用已满；不同父会话无占用会被直接放行）。
    const queued = fake.seam.start('spawn', request)
    const queuedToo = fake.seam.start('spawn', request)
    await flushAdmission()
    guard.dispose()
    await expect(queued).rejects.toMatchObject({ reason: 'guard-disposed' })
    await expect(queuedToo).rejects.toMatchObject({ reason: 'guard-disposed' })
    expect(fake.calls.start).toHaveLength(1)
  })

  it('startContinuable 同样排队：subagent/end 释放占用并唤醒', async () => {
    vi.useFakeTimers()
    const fake = fakeSeam()
    const events = fakeEvents()
    install({ seam: fake.seam, calls: fake.calls }, { maxConcurrent: 1, countRunning: async () => 0 }, events.port)
    const spec = (): SubagentStartContinuableSpecLike => ({
      provider: 'spawn',
      label: 'background worker',
      request: { parent: fakeAgent('parent-1') },
      signal: new AbortController().signal,
    })
    await expect(fake.seam.startContinuable(spec())).resolves.toEqual({ childId: 'child-1', messageId: 'mid:1' })
    const queued = fake.seam.startContinuable(spec())
    await flushAdmission()
    expect(fake.calls.startContinuable).toHaveLength(1)
    await assertPending(queued)
    // continuable 无 run 句柄：占用随 subagent/end 释放 → 唤醒排队者。
    events.emit('subagent/end', { id: sid('child-1') })
    await flushAdmission()
    await expect(queued).resolves.toEqual({ childId: 'child-1', messageId: 'mid:1' })
    expect(fake.calls.startContinuable).toHaveLength(2)
  })

  it('外部结算触发准入复查：口径仍满则继续排队，口径回落则排队者补位', async () => {
    vi.useFakeTimers()
    const fake = fakeSeam()
    const events = fakeEvents()
    scriptedStart(fake)
    // countRunning 动态：宿主口径里有两个运行中子代理（非本守卫占用）→ 委派排队。
    let hostRunning = 2
    install({ seam: fake.seam, calls: fake.calls }, { maxConcurrent: 2, countRunning: async () => hostRunning }, events.port)
    const queued = fake.seam.start('spawn', { parent: fakeAgent('parent-1'), signal: new AbortController().signal })
    await flushAdmission()
    expect(fake.calls.start).toHaveLength(0)
    // 子代理结束但口径仍满（另一个仍在跑）：复查后不误唤醒。
    hostRunning = 2
    events.emit('subagent/end', { id: sid('external-child') })
    await flushAdmission()
    await assertPending(queued)
    expect(fake.calls.start).toHaveLength(0)
    // 口径真正回落：复查后排队者被准入（FIFO 等待者优先）。
    hostRunning = 0
    events.emit('subagent/end', { id: sid('external-child-2') })
    await flushAdmission()
    await expect(queued).resolves.toMatchObject({ id: 'run-1' })
    expect(fake.calls.start).toHaveLength(1)
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

  it('maxConcurrent=0 → 不限且不查询计数（不排队）', async () => {
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

  it('唤醒复查时计数失败 → 排队者以 ConcurrencyCheckError 拒绝（fail-closed 同口径）', async () => {
    vi.useFakeTimers()
    const fake = fakeSeam()
    const events = fakeEvents()
    const runs = scriptedStart(fake)
    let failCount = false
    install(
      { seam: fake.seam, calls: fake.calls },
      { maxConcurrent: 1, countRunning: async () => { if (failCount) throw new Error('store gone'); return 0 } },
      events.port,
    )
    const request = { parent: fakeAgent('parent-1'), signal: new AbortController().signal }
    await expect(fake.seam.start('spawn', request)).resolves.toMatchObject({ id: 'run-1' })
    const queued = fake.seam.start('spawn', request)
    // 提前挂断言：release 触发唤醒复查，失败在 flush 内同步发生（先挂 handler 避免
    // vitest 记 unhandled rejection）。
    const queuedRejection = expect(queued).rejects.toBeInstanceOf(ConcurrencyCheckError)
    await flushAdmission()
    failCount = true
    runs[0]!.resolveResult()
    await flushAdmission()
    await queuedRejection
    expect(fake.calls.start).toHaveLength(1)
  })

  it('父会话缺 id → ConcurrencyCheckError（fail-closed）', async () => {
    const { seam, calls } = fakeSeam()
    install({ seam, calls }, { maxConcurrent: 2 })
    const noIdParent = { id: undefined, session: undefined } as unknown as Agent
    await expect(seam.start('spawn', { parent: noIdParent, signal: new AbortController().signal }))
      .rejects.toBeInstanceOf(ConcurrencyCheckError)
    expect(calls.start).toHaveLength(0)
  })

  it('countRunning 缺省 fail-closed：未配置计数端口且 maxConcurrent>0 → 拒绝委派（M3）', async () => {
    const { seam, calls } = fakeSeam()
    install({ seam, calls }, { maxConcurrent: 2 })
    const request = { parent: fakeAgent('parent-1'), signal: new AbortController().signal }
    await expect(seam.start('spawn', request)).rejects.toBeInstanceOf(ConcurrencyCheckError)
    await expect(seam.startContinuable({
      provider: 'spawn', label: 'x', request: { parent: fakeAgent('parent-1') }, signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ConcurrencyCheckError)
    expect(calls.start).toHaveLength(0)
    expect(calls.startContinuable).toHaveLength(0)
  })

  it('parentSessionId 规范化：缺前缀补 session://，已带前缀原样传递（M3）', async () => {
    const { seam } = fakeSeam()
    const countRunning = vi.fn(async () => 1)
    install({ seam }, { maxConcurrent: 2, countRunning })
    const request = { parent: fakeAgent('parent-1'), signal: new AbortController().signal }
    await expect(seam.start('spawn', request)).resolves.toMatchObject({ id: 'run-1' })
    expect(countRunning).toHaveBeenCalledWith(sid('session://parent-1'))
    const prefixed = { parent: fakeAgent('session://parent-1'), signal: new AbortController().signal }
    await expect(seam.start('spawn', prefixed)).resolves.toMatchObject({ id: 'run-1' })
    expect(countRunning).toHaveBeenCalledWith(sid('session://parent-1'))
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

  it('M1：listChildren 滞后（countRunning 恒 0）时同步占用仍封顶并发（超限排队而非放行）', async () => {
    vi.useFakeTimers()
    const fake = fakeSeam()
    const runs = scriptedStart(fake)
    install({ seam: fake.seam, calls: fake.calls }, { maxConcurrent: 1, countRunning: async () => 0 })
    const request = { parent: fakeAgent('parent-1'), signal: new AbortController().signal }
    await expect(fake.seam.start('spawn', request)).resolves.toMatchObject({ id: 'run-1' })
    // 第二次委派：countRunning 仍报 0，但本地占用已到上限 → 排队（不放行、不拒绝）。
    const queued = fake.seam.start('spawn', request)
    await flushAdmission()
    expect(fake.calls.start).toHaveLength(1)
    await assertPending(queued)
    runs[0]!.resolveResult()
    await flushAdmission()
    await expect(queued).resolves.toMatchObject({ id: 'run-2' })
    expect(fake.calls.start).toHaveLength(2)
  })

  it('默认运行时间预算：超过 defaultMaxRuntimeSeconds → dispose run（取消并失败结算），run 原样透传', async () => {
    vi.useFakeTimers()
    const fake = fakeSeam()
    const runs = scriptedStart(fake)
    install(
      { seam: fake.seam, calls: fake.calls },
      { maxConcurrent: 0, defaultMaxRuntimeSeconds: 30 },
    )
    const request = { parent: fakeAgent('parent-1'), signal: new AbortController().signal }
    const run = await fake.seam.start('spawn', request)
    expect(runs[0]!.dispose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(runs[0]!.dispose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(runs[0]!.dispose).toHaveBeenCalledTimes(1)
    // run 句柄原样透传（消费方继续按其 result/dispose 语义结算失败）。
    expect(run.id).toBe('run-1')
    // result 落定后预算定时器已清：再次推进不再触发 dispose。
    runs[0]!.resolveResult()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runs[0]!.dispose).toHaveBeenCalledTimes(1)
  })

  it('默认运行时间预算：-1（缺省同）不设预算；result 提前落定则清除定时器', async () => {
    vi.useFakeTimers()
    const fake = fakeSeam()
    const runs = scriptedStart(fake)
    // 缺省 defaultMaxRuntimeSeconds = 不限。
    install({ seam: fake.seam, calls: fake.calls }, { maxConcurrent: 0 })
    await fake.seam.start('spawn', { parent: fakeAgent('parent-1'), signal: new AbortController().signal })
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1)
    expect(runs[0]!.dispose).not.toHaveBeenCalled()

    const fake2 = fakeSeam()
    const runs2 = scriptedStart(fake2)
    install({ seam: fake2.seam, calls: fake2.calls }, { maxConcurrent: 0, defaultMaxRuntimeSeconds: 30 })
    await fake2.seam.start('spawn', { parent: fakeAgent('parent-1'), signal: new AbortController().signal })
    runs2[0]!.resolveResult()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runs2[0]!.dispose).not.toHaveBeenCalled()
  })

  it('dispose 清除运行时间预算定时器：拆除守卫不取消仍在运行的 run', async () => {
    vi.useFakeTimers()
    const fake = fakeSeam()
    const runs = scriptedStart(fake)
    const guard = install({ seam: fake.seam, calls: fake.calls }, { maxConcurrent: 0, defaultMaxRuntimeSeconds: 30 })
    await fake.seam.start('spawn', { parent: fakeAgent('parent-1'), signal: new AbortController().signal })
    guard.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runs[0]!.dispose).not.toHaveBeenCalled()
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

  it('双安装顺序（H-4b）：先卸载第一个实例，第二个实例的守卫仍生效（G1 不绕过）', async () => {
    const { seam, originals } = fakeSeam()
    const first = install({ seam }, { maxHopDepth: 2 })
    const second = install({ seam }, { maxHopDepth: 9 })
    first.dispose()
    // 第一个实例已卸载，但第二个实例仍是活跃守卫：原方法不得被恢复。
    expect(seam.followup).not.toBe(originals.followup)
    const args = followupArgs()
    await seam.followup(...args)
    await seam.followup(...args)
    await expect(seam.followup(...args)).rejects.toMatchObject({ maxHopDepth: 2 })
    // 第二个实例卸载后计数归零，才恢复原方法。
    second.dispose()
    expect(seam.followup).toBe(originals.followup)
  })

  it('双安装顺序（H-4b）：先卸载第一个实例，start 仍受 G3 约束（排队语义）', async () => {
    vi.useFakeTimers()
    const { seam, calls } = fakeSeam()
    const countRunning = vi.fn(async () => 2)
    const first = install({ seam, calls }, { maxConcurrent: 2, queueTimeoutSeconds: 1, countRunning })
    const second = install({ seam, calls }, { maxConcurrent: 2, queueTimeoutSeconds: 1, countRunning })
    first.dispose()
    const request = { parent: fakeAgent('parent-1'), signal: new AbortController().signal }
    // 超限委派进入 FIFO 队列等待（不再拒绝）；排队超过 queueTimeoutSeconds 以失败结算。
    const pending = seam.start('spawn', request)
    const pendingRejection = expect(pending).rejects.toBeInstanceOf(SubagentQueueTimeoutError)
    await flushAdmission()
    await vi.advanceTimersByTimeAsync(60_000)
    await pendingRejection
    expect(calls.start).toHaveLength(0)
    second.dispose()
  })
})
