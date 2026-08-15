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
 * - G3：start/startContinuable 委派前在临界区同步占用/释放并发名额（listChildren 快照
 *   与本地占用计数取大，见 reserve/release），超 subagents.maxConcurrent（默认 2）拒绝
 *   新委派并抛 MaxConcurrentSubagentsError，消除 check-then-act 并发窗口（M1）；计数
 *   本身失败时抛 ConcurrencyCheckError（fail-closed）。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { resolveChildToParentTarget } from '../../domain/addressing.ts'
import { shouldAllowDelegation } from '../../domain/concurrencyPolicy.ts'
import {
  ConcurrencyCheckError,
  HopDepthExceededError,
  MaxConcurrentSubagentsError,
  UnsupportedAddressingError,
} from '../../domain/errors.ts'
import { ThreadHopCounter } from '../../domain/hopPolicy.ts'
import type { SubagentReportOptionsLike, SubagentsSeamLike } from './seamTypes.ts'

/** 生命周期事件端口（生产 = ctx.on；测试 = fake bus）。 */
export interface SubagentLifecycleEventsPort {
  on(event: string, listener: (info: { id: SessionId }) => void): () => void
}

export interface SubagentsGuardOptions {
  /** G1：每子线程 hop 上限（老 Gray MAX_HOP_DEPTH=5；0 = 不限/关闭熔断）。 */
  maxHopDepth: number
  /** G3：每父会话运行中子代理上限（老 Gray subagents.maxConcurrent 默认 2；0 = 不限）。 */
  maxConcurrent: number
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
   * 超上限拒绝新请求，消除并发窗口；run 结算（result 落定 / subagent/end）时释放。
   */
  const occupied = new Map<string, number>()
  /** continuable 子代理占用：childId → 已占用的父会话（随 subagent/end 释放）。 */
  const continuableParents = new Map<string, string>()

  /** G1：同线程 hop 检查（check-then-increment；被拒不消耗预算）。 */
  const assertHop = (threadId: string): void => {
    if (options.maxHopDepth <= 0) return
    const decision = hopCounter.tryAdvance(threadId)
    if (!decision.allowed) {
      throw new HopDepthExceededError(threadId, decision.hop, options.maxHopDepth)
    }
  }

  /**
   * G3：委派前占用一个并发名额（fail-closed）。返回归一化父会话 id（调用方据此在
   * 结算/失败时 release）；maxConcurrent<=0 时返回 ''（不限，不占用）。有效数取
   * max(running, occupied)：running 是 listChildren 的 ground truth（含本 guard 已可见
   * 的子代理），occupied 覆盖其激活滞后窗口——取大既消除 check-then-act 窗口，又不会
   * 在快照追上后与 running 双重计数（过度拒绝）。
   */
  const reserve = async (parent: Agent): Promise<string> => {
    if (maxConcurrent <= 0) return ''
    const rawParentSessionId = parent?.id ?? parent?.session?.id
    if (!rawParentSessionId) {
      throw new ConcurrencyCheckError(new Error('delegating parent has no session id'))
    }
    // M3：统一为 session:// 前缀（计数端口按 scheme 匹配会话，缺前缀会静默失配）。
    const parentSessionId = normalizeSessionId(rawParentSessionId)
    let running: number
    try {
      running = await countRunning(parentSessionId)
    } catch (error) {
      throw new ConcurrencyCheckError(error)
    }
    const reserved = occupied.get(parentSessionId) ?? 0
    const effective = Math.max(running, reserved)
    if (!shouldAllowDelegation(effective, maxConcurrent)) {
      throw new MaxConcurrentSubagentsError(String(parentSessionId), effective, maxConcurrent)
    }
    occupied.set(parentSessionId, reserved + 1)
    return parentSessionId
  }

  /** G3：释放一个并发名额（幂等，释放超出占用时静默归零）。 */
  const release = (parentSessionId: string): void => {
    if (parentSessionId === '') return
    const current = occupied.get(parentSessionId)
    if (current === undefined || current <= 1) {
      occupied.delete(parentSessionId)
    } else {
      occupied.set(parentSessionId, current - 1)
    }
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
  // 且都在同一临界区占用名额（M1）。
  seam.start = async (name, request) => {
    const reserved = await reserve(request.parent)
    try {
      const run = await originals.start.apply(seam, [name, request])
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
    const reserved = await reserve(spec.request.parent)
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
      hopCounter.clear(String(info.id))
    }))
  }

  // 记录拆除所需状态（原方法 + 事件注销），供「最后一个持有者」的 dispose 使用
  // （H-4b：no-op 双安装也可能成为最后持有者，必须能完整拆除）。
  installState.set(key, { seam, originals, detachEvents })

  const sendToAgent = makeSendToAgent(seam, options.isRootSession)

  const dispose = (): void => {
    // 只在自己仍是最后一个持有者时拆除包装（H-4b：先卸载的实例不得恢复原方法，
    // 否则后安装的 no-op guard 会失效、G1/G3 被绕过）。
    releaseOne(key)
  }

  return { seam, sendToAgent, dispose }
}
