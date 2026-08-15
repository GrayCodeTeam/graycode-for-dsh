/**
 * GrayCode - G3 并发准入判定（纯 TS，无 ctx）
 *
 * 老 Gray settings `subagents.maxConcurrentAgents`（默认 3）按会话限制并行子代理数，
 * 超出的调用进入全局 FIFO 信号量排队等待，而不是被拒绝（concurrencyLimiter.ts）。
 * DSH 无等价配置，本薄适配层在委派入口（start / startContinuable）前判定准入：
 * 父会话当前运行中的子代理数（经 listChildren 观察 activity === 'running'）加上
 * 本守卫的本地占用，达到上限时新委派进入每父会话 FIFO 队列，等待 release 唤醒，
 * 排队超过 subagents.queueTimeoutSeconds 以失败结算（-1 = 无限等待）。
 *
 * maxConcurrent=0 表示不限（关闭上限，guard 连计数查询都不做、不排队）。
 */
export function shouldAllowDelegation(runningCount: number, maxConcurrent: number): boolean {
  if (maxConcurrent <= 0) return true
  return runningCount < maxConcurrent
}
