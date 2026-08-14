/**
 * GrayCode - migration conversations 写入侧适配
 *
 * 会话目标（DSH session/event/lineage 公开 API）尚未接线（§7.2.3：禁止直接拼写
 * DSH 内部格式），本阶段把规范化后的会话负载暂存为只读 artifact：
 * `<dataRoot>/migration/imports/<runId>/conversations/<convId>.json`。
 * 幂等键照常入台账；DSH session API 接入后可改为真实 seed，幂等重跑不重复。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type { TargetWriterPort, WriteTargetInput, WriteTargetResult } from '../../application/ports.ts'

export function createConversationTargetWriter(options: { importsRoot: string }): TargetWriterPort {
  return {
    kind: 'conversations',
    async write(input: WriteTargetInput): Promise<WriteTargetResult> {
      const data = input.object.data as Record<string, unknown> | undefined
      if (!data) throw new Error(`conversation 负载缺失: ${input.object.legacyId}`)

      const artifact = {
        migratedFrom: 'graycode-1.5.4',
        sourceLegacyId: input.object.legacyId,
        // 规范化视图：meta + Content[] 历史 + 子代理 + 分支（历史只读展示）
        conversationId: data.conversationId,
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.createdAt !== undefined ? { createdAt: data.createdAt } : {}),
        ...(data.updatedAt !== undefined ? { updatedAt: data.updatedAt } : {}),
        ...(data.workspaceUri !== undefined ? { workspaceUri: data.workspaceUri } : {}),
        ...(data.custom !== undefined ? { custom: data.custom } : {}),
        historyFormat: data.historyFormat,
        history: data.history,
        subagents: data.subagents,
        ...(data.branches !== undefined ? { branches: data.branches } : {}),
      }

      const dir = path.join(options.importsRoot, input.runId, 'conversations')
      await fs.mkdir(dir, { recursive: true })
      const safeName = /^[A-Za-z0-9_.-]+$/.test(input.object.legacyId) ? input.object.legacyId : `conv_${input.object.legacyId.length}`
      const target = path.join(dir, `${safeName}.json`)
      const tmp = `${target}.tmp`
      await fs.writeFile(tmp, JSON.stringify(artifact, null, 2), 'utf-8')
      await fs.rename(tmp, target)

      const historyCount = Array.isArray(data.history) ? data.history.length : 0
      return {
        targetRef: `artifact://conversations/${input.runId}/${safeName}.json`,
        notes: [
          `历史 ${historyCount} 条已暂存为只读 artifact（DSH session API 未接线，未写入会话）`,
          ...(data.subagents && Array.isArray(data.subagents) && data.subagents.length > 0
            ? [`子代理 transcript ${data.subagents.length} 个已随附`]
            : []),
        ],
      }
    },
    async probe(targetRef: string): Promise<boolean> {
      const match = targetRef.match(/^artifact:\/\/conversations\/(.+)$/)
      if (!match?.[1]) return false
      try {
        await fs.access(path.join(options.importsRoot, match[1]))
        return true
      } catch {
        return false
      }
    },
  }
}
