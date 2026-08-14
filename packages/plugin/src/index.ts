import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as workflows from './workflows/index.ts'
import * as memory from './memory/index.ts'
import * as checkpoints from './checkpoints/index.ts'
import * as branches from './branches/index.ts'
import * as persona from './persona.ts'
import * as prompt from './prompt/index.ts'
import * as migration from './migration/index.ts'
import * as stagedDiff from './stagedDiff/adapters/dsh/index.ts'
import { GrayRemoteService } from './remote/index.ts'

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
  branches: branches.Config
  persona: persona.Config
  prompt: prompt.Config
  /** Legacy data migration (Phase 5): scan/dry-run/apply of Gray 1.5.4 data dirs. */
  migration: migration.Config
  /** Staged file diff review (ADR-0003): deferred accept/reject of workspace writes. */
  stagedDiff: stagedDiff.Config
}

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  workflows: workflows.Config,
  memory: memory.Config,
  checkpoints: checkpoints.Config,
  branches: branches.Config,
  persona: persona.Config,
  prompt: prompt.Config,
  migration: migration.Config,
  stagedDiff: stagedDiff.Config,
})

export function apply(ctx: Context, config: Config): void {
  const dataRoot = config.dataRoot === '' ? `${resolveDshHome()}/graycode` : config.dataRoot
  // Phase 4 host 侧 Remote API（T8）：注册 `ctx.grayRemote` 分发服务并默认启用
  // 可回放投影日志（<dataRoot>/remote/projections.jsonl）。各域子插件在各自
  // apply() 中向它注册端点；DSH 升级到公开 Remote 注册面后，端点可平移为
  // Typert `@Remote` 方法（见 src/remote/README.md「DSH 升级后如何切换」）。
  new GrayRemoteService(ctx, { journalPath: `${dataRoot}/remote/projections.jsonl` })
  ctx.plugin(workflows, { ...config.workflows, dataRoot })
  ctx.plugin(memory, { ...config.memory, dataRoot })
  ctx.plugin(checkpoints, { ...config.checkpoints, dataRoot })
  ctx.plugin(branches, { ...config.branches, dataRoot })
  ctx.plugin(persona, config.persona)
  ctx.plugin(prompt, { ...config.prompt, dataRoot })
  ctx.plugin(migration, { ...config.migration, dataRoot })
  ctx.plugin(stagedDiff, { ...config.stagedDiff, dataRoot })
}
