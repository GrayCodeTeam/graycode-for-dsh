/**
 * Gray Code config RPC channel (`/graycode`).
 *
 * Why this channel exists at all: DSH rc.5/rc.6 api-proxy serves settings to
 * the browser through a hard-coded namespace allowlist
 * (`WEB_SETTINGS_NAMESPACES` in packages/host/apiproxy). A third-party
 * namespace — however correctly registered through `ctx.settings.register` —
 * answers `settings-not-exposed` on every read and write, so a panel bound to
 * the native settings scope renders but never edits. The allowlist has no
 * official extension point (the api-proxy comment marks moving it into
 * `settings.register()` as deferred work). This plugin therefore keeps the UI
 * inside the native settings page while carrying reads/writes over the
 * documented generic Connection RPC channel (`ctx.connection.rpc.handle`),
 * which has no namespace allowlist. Persistence still rides the native
 * settings document: the channel handler drives `SettingsScope.update/replace`
 * on the `graycode` namespace, so `$DSH_HOME/settings.yaml` stays the single
 * source of truth and a future DSH that exposes third-party namespaces will
 * work without a plugin change.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GrayCodeConfig, GrayCodePatch } from '../shared/config.ts'
import { DEFAULTS } from '../shared/defaults.ts'

/** Wire-shaped result kept local so the plugin does not import api-proxy types. */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** The settings-scope surface this channel needs (structural). */
export interface ConfigScope {
  get(): GrayCodeConfig
  update(patch: GrayCodePatch): Promise<void>
  replace(section: GrayCodePatch): Promise<void>
}

/** The `connection` service surface this channel needs (structural). */
export interface GrayCodeConnection {
  readonly rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown) => Promise<RpcResult<unknown>>,
      options: { authority: 'trusted-host' | 'loopback' },
    ): () => Promise<void> | void
  }
}

/** Logical channel prefix serving this plugin's config endpoints. */
export const GRAYCODE_CHANNEL = '/graycode'

const TOP_LEVEL_KEYS = new Set(Object.keys(DEFAULTS))

/** Reject non-plain patches and unknown top-level keys before they hit the seam. */
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
 * Register the `/graycode` config channel on a fiber whose context already
 * carries `connection` and whose scope owns the registered `graycode`
 * settings namespace.
 * @param ctx - fiber context with `connection` injected.
 * @param scope - settings scope for the Gray Code namespace.
 * @returns a disposer removing the channel (for `ctx.effect`).
 */
export function registerGrayCodeChannel(ctx: Context, scope: ConfigScope): () => Promise<void> | void {
  const connection = ctx.get('connection') as GrayCodeConnection | undefined
  if (connection === undefined || connection.rpc === undefined) {
    ctx.logger.warn('[graycode] connection service unavailable; config channel not registered')
    return () => undefined
  }
  const handler = async (
    endpoint: string,
    payload: unknown,
  ): Promise<RpcResult<unknown>> => {
    try {
      if (endpoint === 'config.get') {
        return { ok: true, value: scope.get() }
      }
      if (endpoint === 'config.update') {
        const patch = readPatch(payload)
        if (patch === undefined) {
          return badRequest('graycode: config.update expects a plain-object { patch } with known top-level keys')
        }
        await scope.update(patch)
        return { ok: true, value: scope.get() }
      }
      if (endpoint === 'config.replace') {
        const config = readPatch(payload)
        if (config === undefined) {
          return badRequest('graycode: config.replace expects a complete plain-object config')
        }
        await scope.replace(config as GrayCodePatch)
        return { ok: true, value: scope.get() }
      }
      if (endpoint === 'config.reset') {
        await scope.replace({})
        return { ok: true, value: scope.get() }
      }
      return badRequest(`graycode: unknown endpoint "${endpoint}"`)
    } catch (error) {
      return internal(`graycode: ${messageOf(error)}`)
    }
  }
  const disposer = connection.rpc.handle(GRAYCODE_CHANNEL, handler, { authority: 'trusted-host' })
  ctx.logger.info(`[graycode] config channel registered at ${GRAYCODE_CHANNEL}`)
  return disposer
}
