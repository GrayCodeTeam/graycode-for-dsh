/**
 * GrayCode native-settings document.
 *
 * This is deliberately a projection of the real Cordis child-plugin Config
 * objects. It must not grow a second, VS Code-shaped configuration model:
 * every field persisted here is fed back into the corresponding live fiber by
 * the composition root.
 */

import type * as workflows from '../workflows/index.ts'
import type * as memory from '../memory/index.ts'
import type * as checkpoints from '../checkpoints/index.ts'
import type * as branches from '../branches/index.ts'
import type * as persona from '../persona.ts'
import type * as prompt from '../prompt/index.ts'
import type * as migration from '../migration/index.ts'
import type * as stagedDiff from '../stagedDiff/adapters/dsh/index.ts'
import type * as activity from '../activity/index.ts'
import type * as media from '../media/index.ts'
import type * as file from '../file/index.ts'
import type * as todo from '../todo/index.ts'
import type * as subagents from '../subagents/index.ts'
import type * as notifications from '../notifications/index.ts'
import type * as thoughts from '../thoughts/index.ts'
import type * as autoCheckpoints from '../autoCheckpoints/index.ts'
import type * as images from '../images/index.ts'
import type * as summary from '../summary/index.ts'

/** Exact live configuration controlled by the GrayCode native settings page. */
export interface GrayCodeConfig {
  workflows: workflows.Config
  memory: memory.Config
  checkpoints: checkpoints.Config
  branches: branches.Config
  persona: persona.Config
  prompt: prompt.Config
  migration: migration.Config
  stagedDiff: stagedDiff.Config
  activity: activity.Config
  media: media.Config
  file: file.Config
  todo: todo.Config
  subagents: subagents.Config
  notifications: notifications.Config
  thoughts: thoughts.Config
  autoCheckpoints: autoCheckpoints.Config
  images: images.Config
  summary: summary.Config
}

/** Settings updates are top-level replacements of one or more module configs. */
export type GrayCodePatch = { [K in keyof GrayCodeConfig]?: GrayCodeConfig[K] }
