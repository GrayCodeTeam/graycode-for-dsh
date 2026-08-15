/**
 * GrayCode - stagedDiff Remote adapter（host 侧，Phase 4 P4-06 staged diff 卡片）。
 *
 * 端点（命名空间 `stagedDiff`）：
 * - `stagedDiff/list`：审阅条目列表（workspaceId/sessionId/status 过滤 + 分页）；
 * - `stagedDiff/preview`：单条完整内容（before 快照 / after 目标 / 状态 / revision），
 *   供 diff 卡片渲染；
 * - `stagedDiff/accept`：接受条目（落盘；expectedRevision 为 CAS 乐观锁，
 *   不符 → GRAY_CONFLICT）；
 * - `stagedDiff/reject`：拒绝条目（CAS 同 accept）。
 *
 * 错误映射：StagedDiffError（GRAY_STAGED_*）由 errors.ts 统一映射为稳定码
 * （ENTRY_NOT_FOUND→GRAY_NOT_FOUND、REVISION_CONFLICT→GRAY_CONFLICT 等）。
 */

import { StagedDiffService } from '../../application/service.ts'
import type { StagedEntryStatus } from '../../domain/types.ts'
import {
  normalizeLimit,
  optionalString,
  optionalStringArray,
  requireInt,
  requireString,
  requireWorkspace,
  slicePage,
} from '../../../remote/validate.ts'
import type {
  GrayRemoteArgs,
  GrayRemoteHandlers,
} from '../../../remote/types.ts'

/** 创建 stagedDiff Remote 端点处理器（由 stagedDiff 域 apply() 注册）。 */
export function createStagedDiffRemoteHandlers(service: StagedDiffService): GrayRemoteHandlers {
  return {
    'stagedDiff/list': async (args: GrayRemoteArgs) => {
      const workspaceId = optionalString(args, 'workspaceId')
      const sessionId = optionalString(args, 'sessionId')
      const statuses = optionalStringArray(args, 'statuses') as StagedEntryStatus[] | undefined
      const cursor = args.cursor === undefined || args.cursor === null ? undefined : requireString(args, 'cursor')
      const limit = normalizeLimit(args.limit)

      const entries = service.listEntries({ workspaceId, sessionId, statuses })
      const sorted = [...entries].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
      const { page, nextCursor } = slicePage(sorted, cursor, limit)
      return { items: page, total: sorted.length, nextCursor }
    },

    'stagedDiff/preview': async (args: GrayRemoteArgs) => {
      const entryId = requireString(args, 'entryId')
      return service.previewEntry(entryId)
    },

    'stagedDiff/accept': async (args: GrayRemoteArgs, signal?: AbortSignal) => {
      const entryId = requireString(args, 'entryId')
      const expectedRevision = requireInt(args, 'expectedRevision')
      const workspace = requireWorkspace(args)
      return service.acceptEntry({ entryId, expectedRevision, workspaceRoot: workspace, signal })
    },

    'stagedDiff/reject': async (args: GrayRemoteArgs) => {
      const entryId = requireString(args, 'entryId')
      const expectedRevision = requireInt(args, 'expectedRevision')
      const workspace = requireWorkspace(args)
      return service.rejectEntry({ entryId, expectedRevision, workspaceRoot: workspace })
    },
  }
}
