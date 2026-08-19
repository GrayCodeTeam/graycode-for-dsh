import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { validateRegexPattern } from '../shared/regexGuard.ts'
import { withProgressWriteLock } from '../workflows/domain/progress/progressWriteLock.ts'
import { depsFromExec, writeTargetText, type ToolDeps } from '../workflows/workspace.ts'
import { resolveWorkspaceTarget, targetInsideWorkspace } from './workspaceGuard.ts'

const MAX_SEARCH_FILES = 5000
const MAX_SEARCH_DEPTH = 20
const MAX_SEARCH_BYTES = 5 * 1024 * 1024
const MAX_REPLACE_BYTES = 1024 * 1024
const MAX_REPLACE_MATCHES = 20_000
const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', 'target', 'coverage', '.venv', 'venv', '__pycache__', '.cache'])

interface SearchArgs {
  mode?: 'search' | 'replace'
  query: string
  path?: string
  pattern?: string
  isRegex?: boolean
  caseSensitive?: boolean
  maxResults?: number
  replace?: string
  maxFiles?: number
}

export interface SearchMatch {
  file: string
  line: number
  column: number
  match: string
  context?: string
}

interface SearchFile {
  path: string
  target: FsTarget
  size?: number
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** Small dependency-free glob matcher for Gray Code's common *, ** and ? patterns. */
export function globPatternToRegex(pattern: string): RegExp {
  const normalized = (pattern || '**/*').replace(/\\/gu, '/')
  let source = '^'
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!
    if (char === '*' && normalized[index + 1] === '*') {
      index += 1
      if (normalized[index + 1] === '/') {
        index += 1
        source += '(?:.*/)?'
      } else {
        source += '.*'
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += escapeRegex(char)
    }
  }
  return new RegExp(`${source}$`, 'u')
}

function normalizeDisplayPath(searchPath: string, relative: string): string {
  const base = searchPath.replace(/\\/gu, '/').replace(/^\.\/?/u, '').replace(/\/+$/u, '')
  return base ? `${base}/${relative}` : relative
}

async function collectFiles(deps: ToolDeps, searchPath: string, pattern: string): Promise<{ files: SearchFile[]; truncated: boolean }> {
  const { root, target } = await resolveWorkspaceTarget(deps, searchPath)
  const info = await deps.fs.stat(target, deps.signal)
  if (info === undefined) throw new Error(`Search path not found: ${searchPath}`)
  const matcher = globPatternToRegex(pattern)
  if (info.type === 'file') {
    const name = searchPath.replace(/\\/gu, '/').split('/').at(-1) ?? searchPath
    return { files: matcher.test(name) ? [{ path: searchPath, target, size: info.size }] : [], truncated: false }
  }
  if (info.type !== 'directory') throw new Error(`Search path is not a file or directory: ${searchPath}`)

  const files: SearchFile[] = []
  let truncated = false
  const visit = async (directory: FsTarget, relativeBase: string, depth: number): Promise<void> => {
    if (depth >= MAX_SEARCH_DEPTH) {
      truncated = true
      return
    }
    for (const child of await deps.fs.listDir(directory, deps.signal)) {
      if (files.length >= MAX_SEARCH_FILES) {
        truncated = true
        return
      }
      if (!targetInsideWorkspace(deps, root, child.target)) continue
      const relative = relativeBase ? `${relativeBase}/${child.name}` : child.name
      if (child.type === 'directory') {
        if (!SKIPPED_DIRS.has(child.name.toLowerCase())) await visit(child.target, relative, depth + 1)
      } else if (child.type === 'file' && matcher.test(relative)) {
        files.push({ path: normalizeDisplayPath(searchPath, relative), target: child.target, size: child.size })
      }
    }
  }
  await visit(target, '', 0)
  return { files, truncated }
}

function offsetLocation(text: string, index: number): { line: number; column: number; context: string } {
  const before = text.slice(0, index)
  const line = before.split('\n').length
  const lineStart = before.lastIndexOf('\n') + 1
  const lineEnd = text.indexOf('\n', index)
  return {
    line,
    column: index - lineStart + 1,
    context: text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd),
  }
}

function collectMatches(text: string, regex: RegExp, file: string, limit: number, withContext: boolean): { matches: SearchMatch[]; count: number } {
  const scan = new RegExp(regex.source, regex.flags)
  const matches: SearchMatch[] = []
  let count = 0
  for (;;) {
    const match = scan.exec(text)
    if (match === null) break
    count += 1
    if (matches.length < limit) {
      const location = offsetLocation(text, match.index)
      matches.push({
        file,
        line: location.line,
        column: location.column,
        match: (match[0] ?? '').slice(0, 220),
        ...(withContext ? { context: location.context.slice(0, 500) } : {}),
      })
    }
    if (match[0] === '') scan.lastIndex += 1
  }
  return { matches, count }
}

async function readSearchText(deps: ToolDeps, file: SearchFile, limit: number): Promise<string> {
  if (file.size !== undefined && file.size > limit) throw new Error(`File exceeds ${limit} byte limit`)
  const text = (await deps.fs.readText(file.target, deps.signal)).replace(/\r\n?/gu, '\n')
  if (Buffer.byteLength(text, 'utf8') > limit) throw new Error(`File exceeds ${limit} byte limit`)
  return text
}

function buildRegex(args: SearchArgs): RegExp {
  const replaceMode = args.mode === 'replace'
  const caseSensitive = typeof args.caseSensitive === 'boolean' ? args.caseSensitive : replaceMode
  const source = args.isRegex === true ? args.query : escapeRegex(args.query)
  const guarded = validateRegexPattern(source, `g${replaceMode ? '' : 'm'}${caseSensitive ? '' : 'i'}`)
  if (!guarded.ok) throw new Error(guarded.error)
  return guarded.regex
}

export async function executeSearchInFiles(deps: ToolDeps, args: SearchArgs): Promise<Record<string, unknown>> {
  if (!args.query) throw new Error('query is required')
  if (args.mode === 'replace' && typeof args.replace !== 'string') {
    throw new Error('replace parameter is required when mode is "replace"')
  }
  const mode = args.mode ?? 'search'
  const regex = buildRegex({ ...args, mode })
  const collected = await collectFiles(deps, args.path || '.', args.pattern || '**/*')
  const skippedFiles: Array<{ file: string; reason: string }> = []

  if (mode === 'search') {
    const maxResults = typeof args.maxResults === 'number' && args.maxResults > 0 ? Math.floor(args.maxResults) : 100
    const results: SearchMatch[] = []
    let totalMatches = 0
    for (const file of collected.files) {
      if (deps.signal?.aborted) throw new Error('Search cancelled')
      try {
        const text = await readSearchText(deps, file, MAX_SEARCH_BYTES)
        const found = collectMatches(text, regex, file.path, Math.max(0, maxResults - results.length), true)
        totalMatches += found.count
        results.push(...found.matches)
      } catch (error) {
        skippedFiles.push({ file: file.path, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return {
      results,
      count: results.length,
      truncated: collected.truncated || totalMatches > maxResults,
      multiRoot: false,
      ...(skippedFiles.length > 0 ? { skippedFiles } : {}),
    }
  }

  const maxFiles = typeof args.maxFiles === 'number' && args.maxFiles > 0 ? Math.floor(args.maxFiles) : 50
  const matches: SearchMatch[] = []
  const results: Array<Record<string, unknown>> = []
  let totalReplacements = 0
  let processedFiles = 0
  let matchesTruncated = false
  for (const file of collected.files) {
    if (processedFiles >= maxFiles) break
    if (deps.signal?.aborted) throw new Error('Search/replace cancelled')
    await withProgressWriteLock(file.path, async () => {
      try {
        const original = await readSearchText(deps, file, MAX_REPLACE_BYTES)
        const found = collectMatches(original, regex, file.path, Math.max(0, MAX_REPLACE_MATCHES - matches.length), false)
        if (found.count === 0) return
        processedFiles += 1
        matches.push(...found.matches)
        if (matches.length >= MAX_REPLACE_MATCHES && found.count > found.matches.length) matchesTruncated = true
        const next = args.isRegex === true
          ? original.replace(new RegExp(regex.source, regex.flags), args.replace!)
          : original.replace(new RegExp(regex.source, regex.flags), () => args.replace!)
        if (next === original) {
          skippedFiles.push({ file: file.path, reason: `Matched ${found.count} time(s) but replacement produced no changes` })
          return
        }
        const outcome = await writeTargetText(deps, file.target, next, file.path)
        totalReplacements += found.count
        results.push({
          file: file.path,
          replacements: found.count,
          status: outcome.staged ? 'pending' : 'accepted',
          ...(outcome.stagedEntryId ? { staged: { entryId: outcome.stagedEntryId, status: 'pending' } } : {}),
        })
      } catch (error) {
        skippedFiles.push({ file: file.path, reason: error instanceof Error ? error.message : String(error) })
      }
    }, deps.cwd)
  }
  return {
    isReplaceMode: true,
    matches,
    results,
    filesModified: results.length,
    totalReplacements,
    truncated: collected.truncated || matchesTruncated || processedFiles >= maxFiles && collected.files.length > processedFiles,
    caseSensitive: typeof args.caseSensitive === 'boolean' ? args.caseSensitive : true,
    multiRoot: false,
    ...(skippedFiles.length > 0 ? { skippedFiles } : {}),
  }
}

function renderJson<A, V>(_args: A, value: V): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function createSearchInFilesTool(fs: FileSystem) {
  return defineTool({
    name: 'search_in_files',
    description: 'Search or search-and-replace text across workspace files. Supports literal and regular-expression queries. Replace mode writes through GrayCode staged-diff review when enabled.',
    parameters: {
      mode: { type: 'string', enum: ['search', 'replace'], description: 'search (default) or replace.' },
      query: { type: 'string', required: true, description: 'Literal text or regular expression to find.' },
      path: { type: 'string', description: 'One workspace-relative file or directory. Defaults to the workspace root.' },
      pattern: { type: 'string', description: 'File glob relative to the search directory, e.g. **/*.ts.' },
      isRegex: { type: 'boolean', description: 'Treat query as a regular expression. Defaults to false.' },
      caseSensitive: { type: 'boolean', description: 'Search defaults false; replace defaults true.' },
      maxResults: { type: 'number', description: 'Maximum returned matches in search mode. Defaults to 100.' },
      replace: { type: 'string', description: 'Required replacement text in replace mode. Regex mode supports capture substitutions.' },
      maxFiles: { type: 'number', description: 'Maximum matched files processed in replace mode. Defaults to 50.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(raw, exec: ToolRunContext) {
      const args = raw as unknown as SearchArgs
      return executeSearchInFiles(depsFromExec(fs, exec, exec.signal), args) as never
    },
  })
}
