/**
 * GrayCode - migration snapshots seed 构造（DSH 公开 session API 的 seed 载荷）
 *
 * B3（docs/PROGRESS.md）：旧 snapshots 解析器（parseSnapshot）已就绪，此前 plan 层
 * 恒 unmapped（noopTarget fail-closed）。本模块把 legacy 快照（HistorySnapshot：
 * id / conversationId / name / description / timestamp / history，见
 * docs/legacy-format.md §1.6）翻译为 DSH session 事件种子：
 *
 * - 快照历史是会话历史在某个时间点的 Content[] 副本 → 复用
 *   conversationSeed.buildConversationSeed 的确定性映射
 *   （turn/user/assistant/tool 事件、unknown→unmapped、header meta）；
 * - createdAt 取快照 timestamp（快照无 workspaceUri → 无 cwd）；
 * - 会话 id：snapshotSessionId(legacyId) —— 确定性，同 legacyId → 同 session id
 *   （幂等重跑不重复创建）；前缀 migrated-snap- 与会话 id（migrated-）区分；
 * - lineage：parentSession 由 snapshotParentSessionId(conversationId) 派生
 *   （= 所属会话的确定性 session id；写入侧放进 header meta，ADR-0002：持久谱系
 *   由 SessionHeader 承载）。parentSession 只是谱系元数据（非外键约束）：父会话
 *   在本库已导入则谱系连通；暂不在也不阻碍导入（孤儿快照同样保留数据）。
 *
 * 确定性：全部由 legacy 内容派生（无随机 UUID），同一 legacyId + 同一快照 →
 * 逐字节相同的 seed，幂等重跑无差异。事件 seq 从 0 连续递增（Session 构造器
 * 强制校验）。
 */

import { createHash } from 'crypto'
import {
  buildConversationSeed,
  conversationSessionId,
  type ConversationSeed,
} from './conversationSeed.ts'

/** validator.validateSnapshot 输出的快照负载的宽松视图 */
export interface SnapshotDataView {
  id?: unknown
  conversationId?: unknown
  name?: unknown
  description?: unknown
  timestamp?: unknown
  history?: unknown
  [key: string]: unknown
}

/**
 * 确定性快照会话 id：同 legacyId → 同 session id（幂等重跑不重复创建）。
 * 安全字符直接保留（可读），否则退化为 sha256 前缀。
 */
export function snapshotSessionId(legacyId: string): string {
  if (/^[A-Za-z0-9_.-]{1,80}$/.test(legacyId)) return `migrated-snap-${legacyId}`
  return `migrated-snap-${createHash('sha256').update(legacyId).digest('hex').slice(0, 16)}`
}

/**
 * 所属会话的确定性 DSH 会话 id（与 conversationTarget 的 conversationSessionId
 * 同源派生）；快照无 conversationId 或非字符串 → undefined（写入侧省略 parentSession）。
 */
export function snapshotParentSessionId(conversationId: unknown): string | undefined {
  if (typeof conversationId !== 'string' || conversationId.length === 0) return undefined
  return conversationSessionId(conversationId)
}

/**
 * 把 legacy 快照负载翻译为确定性 DSH 事件种子 + header meta。
 * 不创建会话、不写盘（纯函数；调用方负责 ctx.sessions.create）。
 */
export function buildSnapshotSeed(data: unknown, options: { legacyId: string }): ConversationSeed {
  const record = (data ?? {}) as SnapshotDataView
  return buildConversationSeed(
    {
      conversationId: record.conversationId,
      createdAt: typeof record.timestamp === 'number' ? record.timestamp : undefined,
      history: Array.isArray(record.history) ? record.history : [],
      historyFormat: 'snapshot',
    },
    options,
  )
}
