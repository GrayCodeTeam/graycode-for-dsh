/**
 * GrayCode - G3 运行中子代理计数适配（listChildren 公开投影）
 *
 * DSH `ctx.subagents.listChildren(parentSessionId)` 返回每子代理的 store 快照
 * activity（'running' = live 于 ctx.sessions；'inactive' = 仅持久化）。G3 以
 * `kind === 'child' && activity === 'running'` 作为「运行中」口径——与老 Gray
 * maxConcurrent 按「并行在跑子代理」计数一致。listDescendants 也可行但更重，
 * 直接子代理计数即够（上限按父会话计，不跨代）。
 */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentsSeamLike } from './seamTypes.ts'

export function countRunningChildrenViaList(
  seam: SubagentsSeamLike,
): (parentSessionId: SessionId) => Promise<number> {
  return async (parentSessionId) => {
    const entries = await seam.listChildren(parentSessionId)
    return entries.filter((entry) => entry.kind === 'child' && entry.activity === 'running').length
  }
}
