/**
 * GrayCode - delete_code 工具（DSH 变体）
 *
 * 与老版 Gray Code backend/tools/file/delete_code.ts 语义对齐：
 * - 参数 `files` 数组（path / start_line / end_line，1-based 两端包含），
 *   即使只删一个文件也必须传数组；
 * - 逐文件校验：path 必填、行号正整数、start ≤ end、文件存在、
 *   5MB 大小护栏（MAX_EDIT_FILE_BYTES，与 read_file/search_in_files 同源）、
 *   行号范围校验（start/end 不得超出文件总行数）；
 * - 逐文件结果（results[]），汇总 successCount/failCount/totalCount；
 *   单个文件失败不阻断其他文件（与老版一致）。
 *
 * DSH 差异（与 workflows 文档工具同族）：
 * - 无 diff 确认面板（DSH 无 requiresUserConfirmation 语义）：文件立即落盘；
 * - 文件读写经 ctx.fs（resolveTarget/readTargetText/writeTargetText）；
 * - staged-diff 适配（ADR-0003 §6 后续动作 2）：stagedDiff enabled 时删除
 *   意图先变成 staged 条目（per-file 结果带 staged.entryId），接受后才落盘；
 * - 「读 → 改 → 写」整体进 per-path 写锁（withProgressWriteLock），防 TOCTOU；
 * - 参数级错误（files 非数组）抛普通 Error；逐文件失败进 results 不抛错。
 */

import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { withProgressWriteLock } from '../workflows/domain/progress/progressWriteLock.ts'
import {
  depsFromExec,
  readTargetText,
  writeTargetText,
  type ToolDeps,
} from '../workflows/workspace.ts'
import { resolveWorkspaceTarget } from './workspaceGuard.ts'

/** 文件大小护栏（与老版 MAX_EDIT_FILE_BYTES 一致，5MB） */
export const MAX_EDIT_FILE_BYTES = 5 * 1024 * 1024

export interface DeleteCodeEntry {
  path: string
  start_line: number
  end_line: number
}

export interface DeleteCodeArgs {
  files: DeleteCodeEntry[]
}

export interface DeleteCodeFileResult {
  path: string
  success: boolean
  start_line?: number
  end_line?: number
  deletedLines?: number
  status?: 'accepted' | 'rejected'
  error?: string
  /** staged-diff 接管时：条目 id（供 staged_diff_accept / staged_diff_reject 使用） */
  staged?: { entryId: string; status: 'pending' }
}

export interface DeleteCodeToolResultData {
  results: DeleteCodeFileResult[]
  successCount: number
  failCount: number
  totalCount: number
}

/**
 * 删除指定行范围（1-based，两端包含）。与老版 deleteLineRange 逐字一致：
 * split('\n') 的尾部空串元素参与行号计数（"a\nb\n" 有 3 行）。
 */
export function deleteLineRange(lines: string[], startLine: number, endLine: number): string {
  return [...lines.slice(0, startLine - 1), ...lines.slice(endLine)].join('\n')
}

/** 校验单个删除条目（老版 deleteSingleFile 的校验段；返回错误文案或 null） */
export function validateDeleteEntry(
  entry: unknown,
): { ok: true; entry: DeleteCodeEntry } | { ok: false; path: string; error: string } {
  const record = (entry ?? {}) as Record<string, unknown>
  const filePath = record.path
  const startLine = record.start_line
  const endLine = record.end_line

  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, path: typeof filePath === 'string' ? filePath : '', error: 'path is required' }
  }
  if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) {
    return { ok: false, path: filePath, error: 'start_line must be a positive integer (1-based)' }
  }
  if (typeof endLine !== 'number' || !Number.isInteger(endLine) || endLine < 1) {
    return { ok: false, path: filePath, error: 'end_line must be a positive integer (1-based)' }
  }
  if (startLine > endLine) {
    return {
      ok: false,
      path: filePath,
      error: `start_line (${startLine}) must be <= end_line (${endLine})`,
    }
  }
  return { ok: true, entry: { path: filePath, start_line: startLine, end_line: endLine } }
}

/** 读取文件文本；文件不存在返回 File not found（老版文案）。先 stat 判 5MB 护栏再读，
 *  大文件不整读入内存（M4：把「先读后判」改为「先判后读」）。 */
async function readFileOrNotFound(
  deps: ToolDeps,
  relPath: string,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const { target } = await resolveWorkspaceTarget(deps, relPath)
  const info = await deps.fs.stat(target, deps.signal)
  if (info === undefined) {
    return { ok: false, error: `File not found: ${relPath}` }
  }
  // 大小护栏前置：stat 能报告字节数时直接拒绝，避免大文件被整读进内存后再判（M4）。
  // 后端无法报告 size 时（size === undefined）回退到读取后按 UTF-8 字节数判定，保证兜底一致。
  if (info.size !== undefined && info.size > MAX_EDIT_FILE_BYTES) {
    return {
      ok: false,
      error: `File too large to edit (${relPath} exceeds ${MAX_EDIT_FILE_BYTES} bytes)`,
    }
  }
  try {
    const content = await readTargetText(deps, target)
    if (Buffer.byteLength(content, 'utf8') > MAX_EDIT_FILE_BYTES) {
      return {
        ok: false,
        error: `File too large to edit (${relPath} exceeds ${MAX_EDIT_FILE_BYTES} bytes)`,
      }
    }
    return { ok: true, content }
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** 执行单个文件的删除（读 → 校验 → 删行 → 写；整体进 per-path 写锁） */
async function deleteSingleFile(
  deps: ToolDeps,
  relPath: string,
  startLine: number,
  endLine: number,
): Promise<DeleteCodeFileResult> {
  return withProgressWriteLock(relPath, async () => {
    const read = await readFileOrNotFound(deps, relPath)
    if (!read.ok) {
      return { path: relPath, success: false, error: read.error }
    }

    const originalContent = read.content
    const originalLines = originalContent.split('\n')
    const totalLines = originalLines.length

    if (startLine > totalLines) {
      return {
        path: relPath,
        success: false,
        error: `start_line ${startLine} is out of range. File has ${totalLines} lines.`,
      }
    }
    if (endLine > totalLines) {
      return {
        path: relPath,
        success: false,
        error: `end_line ${endLine} is out of range. File has ${totalLines} lines.`,
      }
    }

    const newContent = deleteLineRange(originalLines, startLine, endLine)
    const deletedCount = endLine - startLine + 1

    if (originalContent === newContent) {
      return {
        path: relPath,
        success: true,
        start_line: startLine,
        end_line: endLine,
        deletedLines: 0,
        status: 'accepted',
      }
    }

    // 写入前重新解析并再次做 containment 校验，防止读写之间路径别名被换到工作区外。
    const { target } = await resolveWorkspaceTarget(deps, relPath)
    const outcome = await writeTargetText(deps, target, newContent, relPath)
    const result: DeleteCodeFileResult = {
      path: relPath,
      success: true,
      start_line: startLine,
      end_line: endLine,
      deletedLines: deletedCount,
      status: 'accepted',
    }
    if (outcome.staged && outcome.stagedEntryId) {
      result.staged = { entryId: outcome.stagedEntryId, status: 'pending' }
    } else if (outcome.warnings && outcome.warnings.length > 0) {
      result.error = outcome.warnings.join('; ')
    }
    return result
  })
}

/** 逐文件执行删除（不阻断：单文件失败进 results） */
export async function executeDeleteCode(
  deps: ToolDeps,
  args: DeleteCodeArgs,
): Promise<DeleteCodeToolResultData> {
  const results: DeleteCodeFileResult[] = []
  let successCount = 0
  let failCount = 0

  for (const entry of args.files) {
    const validated = validateDeleteEntry(entry)
    if (!validated.ok) {
      results.push({ path: validated.path, success: false, error: validated.error })
      failCount += 1
      continue
    }

    const result = await deleteSingleFile(
      deps,
      validated.entry.path,
      validated.entry.start_line,
      validated.entry.end_line,
    )
    results.push(result)
    if (result.success) successCount += 1
    else failCount += 1
  }

  return { results, successCount, failCount, totalCount: args.files.length }
}

function renderToolResult<A, V>(_args: A, value: V): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function createDeleteCodeTool(fs: FileSystem) {
  return defineTool({
    name: 'delete_code',
    description:
      'Delete a range of lines (inclusive on both ends) from one or more files. The `files` parameter MUST be an array, even for a single file. Example: {"files": [{"path": "file.ts", "start_line": 10, "end_line": 20}]}. Files are written to disk immediately (no diff confirmation).',
    parameters: {
      files: {
        type: 'array',
        required: true,
        description:
          'Array of delete operations. Each element specifies a file (path relative to the workspace root) and the 1-based inclusive line range to delete.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (relative to workspace root)', required: true },
            start_line: { type: 'integer', description: 'Start line number (1-based, inclusive)', required: true },
            end_line: { type: 'integer', description: 'End line number (1-based, inclusive)', required: true },
          },
          additionalProperties: false,
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: renderToolResult,
    },
    async execute(args, exec: ToolRunContext) {
      const deps = depsFromExec(fs, exec, exec.signal)
      const files = (args as { files?: unknown }).files
      if (!files || !Array.isArray(files) || files.length === 0) {
        throw new Error('files is required and must be a non-empty array')
      }
      return executeDeleteCode(deps, { files: files as DeleteCodeEntry[] }) as never
    },
  })
}
