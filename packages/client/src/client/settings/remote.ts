import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { GRAYCODE_CHANNEL } from './store.ts'
import type { GrayRemoteInvoke, GrayRemoteResult } from './types.ts'

/** Adapt the DSH Connection RPC envelope to Gray Remote's nested envelope. */
export function createGrayRemoteInvoker(connection: ConnectionHandle): GrayRemoteInvoke {
  return async <T>(namespace: string, method: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const payload = {
      namespace,
      method,
      args,
    }
    const result = signal === undefined
      ? await connection.rpc.call(GRAYCODE_CHANNEL, 'remote.invoke', payload)
      : await connection.rpc.call(GRAYCODE_CHANNEL, 'remote.invoke', payload, signal)
    if (!result.ok) {
      return {
        ok: false,
        error: {
          code: result.error.code,
          message: result.error.message,
          details: result.error.details,
        },
      } as GrayRemoteResult<T>
    }
    return result.value as GrayRemoteResult<T>
  }
}
