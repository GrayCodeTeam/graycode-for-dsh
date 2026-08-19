import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { withProgressWriteLock } from '../workflows/domain/progress/progressWriteLock.ts'
import { depsFromExec, readTargetText, writeTargetText, type ToolDeps } from '../workflows/workspace.ts'
import { MAX_EDIT_FILE_BYTES } from './tools.ts'
import { resolveWorkspaceTarget } from './workspaceGuard.ts'

export interface InsertCodeEntry {
  path: string
  line: number
  content: string
}

export interface InsertCodeFileResult {
  path: string
  success: boolean
  line?: number
  insertedLines?: number
  status?: 'accepted' | 'pending'
  error?: string
  staged?: { entryId: string; status: 'pending' }
}

export interface InsertCodeResult {
  results: InsertCodeFileResult[]
  successCount: number
  failCount: number
  totalCount: number
}

export function splitInsertContent(content: string): string[] {
  if (content === '') return []
  const lines = content.replace(/\r\n?/gu, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

export function insertAtLine(lines: string[], line: number, content: string): string {
  const index = line - 1
  return [...lines.slice(0, index), ...splitInsertContent(content), ...lines.slice(index)].join('\n')
}

function validateInsertEntry(value: unknown): { ok: true; entry: InsertCodeEntry } | { ok: false; path: string; error: string } {
  const record = (value ?? {}) as Record<string, unknown>
  const filePath = record.path
  const line = record.line
  const content = record.content
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, path: typeof filePath === 'string' ? filePath : '', error: 'path is required' }
  }
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    return { ok: false, path: filePath, error: 'line must be a positive integer (1-based)' }
  }
  if (typeof content !== 'string') {
    return { ok: false, path: filePath, error: 'content is required' }
  }
  return { ok: true, entry: { path: filePath, line, content } }
}

async function insertOne(deps: ToolDeps, entry: InsertCodeEntry): Promise<InsertCodeFileResult> {
  return withProgressWriteLock(entry.path, async () => {
    try {
      const { target } = await resolveWorkspaceTarget(deps, entry.path)
      const info = await deps.fs.stat(target, deps.signal)
      if (info === undefined) {
        return { path: entry.path, success: false, error: `File not found: ${entry.path}. Use write to create new files.` }
      }
      if (info.type !== 'file') {
        return { path: entry.path, success: false, error: `Not a regular file: ${entry.path}` }
      }
      if (info.size !== undefined && info.size > MAX_EDIT_FILE_BYTES) {
        return { path: entry.path, success: false, error: `File too large to edit (${entry.path} exceeds ${MAX_EDIT_FILE_BYTES} bytes)` }
      }
      const original = (await readTargetText(deps, target)).replace(/\r\n?/gu, '\n')
      if (Buffer.byteLength(original, 'utf8') > MAX_EDIT_FILE_BYTES) {
        return { path: entry.path, success: false, error: `File too large to edit (${entry.path} exceeds ${MAX_EDIT_FILE_BYTES} bytes)` }
      }
      const lines = original.split('\n')
      if (entry.line > lines.length + 1) {
        return {
          path: entry.path,
          success: false,
          error: `Line ${entry.line} is out of range. File has ${lines.length} lines. Use 1~${lines.length + 1}.`,
        }
      }
      const next = insertAtLine(lines, entry.line, entry.content)
      const insertedLines = splitInsertContent(entry.content).length
      if (next === original) {
        return { path: entry.path, success: true, line: entry.line, insertedLines: 0, status: 'accepted' }
      }
      const outcome = await writeTargetText(deps, target, next, entry.path)
      return {
        path: entry.path,
        success: true,
        line: entry.line,
        insertedLines,
        status: outcome.staged ? 'pending' : 'accepted',
        ...(outcome.staged && outcome.stagedEntryId
          ? { staged: { entryId: outcome.stagedEntryId, status: 'pending' as const } }
          : {}),
      }
    } catch (error) {
      return { path: entry.path, success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }, deps.cwd)
}

export async function executeInsertCode(deps: ToolDeps, files: unknown[]): Promise<InsertCodeResult> {
  const results: InsertCodeFileResult[] = []
  for (const value of files) {
    const validated = validateInsertEntry(value)
    results.push(validated.ok ? await insertOne(deps, validated.entry) : {
      path: validated.path,
      success: false,
      error: validated.error,
    })
  }
  const successCount = results.filter(result => result.success).length
  return { results, successCount, failCount: results.length - successCount, totalCount: results.length }
}

function renderJson<A, V>(_args: A, value: V): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function createInsertCodeTool(fs: FileSystem) {
  return defineTool({
    name: 'insert_code',
    description: 'Insert code before a 1-based line in one or more workspace files. Use last_line + 1 to append. `files` must be an array even for one file. Writes participate in GrayCode staged-diff review when it is enabled.',
    parameters: {
      files: {
        type: 'array',
        required: true,
        description: 'Insert operations. Each item contains a workspace-relative path, 1-based line, and content.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', required: true, description: 'File path relative to the active workspace.' },
            line: { type: 'integer', required: true, description: '1-based line to insert before; last_line + 1 appends.' },
            content: { type: 'string', required: true, description: 'Code to insert.' },
          },
          additionalProperties: false,
        },
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec: ToolRunContext) {
      const files = (args as { files?: unknown }).files
      if (!Array.isArray(files) || files.length === 0) {
        throw new Error('files is required and must be a non-empty array')
      }
      return executeInsertCode(depsFromExec(fs, exec, exec.signal), files) as never
    },
  })
}
