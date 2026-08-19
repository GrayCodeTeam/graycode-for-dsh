/**
 * GrayCode - branches Remote adapter（host 侧，C5：client 分支管理端点）。
 *
 * 端点（命名空间 `branches`）：
 * - `branches/list`：按 workspace 列出分支组（含候选/激活指针/revision，
 *   供 UI 与管理端点做 CAS）；
 * - `branches/rename`：重命名候选显示名（1-200 字符；expectedRevision CAS）；
 * - `branches/switch` / `delete` / `restore`：浏览器侧候选管理；
 * - `branches/pruneDeleted`：按配置保留期清理过期 tombstone（不删除会话）；
 * - `branches/reroll`：重新生成——fork 目标轮次之前的完整前缀并把该轮次的
 *   用户消息重发到新会话（新会话自动激活）；
 * - `branches/editRetry`：编辑并重试——同上但重发编辑后的文本。
 *   会话未归组时端点层自动建组（以该会话为 root），单会话直接可用。
 *
 * 领域错误（BranchError）按 BRANCH_CODE_MAP 映射为稳定码（见 remote/errors.ts）；
 * 错误信封由 GrayRemoteService.invoke 统一转换，业务失败永不 reject。
 */

import type { BranchCoordinatorService } from '../../service.ts'
import type { GrayBranchGroup } from '../../domain/types.ts'
import { GrayRemoteError } from '../../../remote/errors.ts'
import {
  normalizeLimit,
  optionalString,
  optionalWorkspace,
  requireBoolean,
  requireInt,
  requireString,
  slicePage,
} from '../../../remote/validate.ts'
import type { GrayRemoteArgs, GrayRemoteHandlers } from '../../../remote/types.ts'
import { createBranchWorkspaceId } from '../../service.ts'

/**
 * expectedRevision：branches/list 的 revision 为数字；契约同时允许数字字符串
 * （客户端可原样回传字符串形态），两者都接受。
 */
function optionalRevision(args: GrayRemoteArgs): number | undefined {
  const value = args.expectedRevision
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim())
    if (Number.isSafeInteger(parsed)) return parsed
  }
  throw GrayRemoteError.invalidInput('expectedRevision must be an integer', { field: 'expectedRevision' })
}

/**
 * 解析会话所属分组：已在组内直接返回组 id；未归组时自动建组（以该会话为
 * root，workspaceId 由会话 cwd 派生；无 cwd 时为 undefined）——单会话直接可用。
 */
async function resolveGroupId(service: BranchCoordinatorService, sessionId: string): Promise<string> {
  const existing = service.groupForSession(sessionId)
  if (existing) return existing.id
  const cwd = service.cwdOf(sessionId)
  const group = await service.ensureGroup({
    workspaceId: cwd ? createBranchWorkspaceId(cwd) : undefined,
    rootSessionId: sessionId,
    label: 'main',
  })
  return group.id
}

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
      const expectedRevision = optionalRevision(args)

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

    'branches/switch': async (args: GrayRemoteArgs) => {
      const groupId = requireString(args, 'groupId')
      const sessionId = requireString(args, 'sessionId')
      return service.switchCandidate({ groupId, sessionId, expectedRevision: optionalRevision(args) })
    },

    'branches/delete': async (args: GrayRemoteArgs) => {
      const groupId = requireString(args, 'groupId')
      const sessionId = requireString(args, 'sessionId')
      if (requireBoolean(args, 'confirm') !== true) {
        throw GrayRemoteError.invalidInput('confirm must be true', { field: 'confirm' })
      }
      return service.deleteCandidate({ groupId, sessionId, expectedRevision: optionalRevision(args) })
    },

    'branches/restore': async (args: GrayRemoteArgs) => {
      const groupId = requireString(args, 'groupId')
      const sessionId = requireString(args, 'sessionId')
      return service.restoreCandidate({ groupId, sessionId, expectedRevision: optionalRevision(args) })
    },

    'branches/pruneDeleted': async (args: GrayRemoteArgs) => {
      if (requireBoolean(args, 'confirm') !== true) {
        throw GrayRemoteError.invalidInput('confirm must be true', { field: 'confirm' })
      }
      const workspace = optionalWorkspace(args)
      return service.pruneDeletedCandidates({
        workspaceId: workspace ? createBranchWorkspaceId(workspace) : undefined,
      })
    },

    'branches/reroll': async (args: GrayRemoteArgs) => {
      const sessionId = requireString(args, 'sessionId')
      const turn = requireInt(args, 'turn')
      const expectedRevision = optionalRevision(args)
      const groupId = await resolveGroupId(service, sessionId)
      const result = await service.reroll({ groupId, sessionId, turn, expectedRevision })
      return { branchSessionId: result.sessionId }
    },

    'branches/editRetry': async (args: GrayRemoteArgs) => {
      const sessionId = requireString(args, 'sessionId')
      const turn = requireInt(args, 'turn')
      const text = requireString(args, 'text')
      const expectedRevision = optionalRevision(args)
      const groupId = await resolveGroupId(service, sessionId)
      const result = await service.editRetry({ groupId, sessionId, turn, text, expectedRevision })
      return { branchSessionId: result.sessionId }
    },
  }
}
