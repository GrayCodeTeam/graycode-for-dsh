/**
 * GrayCode - autoCheckpoints 域（自动存档点）
 *
 * 按配置在特定时机自动调用现有 CheckpointService.createCheckpoint（增量链/
 * 排除/并发锁全部复用 checkpoints 域实现，本域不改动它）：
 * - 用户消息提交前（beforeUserMessage）：`session/event` 中 type ===
 *   'user/message' 且 source.kind === 'user' 的直接用户消息（与 branches 域
 *   directUserMessageSeqOfTurn 同口径）。轮次内消息已入日志（post-commit
 *   事件）、模型尚未开始处理，是「用户消息前」的最早可靠信号；turn 由日志
 *   最后一条 turn/start 推导。
 * - 大改动执行前（beforeMajorChange）：`tools/pre-execute` waterfall（工具
 *   体执行前的最后一个统一钩子，exec.name 即工具名）；命中 majorChangeTools
 *   即建点。监听器必须调用 next() 并把结果返回，不阻塞工具派发。
 * - 去重：同一 turn 内同类型（user / tool:<name>）只建一次（policy 层 Dedupe）。
 * - enabled=false 或取不到会话 cwd 时跳过。
 *
 * 跨域依赖：经 ctx.inject 等待 checkpoints 域提供的 CHECKPOINTS_SERVICE_KEY
 * （checkpoints/index.ts）；HMR 时随提供方重挂自动重连。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CHECKPOINTS_SERVICE_KEY } from '../checkpoints/index.ts'
import type { CheckpointService } from '../checkpoints/service.ts'
import {
  AutoCheckpointDedupe,
  checkpointNotesFor,
  checkpointTitleFor,
  currentTurnOf,
  isDirectUserMessage,
  shouldCreateToolCheckpoint,
  shouldCreateUserCheckpoint,
  type AutoCheckpointKind,
} from './policy.ts'

export const name = 'graycode-auto-checkpoints'

/**
 * 默认大改动工具清单（文件修改类）：apply_diff / write_file / insert_code /
 * delete_file / delete_code / create_directory / execute_command / edit_file。
 */
export const DEFAULT_MAJOR_CHANGE_TOOLS: readonly string[] = [
  'apply_diff',
  'write_file',
  'insert_code',
  'delete_file',
  'delete_code',
  'create_directory',
  'execute_command',
  'edit_file',
]

export interface Config {
  /** 总开关：false 时不订阅任何事件（默认 false）。 */
  enabled: boolean
  /** 用户消息提交前存档（默认 false）。 */
  beforeUserMessage: boolean
  /** 大改动（majorChangeTools 命中的工具）执行前存档（默认 false）。 */
  beforeMajorChange: boolean
  /** 视为「大改动」的工具名清单（默认见 DEFAULT_MAJOR_CHANGE_TOOLS）。 */
  majorChangeTools: string[]
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  beforeUserMessage: z.boolean().default(false),
  beforeMajorChange: z.boolean().default(false),
  majorChangeTools: z.array(z.string()).default([...DEFAULT_MAJOR_CHANGE_TOOLS]),
})

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return

  // 等待 checkpoints 域提供实例：服务缺失时本域保持待机，提供后自动激活
  // （HMR 时提供方重挂同样触发本回调重跑，不会持有已弃用实例）。
  ctx.inject([CHECKPOINTS_SERVICE_KEY] as never, (sctx) => {
    const service = sctx.get(CHECKPOINTS_SERVICE_KEY) as CheckpointService
    const dedupe = new AutoCheckpointDedupe()
    const warn = (error: unknown): void => {
      sctx.logger.warn(
        `graycode-auto-checkpoints: checkpoint creation failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const createFor = (
      sessionId: string,
      cwd: string | undefined,
      turn: number | undefined,
      kind: AutoCheckpointKind
    ): void => {
      // 取不到工作区 cwd 时跳过；去重发生在发起之前（同步），同一 turn 内
      // 同类型后续事件不会再触发。
      if (!cwd) return
      if (!dedupe.claim(sessionId, turn, kind)) return
      void service
        .createCheckpoint(cwd, {
          title: checkpointTitleFor(kind),
          notes: checkpointNotesFor(sessionId, turn),
        })
        .catch(warn)
    }

    // 用户消息前：post-commit 监听器（事件已入日志、模型未开始处理）；
    // 存档失败只告警，不阻断事件流。
    const detachSession = sctx.on('session/event', (session, event) => {
      if (!shouldCreateUserCheckpoint(config)) return
      if (!isDirectUserMessage(event as { type: string; data?: { source?: { kind?: string } } })) return
      createFor(String(session.id), session.header.cwd, currentTurnOf(session.events), { type: 'user-message' })
    })

    // 大改动前：waterfall 事件必须调用 next() 并把结果返回给下游。
    // 建点为 fire-and-forget（不阻塞工具派发；await 由 createCheckpoint 自身串行化）。
    const detachTool = sctx.on('tools/pre-execute', (exec, next) => {
      if (shouldCreateToolCheckpoint(config, exec.name)) {
        const session = exec.agent?.session
        if (session) {
          createFor(String(session.id), session.header.cwd, currentTurnOf(session.events), {
            type: 'tool',
            toolName: exec.name,
          })
        }
      }
      return next()
    })

    sctx.effect(() => () => {
      detachSession()
      detachTool()
    })
  })
}
