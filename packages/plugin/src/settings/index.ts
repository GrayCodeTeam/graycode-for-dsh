/**
 * Gray Code 设置面板 —— Host 侧领域入口。
 *
 * 注册 `graycode` settings 命名空间（schemastery schema + DEFAULTS base 层，
 * 持久化到 $DSH_HOME/settings.yaml）并挂载 `/graycode` 配置通道（浏览器面板
 * 的 config.get/update/reset 与 Gray Remote bridge，见 rpc.ts 为什么不用原生 settings
 * 线）。通道随带 `settings` 注入的 fiber 一起卸载（disposal / reload）。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { GRAYCODE_SETTINGS_NAMESPACE, GrayCodeSchema } from './schema.ts'
import { registerGrayCodeChannel, type ConfigScope } from './rpc.ts'
import type { GrayCodeConfig, GrayCodePatch } from './types.ts'

export type { GrayCodeConfig, GrayCodePatch } from './types.ts'

export const name = 'graycode-settings'

export interface Config {
  /** Composition config projected from the real child-plugin fibers. */
  base: GrayCodeConfig
  /** Internal live-reload sink installed by the composition root. */
  onChange?: (next: GrayCodeConfig, prev?: GrayCodeConfig) => void | Promise<void>
}

export const Config: z<Config> = z.object({
  base: GrayCodeSchema,
  onChange: z.any().default(undefined),
})

export function apply(ctx: Context, config: Config): void {
  // Both services are hard dependencies of this browser-facing domain. Using
  // inject instead of a one-shot ctx.get means a connection reload re-registers
  // the channel automatically and HMR cannot leave the panel stranded.
  ctx.inject(['settings', 'connection'], (sctx) => {
    const scope = sctx.settings.register(GRAYCODE_SETTINGS_NAMESPACE, GrayCodeSchema, {
      base: config.base,
      applies: 'live',
    })
    const configScope: ConfigScope = {
      get: () => scope.get(),
      update: (patch: GrayCodePatch) => scope.update(patch as object),
      replace: (section: GrayCodePatch) => scope.replace(section as object),
    }
    sctx.effect(() => registerGrayCodeChannel(sctx, configScope, GrayCodeSchema), 'graycode: 配置通道')
    sctx.effect(() => scope.watch((next, prev) => config.onChange?.(next, prev)))
    void Promise.resolve()
      .then(() => config.onChange?.(scope.get()))
      .catch(error => sctx.logger.error('[graycode] initial settings apply failed', error))
    sctx.logger.info('[graycode] settings 命名空间已注册（graycode: 持久化于 settings.yaml）')
  })
}
