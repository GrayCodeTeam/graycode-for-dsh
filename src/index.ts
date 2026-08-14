/**
 * Gray Code for DSH — Host plugin.
 *
 * Registers the `graycode` settings namespace (persistence + host reads,
 * composed over the shared default document) and the `/graycode` config
 * channel the browser settings section reads and writes through.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GrayCodeConfig, GrayCodePatch } from '../shared/config.ts'
import { DEFAULTS } from '../shared/defaults.ts'
import { GRAYCODE_SETTINGS_NAMESPACE, GrayCodeSchema } from './schema.ts'
import { registerGrayCodeChannel, type ConfigScope } from './rpc.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'graycode'

/** Required services (cordis fiber inject). */
export const inject = ['connection']

/** Resolved plugin config: the composition entry may override defaults. */
export interface Config {
  /** Composition-layer overrides merged under the schema defaults. */
  base?: Partial<GrayCodeConfig>
}

/**
 * Mount the Gray Code settings namespace and its config channel.
 * The channel lives on a fiber with `settings` injected so it disappears
 * together with the provider (disposal, reload).
 * @param ctx - plugin context.
 * @param config - composition entry config (optional base overrides).
 */
export function apply(ctx: Context, config?: Config): void {
  ctx.inject(['settings'], (sctx) => {
    const base = { ...DEFAULTS, ...config?.base } as GrayCodeConfig
    const scope = sctx.settings.register(GRAYCODE_SETTINGS_NAMESPACE, GrayCodeSchema, { base })
    const configScope: ConfigScope = {
      get: () => scope.get() as GrayCodeConfig,
      update: (patch: GrayCodePatch) => scope.update(patch as object),
      replace: (section: GrayCodePatch) => scope.replace(section as object),
    }
    sctx.effect(() => registerGrayCodeChannel(sctx, configScope), 'graycode: config channel')
    sctx.logger.info('[graycode] settings namespace registered (graycode: in settings document)')
  })
}
