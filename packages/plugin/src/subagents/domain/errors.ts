/**
 * GrayCode - subagents 薄适配层（G1/G2/G3）类型化拒绝错误
 *
 * 各缺口/边界有明确的错误，供上层工具/工作流转译与测试断言：
 * - G1 HopDepthExceededError：同线程 hopDepth 超上限（参照老 Gray MAX_HOP_DEPTH=5 硬熔断）；
 * - G2 UnsupportedAddressingError：子→父任意寻址为 DSH seam 的能力边界，fail-closed；
 * - G3 排队语义（老 Gray concurrencyLimiter）：超 maxConcurrent 的委派进入每父会话 FIFO
 *   队列等待名额，而非直接拒绝——排队超 SubagentQueueTimeoutError、排队中被取消
 *   SubagentQueueCancelledError（委派未启动，均以失败结算回调用方）；
 * - ConcurrencyCheckError：无法枚举运行中数量时 fail-closed（守卫不静默放行）。
 */
export class HopDepthExceededError extends Error {
  readonly threadId: string
  readonly attemptedHop: number
  readonly maxHopDepth: number

  constructor(threadId: string, attemptedHop: number, maxHopDepth: number) {
    super(
      `subagents G1: message delivery rejected — thread ${threadId} hop ${attemptedHop} exceeds maxHopDepth ${maxHopDepth} (old Gray MAX_HOP_DEPTH=5 circuit breaker)`,
    )
    this.name = 'HopDepthExceededError'
    this.threadId = threadId
    this.attemptedHop = attemptedHop
    this.maxHopDepth = maxHopDepth
  }
}

/**
 * 排队等待并发名额超时（老 Gray SubAgentQueueTimeoutError 语义）。
 *
 * 委派在 FIFO 队列中等待超过 subagents.queueTimeoutSeconds 后以失败结算——
 * 超时是失败，不是用户取消；此时委派尚未到达宿主（原 start 未被调用）。
 */
export class SubagentQueueTimeoutError extends Error {
  readonly parentSessionId: string
  readonly queueTimeoutSeconds: number

  constructor(parentSessionId: string, queueTimeoutSeconds: number) {
    super(
      `subagents G3: delegation failed — parent ${parentSessionId} waited in the concurrency queue longer than subagents.queueTimeoutSeconds=${queueTimeoutSeconds}s (run settled as failed, never started)`,
    )
    this.name = 'SubagentQueueTimeoutError'
    this.parentSessionId = parentSessionId
    this.queueTimeoutSeconds = queueTimeoutSeconds
  }
}

/**
 * 排队等待期间被取消：委派请求的 signal 中止，或守卫安装被拆除（dispose/HMR）。
 *
 * 委派同样未到达宿主（原 start 未被调用），以失败结算回调用方。
 */
export class SubagentQueueCancelledError extends Error {
  readonly parentSessionId: string
  readonly reason: 'signal' | 'guard-disposed'

  constructor(parentSessionId: string, reason: 'signal' | 'guard-disposed') {
    super(
      `subagents G3: delegation cancelled while waiting in the concurrency queue on parent ${parentSessionId} (${reason === 'signal' ? 'request signal aborted' : 'guard installation disposed'}; run never started)`,
    )
    this.name = 'SubagentQueueCancelledError'
    this.parentSessionId = parentSessionId
    this.reason = reason
  }
}

export class UnsupportedAddressingError extends Error {
  readonly target: string
  readonly origin: string

  constructor(target: string, origin: string) {
    super(
      `subagents G2: child→parent arbitrary addressing is a DSH seam capability boundary — target "${target}" from "${origin}" is not the caller's durable direct parent; ctx.subagents.reportFrom only reaches the exact live direct parent (see docs/SUBAGENTS_VERIFICATION.md §4 G2)`,
    )
    this.name = 'UnsupportedAddressingError'
    this.target = target
    this.origin = origin
  }
}

export class ConcurrencyCheckError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    super(
      `subagents G3: cannot verify running-subagent count (fail-closed) — ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'ConcurrencyCheckError'
    this.cause = cause
  }
}
