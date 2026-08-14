/**
 * Gray Code 配置 RPC 通道（`/graycode`）。
 *
 * 为什么需要这条通道：DSH rc.5/rc.6 的 api-proxy 通过硬编码命名空间白名单
 * （`WEB_SETTINGS_NAMESPACES`）向浏览器提供 settings——第三方命名空间无论是否
 * 正确经 `ctx.settings.register` 注册，都会在每次读写时得到 `settings-not-exposed`，
 * 面板能渲染但永远编辑不了。白名单没有官方扩展点（api-proxy 注释把「移入
 * settings.register()」列为 deferred 工作）。本插件因此让面板留在原生 settings
 * 页内，但读写走文档化的通用 Connection RPC 通道（`ctx.connection.rpc.handle`，
 * 无命名空间白名单）。持久化仍由原生 settings 文档承担：handler 驱动注册好的
 * `graycode` 命名空间 `SettingsScope.update/replace`，$DSH_HOME/settings.yaml
 * 保持唯一事实来源；未来 DSH 开放第三方命名空间后无需改插件即可平移。
 *
 * 设计为可测：handler 逻辑经 `createGrayCodeConfigHandler` 工厂导出，注入
 * scope 桩即可单测四个端点；`registerGrayCodeChannel` 只做 connection 守卫与
 * 注册接线，注入 ctx/connection 桩即可单测。
 */

import { DEFAULTS } from './defaults.ts'
import type { GrayCodeConfig, GrayCodePatch } from './types.ts'

/** 线形结果（本地定义，不 import dsh-host-apiproxy 的类型）。 */
export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

/** 本通道需要的 settings scope 表面（结构化子集）。 */
export interface ConfigScope {
  get(): GrayCodeConfig
  update(patch: GrayCodePatch): Promise<void>
  replace(section: GrayCodePatch): Promise<void>
}

/** 本通道需要的 connection 服务表面（结构化子集，不依赖 dsh-client-connection 类型）。 */
export interface GrayCodeConnection {
  readonly rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown) => Promise<RpcResult<unknown>>,
      options: { authority: 'trusted-host' | 'loopback' },
    ): () => Promise<void> | void
  }
}

/** 注册 /graycode 通道所需的 host 上下文表面（结构化子集，便于测试桩注入）。 */
export interface ChannelHostContextLike {
  get(name: string): unknown
  readonly logger: {
    warn(message: string): void
    info(message: string): void
  }
}

/** 逻辑通道前缀，承载本插件的配置端点。 */
export const GRAYCODE_CHANNEL = '/graycode'

const TOP_LEVEL_KEYS = new Set(Object.keys(DEFAULTS))

/**
 * 校验顶层 key 白名单：只接受普通对象、且所有 key 都在默认文档顶层
 * （未知 key / 非对象载荷在进入 settings seam 之前拒绝）。
 * @param payload - 通道载荷。
 * @returns 合法补丁，否则 undefined。
 */
function readPatch(payload: unknown): GrayCodePatch | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const patch: GrayCodePatch = {}
  for (const [key, value] of Object.entries(payload)) {
    if (!TOP_LEVEL_KEYS.has(key)) return undefined
    ;(patch as Record<string, unknown>)[key] = value
  }
  return patch
}

function badRequest(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'bad-request', message } }
}

function internal(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'internal', message } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 创建 `/graycode` 通道 handler（config.get/update/replace/reset 四端点）。
 * 纯工厂：不触碰任何 host 服务，注入 scope 桩即可单测。
 * @param scope - 已注册 graycode 命名空间的 settings scope。
 * @returns 通道 handler（端点 → 载荷 → RpcResult）。
 */
export function createGrayCodeConfigHandler(scope: ConfigScope): (endpoint: string, payload: unknown) => Promise<RpcResult<unknown>> {
  return async (endpoint: string, payload: unknown): Promise<RpcResult<unknown>> => {
    try {
      if (endpoint === 'config.get') {
        return { ok: true, value: scope.get() }
      }
      if (endpoint === 'config.update') {
        const patch = readPatch(payload)
        if (patch === undefined) {
          return badRequest('graycode: config.update 期望普通对象补丁且 key 均为已知顶层字段')
        }
        await scope.update(patch)
        return { ok: true, value: scope.get() }
      }
      if (endpoint === 'config.replace') {
        const config = readPatch(payload)
        if (config === undefined) {
          return badRequest('graycode: config.replace 期望完整普通对象配置且 key 均为已知顶层字段')
        }
        await scope.replace(config as GrayCodePatch)
        return { ok: true, value: scope.get() }
      }
      if (endpoint === 'config.reset') {
        await scope.replace({})
        return { ok: true, value: scope.get() }
      }
      return badRequest(`graycode: 未知端点 "${endpoint}"`)
    } catch (error) {
      return internal(`graycode: ${messageOf(error)}`)
    }
  }
}

/**
 * 在携带 `connection` 的 fiber 上注册 `/graycode` 配置通道。connection 缺失
 * （未挂载/不可用）时仅告警并跳过——settings 命名空间注册不受影响。
 * @param ctx - fiber 上下文（已注入 settings）。
 * @param scope - graycode 命名空间的 settings scope。
 * @returns 注销函数（供 ctx.effect 收集；connection 缺失时为 no-op）。
 */
export function registerGrayCodeChannel(ctx: ChannelHostContextLike, scope: ConfigScope): () => Promise<void> | void {
  const connection = ctx.get('connection') as GrayCodeConnection | undefined
  if (connection === undefined || connection.rpc === undefined) {
    ctx.logger.warn('[graycode] connection 服务不可用，/graycode 配置通道未注册（settings 命名空间不受影响）')
    return () => undefined
  }
  const disposer = connection.rpc.handle(GRAYCODE_CHANNEL, createGrayCodeConfigHandler(scope), {
    authority: 'trusted-host',
  })
  ctx.logger.info(`[graycode] 配置通道已注册: ${GRAYCODE_CHANNEL}`)
  return disposer
}
