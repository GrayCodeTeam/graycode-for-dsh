/**
 * Manual conversation summary — pure logic.
 *
 * `unpackSummarizeResult` flattens the nested wire envelope (Connection RPC
 * result → grayRemote failure envelope → endpoint result) into a domain
 * result; `runSummarize` drives the click flow (working → success/failed)
 * with an injected remote seat, so the node-environment tests cover the whole
 * decision surface without React.
 */

/** Wire envelope of `connection.rpc.call(...)` (and of the nested grayRemote result). */
export interface SummarizeRemoteEnvelopeLike {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: {
    readonly code?: string
    readonly message?: string
    readonly details?: { readonly code?: string } | null
  }
}

/** Remote seat: endpoint invoke over the `/graycode` Connection channel. */
export type SummarizeRemoteLike = (
  namespace: string,
  method: string,
  args?: Record<string, unknown>,
) => Promise<SummarizeRemoteEnvelopeLike>

export type UnpackedSummarizeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly domainCode?: string }

/**
 * 扁平化总结响应：transport 失败（RPC 信封 ok=false）、grayRemote 业务失败
 * （value.ok=false，details.code 携带插件域码如 EMPTY_INPUT）、成功
 * （value.ok=true + text 非空）。畸形/空文本按失败处理，绝不让空弹层静默。
 */
export function unpackSummarizeResult(call: SummarizeRemoteEnvelopeLike): UnpackedSummarizeResult {
  if (!call.ok) {
    return {
      ok: false,
      code: call.error?.code ?? 'transport',
      message: call.error?.message ?? 'remote call failed',
    }
  }
  const value = call.value
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    return { ok: false, code: 'malformed', message: 'malformed summarize response' }
  }
  const envelope = value as SummarizeRemoteEnvelopeLike
  if (!envelope.ok) {
    return {
      ok: false,
      code: envelope.error?.code ?? 'unknown',
      message: envelope.error?.message ?? 'summarize failed',
      domainCode: envelope.error?.details?.code,
    }
  }
  const text = (envelope.value as { text?: unknown } | undefined)?.text
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, code: 'empty', message: 'summarize returned no text' }
  }
  return { ok: true, text }
}

export type SummarizePhase = 'idle' | 'working' | 'success' | 'failed'

/** 点击流程的驱动状态（组件把每次推送写入 useState）。 */
export interface SummarizeRunState {
  readonly phase: SummarizePhase
  /** success 时的总结文本。 */
  readonly text?: string
  /** failed 时的可展示错误文案。 */
  readonly failure?: string
}

/** 领域码 → 是否需要本地化「无内容」文案（EMPTY_INPUT：全部落在保留窗口内）。 */
export function isEmptyInputResult(domainCode: string | undefined): boolean {
  return domainCode === 'EMPTY_INPUT'
}

/**
 * 点击总结：调 `summary/generate` 并驱动状态。
 * 失败非静默：failed 状态携带 `t(failed): message` 文案 + console.warn；
 * transport 异常同样落 failed。返回终态供测试断言。
 */
export async function runSummarize(
  remote: SummarizeRemoteLike,
  sessionId: string,
  onState: (state: SummarizeRunState) => void,
  translate: (key: 'failed' | 'empty', params?: Record<string, unknown>) => string,
): Promise<SummarizeRunState> {
  onState({ phase: 'working' })
  try {
    const call = await remote('summary', 'generate', { sessionId })
    const result = unpackSummarizeResult(call)
    if (result.ok) {
      const state: SummarizeRunState = { phase: 'success', text: result.text }
      onState(state)
      return state
    }
    const message = isEmptyInputResult(result.domainCode)
      ? translate('empty')
      : `${translate('failed')}: ${result.message}`
    const state: SummarizeRunState = { phase: 'failed', failure: message }
    onState(state)
    console.warn(`[graycode.summarize] ${result.code}: ${result.message}`)
    return state
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const state: SummarizeRunState = { phase: 'failed', failure: `${translate('failed')}: ${detail}` }
    onState(state)
    console.warn('[graycode.summarize] transport failure:', error)
    return state
  }
}
