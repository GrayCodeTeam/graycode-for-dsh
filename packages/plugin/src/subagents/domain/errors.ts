/**
 * GrayCode - subagents 薄适配层（G1/G2/G3）类型化拒绝错误
 *
 * 三个缺口各有明确的拒绝错误，供上层工具/工作流转译与测试断言：
 * - G1 HopDepthExceededError：同线程 hopDepth 超上限（参照老 Gray MAX_HOP_DEPTH=5 硬熔断）；
 * - G2 UnsupportedAddressingError：子→父任意寻址为 DSH seam 的能力边界，fail-closed；
 * - G3 MaxConcurrentSubagentsError：运行中子代理数超 subagents.maxConcurrent；
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

export class MaxConcurrentSubagentsError extends Error {
  readonly parentSessionId: string
  readonly running: number
  readonly maxConcurrent: number

  constructor(parentSessionId: string, running: number, maxConcurrent: number) {
    super(
      `subagents G3: delegation rejected — parent ${parentSessionId} already runs ${running} subagents, exceeding subagents.maxConcurrent=${maxConcurrent}`,
    )
    this.name = 'MaxConcurrentSubagentsError'
    this.parentSessionId = parentSessionId
    this.running = running
    this.maxConcurrent = maxConcurrent
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
