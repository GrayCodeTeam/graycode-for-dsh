/**
 * GrayCode - staged-diff 工具（DSH defineTool 表面，ADR-0003 §6 后续动作 2 的前置批次）
 *
 * 5 个工具：staged_diff_stage / staged_diff_list / staged_diff_preview /
 * staged_diff_accept / staged_diff_reject。
 *
 * 语义要点：
 * - 本期不改任何现有写工具：这些工具是「写工具/测试入口」与审阅闭环；
 *   design/progress/review/checkpoint restore 的接入是后续批次。
 * - stage 只记录写入意图（pending 条目），绝不提前写 workspace；
 * - accept 落盘成功后才置 done；失败保持 accepted 并允许重试（不向 UI 假报完成）；
 * - reject 不落盘；目标文件已被其他流程修改且 before 存在时返回冲突而非自动覆盖；
 * - 所有变更支持 expectedRevision 乐观并发控制；冲突返回权威条目。
 * - 错误返回稳定机器码（StagedDiffErrorCode），UI/模型不解析错误文案。
 */
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { StagedDiffService, createStagedWorkspaceId } from '../../application/service.ts'
import { StagedDiffError, type StagedEntry } from '../../domain/types.ts'

export { createStagedWorkspaceId } from '../../application/service.ts'

function sessionIdOf(exec: ToolRunContext): string {
  // 3.17-M7：与 stagedWriteHook 的 'unknown' 兜底保持一致——headless（无 agent 会话）
  // 调用以 'unknown' 归组，而不是空串（空串会被 createEntry 以 GRAY_INVALID_INPUT 拒绝，
  // 导致同一 headless 场景下工具与写前钩子行为不一致）。
  return exec.agent?.session?.id || 'unknown'
}

function cwdOf(exec: ToolRunContext): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

function toText(_args: unknown, value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** 错误投影：稳定 code + 人类可读 message + 权威条目（冲突/失败时） */
function errorOf(error: unknown): { success: false; error: string; code?: string; entry?: StagedEntry } {
  if (error instanceof StagedDiffError) {
    return { success: false, error: error.message, code: error.code, ...(error.entry ? { entry: error.entry } : {}) }
  }
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

/** 条目输出投影 schema（before 允许 null：oneOf string|null） */
const entrySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    workspaceId: { type: 'string', required: true },
    sessionId: { type: 'string', required: true },
    path: { type: 'string', required: true },
    before: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    after: { type: 'string', required: true },
    toolCallId: { type: 'string' },
    status: {
      type: 'string',
      enum: ['pending', 'reviewing', 'accepted', 'rejected', 'done', 'needs-reapply'],
      required: true,
    },
    createdAt: { type: 'integer', required: true },
    updatedAt: { type: 'integer', required: true },
    revision: { type: 'integer', required: true },
  },
} as const

/** stage/list/preview/accept/reject 公共输出形状 */
const entryResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    success: { type: 'boolean', required: true },
    entry: entrySchema,
    error: { type: 'string' },
    code: { type: 'string' },
  },
} as const

export function createStagedDiffTools(service: StagedDiffService): ToolDefinition[] {
  return [
    defineTool({
      name: 'staged_diff_stage',
      description:
        'Stage a workspace file write for deferred review: records the write intent (target path + target content) as a pending entry instead of writing the file. The change only lands on disk after the user accepts it via staged_diff_accept; rejected entries never touch disk. Re-staging the same toolCallId+path while the entry is pending/reviewing returns the existing entry (idempotent).',
      parameters: {
        path: { type: 'string', required: true, description: 'Workspace-relative target path (POSIX separators; no leading "/", no "..").' },
        content: { type: 'string', required: true, description: 'Full target file content after this write.' },
        before: { type: 'string', description: 'Optional snapshot of the content before this write (FsWriteOutcome.before semantics); omit when the file does not exist or the old content is unknown.' },
        toolCallId: { type: 'string', description: 'Optional idempotency key; together with path it dedupes re-staging of the same intent.' },
      },
      output: {
        schema: entryResultSchema,
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          const entry = await service.createEntry({
            workspaceId: createStagedWorkspaceId(cwdOf(exec)),
            sessionId: sessionIdOf(exec),
            path: args.path,
            after: args.content,
            before: args.before,
            toolCallId: args.toolCallId,
          })
          return { success: true, entry }
        } catch (error) {
          return errorOf(error)
        }
      },
    }),

    defineTool({
      name: 'staged_diff_list',
      description:
        'List the review batch of the current workspace+session: all pending/reviewing staged entries aggregated in one derived view (ADR-0003 cross-tool accumulation), sorted by creation time. Read-only.',
      parameters: {
        workspaceId: { type: 'string', description: 'Optional workspace id; defaults to the current session cwd.' },
        sessionId: { type: 'string', description: 'Optional session id; defaults to the current session.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            success: { type: 'boolean', required: true },
            batch: {
              type: 'object',
              additionalProperties: false,
              properties: {
                workspaceId: { type: 'string', required: true },
                sessionId: { type: 'string', required: true },
                entries: { type: 'array', items: entrySchema, required: true },
                pendingCount: { type: 'integer', required: true },
                reviewingCount: { type: 'integer', required: true },
                totalCount: { type: 'integer', required: true },
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
          const workspaceId = args.workspaceId ?? createStagedWorkspaceId(cwdOf(exec))
          const sessionId = args.sessionId ?? sessionIdOf(exec)
          const batch = service.reviewBatch(workspaceId, sessionId)
          return { success: true, batch }
        } catch (error) {
          return errorOf(error)
        }
      },
    }),

    defineTool({
      name: 'staged_diff_preview',
      description:
        'Preview one staged entry: target path, full target content, the before snapshot when available, status and revision. Read-only; never writes.',
      parameters: {
        entryId: { type: 'string', required: true, description: 'Staged entry id (from staged_diff_stage / staged_diff_list).' },
      },
      output: {
        schema: entryResultSchema,
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          const entry = await service.previewEntry(args.entryId)
          return { success: true, entry }
        } catch (error) {
          return errorOf(error)
        }
      },
    }),

    defineTool({
      name: 'staged_diff_accept',
      description:
        'Accept a staged entry: writes the staged content to disk (via the workspace filesystem, sandboxed to the workspace root), then marks the entry done. On apply failure the entry stays accepted and the call can be retried with the fresh revision; the UI is never told the entry completed when the write failed. Use expectedRevision from the entry for optimistic concurrency.',
      parameters: {
        entryId: { type: 'string', required: true, description: 'Staged entry id.' },
        expectedRevision: { type: 'integer', description: 'Optional CAS token; the operation fails with GRAY_STAGED_REVISION_CONFLICT when the entry changed since it was read.' },
      },
      output: {
        schema: entryResultSchema,
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const entry = await service.acceptEntry({
            entryId: args.entryId,
            expectedRevision: args.expectedRevision,
            workspaceRoot: cwdOf(exec),
          })
          return { success: true, entry }
        } catch (error) {
          return errorOf(error)
        }
      },
    }),

    defineTool({
      name: 'staged_diff_reject',
      description:
        'Reject a staged entry: the write intent is abandoned and nothing is written to disk. If the target file was modified by another flow after staging (its disk content no longer matches the entry before snapshot), the call returns GRAY_STAGED_REJECT_CONFLICT with the authoritative entry instead of silently overwriting. Use expectedRevision for optimistic concurrency.',
      parameters: {
        entryId: { type: 'string', required: true, description: 'Staged entry id.' },
        expectedRevision: { type: 'integer', description: 'Optional CAS token; fails with GRAY_STAGED_REVISION_CONFLICT when the entry changed since it was read.' },
      },
      output: {
        schema: entryResultSchema,
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const entry = await service.rejectEntry({
            entryId: args.entryId,
            expectedRevision: args.expectedRevision,
            workspaceRoot: cwdOf(exec),
          })
          return { success: true, entry }
        } catch (error) {
          return errorOf(error)
        }
      },
    }),
  ]
}
