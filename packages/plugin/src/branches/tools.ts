/**
 * GrayCode - 树状分支工具（DSH defineTool 表面，V2 §P3E）
 *
 * 7 个工具：branch_list / branch_create / branch_reroll / branch_edit_retry /
 * branch_switch / branch_delete / branch_restore。
 *
 * 语义要点：
 * - 对话正文真源是 dsh Session；本工具只操作 Gray sidecar（分组/候选/激活指针）。
 * - reroll / edit retry 通过 dsh agent factory fork 新会话（完整轮次前缀），
 *   并把目标轮次的原始（或编辑后的）用户消息重发到新会话；
 *   无 agent factory 时降级为仅建会话（agentAttached = false）。
 * - reroll / edit_retry 成功后新候选自动激活（D-2，旧版 updateTail:true）：
 *   sidecar 提交时 activeSessionId 即切到新候选，无需再调 branch_switch；
 *   branch_create（手动分支）不自动激活。切换只改会话指针，不改任何会话日志。
 * - 所有变更支持 expectedRevision 乐观并发控制；冲突返回权威快照。
 * - 错误返回稳定机器码（BranchErrorCode），UI/模型不解析错误文案。
 */

import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { BranchCoordinatorService, createBranchWorkspaceId } from './service.ts'
import { BranchError, BranchErrorCode } from './domain/types.ts'
import { scanTurns } from './domain/turnLocator.ts'

function sessionIdOf(exec: ToolRunContext): string {
  return exec.agent?.session?.id ?? ''
}

function cwdOf(exec: ToolRunContext): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

function toText(_args: unknown, value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** 错误投影：稳定 code + 人类可读 message */
function errorOf(error: unknown): { success: false; error: string; code?: string } {
  if (error instanceof BranchError) {
    return { success: false, error: error.message, code: error.code }
  }
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

/** 解析 groupId：显式给出则校验存在；否则从会话归属推导 */
function resolveGroupId(
  service: BranchCoordinatorService,
  groupId: string | undefined,
  sessionId: string
): string {
  if (groupId) {
    if (!service.getGroup(groupId)) {
      throw new BranchError(
        `branch group "${groupId}" not found`,
        BranchErrorCode.GROUP_NOT_FOUND
      )
    }
    return groupId
  }
  const group = service.groupForSession(sessionId)
  if (!group) {
    throw new BranchError(
      'no branch group contains the given session; create one first (branch_create)',
      BranchErrorCode.GROUP_NOT_FOUND
    )
  }
  return group.id
}

/** 候选列表投影（含活动候选的轮次摘要，供 reroll / edit_retry 选轮次） */
interface ProjectedCandidate {
  sessionId: string
  parentSessionId?: string
  boundary?: number
  kind: 'root' | 'reroll' | 'edit' | 'manual'
  label?: string
  deleted: boolean
  createdAt: number
}

interface ProjectedTurn {
  turn: number
  closed: boolean
  userMessages: number
}

interface ProjectedGroup {
  groupId: string
  workspaceId?: string
  rootSessionId: string
  activeSessionId: string
  revision: number
  candidates: ProjectedCandidate[]
  turns: ProjectedTurn[]
}

function projectGroup(service: BranchCoordinatorService, groupId: string): ProjectedGroup | undefined {
  const group = service.getGroup(groupId)
  if (!group) return undefined
  const active = group.candidates.find(c => c.sessionId === group.activeSessionId)
  const turns: ProjectedTurn[] = active
    ? scanTurns(service.eventsOf(group.activeSessionId)).map(t => ({
        turn: t.turn,
        closed: t.closed,
        userMessages: t.userMessageSeqs.length,
      }))
    : []
  return {
    groupId: group.id,
    workspaceId: group.workspaceId,
    rootSessionId: group.rootSessionId,
    activeSessionId: group.activeSessionId,
    revision: group.revision,
    candidates: group.candidates.map(c => ({
      sessionId: c.sessionId,
      parentSessionId: c.parentSessionId,
      boundary: c.boundary,
      kind: c.kind,
      label: c.label,
      deleted: c.deletedAt !== undefined,
      createdAt: c.createdAt,
    })),
    turns,
  }
}

export function createBranchTools(service: BranchCoordinatorService): ToolDefinition[] {
  return [
    defineTool({
      name: 'branch_list',
      description:
        'List tree-branch groups of the current workspace (or a specific group). Each group holds candidate conversations forked from one root session; candidates share history up to their fork boundary. For the active candidate, the turn summary lists the turn numbers used by branch_reroll / branch_edit_retry. Read-only.',
      parameters: {
        groupId: { type: 'string', description: 'Optional group id to list; omit to list all groups of the workspace.' },
        workspace: { type: 'string', description: 'Optional absolute workspace directory; defaults to the current session cwd.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', required: true },
            groups: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  groupId: { type: 'string' },
                  workspaceId: { type: 'string' },
                  rootSessionId: { type: 'string' },
                  activeSessionId: { type: 'string' },
                  revision: { type: 'integer' },
                  candidates: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        sessionId: { type: 'string' },
                        parentSessionId: { type: 'string' },
                        boundary: { type: 'integer' },
                        kind: { type: 'string', enum: ['root', 'reroll', 'edit', 'manual'] },
                        label: { type: 'string' },
                        deleted: { type: 'boolean' },
                        createdAt: { type: 'integer' },
                      },
                    },
                  },
                  turns: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        turn: { type: 'integer' },
                        closed: { type: 'boolean' },
                        userMessages: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
            error: { type: 'string' },
            code: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          const workspace = args.workspace ?? cwdOf(exec)
          const wsId = createBranchWorkspaceId(workspace)
          if (args.groupId && !service.getGroup(args.groupId)) {
            throw new BranchError(
              `branch group "${args.groupId}" not found`,
              BranchErrorCode.GROUP_NOT_FOUND
            )
          }
          const groups = args.groupId
            ? (() => {
                const projected = projectGroup(service, args.groupId)
                return projected ? [projected] : []
              })()
            : service
                .listGroups()
                .filter(g => !g.workspaceId || g.workspaceId === wsId)
                .map(g => projectGroup(service, g.id))
                .filter((g): g is ProjectedGroup => g !== undefined)
          return { success: true, groups }
        } catch (error) {
          return errorOf(error)
        }
      },
    }),

    defineTool({
      name: 'branch_create',
      description:
        'Manually create a new candidate branch of an existing branch group: forks the parent session through its last complete turn boundary (or the given boundary) as a new session. The active pointer is not changed by branch_create (use branch_switch to activate). Use expectedRevision (from branch_list) for optimistic concurrency; on conflict the authoritative group is returned in error.groupId data via a follow-up branch_list.',
      parameters: {
        sessionId: { type: 'string', description: 'Parent session id; defaults to the current session.' },
        groupId: { type: 'string', description: 'Optional branch group id; defaults to the group containing the parent session.' },
        boundary: { type: 'integer', description: 'Optional inclusive source event seq to fork through; defaults to the last complete turn end.' },
        label: { type: 'string', description: 'Optional display label for the new candidate.' },
        expectedRevision: { type: 'integer', description: 'Optional CAS token; the operation fails when the group changed since branch_list.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', required: true },
            groupId: { type: 'string' },
            sessionId: { type: 'string' },
            parentSessionId: { type: 'string' },
            boundary: { type: 'integer' },
            kind: { type: 'string' },
            agentAttached: { type: 'boolean', description: 'False when the host has no agent-loop: the session was created without an agent to drive.' },
            orphan: { type: 'boolean', description: 'True when the fork session exists but could not be recorded in the branch group (sidecar write failure); it remains recoverable via the returned sessionId.' },
            revision: { type: 'integer' },
            activeSessionId: { type: 'string', description: 'The active candidate after the commit (unchanged for branch_create).' },
            error: { type: 'string' },
            code: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const parentSessionId = args.sessionId ?? sessionIdOf(exec)
          const groupId = resolveGroupId(service, args.groupId, parentSessionId)
          const result = await service.createBranch({
            groupId,
            parentSessionId,
            boundary: args.boundary,
            label: args.label,
            expectedRevision: args.expectedRevision,
          })
          return { success: true, ...result }
        } catch (error) {
          return errorOf(error)
        }
      },
    }),

    defineTool({
      name: 'branch_reroll',
      description:
        'Reroll a conversation turn on a candidate session: fork a new session from the last complete turn before the given turn, and resend that turn\'s original user message to the new session (the model regenerates the response). The new session becomes a candidate of the same branch group and is activated immediately: the group\'s activeSessionId switches to it (no branch_switch needed). Get turn numbers from branch_list.',
      parameters: {
        sessionId: { type: 'string', description: 'Candidate session id to reroll from; defaults to the current session.' },
        groupId: { type: 'string', description: 'Optional branch group id; defaults to the group containing the session.' },
        turn: { type: 'integer', required: true, description: 'Turn number to reroll (from branch_list turn summary).' },
        expectedRevision: { type: 'integer', description: 'Optional CAS token for the branch group.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', required: true },
            groupId: { type: 'string' },
            sessionId: { type: 'string', description: 'The new forked session.' },
            boundary: { type: 'integer' },
            targetTurn: { type: 'integer' },
            messageSent: { type: 'boolean', description: 'Whether the original user message was delivered to the new session.' },
            agentAttached: { type: 'boolean' },
            orphan: { type: 'boolean' },
            revision: { type: 'integer' },
            activeSessionId: { type: 'string', description: 'The active candidate after the commit: the new forked session (auto-activated), or the previous active when orphan.' },
            error: { type: 'string' },
            code: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const sessionId = args.sessionId ?? sessionIdOf(exec)
          const groupId = resolveGroupId(service, args.groupId, sessionId)
          const result = await service.reroll({
            groupId,
            sessionId,
            turn: args.turn,
            expectedRevision: args.expectedRevision,
          })
          return { success: true, ...result }
        } catch (error) {
          return errorOf(error)
        }
      },
    }),

    defineTool({
      name: 'branch_edit_retry',
      description:
        'Edit a conversation turn and retry: fork a new session from the last complete turn before the given turn, and send the edited user message to the new session. The new session becomes a candidate of the same branch group and is activated immediately: the group\'s activeSessionId switches to it (no branch_switch needed).',
      parameters: {
        sessionId: { type: 'string', description: 'Candidate session id to retry from; defaults to the current session.' },
        groupId: { type: 'string', description: 'Optional branch group id; defaults to the group containing the session.' },
        turn: { type: 'integer', required: true, description: 'Turn number to replace (from branch_list turn summary).' },
        text: { type: 'string', required: true, description: 'The edited user message text to send to the new session.' },
        expectedRevision: { type: 'integer', description: 'Optional CAS token for the branch group.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', required: true },
            groupId: { type: 'string' },
            sessionId: { type: 'string' },
            boundary: { type: 'integer' },
            targetTurn: { type: 'integer' },
            messageSent: { type: 'boolean' },
            agentAttached: { type: 'boolean' },
            orphan: { type: 'boolean' },
            revision: { type: 'integer' },
            activeSessionId: { type: 'string', description: 'The active candidate after the commit: the new forked session (auto-activated), or the previous active when orphan.' },
            error: { type: 'string' },
            code: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const sessionId = args.sessionId ?? sessionIdOf(exec)
          const groupId = resolveGroupId(service, args.groupId, sessionId)
          const result = await service.editRetry({
            groupId,
            sessionId,
            turn: args.turn,
            text: args.text,
            expectedRevision: args.expectedRevision,
          })
          return { success: true, ...result }
        } catch (error) {
          return errorOf(error)
        }
      },
    }),

    defineTool({
      name: 'branch_switch',
      description:
        'Switch the active candidate of a branch group. Only the conversation pointer changes; no session log is rewritten. Chat history of the target candidate is preserved.',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'Candidate session id to activate.' },
        groupId: { type: 'string', description: 'Optional group id; defaults to the group containing the current session.' },
        expectedRevision: { type: 'integer', description: 'Optional CAS token.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', required: true },
            groupId: { type: 'string' },
            sessionId: { type: 'string' },
            revision: { type: 'integer' },
            activeSessionId: { type: 'string' },
            error: { type: 'string' },
            code: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const current = args.groupId ? '' : sessionIdOf(exec)
          const groupId = resolveGroupId(service, args.groupId, current || args.sessionId)
          const result = await service.switchCandidate({
            groupId,
            sessionId: args.sessionId,
            expectedRevision: args.expectedRevision,
          })
          return { success: true, ...result }
        } catch (error) {
          return errorOf(error)
        }
      },
    }),

    defineTool({
      name: 'branch_delete',
      description:
        'Soft-delete a candidate branch: it is hidden from branch lists but its session log is kept. The root candidate and the active candidate cannot be deleted (switch first). Use branch_restore to bring it back.',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'Candidate session id to delete.' },
        groupId: { type: 'string', description: 'Optional group id; defaults to the group containing the current session.' },
        expectedRevision: { type: 'integer', description: 'Optional CAS token.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', required: true },
            groupId: { type: 'string' },
            sessionId: { type: 'string' },
            revision: { type: 'integer' },
            activeSessionId: { type: 'string' },
            error: { type: 'string' },
            code: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const current = args.groupId ? '' : sessionIdOf(exec)
          const groupId = resolveGroupId(service, args.groupId, current || args.sessionId)
          const result = await service.deleteCandidate({
            groupId,
            sessionId: args.sessionId,
            expectedRevision: args.expectedRevision,
          })
          return { success: true, ...result }
        } catch (error) {
          return errorOf(error)
        }
      },
    }),

    defineTool({
      name: 'branch_restore',
      description:
        'Restore a soft-deleted candidate branch (clears the tombstone; the session log was never removed).',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'Candidate session id to restore.' },
        groupId: { type: 'string', description: 'Optional group id; defaults to the group containing the current session.' },
        expectedRevision: { type: 'integer', description: 'Optional CAS token.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', required: true },
            groupId: { type: 'string' },
            sessionId: { type: 'string' },
            revision: { type: 'integer' },
            activeSessionId: { type: 'string' },
            error: { type: 'string' },
            code: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const current = args.groupId ? '' : sessionIdOf(exec)
          const groupId = resolveGroupId(service, args.groupId, current || args.sessionId)
          const result = await service.restoreCandidate({
            groupId,
            sessionId: args.sessionId,
            expectedRevision: args.expectedRevision,
          })
          return { success: true, ...result }
        } catch (error) {
          return errorOf(error)
        }
      },
    }),
  ]
}
