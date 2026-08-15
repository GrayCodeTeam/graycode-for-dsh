/**
 * GrayCode - subagents stop-reason 共享词汇表（统一 stop reason 错误码，L2）
 *
 * dsh-subagent@0.1.0-rc.6 的 `SubagentResult.stopReason` 在 .d.ts 中为 string 宽类型
 * （未导出精确联合；见 docs/SUBAGENTS_VERIFICATION.md §2 探针）。本表是前台结算
 * （settleForegroundRun）判断「run 是否干净完成」的唯一事实源：所有消费方都应从这里
 * 取错误码文案，不再各自硬编码 switch。词汇按 DSH LLM ChatStopReason 惯例整理，覆盖
 * 本域已观察到的全部值；新增/未知 stop reason 一律经 default 分支原样上报（fail-closed，
 * 绝不静默视为成功）。后续若 host 暴露精确联合，据此表核对即可。
 */

/** 已识别为「干净完成」的 stop reason（唯一非异常值）。 */
export const SUBAGENT_STOP_REASON_COMPLETED = 'completed' as const

/**
 * 已知非完成 stop reason → 前台运行失败文案。key 使用字面联合；未知值由
 * stopReasonError 的 default 分支兜底。
 */
export const SUBAGENT_STOP_REASON_ERRORS = {
  aborted: 'subagent run was cancelled',
  error: 'subagent run failed',
  'max-tokens': 'subagent run hit its token limit before finishing',
  refusal: 'subagent declined the task',
} as const

export type SubagentStopReasonErrorCode = keyof typeof SUBAGENT_STOP_REASON_ERRORS

/**
 * 前台运行结算判定：
 * - 'completed' → undefined（干净完成，不视为失败）；
 * - 已知非完成码 → 对应失败文案；
 * - 未知码 → 带原值的异常文案（不静默吞掉，便于对真实 dsh-subagent 词汇做审计）。
 */
export function stopReasonError(reason: string): string | undefined {
  if (reason === SUBAGENT_STOP_REASON_COMPLETED) return undefined
  const known = SUBAGENT_STOP_REASON_ERRORS[reason as SubagentStopReasonErrorCode]
  if (known !== undefined) return known
  return `subagent run ended abnormally (${reason})`
}
