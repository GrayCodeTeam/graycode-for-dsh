/**
 * 7 个存档工具的 defineTool 定义（注册进 checkpoints/index.ts 的 apply）。
 *
 * 描述均为英文（DSH 工具描述契约）；parameters/output 使用 dsh-tools 的
 * 参数 DSL；output.render 是纯函数投影（args + value → 文本块）。
 *
 * 工作区身份：execute 的 `exec.agent?.session.header.cwd`（undefined 回退
 * process.cwd()）。恢复门闸：restore 必须在本次会话内先拿到 checkpoint_preview
 * 的 previewToken 并显式回传，无有效 token 拒绝（service 层强制）；
 * token 绑定 manifest hash 与目标基线摘要，目标变化后旧 token 失效。
 * checkpoint_gc：Blob GC（内容寻址池），dry-run 优先（默认只列出待删 blob）。
 */

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { omitUndefined, type CheckpointService } from './service.ts'

/** 从执行上下文解析工作区 cwd（undefined 回退 process.cwd()） */
function resolveCwd(exec: ToolRunContext): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

/** 工具返回的 JsonValue 序列化辅助（render 纯函数用） */
function toText(args: unknown, value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function createTool(service: CheckpointService) {
  return {
    checkpoint_create: defineTool({
      name: 'checkpoint_create',
      description:
        'Create a full workspace checkpoint (snapshot) of the current working directory into the plugin-private content-addressed archive. Files under .git, node_modules, and default exclusion profiles (logs, caches, build artifacts, etc.) are skipped. Blobs are content-addressed (same content is reused across checkpoints); the snapshot chains from the previous checkpoint (incremental parent) with a change list. Returns the new checkpoint id and statistics.',
      parameters: {
        title: { type: 'string', description: 'Optional short title for the checkpoint.' },
        notes: { type: 'string', description: 'Optional free-form notes describing the checkpoint.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            checkpointId: { type: 'string', description: 'The created checkpoint id (cp_<hex>).' },
            type: { type: 'string', enum: ['full', 'incremental'], description: 'Checkpoint type (incremental when a parent snapshot exists).' },
            fileCount: { type: 'integer', description: 'Number of files in the snapshot.' },
            sizeBytes: { type: 'integer', description: 'Bytes newly written to the blob pool (unchanged content is reused).' },
            excludedCount: { type: 'integer', description: 'Number of excluded files/directories.' },
            baseCheckpointId: { type: 'string', description: 'Parent checkpoint id this snapshot chains from, when present.' },
            description: { type: 'string', description: 'Effective description of the checkpoint.' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const result = await service.createCheckpoint(resolveCwd(exec), {
          title: args.title,
          notes: args.notes,
          signal: exec.signal,
        })
        if (!result) {
          throw new Error('Failed to create checkpoint (see logs for details)')
        }
        // H-1：baseCheckpointId/description 可能为 undefined——剔除 undefined 值键后返回
        // （snapshotToolValue 对含 undefined 值键的对象抛 ToolOutputError）。
        return omitUndefined({
          checkpointId: result.checkpointId,
          type: result.type,
          fileCount: result.fileCount,
          sizeBytes: result.sizeBytes,
          excludedCount: result.excludedCount,
          baseCheckpointId: result.baseCheckpointId,
          description: result.description,
        })
      },
    }),

    checkpoint_list: defineTool({
      name: 'checkpoint_list',
      description:
        'List checkpoint summaries for a workspace, newest first, with cursor-based pagination. Use the returned nextCursor as the cursor parameter to fetch the next page.',
      parameters: {
        workspace: { type: 'string', description: 'Optional absolute workspace directory to list; defaults to the current session cwd.' },
        cursor: { type: 'string', description: 'Opaque pagination cursor (the id of the last listed checkpoint).' },
        limit: { type: 'integer', description: 'Maximum number of items per page (1-100, default 20).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  conversationId: { type: 'string' },
                  timestamp: { type: 'integer' },
                  type: { type: 'string', enum: ['full', 'incremental'] },
                  baseCheckpointId: { type: 'string' },
                  contentHash: { type: 'string' },
                  fileCount: { type: 'integer' },
                  backupBytes: { type: 'integer' },
                  excludedCount: { type: 'integer' },
                  description: { type: 'string' },
                },
              },
            },
            total: { type: 'integer', description: 'Total checkpoint count for the workspace.' },
            nextCursor: { type: 'string', description: 'Cursor for the next page; absent when no more items.' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const cwd = args.workspace ?? resolveCwd(exec)
        return service.listCheckpoints(cwd, { cursor: args.cursor, limit: args.limit })
      },
    }),

    checkpoint_preview: defineTool({
      name: 'checkpoint_preview',
      description:
        'Compute (without writing anything) the exact restore plan for a checkpoint: files to restore, files to delete, untracked files, skipped files, and conflicts. Returns a previewToken that MUST be passed unchanged to checkpoint_restore as confirmation. The token binds this checkpoint, this workspace, the manifest hash, and a baseline digest of the current workspace files: if any tracked file changes after preview, the token is invalidated and checkpoint_restore will deny until you preview again. The token is only valid within this session.',
      parameters: {
        checkpointId: { type: 'string', required: true, description: 'Checkpoint id to preview.' },
        deleteUntrackedFiles: {
          type: 'boolean',
          description: 'Whether the plan should account for deleting files created after the snapshot (default false).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            preview: {
              type: 'object',
              additionalProperties: false,
              properties: {
                success: { type: 'boolean' },
                restored: { type: 'integer' },
                deleted: { type: 'integer' },
                deletedIfUnconfirmed: { type: 'integer' },
                skipped: { type: 'integer' },
                deletablePaths: { type: 'array', items: { type: 'string' } },
                untrackedPaths: { type: 'array', items: { type: 'string' } },
                unbackedPaths: { type: 'array', items: { type: 'string' } },
                error: { type: 'string' },
              },
            },
            previewToken: {
              type: 'string',
              description: 'Confirmation token required by checkpoint_restore; only present when the preview succeeded.',
            },
            baselineDigest: {
              type: 'string',
              description:
                'Digest of the current workspace files captured by this preview and bound to the previewToken; checkpoint_restore re-compares the workspace against it and denies if it changed (re-run preview).',
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return service.previewRestore(resolveCwd(exec), args.checkpointId, {
          deleteUntrackedFiles: args.deleteUntrackedFiles === true,
        })
      },
    }),

    checkpoint_restore: defineTool({
      name: 'checkpoint_restore',
      description:
        'Restore a workspace to a checkpoint state. Requires the previewToken returned by checkpoint_preview in this session for the same checkpoint and workspace; the token binds a baseline digest of the workspace captured at preview time, so restoring is denied if any tracked file changed after preview (run checkpoint_preview again to re-confirm). Copies phase runs before any deletion and deletions only run when every copy succeeded; per-file failures are reported. With deleteUntrackedFiles=false (default) only files recorded by the snapshot are touched and files created after the snapshot are kept. Before restoring, an automatic protection point checkpoint of the current workspace is created so the pre-restore state can be rolled back (disable via plugin config restoreProtectionPoint=false; if its creation fails the restore still proceeds and a warning is logged).',
      parameters: {
        checkpointId: { type: 'string', required: true, description: 'Checkpoint id to restore.' },
        previewToken: { type: 'string', required: true, description: 'The previewToken returned by checkpoint_preview for this checkpoint/workspace.' },
        deleteUntrackedFiles: {
          type: 'boolean',
          description: 'Also delete files created after the snapshot (must have been confirmed via preview, default false).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            success: { type: 'boolean' },
            restored: { type: 'integer' },
            deleted: { type: 'integer' },
            skipped: { type: 'integer' },
            error: { type: 'string' },
            failures: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string' },
                  reason: { type: 'string', enum: ['missing_in_chain', 'hash_mismatch', 'copy_failed', 'delete_failed'] },
                },
              },
            },
            unbackedPaths: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return service.restoreCheckpoint(resolveCwd(exec), args.checkpointId, args.previewToken, {
          deleteUntrackedFiles: args.deleteUntrackedFiles === true,
          signal: exec.signal,
        })
      },
    }),

    checkpoint_delete: defineTool({
      name: 'checkpoint_delete',
      description:
        'Delete a checkpoint: removes its record and manifest and decrements blob reference counts (blobs are physically reclaimed later by checkpoint_gc once their refcount reaches zero past the grace period). Chain protection rejects deletion when another checkpoint references this one as its base snapshot (computeForcedKeepIds ancestor closure); pass force=true to bypass chain protection (successor checkpoints then restore as broken chains).',
      parameters: {
        checkpointId: { type: 'string', required: true, description: 'Checkpoint id to delete.' },
        force: { type: 'boolean', description: 'Skip chain protection (default false).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            success: { type: 'boolean' },
            deleted: { type: 'boolean' },
            rejected: { type: 'string', description: 'Chain-protection rejection message, when applicable.' },
            reason: { type: 'string', description: 'Failure reason (not found / cancelled / error).' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return service.deleteCheckpoint(resolveCwd(exec), args.checkpointId, {
          force: args.force === true,
          signal: exec.signal,
        })
      },
    }),

    checkpoint_verify: defineTool({
      name: 'checkpoint_verify',
      description:
        'Read-only integrity verification of a checkpoint: manifest validity, blob existence plus content-hash agreement with the addressing key, and incremental-chain completeness (base index plus cycle detection plus manifest existence per chain node). Never modifies the archive or the workspace.',
      parameters: {
        checkpointId: { type: 'string', required: true, description: 'Checkpoint id to verify.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', description: 'True when no integrity issue was found.' },
            checkpointId: { type: 'string' },
            issues: { type: 'array', items: { type: 'string' }, description: 'Human-readable integrity issues.' },
            checkedFiles: { type: 'integer', description: 'Number of blobs hash-verified.' },
            chainLength: { type: 'integer', description: 'Length of the incremental chain ending at this checkpoint.' },
            filesRevisionPaired: { type: 'boolean', description: 'Manifest self-consistency flag (single-file manifest layout).' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        return service.verifyCheckpoint(args.checkpointId)
      },
    }),

    checkpoint_gc: defineTool({
      name: 'checkpoint_gc',
      description:
        'Garbage-collect the content-addressed blob pool for the current workspace: only blobs whose reference count is zero (no manifest references them) and whose orphan age exceeds the configured grace period are collected. Reference counts are recomputed from manifests (authoritative). Dry-run by default: lists the blobs that WOULD be removed without deleting anything; pass dryRun=false to actually remove them. Mutually exclusive with create/restore/delete on the workspace.',
      parameters: {
        dryRun: {
          type: 'boolean',
          description: 'Only report removable blobs without deleting (default true).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dryRun: { type: 'boolean', description: 'True when nothing was deleted.' },
            removedBlobs: { type: 'array', items: { type: 'string' }, description: 'Blob hashes removed (or that would be removed in dry-run).' },
            removedBytes: { type: 'integer', description: 'Bytes actually removed (0 in dry-run).' },
            pendingBlobs: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  hash: { type: 'string' },
                  orphanedSince: { type: 'integer' },
                  ageMs: { type: 'integer' },
                },
              },
              description: 'Orphans still inside the grace period (not collected).',
            },
            refsVerified: { type: 'integer', description: 'Blob reference entries verified against manifests.' },
            issue: { type: 'string', description: 'Diagnostic issue (e.g. invalid blob filenames), when present.' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return service.collectGarbage(resolveCwd(exec), {
          dryRun: args.dryRun !== false,
          signal: exec.signal,
        })
      },
    }),
  }
}

/** 7 个存档工具的 defineTool 定义数组（供 scoped 注册器安装） */
export function createCheckpointToolDefinitions(service: CheckpointService) {
  const tools = createTool(service)
  return [
    tools.checkpoint_create,
    tools.checkpoint_list,
    tools.checkpoint_preview,
    tools.checkpoint_restore,
    tools.checkpoint_delete,
    tools.checkpoint_verify,
    tools.checkpoint_gc,
  ]
}

/** 注册 7 个存档工具（ctx.tools.register 返回 disposer；聚合后供 apply 返回） */
export function registerCheckpointTools(ctx: Context, service: CheckpointService): () => void {
  const disposers = createCheckpointToolDefinitions(service).map(tool => ctx.tools.register(tool))
  return () => {
    for (const dispose of disposers) {
      dispose()
    }
  }
}
