/**
 * GrayCode - branches Remote adapter（host 侧，C5：client 分支管理端点）。
 *
 * 端点（命名空间 `branches`）：
 * - `branches/list`：按 workspace 列出分支组（含候选/激活指针/revision，
 *   供 UI 与管理端点做 CAS）；
 * - `branches/rename`：重命名候选显示名（1-200 字符；expectedRevision CAS）。
 *
 * 领域错误（BranchError）按 BRANCH_CODE_MAP 映射为稳定码（见 remote/errors.ts）；
 * 错误信封由 GrayRemoteService.invoke 统一转换，业务失败永不 reject。
 */

import type { BranchCoordinatorService } from '../../service.ts'
import type { GrayBranchGroup } from '../../domain/types.ts'
import { GrayRemoteError } from '../../../remote/errors.ts'
import {
  normalizeLimit,
  optionalInt,
  optionalString,
  optionalWorkspace,
  requireString,
  slicePage,
} from '../../../remote/validate.ts'
import type { GrayRemoteArgs, GrayRemoteHandlers } from '../../../remote/types.ts'
import { createBranchWorkspaceId } from '../../service.ts'

/** 分支组 → Remote 视图（组摘要 + 候选投影，与工具层 branch_list 同构）。 */
function projectGroup(group: GrayBranchGroup): { id: string } & Record<string, unknown> {
  return {
    id: group.id,
    groupId: group.id,
    workspaceId: group.workspaceId,
    rootSessionId: group.rootSessionId,
    activeSessionId: group.activeSessionId,
    revision: group.revision,
    createdAt: group.createdAt,
    candidates: group.candidates.map(c => ({
      sessionId: c.sessionId,
      parentSessionId: c.parentSessionId,
      boundary: c.boundary,
      kind: c.kind,
      label: c.label,
      deleted: c.deletedAt !== undefined,
      createdAt: c.createdAt,
    })),
  }
}

/**
 * 领域错误经 remote/errors.ts 的 toGrayRemoteFailure 单点映射（BRANCH_CODE_MAP），
 * handler 直接上抛 BranchError；本文件不重复转换。
 */

/** 创建 branches Remote 端点处理器（由 branches 域 apply() 注册）。 */
export function createBranchesRemoteHandlers(service: BranchCoordinatorService): GrayRemoteHandlers {
  return {
    'branches/list': async (args: GrayRemoteArgs) => {
      const workspace = optionalWorkspace(args)
      const cursor = optionalString(args, 'cursor')
      const limit = normalizeLimit(args.limit)
      const wsId = workspace ? createBranchWorkspaceId(workspace) : undefined
      const groups = service
        .listGroups()
        .filter(g => wsId === undefined || !g.workspaceId || g.workspaceId === wsId)
        .map(projectGroup)
      const { page, nextCursor } = slicePage(groups, cursor, limit)
      return { items: page, total: groups.length, nextCursor }
    },

    'branches/rename': async (args: GrayRemoteArgs) => {
      const sessionId = requireString(args, 'sessionId')
      const label = requireString(args, 'label')
      if (label.length > 200) {
        throw GrayRemoteError.invalidInput('label must be at most 200 characters', { label })
      }
      const groupId = optionalString(args, 'groupId')
      const expectedRevision = optionalInt(args, 'expectedRevision')

      let resolvedGroupId: string
      if (groupId) {
        if (!service.getGroup(groupId)) {
          throw GrayRemoteError.notFound(`branch group "${groupId}" not found`, {})
        }
        resolvedGroupId = groupId
      } else {
        const group = service.groupForSession(sessionId)
        if (!group) {
          throw GrayRemoteError.notFound('no branch group contains the given session', {})
        }
        resolvedGroupId = group.id
      }

      const result = await service.renameCandidate({
        groupId: resolvedGroupId,
        sessionId,
        label,
        expectedRevision,
      })
      return {
        groupId: result.groupId,
        sessionId: result.sessionId,
        revision: result.revision,
        activeSessionId: result.activeSessionId,
      }
    },
  }
}
