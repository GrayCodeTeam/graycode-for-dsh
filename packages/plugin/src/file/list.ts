import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { depsFromExec, type ToolDeps } from '../workflows/workspace.ts'
import { resolveWorkspaceTarget, targetInsideWorkspace } from './workspaceGuard.ts'

const MAX_DEPTH = 10
const MAX_ENTRIES = 5000
const LINE_COUNT_MAX_BYTES = 5 * 1024 * 1024
const IGNORED = new Set(['.git'])
const RECURSIVE_SKIPPED = new Set(['.git', 'node_modules', 'dist', 'out', 'build', 'target', 'coverage', '.venv', 'venv', '__pycache__', '.cache'])

export interface ListFileEntry {
  name: string
  type: 'file' | 'directory'
  lineCount?: number
}

export interface ListPathResult {
  path: string
  entries: ListFileEntry[]
  fileCount: number
  dirCount: number
  success: boolean
  truncated?: boolean
  error?: string
}

export interface ListFilesResult {
  results: ListPathResult[]
  totalFiles: number
  totalDirs: number
  totalPaths: number
}

function joinDisplay(base: string, name: string): string {
  return base ? `${base}/${name}` : name
}

async function lineCount(deps: ToolDeps, target: FsTarget, size?: number): Promise<number | undefined> {
  if (size !== undefined && size > LINE_COUNT_MAX_BYTES) return undefined
  try {
    const text = await deps.fs.readText(target, deps.signal)
    if (Buffer.byteLength(text, 'utf8') > LINE_COUNT_MAX_BYTES) return undefined
    return text === '' ? 0 : text.split('\n').length
  } catch {
    return undefined
  }
}

async function listOne(deps: ToolDeps, dirPath: string, recursive: boolean): Promise<ListPathResult> {
  try {
    const { root, target } = await resolveWorkspaceTarget(deps, dirPath)
    const info = await deps.fs.stat(target, deps.signal)
    if (info === undefined) throw new Error(`Directory not found: ${dirPath}`)
    if (info.type !== 'directory') throw new Error(`Not a directory: ${dirPath}`)

    const entries: ListFileEntry[] = []
    let truncated = false
    const visit = async (directory: FsTarget, base: string, depth: number): Promise<void> => {
      if (depth >= MAX_DEPTH) {
        truncated = true
        return
      }
      for (const child of await deps.fs.listDir(directory, deps.signal)) {
        if (entries.length >= MAX_ENTRIES) {
          truncated = true
          return
        }
        if (!targetInsideWorkspace(deps, root, child.target) || IGNORED.has(child.name)) continue
        const relative = joinDisplay(base, child.name)
        if (child.type === 'directory') {
          if (recursive && RECURSIVE_SKIPPED.has(child.name.toLowerCase())) continue
          entries.push({ name: `${relative}/`, type: 'directory' })
          if (recursive) await visit(child.target, relative, depth + 1)
        } else if (child.type === 'file') {
          const count = await lineCount(deps, child.target, child.size)
          entries.push({ name: relative, type: 'file', ...(count === undefined ? {} : { lineCount: count }) })
        }
      }
    }
    await visit(target, '', 0)
    entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1)
    return {
      path: dirPath,
      entries,
      fileCount: entries.filter(entry => entry.type === 'file').length,
      dirCount: entries.filter(entry => entry.type === 'directory').length,
      success: true,
      ...(truncated ? { truncated: true } : {}),
    }
  } catch (error) {
    return {
      path: dirPath,
      entries: [],
      fileCount: 0,
      dirCount: 0,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function executeListFiles(deps: ToolDeps, paths: string[], recursive: boolean): Promise<ListFilesResult> {
  const results: ListPathResult[] = []
  for (const dirPath of paths) results.push(await listOne(deps, dirPath, recursive))
  return {
    results,
    totalFiles: results.reduce((sum, result) => sum + result.fileCount, 0),
    totalDirs: results.reduce((sum, result) => sum + result.dirCount, 0),
    totalPaths: paths.length,
  }
}

function renderJson<A, V>(_args: A, value: V): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function createListFilesTool(fs: FileSystem) {
  return defineTool({
    name: 'list_files',
    description: 'List files and subdirectories in one or more workspace directories. Text files include lineCount when it can be computed. Recursive listing is bounded to depth 10 and 5000 entries.',
    parameters: {
      paths: {
        type: 'array',
        required: true,
        description: 'Workspace-relative directory paths. Must be an array even for one directory.',
        items: { type: 'string' },
      },
      recursive: { type: 'boolean', description: 'Recursively list subdirectories. Defaults to false.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec: ToolRunContext) {
      const rawPaths = (args as { paths?: unknown }).paths
      if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.some(value => typeof value !== 'string')) {
        throw new Error('paths is required and must be a non-empty string array')
      }
      return executeListFiles(
        depsFromExec(fs, exec, exec.signal),
        rawPaths as string[],
        (args as { recursive?: unknown }).recursive === true,
      ) as never
    },
  })
}
