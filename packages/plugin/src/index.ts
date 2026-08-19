import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { deepEqualJson } from '@deepseek-ai/dsh-settings'
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
import * as images from './images/index.ts'
import * as summary from './summary/index.ts'
import * as settings from './settings/index.ts'
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
  /** Images domain: generate_image tool (generation + editing via referenceImages). */
  images: images.Config
  /** Summary domain: manual conversation summarization via summary/generate. */
  summary: summary.Config
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
  images: images.Config,
  summary: summary.Config,
})

export type LiveConfigFibers = {
  [K in keyof settings.GrayCodeConfig]: {
    update(config: settings.GrayCodeConfig[K], noSave?: boolean): void | Promise<void>
  }
}

/** Serialize native-settings commits and restart only fibers whose real config changed. */
export function createLiveConfigUpdater(
  fibers: LiveConfigFibers,
  initial: settings.GrayCodeConfig,
): (next: settings.GrayCodeConfig) => Promise<void> {
  let appliedConfig = initial
  let updateQueue: Promise<void> = Promise.resolve()
  return (next: settings.GrayCodeConfig): Promise<void> => {
    updateQueue = updateQueue.catch(() => undefined).then(async () => {
      const keys = Object.keys(fibers) as Array<keyof LiveConfigFibers>
      const updateOne = async <K extends keyof LiveConfigFibers>(key: K): Promise<void> => {
        await fibers[key].update(next[key], true)
      }
      for (const key of keys) {
        if (!deepEqualJson(appliedConfig[key], next[key])) {
          await updateOne(key)
          // 每个 fiber 成功后立即推进该键的真实运行态基线。若后续 fiber 失败，
          // 下一次提交仍能识别并回滚此前已经成功应用的模块。
          appliedConfig = { ...appliedConfig, [key]: next[key] }
        }
      }
    })
    return updateQueue
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const dataRoot = config.dataRoot === '' ? `${resolveDshHome()}/graycode` : config.dataRoot
  const liveConfig: settings.GrayCodeConfig = {
    workflows: { ...config.workflows, dataRoot },
    memory: { ...config.memory, dataRoot },
    checkpoints: { ...config.checkpoints, dataRoot },
    branches: { ...config.branches, dataRoot },
    persona: config.persona,
    prompt: { ...config.prompt, dataRoot },
    migration: { ...config.migration, dataRoot },
    stagedDiff: { ...config.stagedDiff, dataRoot },
    activity: { ...config.activity, dataRoot },
    media: config.media,
    file: config.file,
    todo: config.todo,
    subagents: config.subagents,
    notifications: config.notifications,
    thoughts: config.thoughts,
    images: config.images,
    summary: config.summary,
  }
  // Phase 4 host 侧 Remote API（T8）：注册 `ctx.grayRemote` 分发服务并默认启用
  // 可回放投影日志（<dataRoot>/remote/projections.jsonl）。各域子插件在各自
  // apply() 中向它注册端点；DSH 升级到公开 Remote 注册面后，端点可平移为
  // Typert `@Remote` 方法（设计见 docs/PLAN_V2.md §5.6 与 docs/ADR-0002 §5）。
  new GrayRemoteService(ctx, { journalPath: `${dataRoot}/remote/projections.jsonl` })

  // Thoughts request layer (A1): llm/stream waterfall rewrite (non-contract,
  // ADR-0002 §4b). Reads the prompt-mode service lazily via ctx.get — prompt
  // must mount first (it does, right above) so the service exists.
  const promptFiber = ctx.plugin(prompt, liveConfig.prompt)
  const thoughtsFiber = ctx.plugin(thoughts, liveConfig.thoughts)

  const fibers = {
    workflows: ctx.plugin(workflows, liveConfig.workflows),
    memory: ctx.plugin(memory, liveConfig.memory),
    checkpoints: ctx.plugin(checkpoints, liveConfig.checkpoints),
    branches: ctx.plugin(branches, liveConfig.branches),
    persona: ctx.plugin(persona, liveConfig.persona),
    prompt: promptFiber,
    migration: ctx.plugin(migration, liveConfig.migration),
    stagedDiff: ctx.plugin(stagedDiff, liveConfig.stagedDiff),
  // Activity domain: Config carries its own dataRoot field, forwarded from the composition root.
    activity: ctx.plugin(activity, liveConfig.activity),
  // Media domain: Config has no dataRoot (no persistence under the plugin root).
    media: ctx.plugin(media, liveConfig.media),
  // File domain: Config has no dataRoot (no persistence under the plugin root).
    file: ctx.plugin(file, liveConfig.file),
  // Todo domain: Config has no dataRoot (no persistence under the plugin root).
    todo: ctx.plugin(todo, liveConfig.todo),
  // Subagents thin adapter (C1): guards installed over the DSH `ctx.subagents` seam
  // (inject waits for `agents` + `subagents` services; absent seam degrades to a warn).
    subagents: ctx.plugin(subagents, liveConfig.subagents),
  // Notifications domain (C4): notify tool + Windows native toast / noop backends.
    notifications: ctx.plugin(notifications, liveConfig.notifications),
  // Thoughts request layer (A1): llm/stream waterfall rewrite (non-contract,
  // ADR-0002 §4b), always paired with the prompt plugin above.
    thoughts: thoughtsFiber,
  // Images: generate_image tool (default off); mounts after media so its
  // real implementation supersedes the media domain's fail-closed placeholder.
    images: ctx.plugin(images, liveConfig.images),
  // Summary: manual summarization endpoint `summary/generate` registered on
  // ctx.grayRemote (GrayRemoteService mounted above); mount returns a disposer.
    summary: ctx.plugin(summary, liveConfig.summary),
  }

  const applyLiveConfig = createLiveConfigUpdater(fibers, liveConfig)
  // branches/checkpoints/stagedDiff 都有持久化初始化。组合根必须把这三条异步
  // 子 fiber 纳入自己的 ready 边界；否则父 fiber 已 ACTIVE、调用方已经采集工具
  // 集时，子 fiber 仍可能在加载 sidecar，造成首次挂载/HMR 观察到半套功能。
  await Promise.all([fibers.branches, fibers.checkpoints, fibers.stagedDiff])
  // Settings 面板域：注册 graycode settings 命名空间（持久化）+ /graycode 配置
  // 通道（浏览器面板读写；connection 缺失时通道跳过，命名空间不受影响）。
  ctx.plugin(settings, { base: liveConfig, onChange: applyLiveConfig })
}
