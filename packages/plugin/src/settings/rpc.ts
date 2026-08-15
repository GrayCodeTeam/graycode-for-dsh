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

/**
 * 浏览器桥（/graycode remote.invoke）允许转发的 Gray Remote 端点白名单（M1）。
 *
 * 背景：该通道 authority 为 'trusted-host'，但防御纵深要求桥层不无差别透传全部
 * 端点——后续新增端点默认不可达，须显式加入本白名单（fail-closed）。当前条目覆盖
 * 浏览器面板实际消费的全部端点；破坏性端点（memory/forget、checkpoints/restore/
 * delete/gc、stagedDiff/accept|reject、branches/rename）各自携带 handler 级确认门
 * （confirm:true / previewToken / CAS revision），白名单不重复拦截，但任何新端点
 * 默认被拒，杜绝「新注册端点自动暴露给浏览器」的扩散面。
 */
export const REMOTE_BRIDGE_ENDPOINT_ALLOWLIST: ReadonlySet<string> = new Set([
  'activity/stats',
  'branches/editRetry',
  'branches/list',
  'branches/rename',
  'branches/reroll',
  'checkpoints/create',
  'checkpoints/list',
  'checkpoints/verify',
  'checkpoints/previewRestore',
  'checkpoints/restore',
  'checkpoints/delete',
  'checkpoints/gc',
  'memory/list',
  'memory/note',
  'memory/edit',
  'memory/forget',
  'memory/forgetBatch',
  'memory/scopes',
  'memory/configGet',
  'memory/configUpdate',
  'migration/scopeMap',
  'prompt/modes.list',
  'prompt/modes.get',
  'prompt/modes.setCurrent',
  'prompt/modes.create',
  'prompt/modes.update',
  'prompt/modes.delete',
  'prompt/modes.duplicate',
  'prompt/modes.import',
  'prompt/modes.export',
  'stagedDiff/list',
  'stagedDiff/preview',
  'stagedDiff/accept',
  'stagedDiff/reject',
  'summary/generate',
  'workflows/list',
  'workflows/get',
])

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

/**
 * 校验 patch 的嵌套值（L12）：对每个顶层键用其子 schema（schema.dict[key]，与
 * schema.spec.ts 对 GrayCodeSchema.dict 的既有读取口径一致）做一次构造级校验。
 * 下游 scope.update 本身也会校验（dsh-settings：校验失败在持久化前拒绝），此处
 * 提前到 RPC 层，让非法嵌套值以 bad-request（带具体字段）返回而非 generic internal。
 */
function validatePatchNested(schema: z<GrayCodeConfig>, patch: GrayCodePatch): string | null {
  for (const [key, value] of Object.entries(patch)) {
    const sub = schema.dict?.[key]
    if (sub === undefined) continue
    try {
      sub(value as never)
    } catch (error) {
      return `${key}: ${messageOf(error)}`
    }
  }
  return null
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
        // L12：嵌套值在 RPC 层先行校验（错误码从 generic internal 提前为 bad-request）
        const nestedIssue = validatePatchNested(schema, patch)
        if (nestedIssue !== null) {
          return badRequest(`graycode: config.update rejected by schema (${nestedIssue})`)
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
        // M1：端点白名单校验（fail-closed）——未列入白名单的端点不转发
        if (!REMOTE_BRIDGE_ENDPOINT_ALLOWLIST.has(`${call.namespace}/${call.method}`)) {
          return badRequest(
            `graycode: remote.invoke endpoint "${call.namespace}/${call.method}" is not whitelisted for the browser bridge`,
          )
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
