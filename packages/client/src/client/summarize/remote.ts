/**
 * Manual conversation summary — remote seat.
 *
 * Adapts the DSH Connection RPC envelope to the summary endpoint's nested
 * envelope over the host's `/graycode` channel (registered by the plugin's
 * settings domain; `remote.invoke` dispatches to Gray Remote endpoints).
 * Self-contained: deliberately does not import from `settings/` (owned by
 * another workstream) — the wire contract is duplicated structurally.
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SummarizeRemoteEnvelopeLike, SummarizeRemoteLike } from './logic.ts'

/** 通道前缀（与宿主 `/graycode` channel 共享，见 plugin/src/settings/rpc.ts）。 */
export const GRAYCODE_SUMMARIZE_CHANNEL = '/graycode'

/** Create the `summary/*` endpoint invoker over one connection handle. */
export function createSummarizeRemote(connection: ConnectionHandle): SummarizeRemoteLike {
  return async (namespace, method, args = {}) => {
    const result = await connection.rpc.call(
      GRAYCODE_SUMMARIZE_CHANNEL,
      'remote.invoke',
      { namespace, method, args },
    )
    return result as SummarizeRemoteEnvelopeLike
  }
}
