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

/** 客户端兜底超时（毫秒）：host 悬挂时弹层不永久卡死（默认 60s）。 */
export const SUMMARIZE_TIMEOUT_MS = 60_000

/** runSummarize 选项：超时预算 + 调用方取消信号（关闭弹层即中止）。 */
export interface SummarizeRunOptions {
  /** 客户端兜底超时毫秒（默认 SUMMARIZE_TIMEOUT_MS；测试注入小预算）。 */
  readonly timeoutMs?: number
  /** 调用方取消信号：中止后返回 idle 且不再推送状态（恢复按钮）。 */
  readonly signal?: AbortSignal
}

/** 领域码 → 是否需要本地化「无内容」文案（EMPTY_INPUT：全部落在保留窗口内）。 */
export function isEmptyInputResult(domainCode: string | undefined): boolean {
  return domainCode === 'EMPTY_INPUT'
}

/** 把远端调用与本地信号赛跑：信号中止即拒绝（远端 promise 的结果随后被丢弃）。 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const onAbort = (): void => reject(new DOMException('aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * 点击总结：调 `summary/generate` 并驱动状态。
 * 失败非静默：failed 状态携带 `t(failed): message` 文案 + console.warn；
 * transport 异常同样落 failed。返回终态供测试断言。
 *
 * 兜底（M-1）：options.timeoutMs 超时 → failed(t('timeout'))；options.signal
 * 中止（用户关闭弹层）→ 静默返回 idle（恢复按钮），host 悬挂不再卡死 UI。
 */
export async function runSummarize(
  remote: SummarizeRemoteLike,
  sessionId: string,
  onState: (state: SummarizeRunState) => void,
  translate: (key: 'failed' | 'empty' | 'timeout', params?: Record<string, unknown>) => string,
  options: SummarizeRunOptions = {},
): Promise<SummarizeRunState> {
  const timeoutMs = options.timeoutMs ?? SUMMARIZE_TIMEOUT_MS
  onState({ phase: 'working' })
  let timedOut = false
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', onAbort)
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const call = await raceWithAbort(remote('summary', 'generate', { sessionId }), controller.signal)
    const result = unpackSummarizeResult(call)
    if (result.ok) {
      const state: SummarizeRunState = { phase: 'success', text: result.text }
      onState(state)
      return state
    }
    if (result.code === 'GRAY_CANCELLED') {
      // 服务端已取消（ABORTED → GRAY_CANCELLED）：与本地取消同语义，静默恢复按钮
      return { phase: 'idle' }
    }
    const message = isEmptyInputResult(result.domainCode)
      ? translate('empty')
      : `${translate('failed')}: ${result.message}`
    const state: SummarizeRunState = { phase: 'failed', failure: message }
    onState(state)
    console.warn(`[graycode.summarize] ${result.code}: ${result.message}`)
    return state
  } catch (error) {
    if (timedOut) {
      const state: SummarizeRunState = { phase: 'failed', failure: translate('timeout') }
      onState(state)
      console.warn('[graycode.summarize] summarize timed out')
      return state
    }
    if (options.signal?.aborted) {
      // 用户关闭弹层：中止等待，恢复按钮（不推送失败状态）
      return { phase: 'idle' }
    }
    const detail = error instanceof Error ? error.message : String(error)
    const state: SummarizeRunState = { phase: 'failed', failure: `${translate('failed')}: ${detail}` }
    onState(state)
    console.warn('[graycode.summarize] transport failure:', error)
    return state
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
