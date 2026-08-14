/**
 * Gray Code 设置面板 —— Host 侧领域入口。
 *
 * 注册 `graycode` settings 命名空间（schemastery schema + DEFAULTS base 层，
 * 持久化到 $DSH_HOME/settings.yaml）并挂载 `/graycode` 配置通道（浏览器面板
 * 的 config.get/update/replace/reset 四端点，见 rpc.ts 为什么不用原生 settings
 * 线）。通道随带 `settings` 注入的 fiber 一起卸载（disposal / reload）。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULTS } from './defaults.ts'
import { GRAYCODE_SETTINGS_NAMESPACE, GrayCodeSchema } from './schema.ts'
import { registerGrayCodeChannel, type ConfigScope } from './rpc.ts'
import type { GrayCodeConfig, GrayCodePatch } from './types.ts'

export const name = 'graycode-settings'

export interface Config {
  /** 组合层 base 覆盖：合并到默认文档之下、用户 section 之上（可选）。 */
  base?: Partial<GrayCodeConfig>
}

export const Config: z<Config> = z.object({
  base: z.dict(z.any()).default({}),
})

export function apply(ctx: Context, config: Config): void {
  // settings 服务存在时才注册命名空间与通道；服务不可用时整个 fiber 不启动。
  ctx.inject(['settings'], (sctx) => {
    const base = { ...DEFAULTS, ...config.base } as GrayCodeConfig
    const scope = sctx.settings.register(GRAYCODE_SETTINGS_NAMESPACE, GrayCodeSchema, { base })
    const configScope: ConfigScope = {
      get: () => scope.get(),
      update: (patch: GrayCodePatch) => scope.update(patch as object),
      replace: (section: GrayCodePatch) => scope.replace(section as object),
    }
    // 通道注册随本 fiber 卸载（HMR：旧通道先注销，新实例可重新注册）。
    sctx.effect(() => registerGrayCodeChannel(sctx, configScope), 'graycode: 配置通道')
    sctx.logger.info('[graycode] settings 命名空间已注册（graycode: 持久化于 settings.yaml）')
  })
}
