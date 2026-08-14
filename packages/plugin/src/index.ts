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
import * as activity from './activity/index.ts'
import * as media from './media/index.ts'
import * as file from './file/index.ts'
import * as todo from './todo/index.ts'
import * as subagents from './subagents/index.ts'
import * as notifications from './notifications/index.ts'
import * as thoughts from './thoughts/index.ts'
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
  /** Activity domain: usage-time stats sampled from user messages and agent steps. */
  activity: activity.Config
  /** Media domain: local sharp processing (crop/resize/rotate). */
  media: media.Config
  /** File domain: generic file editing tools (delete_code, C7). */
  file: file.Config
  /** Todo domain: incremental todo_update adapter (C3). */
  todo: todo.Config
  /** Subagents thin adapter (C1): hop circuit breaker / addressing / maxConcurrent guards. */
  subagents: subagents.Config
  /** Notifications domain (C4): notify tool + multi-platform delivery backends. */
  notifications: notifications.Config
  /** Thoughts request layer (A1): llm/stream rewrite, off by default. */
  thoughts: thoughts.Config
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
  activity: activity.Config,
  media: media.Config,
  file: file.Config,
  todo: todo.Config,
  subagents: subagents.Config,
  notifications: notifications.Config,
  thoughts: thoughts.Config,
})

export function apply(ctx: Context, config: Config): void {
  const dataRoot = config.dataRoot === '' ? `${resolveDshHome()}/graycode` : config.dataRoot
  // Phase 4 host 侧 Remote API（T8）：注册 `ctx.grayRemote` 分发服务并默认启用
  // 可回放投影日志（<dataRoot>/remote/projections.jsonl）。各域子插件在各自
  // apply() 中向它注册端点；DSH 升级到公开 Remote 注册面后，端点可平移为
  // Typert `@Remote` 方法（设计见 docs/PLAN_V2.md §5.6 与 docs/ADR-0002 §5）。
  new GrayRemoteService(ctx, { journalPath: `${dataRoot}/remote/projections.jsonl` })
  ctx.plugin(workflows, { ...config.workflows, dataRoot })
  ctx.plugin(memory, { ...config.memory, dataRoot })
  ctx.plugin(checkpoints, { ...config.checkpoints, dataRoot })
  ctx.plugin(branches, { ...config.branches, dataRoot })
  ctx.plugin(persona, config.persona)
  ctx.plugin(prompt, { ...config.prompt, dataRoot })
  ctx.plugin(migration, { ...config.migration, dataRoot })
  ctx.plugin(stagedDiff, { ...config.stagedDiff, dataRoot })
  // Activity domain: Config carries its own dataRoot field, forwarded from the composition root.
  ctx.plugin(activity, { ...config.activity, dataRoot })
  // Media domain: Config has no dataRoot (no persistence under the plugin root).
  ctx.plugin(media, { ...config.media })
  // File domain: Config has no dataRoot (no persistence under the plugin root).
  ctx.plugin(file, { ...config.file })
  // Todo domain: Config has no dataRoot (no persistence under the plugin root).
  ctx.plugin(todo, { ...config.todo })
  // Subagents thin adapter (C1): guards installed over the DSH `ctx.subagents` seam
  // (inject waits for `agents` + `subagents` services; absent seam degrades to a warn).
  ctx.plugin(subagents, { ...config.subagents })
  // Notifications domain (C4): notify tool + Windows native toast / noop backends.
  ctx.plugin(notifications, { ...config.notifications })
  // Thoughts request layer (A1): llm/stream waterfall rewrite (non-contract,
  // ADR-0002 §4b), off by default. Reads the prompt-mode service lazily via
  // ctx.get — prompt must mount first (it does, above) so the service exists.
  ctx.plugin(thoughts, { ...config.thoughts })
}
