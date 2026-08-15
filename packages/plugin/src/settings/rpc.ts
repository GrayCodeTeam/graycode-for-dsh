/** Browser bridge for native GrayCode settings and Gray Remote endpoints. */

import type z from '@deepseek-ai/schemastery'
import { redactSecrets } from '@deepseek-ai/dsh-settings'
import { DEFAULTS } from './defaults.ts'
import type { GrayCodeConfig, GrayCodePatch } from './types.ts'

interface RpcBadRequest {
  code: 'bad-request'
  message: string
  details: { issues: unknown[] }
}

interface RpcInternalError {
  code: 'internal'
  message: string
  details: Record<string, never>
}

/** DSH Connection RPC result envelope. Error details are required by its client parser. */
export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RpcBadRequest | RpcInternalError }

export interface ConfigScope {
  get(): GrayCodeConfig
  update(patch: GrayCodePatch): Promise<void>
  replace(section: GrayCodePatch): Promise<void>
}

export interface GrayRemoteLike {
  invoke(
    namespace: string,
    method: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>
}

export interface GrayCodeConnection {
  readonly rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<RpcResult<unknown>>,
      options: { authority: 'trusted-host' | 'loopback' },
    ): () => Promise<void> | void
  }
}

export interface ChannelHostContextLike {
  get(name: string): unknown
  readonly logger: {
    warn(message: string): void
    info(message: string): void
  }
}

export const GRAYCODE_CHANNEL = '/graycode'

const TOP_LEVEL_KEYS = new Set(Object.keys(DEFAULTS))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPatch(payload: unknown): GrayCodePatch | undefined {
  if (!isRecord(payload)) return undefined
  const patch: GrayCodePatch = {}
  for (const [key, value] of Object.entries(payload)) {
    if (!TOP_LEVEL_KEYS.has(key)) return undefined
    ;(patch as Record<string, unknown>)[key] = value
  }
  return patch
}

/** The documented update payload is `{ patch }`; direct patches remain compatible. */
function readUpdatePatch(payload: unknown): GrayCodePatch | undefined {
  if (isRecord(payload) && Object.keys(payload).length === 1 && 'patch' in payload) {
    return readPatch(payload.patch)
  }
  return readPatch(payload)
}

function readRemoteCall(payload: unknown): {
  namespace: string
  method: string
  args: Record<string, unknown>
} | undefined {
  if (!isRecord(payload)) return undefined
  if (typeof payload.namespace !== 'string' || payload.namespace.trim() === '') return undefined
  if (typeof payload.method !== 'string' || payload.method.trim() === '') return undefined
  if (payload.args !== undefined && !isRecord(payload.args)) return undefined
  return {
    namespace: payload.namespace,
    method: payload.method,
    args: payload.args ?? {},
  }
}

function badRequest(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function internal(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createGrayCodeConfigHandler(
  scope: ConfigScope,
  schema: z<GrayCodeConfig>,
  remote?: GrayRemoteLike,
): (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<RpcResult<unknown>> {
  const getForWire = (): GrayCodeConfig => redactSecrets(schema as z<never>, scope.get()).value as GrayCodeConfig

  return async (endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>> => {
    try {
      if (endpoint === 'config.get') {
        return { ok: true, value: getForWire() }
      }
      if (endpoint === 'config.update') {
        const patch = readUpdatePatch(payload)
        if (patch === undefined) {
          return badRequest('graycode: config.update expects { patch } with known top-level keys')
        }
        await scope.update(patch)
        return { ok: true, value: getForWire() }
      }
      if (endpoint === 'config.reset') {
        await scope.replace({})
        return { ok: true, value: getForWire() }
      }
      if (endpoint === 'remote.invoke') {
        const call = readRemoteCall(payload)
        if (call === undefined) {
          return badRequest('graycode: remote.invoke expects namespace, method and optional object args')
        }
        if (remote === undefined) {
          return internal('graycode: Gray Remote service is unavailable')
        }
        return { ok: true, value: await remote.invoke(call.namespace, call.method, call.args, signal) }
      }
      return badRequest(`graycode: unknown endpoint "${endpoint}"`)
    } catch (error) {
      return internal(`graycode: ${messageOf(error)}`)
    }
  }
}

export function registerGrayCodeChannel(
  ctx: ChannelHostContextLike,
  scope: ConfigScope,
  schema: z<GrayCodeConfig>,
): () => Promise<void> | void {
  const connection = ctx.get('connection') as GrayCodeConnection | undefined
  if (connection === undefined || connection.rpc === undefined) {
    ctx.logger.warn('[graycode] connection service unavailable; /graycode was not registered')
    return () => undefined
  }
  const remote = ctx.get('grayRemote') as GrayRemoteLike | undefined
  const disposer = connection.rpc.handle(
    GRAYCODE_CHANNEL,
    createGrayCodeConfigHandler(scope, schema, remote),
    { authority: 'trusted-host' },
  )
  ctx.logger.info(`[graycode] browser channel registered: ${GRAYCODE_CHANNEL}`)
  return disposer
}
