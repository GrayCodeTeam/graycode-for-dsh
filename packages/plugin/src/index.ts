import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as workflows from './workflows/index.ts'
import * as memory from './memory/index.ts'
import * as checkpoints from './checkpoints/index.ts'

export const name = 'graycode'

/**
 * GrayCode host plugin composition root. Each domain mounts as its own Cordis
 * child plugin with its own lifecycle; `dataRoot` is resolved once here and
 * forwarded so every domain writes under one plugin-private root.
 */
export interface Config {
  /** Plugin-private data root. Empty resolves to `$DSH_HOME/graycode`. */
  dataRoot: string
  workflows: workflows.Config
  memory: memory.Config
  checkpoints: checkpoints.Config
}

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  workflows: workflows.Config,
  memory: memory.Config,
  checkpoints: checkpoints.Config,
})

export function apply(ctx: Context, config: Config): void {
  const dataRoot = config.dataRoot === '' ? `${resolveDshHome()}/graycode` : config.dataRoot
  ctx.plugin(workflows, { ...config.workflows, dataRoot })
  ctx.plugin(memory, { ...config.memory, dataRoot })
  ctx.plugin(checkpoints, { ...config.checkpoints, dataRoot })
}
