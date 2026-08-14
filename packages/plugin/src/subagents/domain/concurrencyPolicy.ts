/**
 * GrayCode - G3 并发上限判定（纯 TS，无 ctx）
 *
 * 老 Gray settings `subagents.maxConcurrent`（默认 2）按会话限制并行子代理数。
 * DSH 无等价配置，本薄适配层在委派入口（start / startContinuable）前检查父会话
 * 当前运行中的子代理数（经 listChildren 观察 activity === 'running'），超限拒绝新委派。
 *
 * maxConcurrent=0 表示不限（关闭上限，guard 连计数查询都不做）。
 */
export function shouldAllowDelegation(runningCount: number, maxConcurrent: number): boolean {
  if (maxConcurrent <= 0) return true
  return runningCount < maxConcurrent
}
