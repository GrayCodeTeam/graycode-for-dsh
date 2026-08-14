/**
 * GrayCode - G1 hop 计数器（纯 TS，无 ctx）
 *
 * 老 Gray 用 threadId + hopDepth 做消息级防循环熔断（MAX_HOP_DEPTH=5）：同线程内
 * 父子互发（parent send_message ↔ child report(wakeup)）每投递一跳 +1，超上限拒投。
 * DSH seam 不暴露 thread 概念，本计数器以「subagent_id（子会话 id）派生 threadId」
 * 为线程身份（一个子代理有唯一持久化直接父代理，故 childId 唯一标识一条父子消息链）。
 *
 * 语义：
 * - tryAdvance：check-then-increment，被拒的跳数不消耗预算（与老 Gray「拒投 = 未投递」一致）；
 * - reset(threadId)：新激活纪元开始（subagent/start）时重置，每条线程一个完整预算；
 * - clear(threadId)：线程结束（subagent/end）时清理，防止 map 无限增长；
 * - maxHopDepth=0 表示不限（关闭熔断）。
 */
export type HopAdvance = { allowed: true; hop: number } | { allowed: false; hop: number }

export class ThreadHopCounter {
  private readonly hops = new Map<string, number>()

  constructor(private readonly maxHopDepth: number) {}

  /** 当前线程已用跳数（无记录 = 0）。 */
  peek(threadId: string): number {
    return this.hops.get(threadId) ?? 0
  }

  /**
   * 尝试推进一跳。超上限时返回 allowed:false 且不记录（不消耗预算）；
   * 未超限时记录并返回新跳数。
   */
  tryAdvance(threadId: string): HopAdvance {
    const next = (this.hops.get(threadId) ?? 0) + 1
    if (this.maxHopDepth > 0 && next > this.maxHopDepth) {
      return { allowed: false, hop: next }
    }
    this.hops.set(threadId, next)
    return { allowed: true, hop: next }
  }

  /** 新线程/新激活纪元开始：重置计数（subagent/start）。 */
  reset(threadId: string): void {
    this.hops.set(threadId, 0)
  }

  /** 线程结束：清理计数（subagent/end）。 */
  clear(threadId: string): void {
    this.hops.delete(threadId)
  }
}
