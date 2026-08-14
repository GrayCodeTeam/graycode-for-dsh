/**
 * GrayCode - migration conversations 写入侧适配（DSH session 公开 API seed）
 *
 * §7.2.3：会话必须通过 DSH 公开 session/persistence API 创建或 seed，禁止直接
 * 拼写 DSH 内部格式。本适配器：
 *
 * - 主路径（注入 `sessions` = ctx.sessions，SessionStore 公开 API）：
 *   `ctx.sessions.create(id, { seed, meta })` 创建会话并 seed 规范化历史
 *   （seed 由 conversationSeed.ts 确定性构造：turn/user/assistant/tool 事件 +
 *   header meta cwd/createdAt/seedLength）。
 * - 可选持久化（注入 `persistence` = ctx.sessionPersistence，公开 API 的结构化
 *   子集；dsh-session-persistence 为 devDep，src 不直接依赖）：创建后
 *   `create(header)` + `append(id, events)` 落盘，再 `sessions.flush(session)`
 *   触发挂载后端的耐久性检查点（构造 seed 不发射 session/event，必须显式落盘）。
 * - 无法用公开 API 表达的字段（标题/updatedAt/workspaceUri/custom/subagents/
 *   branches/未知 part）仍以 artifact 随附并在 notes 说明；
 * - 幂等：同 legacyId → 同 sessionId；live store 已有该会话或 create 报
 *   already exists（并发）→ 跳过创建不重复；跨 run 幂等由应用层台账保证；
 * - probe：session://<id> 校验 live store（或持久化后端 inspect）；兼容旧
 *   artifact:// 引用（artifact 时代的台账条目仍可 verify）。
 *
 * 未注入 sessions API 时保持旧行为：只读 artifact 暂存（targetRef artifact://）。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { SessionId, type SessionEvent, type SessionHeader, type SessionStore } from '@deepseek-ai/dsh-session'
import type { TargetWriterPort, WriteTargetInput, WriteTargetResult } from '../../application/ports.ts'
import { buildConversationSeed, conversationSessionId } from './conversationSeed.ts'

/**
 * dsh-session-persistence 公开 API 的结构化子集（后端可选注入）。
 * 只取本适配器用到的三个方法；返回/参数用宽类型，避免 src 依赖 devDep 包。
 */
export interface SessionPersistenceLike {
  create(meta: SessionHeader): Promise<void>
  append(id: SessionId, events: readonly SessionEvent[]): Promise<void>
  inspect?(id: SessionId, signal?: AbortSignal): Promise<unknown>
}

export interface ConversationTargetWriterOptions {
  /** artifact 根（<dataRoot>/migration/imports；无公开 API 字段的随附位置） */
  importsRoot: string
  /** DSH 公开 session API（ctx.sessions）；缺省 = 仅 artifact 暂存（旧行为） */
  sessions?: SessionStore
  /** DSH 持久化后端公开 API（ctx.sessionPersistence，可选） */
  persistence?: SessionPersistenceLike
}

export function createConversationTargetWriter(options: ConversationTargetWriterOptions): TargetWriterPort {
  const { importsRoot, sessions, persistence } = options
  return {
    kind: 'conversations',
    async write(input: WriteTargetInput): Promise<WriteTargetResult> {
      const data = input.object.data as Record<string, unknown> | undefined
      if (!data) throw new Error(`conversation 负载缺失: ${input.object.legacyId}`)

      const seed = buildConversationSeed(data, { legacyId: input.object.legacyId })
      const sessionIdString = conversationSessionId(input.object.legacyId)
      const history = Array.isArray(data.history) ? (data.history as unknown[]) : []

      const artifact = {
        migratedFrom: 'graycode-1.5.4',
        sourceLegacyId: input.object.legacyId,
        // 规范化视图：meta + Content[] 历史 + 子代理 + 分支（历史只读展示）
        conversationId: data.conversationId,
        ...(sessions ? { sessionId: sessionIdString } : {}),
        ...(sessions ? { targetRef: `session://${sessionIdString}` } : {}),
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.createdAt !== undefined ? { createdAt: data.createdAt } : {}),
        ...(data.updatedAt !== undefined ? { updatedAt: data.updatedAt } : {}),
        ...(data.workspaceUri !== undefined ? { workspaceUri: data.workspaceUri } : {}),
        ...(data.custom !== undefined ? { custom: data.custom } : {}),
        historyFormat: data.historyFormat,
        history,
        subagents: data.subagents,
        ...(data.branches !== undefined ? { branches: data.branches } : {}),
        seed: {
          eventCount: seed.events.length,
          turns: seed.stats.turns,
          userMessages: seed.stats.userMessages,
          assistantMessages: seed.stats.assistantMessages,
          toolCalls: seed.stats.toolCalls,
          toolResults: seed.stats.toolResults,
          ...(seed.unmapped.length > 0 ? { unmapped: seed.unmapped } : {}),
        },
      }
      const artifactRef = await writeArtifact(importsRoot, input.runId, input.object.legacyId, artifact)
      const notes: string[] = []

      if (sessions) {
        const sessionId = SessionId(sessionIdString)
        if (sessions.get(sessionId)) {
          notes.push(`DSH 会话已存在（幂等，未重复创建）: session://${sessionIdString}`)
        } else {
          try {
            const session = sessions.create(sessionId, { seed: seed.events, meta: seed.meta })
            if (persistence) {
              await persistence.create(session.header)
              await persistence.append(session.id, session.events)
              notes.push(`持久化后端已落盘 ${session.events.length} 条事件（create + append）`)
            }
            await sessions.flush(session)
            notes.push(`DSH 会话已创建并 seed ${seed.events.length} 条历史事件: session://${sessionIdString}`)
          } catch (err) {
            if (err instanceof Error && err.message.includes('already exists')) {
              // 并发/同进程重复创建：幂等跳过（不视为失败，可重跑）
              notes.push(`DSH 会话已存在（并发幂等，未重复创建）: session://${sessionIdString}`)
            } else {
              throw err
            }
          }
        }
        notes.push(`无公开 API 字段（标题/updatedAt/workspaceUri/custom/subagents/branches）随附 artifact: ${artifactRef}`)
        if (seed.unmapped.length > 0) {
          notes.push(`${seed.unmapped.length} 条未知 Content 仅随附 artifact（只读展示，未进入事件日志）`)
        }
        if (data.subagents && Array.isArray(data.subagents) && data.subagents.length > 0) {
          notes.push(`子代理 transcript ${data.subagents.length} 个已随附 artifact（未创建子会话）`)
        }
        return { targetRef: `session://${sessionIdString}`, notes }
      }

      // 旧行为：sessions API 未注入 → 只读 artifact 暂存
      notes.push(`历史 ${history.length} 条已暂存为只读 artifact（DSH session API 未注入，未创建会话）`)
      if (data.subagents && Array.isArray(data.subagents) && data.subagents.length > 0) {
        notes.push(`子代理 transcript ${data.subagents.length} 个已随附`)
      }
      return { targetRef: artifactRef, notes }
    },

    async probe(targetRef: string): Promise<boolean> {
      const sessionMatch = targetRef.match(/^session:\/\/(.+)$/)
      if (sessionMatch?.[1]) {
        const id = SessionId(sessionMatch[1])
        if (sessions?.get(id)) return true
        if (persistence?.inspect) {
          try {
            await persistence.inspect(id)
            return true
          } catch {
            return false
          }
        }
        return false
      }
      const artifactMatch = targetRef.match(/^artifact:\/\/conversations\/(.+)$/)
      if (!artifactMatch?.[1]) return false
      try {
        // artifact 物理布局：<importsRoot>/<runId>/conversations/<name>.json
        // （URI 路径 <runId>/<name>.json 省略了域目录段，探测时补回）
        const rel = artifactMatch[1]
        const slash = rel.lastIndexOf('/')
        const runDir = slash >= 0 ? rel.slice(0, slash) : ''
        const name = slash >= 0 ? rel.slice(slash + 1) : rel
        await fs.access(path.join(importsRoot, runDir, 'conversations', name))
        return true
      } catch {
        return false
      }
    },
  }
}

async function writeArtifact(
  importsRoot: string,
  runId: string,
  legacyId: string,
  artifact: Record<string, unknown>,
): Promise<string> {
  const dir = path.join(importsRoot, runId, 'conversations')
  await fs.mkdir(dir, { recursive: true })
  const safeName = /^[A-Za-z0-9_.-]+$/.test(legacyId) ? legacyId : `conv_${legacyId.length}`
  const target = path.join(dir, `${safeName}.json`)
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, JSON.stringify(artifact, null, 2), 'utf-8')
  await fs.rename(tmp, target)
  return `artifact://conversations/${runId}/${safeName}.json`
}
