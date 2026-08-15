/** Authoritative native-settings schema backed by the real module schemas. */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as workflows from '../workflows/index.ts'
import * as memory from '../memory/index.ts'
import * as checkpoints from '../checkpoints/index.ts'
import * as branches from '../branches/index.ts'
import * as persona from '../persona.ts'
import * as prompt from '../prompt/index.ts'
import * as migration from '../migration/index.ts'
import * as stagedDiff from '../stagedDiff/adapters/dsh/index.ts'
import * as activity from '../activity/index.ts'
import * as media from '../media/index.ts'
import * as file from '../file/index.ts'
import * as todo from '../todo/index.ts'
import * as subagents from '../subagents/index.ts'
import * as notifications from '../notifications/index.ts'
import * as thoughts from '../thoughts/index.ts'
import * as autoCheckpoints from '../autoCheckpoints/index.ts'
import * as images from '../images/index.ts'
import * as summary from '../summary/index.ts'
import type { GrayCodeConfig } from './types.ts'

export const GRAYCODE_SETTINGS_NAMESPACE: SettingsNamespace = settingsNamespace('graycode')

/** Reuse every domain's validation and defaults verbatim. */
export const GrayCodeSchema: z<GrayCodeConfig> = z.object({
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
  autoCheckpoints: autoCheckpoints.Config,
  images: images.Config,
  summary: summary.Config,
})
