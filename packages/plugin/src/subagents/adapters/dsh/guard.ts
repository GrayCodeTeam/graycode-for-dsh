/**
 * GrayCode - subagents 薄适配层：ctx.subagents seam 守卫安装器（G1/G2/G3）
 *
 * 探明结论（依据 dsh-subagent@0.1.0-rc.6 的 .d.ts，见 docs/SUBAGENTS_VERIFICATION.md）：
 * - `ctx.subagents`（SubagentRuntime extends Service）把模型侧 send_message/report 的
 *   实际投递收敛到两个公开方法：followup（父→子，仅精确 live 直接父授权）与
 *   reportFrom（子→直接父，「调用方不可命名收件人」）。base 层 tool 包在本仓库
 *   node_modules 未安装，故「工具层包装」不可行；事件面（subagent/start/end）只
 *   描述生命周期、不含消息内容。**seam 方法本身是唯一可拦截点**：本安装器以
 *   「实例方法遮蔽（own property 覆盖原型方法）」包装 followup/reportFrom/start/
 *   startContinuable，保存原方法；dispose 只在「最后一个持有者」卸载时恢复原方法
 *   （安装引用计数，HMR 双 apply 不互相拆台，见 H-4b）。
 * - G1：hop 计数器包在 followup/reportFrom 外层，threadId 由 subagent_id（childId /
 *   child.id）派生，同线程超 maxHopDepth（默认 5，老 Gray MAX_HOP_DEPTH）拒绝投递并抛
 *   HopDepthExceededError；subagent/start 仅在无活跃预算时重置线程预算（L4，resume 不
 *   绕开熔断）、subagent/end 清理。
 * - G2：reportFrom 不支持任意寻址（能力边界），sendToAgent 仅当 target 解析为调用方
 *   持久化直接父（含 'main' 且父为 root）时走 reportFrom，否则抛 UnsupportedAddressingError
 *   （fail-closed，不硬写 hack）。
 * - G3：start/startContinuable 委派前在临界区占用/释放并发名额（listChildren 快照
 *   与本地占用计数取大，见 reserve/release）。超 subagents.maxConcurrent（默认 3）的
 *   委派不再直接拒绝，而是进入每父会话 FIFO 队列等待名额释放（老 Gray
 *   concurrencyLimiter 语义）：排队超过 subagents.queueTimeoutSeconds（默认 600，
 *   -1 不限）以 SubagentQueueTimeoutError 失败结算；排队中 signal 中止或守卫拆除以
 *   SubagentQueueCancelledError 结算（消除 check-then-act 并发窗口，M1）；计数本身
 *   失败时抛 ConcurrencyCheckError（fail-closed，排队者同样被拒绝）。另对 one-shot
 *   run 挂默认运行时间预算 subagents.defaultMaxRuntimeSeconds（默认 1800，-1 不限）：
 *   到时 dispose run 句柄（seam 公开的取消手段）→ 以非 completed stopReason 失败结算。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { resolveChildToParentTarget } from '../../domain/addressing.ts'
import { shouldAllowDelegation } from '../../domain/concurrencyPolicy.ts'
import {
  ConcurrencyCheckError,
  HopDepthExceededError,
  SubagentQueueCancelledError,
  SubagentQueueTimeoutError,
  UnsupportedAddressingError,
} from '../../domain/errors.ts'
import { ThreadHopCounter } from '../../domain/hopPolicy.ts'
import type { SubagentReportOptionsLike, SubagentRunLike, SubagentsSeamLike } from './seamTypes.ts'

/** 生命周期事件端口（生产 = ctx.on；测试 = fake bus）。 */
export interface SubagentLifecycleEventsPort {
  on(event: string, listener: (info: { id: SessionId }) => void): () => void
}

export interface SubagentsGuardOptions {
  /** G1：每子线程 hop 上限（老 Gray MAX_HOP_DEPTH=5；0 = 不限/关闭熔断）。 */
  maxHopDepth: number
  /** G3：每父会话运行中子代理上限（老 Gray subagents.maxConcurrentAgents 默认 3；0 = 不限）。 */
  maxConcurrent: number
  /**
   * G3：排队等待名额的超时（秒，老 Gray queueTimeoutSeconds 默认 600）。超时的委派
   * 以 SubagentQueueTimeoutError 失败结算（委派未启动）。>0 生效；
   * -1 / 0 / 缺省 = 无限等待（老 Gray limiter：undefined/负数/0 均无超时）。
   */
  queueTimeoutSeconds?: number
  /**
   * G3：one-shot 委派的默认最大运行时间（秒，老 Gray defaultMaxRuntimeSeconds 默认
   * 1800）。到时 dispose run 句柄（seam 公开取消手段）→ run 以非 completed stopReason
   * 结算、消费方按失败处理。>0 生效；-1 / 0 / 缺省 = 不限。
   * continuable 子代理无 run 句柄（continuation manager 持有全生命周期），不适用。
   */
  defaultMaxRuntimeSeconds?: number
  /** G3：运行中数量计数端口（默认经 countRunningChildrenViaList 接 listChildren）。 */
  countRunning?: (parentSessionId: SessionId) => Promise<number>
  /** G2：判断会话是否主会话（root），用于把 'main' 映射到直接父。 */
  isRootSession?: (sessionId: string) => boolean
  /** 告警日志端口。 */
  logger?: { warn(message: string): void }
}

export interface SubagentsGuard {
  /** 被守卫后的 seam（方法已被包装，经它调用即受 G1/G3 约束）。 */
  readonly seam: SubagentsSeamLike
  /**
   * G2：子→父消息（老 Gray agent_send_message 方向）。target 解析为调用方持久化
   * 直接父（含 'main' 且父为 root）时经 reportFrom 投递；其余任意寻址 fail-closed。
   */
  sendToAgent(
    origin: Agent,
    target: string,
    content: readonly ContentBlock[],
    options: SubagentReportOptionsLike,
  ): Promise<MessageId>
  /**
   * 释放本次安装持有；仅当自己是「最后一个持有者」（计数归零）时才恢复原方法、
   * 注销事件（幂等）。先卸载的实例不会拆掉后安装实例仍在使用的包装（H-4b）。
   */
  dispose(): void
}

/**
 * 重复安装守卫（HMR 双 apply 兜底）：同一 seam 实例只包装一次，但每次安装都登记
 * 引用计数。dispose 仅当计数归零（自己是最后一个持有者）时才恢复原方法并注销事件
 * ——否则先卸载的实例会无条件恢复原方法，使后安装的 no-op guard 失效、G1/G3 被
 * 绕过（H-4b）。
 */
const installCounts = new WeakMap<object, number>()

/** 拆除一个守卫安装所需的状态（原方法 + 事件注销），由最后一个持有者消费。 */
interface GuardInstallState {
  seam: SubagentsSeamLike
  originals: {
    followup: SubagentsSeamLike['followup']
    reportFrom: SubagentsSeamLike['reportFrom']
    start: SubagentsSeamLike['start']
    startContinuable: SubagentsSeamLike['startContinuable']
  }
  detachEvents: Array<() => void>
}
const installState = new WeakMap<object, GuardInstallState>()

/**
 * L3：reportFrom 的 threadId 解析——优先取真实线程 id（子代理会话 id，与 followup 的
 * childId、subagent 生命周期事件 id 同源），缺失时按对象实例分配唯一匿名线程（无 id
 * 子代理不再共用 '' 预算桶：一个子代理耗尽 hop 预算不会误伤其他无 id 子代理）。
 */
const anonymousReportThreads = new WeakMap<object, string>()
let anonymousReportThreadSeq = 0

function reportThreadIdOf(child: Agent): string {
  const sessionId = child?.session?.id
  if (sessionId !== undefined && String(sessionId).length > 0) return String(sessionId)
  const agentId = child?.id
  if (agentId !== undefined && String(agentId).length > 0) return String(agentId)
  if (child == null) return ''
  const key = child as object
  const existing = anonymousReportThreads.get(key)
  if (existing !== undefined) return existing
  const fresh = `anonymous-report:${(anonymousReportThreadSeq += 1)}`
  anonymousReportThreads.set(key, fresh)
  return fresh
}

/** 归零拆除：恢复原方法、注销事件、清除安装状态（幂等）。 */
function teardown(key: object): void {
  installCounts.delete(key)
  const state = installState.get(key)
  installState.delete(key)
  if (!state) return
  state.seam.followup = state.originals.followup
  state.seam.reportFrom = state.originals.reportFrom
  state.seam.start = state.originals.start
  state.seam.startContinuable = state.originals.startContinuable
  for (const detach of state.detachEvents.splice(0)) detach()
}

/** 释放一次安装持有；返回计数是否归零（归零者负责拆除包装与注销事件）。 */
function releaseOne(key: object): boolean {
  const remaining = (installCounts.get(key) ?? 1) - 1
  if (remaining > 0) {
    installCounts.set(key, remaining)
    return false
  }
  teardown(key)
  return true
}

/** G2 投递器（两种安装路径共用）。 */
function makeSendToAgent(
  seam: SubagentsSeamLike,
  isRootSession: ((sessionId: string) => boolean) | undefined,
): SubagentsGuard['sendToAgent'] {
  return (origin, target, content, options) => {
    const callerSessionId = String(origin?.id ?? origin?.session?.id ?? '')
    const parentSessionId = origin?.session?.header?.parentSession
    const parentIsRoot = parentSessionId !== undefined && (isRootSession?.(String(parentSessionId)) ?? false)
    const resolved = resolveChildToParentTarget(
      target,
      callerSessionId,
      parentSessionId !== undefined ? String(parentSessionId) : undefined,
      parentIsRoot,
    )
    if (resolved.kind === 'unsupported') {
      throw new UnsupportedAddressingError(resolved.target, resolved.origin)
    }
    // 走已包装的 seam.reportFrom：G1 hop 守卫随之生效。
    return seam.reportFrom(origin, content, options)
  }
}

/**
 * 统一为 `session://` 前缀形式：DSH 会话引用两种写法都常见（见 addressing.ts
 * normalizeSessionRef 的说明），G3 计数端口（listChildren 按 scheme 匹配会话）
 * 拿到缺前缀的引用会静默失配 → 并发守卫失效（M3）。
 */
function normalizeSessionId(id: SessionId): SessionId {
  const raw = String(id)
  return (raw.startsWith('session://') ? raw : `session://${raw}`) as SessionId
}

/**
 * Node 定时器 unref（排队/预算定时器不得阻止宿主进程退出）；非 Node 定时器句柄
 * （number，浏览器/仿真环境）没有 unref，静默跳过。
 */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  ;(timer as { unref?: () => void }).unref?.()
}

export function installSubagentsGuards(
  seam: SubagentsSeamLike,
  options: SubagentsGuardOptions,
  events?: SubagentLifecycleEventsPort,
): SubagentsGuard {
  const key = seam as object
  const existing = installCounts.get(key) ?? 0
  installCounts.set(key, existing + 1)

  if (existing > 0) {
    options.logger?.warn('graycode-subagents: seam already guarded — skipping re-install (HMR double-apply guard)')
    return {
      seam,
      sendToAgent: makeSendToAgent(seam, options.isRootSession),
      // no-op 安装只占一个持有；dispose 递减计数，最后一个持有者负责拆除包装。
      dispose: () => { releaseOne(key) },
    }
  }

  // 保存原方法（未绑定；调用时 .apply(seam) 保证 this 正确）。
  const originals = {
    followup: seam.followup,
    reportFrom: seam.reportFrom,
    start: seam.start,
    startContinuable: seam.startContinuable,
  }

  const hopCounter = new ThreadHopCounter(options.maxHopDepth)
  const maxConcurrent = options.maxConcurrent
  // 老 Gray 全局配置：排队超时（默认 600，-1 不限）与默认运行时间（默认 1800，-1 不限）。
  // <=0（含缺省）一律视为「不设限/不启用」，与老 Gray limiter 的 undefined/负数/0 口径一致。
  const queueTimeoutSeconds = options.queueTimeoutSeconds ?? -1
  const defaultMaxRuntimeSeconds = options.defaultMaxRuntimeSeconds ?? -1
  // M3：countRunning 缺省 fail-closed——未配置计数端口且 maxConcurrent>0 时拒绝
  // 委派（显式报错），绝不静默放行（旧默认 async () => 0 会让 G3 永久失效）。
  // 抛普通 Error：reserve 的 try/catch 统一包成 ConcurrencyCheckError。
  const countRunning = options.countRunning ?? (async () => {
    throw new Error('no countRunning port configured — refusing delegation (fail-closed)')
  })

  /**
   * M1：G3 并发占用计数（临界区）。listChildren 投影有激活滞后（新起的子代理不会立即
   * 出现在 activity='running' 里），纯 check-then-act（先查 listChildren 再放行）会让
   * 连续快速委派都读到旧快照而超限。这里以「同步占用/释放」为临界区：reserve 在一次
   * 同步 tick 内完成「检查 + 占用」（countRunning 的 await 之后到占用之间无 await），
   * run 结算（result 落定 / subagent/end）时释放。
   */
  const occupied = new Map<string, number>()
  /** continuable 子代理占用：childId → 已占用的父会话（随 subagent/end 释放）。 */
  const continuableParents = new Map<string, string>()

  /**
   * G3 FIFO 排队（老 Gray concurrencyLimiter 语义）：超限委派进入每父会话队列等待
   * 名额释放，而不是被拒绝。等待期间三类出队路径共用同一幂等结算（清定时器 + 摘除
   * abort 监听 + 移出队列）：release/结算事件唤醒（admit，占用名额后放行）、排队超时
   * （fail SubagentQueueTimeoutError）、signal 中止/守卫拆除（fail SubagentQueueCancelledError）。
   */
  interface QueueWaiter {
    readonly parentSessionId: string
    /** 占用一个名额并放行等待中的委派（在串行准入段内调用）。 */
    admit(): void
    /** 以失败结算等待中的委派（委派未到达宿主）。 */
    fail(error: Error): void
  }
  const waiters = new Map<string, QueueWaiter[]>()
  /**
   * 每父会话准入串行链：直接 reserve 与唤醒重查都在同一条 promise 链上排队执行，
   * 「countRunning 的 await 之后到占用之间」不会插入并发的另一段准入（M1 窗口在
   * 排队语义下同样必须关闭，否则唤醒与新增请求交错会超发名额）。
   */
  const admissionTails = new Map<string, Promise<void>>()
  /** 运行时间预算定时器集合（teardown 统一清理，防 open handle 残留）。 */
  const runtimeTimers = new Set<ReturnType<typeof setTimeout>>()

  /** 在父会话的串行准入链上执行一段准入逻辑；返回本段执行结果（异常只归属本段）。 */
  const serializeAdmission = (parentSessionId: string, section: () => Promise<void>): Promise<void> => {
    const previous = admissionTails.get(parentSessionId) ?? Promise.resolve()
    const run = previous.then(section, section)
    admissionTails.set(parentSessionId, run.then(() => undefined, () => undefined))
    return run
  }

  /** G1：同线程 hop 检查（check-then-increment；被拒不消耗预算）。 */
  const assertHop = (threadId: string): void => {
    if (options.maxHopDepth <= 0) return
    const decision = hopCounter.tryAdvance(threadId)
    if (!decision.allowed) {
      throw new HopDepthExceededError(threadId, decision.hop, options.maxHopDepth)
    }
  }

  /**
   * G3：委派前占用一个并发名额，超限则排队等待（老 Gray：排队而不是拒绝）。
   * 返回归一化父会话 id（调用方据此在结算/失败时 release）；maxConcurrent<=0 时
   * 返回 ''（不限，不占用、不排队）。有效数取 max(running, occupied)：running 是
   * listChildren 的 ground truth（含本 guard 已可见的子代理），occupied 覆盖其激活
   * 滞后窗口——取大既消除 check-then-act 窗口，又不会在快照追上后双重计数（超发）。
   * 排队期间 signal 中止 → SubagentQueueCancelledError；超过 queueTimeoutSeconds →
   * SubagentQueueTimeoutError（均以失败结算，委派未到达宿主）。
   */
  const reserve = (parent: Agent, signal?: AbortSignal): Promise<string> => {
    if (maxConcurrent <= 0) return Promise.resolve('')
    const rawParentSessionId = parent?.id ?? parent?.session?.id
    if (!rawParentSessionId) {
      return Promise.reject(new ConcurrencyCheckError(new Error('delegating parent has no session id')))
    }
    // M3：统一为 session:// 前缀（计数端口按 scheme 匹配会话，缺前缀会静默失配）。
    const parentSessionId = String(normalizeSessionId(rawParentSessionId))
    return new Promise<string>((resolveReservation, rejectReservation) => {
      void serializeAdmission(parentSessionId, async () => {
        const queue = waiters.get(parentSessionId) ?? []
        // FIFO 公平：已有排队者时新请求不重查容量、直接排到队尾（老 Gray drainQueue
        // 语义——不得插队抢占唤醒间隙里出现的空位）。
        if (queue.length === 0) {
          let running: number
          try {
            running = await countRunning(parentSessionId as SessionId)
          } catch (error) {
            throw new ConcurrencyCheckError(error)
          }
          const reservedCount = occupied.get(parentSessionId) ?? 0
          if (shouldAllowDelegation(Math.max(running, reservedCount), maxConcurrent)) {
            occupied.set(parentSessionId, reservedCount + 1)
            resolveReservation(parentSessionId)
            return
          }
        }
        if (signal?.aborted) {
          rejectReservation(new SubagentQueueCancelledError(parentSessionId, 'signal'))
          return
        }
        waiters.set(parentSessionId, queue)
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        let onAbort: (() => void) | undefined
        const finalize = (settle: () => void): void => {
          if (settled) return
          settled = true
          const current = waiters.get(parentSessionId)
          if (current !== undefined) {
            const index = current.indexOf(waiter)
            if (index >= 0) current.splice(index, 1)
            if (current.length === 0) waiters.delete(parentSessionId)
          }
          if (timer !== undefined) clearTimeout(timer)
          if (onAbort !== undefined && signal !== undefined) signal.removeEventListener('abort', onAbort)
          settle()
        }
        const waiter: QueueWaiter = {
          parentSessionId,
          admit: () => finalize(() => {
            // 占用与放行在同一同步块完成（串行准入段内），唤醒循环重读 occupied 即见增量。
            occupied.set(parentSessionId, (occupied.get(parentSessionId) ?? 0) + 1)
            resolveReservation(parentSessionId)
          }),
          fail: (error) => finalize(() => rejectReservation(error)),
        }
        if (queueTimeoutSeconds > 0) {
          // setTimeout 上限 2^31-1ms（超出被 Node 当作 1ms 立即触发），clamp；
          // 错误信息仍携带配置原值（老 Gray 同款处理）。
          timer = setTimeout(() => {
            waiter.fail(new SubagentQueueTimeoutError(parentSessionId, queueTimeoutSeconds))
          }, Math.min(queueTimeoutSeconds * 1000, 2 ** 31 - 1))
          unrefTimer(timer)
        }
        if (signal !== undefined) {
          onAbort = () => waiter.fail(new SubagentQueueCancelledError(parentSessionId, 'signal'))
          signal.addEventListener('abort', onAbort, { once: true })
        }
        queue.push(waiter)
      }).catch(rejectReservation)
    })
  }

  /**
   * G3：释放一个并发名额（幂等，释放超出占用时静默归零）并按 FIFO 唤醒等待者。
   * 唤醒在串行准入段内重查计数（listChildren 口径可能已回落），容量仍满则继续等待。
   */
  const release = (parentSessionId: string): void => {
    if (parentSessionId === '') return
    const current = occupied.get(parentSessionId)
    if (current === undefined || current <= 1) {
      occupied.delete(parentSessionId)
    } else {
      occupied.set(parentSessionId, current - 1)
    }
    wakeWaiters(parentSessionId)
  }

  /** G3：名额可能空出（release / 任意 subagent/end）后按 FIFO 补位唤醒。 */
  const wakeWaiters = (parentSessionId: string): void => {
    void serializeAdmission(parentSessionId, async () => {
      for (;;) {
        const queue = waiters.get(parentSessionId)
        if (queue === undefined || queue.length === 0) return
        let running: number
        try {
          running = await countRunning(parentSessionId as SessionId)
        } catch (error) {
          // fail-closed：无法核实计数时拒绝该父会话全部排队者（与直接路径同口径）。
          const failure = new ConcurrencyCheckError(error)
          for (const waiter of queue.splice(0)) waiter.fail(failure)
          waiters.delete(parentSessionId)
          return
        }
        const reservedCount = occupied.get(parentSessionId) ?? 0
        if (!shouldAllowDelegation(Math.max(running, reservedCount), maxConcurrent)) return
        queue.shift()!.admit()
      }
    }).catch(() => undefined) // 唤醒段自身异常不外泄（无调用方可承接；等待者已在段内结算）。
  }

  /**
   * G3 运行时间预算（老 Gray defaultMaxRuntimeSeconds=1800）：one-shot run 句柄可
   * dispose（.d.ts：Cancel remaining work, reach child quiescence, and release
   * resources），到时 dispose → 宿主以非 completed stopReason（'aborted'）结算 result，
   * 消费方（settleForegroundRun / settleRun）按失败处理。result 落定即清定时器；
   * continuable 无 run 句柄（continuation manager 持有子代理全生命周期），不适用。
   */
  const applyRuntimeBudget = (run: SubagentRunLike): SubagentRunLike => {
    if (defaultMaxRuntimeSeconds <= 0) return run
    const timer = setTimeout(() => {
      runtimeTimers.delete(timer)
      options.logger?.warn(
        `graycode-subagents: one-shot subagent run exceeded defaultMaxRuntimeSeconds=${defaultMaxRuntimeSeconds}s — disposing (cancel) so it settles as failed`,
      )
      void Promise.resolve(run.dispose()).catch((error) => {
        options.logger?.warn(
          `graycode-subagents: runtime-budget dispose failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }, Math.min(defaultMaxRuntimeSeconds * 1000, 2 ** 31 - 1))
    unrefTimer(timer)
    runtimeTimers.add(timer)
    const settleBudgetTimer = (): void => {
      if (runtimeTimers.delete(timer)) clearTimeout(timer)
    }
    if (run?.result?.then !== undefined) void run.result.then(settleBudgetTimer, settleBudgetTimer)
    return run
  }

  // G1：消息方向（父→子 / 子→父）都进同一 hop 计数器（threadId = subagent_id 派生）。
  // 注意：包装必须 async——原 seam 方法为异步契约（调用方 await），同步 throw 会绕过
  // 调用方的 rejected-promise 处理路径；同步错误在此转为 rejected promise。
  seam.followup = async (parent, childId, content, opts) => {
    assertHop(String(childId))
    return originals.followup.apply(seam, [parent, childId, content, opts])
  }
  seam.reportFrom = async (child, content, opts) => {
    // L3：优先取真实 threadId（子代理会话 id），缺失才退化到对象实例唯一匿名线程。
    assertHop(reportThreadIdOf(child))
    return originals.reportFrom.apply(seam, [child, content, opts])
  }
  // G3：两个委派入口（one-shot start / continuable startContinuable）都限并发，
  // 且都在同一临界区占用名额（M1）；排队期间委派尚未到达宿主，signal 中止/排队
  // 超时由 reserve 以失败结算。one-shot 额外挂默认运行时间预算。
  seam.start = async (name, request) => {
    const reserved = await reserve(request.parent, request.signal)
    try {
      const run = await originals.start.apply(seam, [name, request])
      applyRuntimeBudget(run)
      if (reserved !== '') {
        if (run?.result?.then !== undefined) {
          // 结算（成功或失败）即释放占用；release 幂等，双路径安全。
          void run.result.then(() => release(reserved), () => release(reserved))
        } else {
          // 防御：无 result 承诺的 run 不存在可观测结算点，立即释放占用。
          release(reserved)
        }
      }
      return run
    } catch (error) {
      if (reserved !== '') release(reserved)
      throw error
    }
  }
  seam.startContinuable = async (spec) => {
    const reserved = await reserve(spec.request.parent, spec.signal)
    try {
      const started = await originals.startContinuable.apply(seam, [spec])
      // continuable 无 run 句柄：占用随 subagent/end 事件释放（生产 events 恒在场）。
      if (reserved !== '') continuableParents.set(String(started.childId), reserved)
      return started
    } catch (error) {
      if (reserved !== '') release(reserved)
      throw error
    }
  }

  // G1：新子代理激活（subagent/start）→ 预算重置仅在确实需要时进行（L4：活跃线程的
  // 再次 start 是 resume，重置会清零累计 hop，让 resume+ping-pong 无限绕开熔断）；
  // 结算（subagent/end）→ 清理 hop 预算并释放 continuable 并发占用。
  const detachEvents: Array<() => void> = []
  if (events) {
    detachEvents.push(events.on('subagent/start', (info) => {
      const threadId = String(info.id)
      if (!hopCounter.has(threadId)) hopCounter.reset(threadId)
    }))
    detachEvents.push(events.on('subagent/end', (info) => {
      const parentSessionId = continuableParents.get(String(info.id))
      if (parentSessionId !== undefined) {
        continuableParents.delete(String(info.id))
        release(parentSessionId)
      }
      // 任意子代理结算都可能让 listChildren 口径回落（激活滞后窗口关闭、守卫安装前
      // 启动的子代理结束）：对仍有排队者的父会话统一补一次准入复查（FIFO 等待者优先，
      // 老 Gray drainQueue 语义）。快照 keys 防迭代中删除。
      for (const queuedParent of [...waiters.keys()]) {
        const queue = waiters.get(queuedParent)
        if (queue !== undefined && queue.length > 0) wakeWaiters(queuedParent)
      }
      hopCounter.clear(String(info.id))
    }))
  }

  // 记录拆除所需状态（原方法 + 事件注销），供「最后一个持有者」的 dispose 使用
  // （H-4b：no-op 双安装也可能成为最后持有者，必须能完整拆除）。
  installState.set(key, { seam, originals, detachEvents })

  const sendToAgent = makeSendToAgent(seam, options.isRootSession)

  const dispose = (): void => {
    // 清空每父会话 FIFO 队列：挂起等待者以 SubagentQueueCancelledError 失败结算
    // （委派未到达宿主，调用方的 await 会得到明确失败而非永久挂起）；排队超时定时器
    // 随 waiter.fail 一并清理。运行时间预算定时器同样清除（不 dispose 仍在运行的
    // run——run 归宿主/调用方所有，拆除守卫不得顺手取消用户任务；预算随之失效）。
    for (const [, queue] of [...waiters]) {
      for (const waiter of queue.splice(0)) {
        waiter.fail(new SubagentQueueCancelledError(waiter.parentSessionId, 'guard-disposed'))
      }
    }
    waiters.clear()
    for (const timer of runtimeTimers) clearTimeout(timer)
    runtimeTimers.clear()
    // 只在自己仍是最后一个持有者时拆除包装（H-4b：先卸载的实例不得恢复原方法，
    // 否则后安装的 no-op guard 会失效、G1/G3 被绕过）。
    releaseOne(key)
  }

  return { seam, sendToAgent, dispose }
}
