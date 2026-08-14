/**
 * GrayCode - migration snapshots 写入侧适配（DSH session 公开 API seed + lineage header）
 *
 * B3（docs/PROGRESS.md）：旧 snapshots 解析器已就绪（parseSnapshot），此前 plan 层
 * 恒 unmapped（noopTarget fail-closed）。本适配器把快照映射为 DSH session：
 *
 * - 语义（SPIKE 结论，见 src/migration/README.md）：快照 = 会话历史在某个时间点的
 *   命名副本。用 `ctx.sessions.create(id, { seed, meta })` 公开 API 创建独立会话并
 *   seed 快照历史（确定性映射，复用 conversationSeed.buildConversationSeed）；
 *   header 谱系用 meta.parentSession（= 所属会话的确定性 session id）+
 *   meta.seedLength 表达（ADR-0002：持久谱系由 SessionHeader 承载）。
 *   不用 `fork()`：fork 要求源会话 live 且边界对齐（INVALID_BOUNDARY/OPEN_TURN），
 *   迁移场景（源可能不含父会话、快照历史是独立 Content[] 子集）下不可靠。
 * - parentSession 是确定性派生 id：父会话若也在本库导入，谱系即连通；暂不在仍记录
 *   该确定性 id（父会话后续导入后自动解析）。孤儿快照（conversationId 对应会话不在
 *   源库）同样导入为独立会话（数据保留优先，legacy-format.md §8「snapshots/ 优先迁移」）。
 * - 幂等：同 legacyId → 同 session id；live store 已有该会话或 create 报
 *   already exists（并发）→ 跳过创建不重复；跨 run 幂等由应用层台账保证；
 * - probe：session://<id> 校验 live store（或持久化后端 inspect）；兼容旧
 *   artifact:// 引用。
 *
 * 未注入 sessions API 时保持旧行为：只读 artifact 暂存（targetRef artifact://）。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { SessionId, type SessionStore } from '@deepseek-ai/dsh-session'
import type { TargetWriterPort, WriteTargetInput, WriteTargetResult } from '../../application/ports.ts'
import { buildSnapshotSeed, snapshotParentSessionId, snapshotSessionId } from './snapshotSeed.ts'
import type { SessionPersistenceLike } from './conversationTarget.ts'

export interface SnapshotTargetWriterOptions {
  /** artifact 根（<dataRoot>/migration/imports；快照原始负载随附位置） */
  importsRoot: string
  /** DSH 公开 session API（ctx.sessions）；缺省 = 仅 artifact 暂存（旧行为） */
  sessions?: SessionStore
  /** DSH 持久化后端公开 API（ctx.sessionPersistence，可选） */
  persistence?: SessionPersistenceLike
}

export function createSnapshotTargetWriter(options: SnapshotTargetWriterOptions): TargetWriterPort {
  const { importsRoot, sessions, persistence } = options
  return {
    kind: 'snapshots',
    async write(input: WriteTargetInput): Promise<WriteTargetResult> {
      const data = input.object.data as Record<string, unknown> | undefined
      if (!data) throw new Error(`snapshot 负载缺失: ${input.object.legacyId}`)

      const seed = buildSnapshotSeed(data, { legacyId: input.object.legacyId })
      const sessionIdString = snapshotSessionId(input.object.legacyId)
      const parentSessionString = snapshotParentSessionId(data.conversationId)
      const history = Array.isArray(data.history) ? (data.history as unknown[]) : []

      const artifact = {
        migratedFrom: 'graycode-1.5.4',
        sourceLegacyId: input.object.legacyId,
        // 规范化视图：id / 归属会话 / 名称 / 描述 / 时间戳 / 历史（只读展示）
        id: data.id,
        conversationId: data.conversationId,
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.timestamp !== undefined ? { timestamp: data.timestamp } : {}),
        ...(sessions ? { sessionId: sessionIdString } : {}),
        ...(sessions ? { targetRef: `session://${sessionIdString}` } : {}),
        ...(parentSessionString ? { parentSession: parentSessionString } : {}),
        history,
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
            const meta = {
              ...seed.meta,
              ...(parentSessionString ? { parentSession: SessionId(parentSessionString) } : {}),
            }
            const session = sessions.create(sessionId, { seed: seed.events, meta })
            if (persistence) {
              await persistence.create(session.header)
              await persistence.append(session.id, session.events)
              notes.push(`持久化后端已落盘 ${session.events.length} 条事件（create + append）`)
            }
            await sessions.flush(session)
            const lineage = parentSessionString
              ? `，lineage parentSession=session://${parentSessionString}`
              : ''
            notes.push(
              `DSH 快照会话已创建并 seed ${seed.events.length} 条历史事件: session://${sessionIdString}${lineage}`,
            )
          } catch (err) {
            if (err instanceof Error && err.message.includes('already exists')) {
              // 并发/同进程重复创建：幂等跳过（不视为失败，可重跑）
              notes.push(`DSH 会话已存在（并发幂等，未重复创建）: session://${sessionIdString}`)
            } else {
              throw err
            }
          }
        }
        notes.push(`快照原始负载（name/description/history 等）随附 artifact: ${artifactRef}`)
        if (seed.unmapped.length > 0) {
          notes.push(`${seed.unmapped.length} 条未知 Content 仅随附 artifact（只读展示，未进入事件日志）`)
        }
        return { targetRef: `session://${sessionIdString}`, notes }
      }

      // 旧行为：sessions API 未注入 → 只读 artifact 暂存
      notes.push(`快照 ${history.length} 条历史已暂存为只读 artifact（DSH session API 未注入，未创建会话）`)
      if (seed.unmapped.length > 0) {
        notes.push(`${seed.unmapped.length} 条未知 Content 仅随附 artifact`)
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
      const artifactMatch = targetRef.match(/^artifact:\/\/snapshots\/(.+)$/)
      if (!artifactMatch?.[1]) return false
      try {
        // artifact 物理布局：<importsRoot>/<runId>/snapshots/<name>.json
        const rel = artifactMatch[1]
        const slash = rel.lastIndexOf('/')
        const runDir = slash >= 0 ? rel.slice(0, slash) : ''
        const name = slash >= 0 ? rel.slice(slash + 1) : rel
        await fs.access(path.join(importsRoot, runDir, 'snapshots', name))
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
  const dir = path.join(importsRoot, runId, 'snapshots')
  await fs.mkdir(dir, { recursive: true })
  const safeName = /^[A-Za-z0-9_.-]+$/.test(legacyId) ? legacyId : `snap_${legacyId.length}`
  const target = path.join(dir, `${safeName}.json`)
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, JSON.stringify(artifact, null, 2), 'utf-8')
  await fs.rename(tmp, target)
  return `artifact://snapshots/${runId}/${safeName}.json`
}
