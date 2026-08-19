import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createInsertCodeTool, insertAtLine, splitInsertContent, type InsertCodeResult } from '../../src/file/insert.ts'
import { createListFilesTool, type ListFilesResult } from '../../src/file/list.ts'
import { createSearchInFilesTool, globPatternToRegex } from '../../src/file/search.ts'
import { setStagedWriteHook, type StageWriteInput } from '../../src/workflows/stagedWriteHook.ts'

let sandboxRoot: string
let workspace: string
let outsideFile: string
let fsService: LocalFileSystem

function exec(): ToolRunContext {
  return {
    agent: { session: { id: 'root', header: { cwd: workspace } } },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
}

beforeAll(async () => {
  sandboxRoot = await mkdtemp(path.join(os.tmpdir(), 'graycode-file-compat-'))
  workspace = path.join(sandboxRoot, 'workspace')
  outsideFile = path.join(sandboxRoot, 'outside.txt')
  await mkdir(workspace, { recursive: true })
  fsService = new LocalFileSystem(new Context(), { cwd: workspace, diffBasisMaxBytes: 10 * 1024 * 1024 })
})

afterAll(async () => {
  await rm(sandboxRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  setStagedWriteHook(null)
  await rm(path.join(workspace, 'src'), { recursive: true, force: true })
  await rm(path.join(workspace, 'node_modules'), { recursive: true, force: true })
  await mkdir(path.join(workspace, 'src', 'nested'), { recursive: true })
  await mkdir(path.join(workspace, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(path.join(workspace, 'src', 'a.ts'), 'const alpha = 1\nconst beta = alpha\n', 'utf8')
  await writeFile(path.join(workspace, 'src', 'nested', 'b.ts'), 'export const Alpha = 2\n', 'utf8')
  await writeFile(path.join(workspace, 'src', 'note.txt'), 'alpha $& marker\n', 'utf8')
  await writeFile(path.join(workspace, 'node_modules', 'pkg', 'ignored.ts'), 'alpha\n', 'utf8')
  await writeFile(outsideFile, 'outside-original\n', 'utf8')
})

afterEach(() => {
  setStagedWriteHook(null)
})

describe('insert_code compatibility tool', () => {
  it('keeps trailing newline out of the inserted-line count', () => {
    expect(splitInsertContent('x\ny\n')).toEqual(['x', 'y'])
    expect(insertAtLine(['a', 'b'], 2, 'x\ny\n')).toBe('a\nx\ny\nb')
  })

  it('inserts batches and rejects workspace escapes', async () => {
    const tool = createInsertCodeTool(fsService)
    const result = await tool.execute({
      files: [
        { path: 'src/a.ts', line: 2, content: 'const inserted = true\n' },
        { path: '../outside.txt', line: 1, content: 'escaped\n' },
      ],
    }, exec()) as never as InsertCodeResult

    expect(result).toMatchObject({ successCount: 1, failCount: 1, totalCount: 2 })
    expect(result.results[0]).toMatchObject({ success: true, insertedLines: 1 })
    expect(result.results[1]).toMatchObject({ success: false, error: 'Path must stay inside the active workspace.' })
    expect(await readFile(path.join(workspace, 'src', 'a.ts'), 'utf8')).toContain('const inserted = true\nconst beta')
    expect(await readFile(outsideFile, 'utf8')).toBe('outside-original\n')
  })

  it('routes insert and search-replace writes through staged diff when enabled', async () => {
    const staged: StageWriteInput[] = []
    setStagedWriteHook({
      enabled: true,
      async stageWrite(input) {
        staged.push(input)
        return { entryId: `stage-${staged.length}` }
      },
    })

    const inserted = await createInsertCodeTool(fsService).execute({
      files: [{ path: 'src/a.ts', line: 1, content: '// staged\n' }],
    }, exec()) as never as InsertCodeResult
    expect(inserted.results[0]?.staged).toEqual({ entryId: 'stage-1', status: 'pending' })

    const replaced = await createSearchInFilesTool(fsService).execute({
      mode: 'replace', query: 'alpha', replace: 'gamma', path: 'src/a.ts',
    }, exec()) as never as { results: Array<{ staged: { entryId: string; status: string } }> }
    expect(replaced.results[0]?.staged).toEqual({ entryId: 'stage-2', status: 'pending' })
    expect(staged.map(item => item.relPath)).toEqual(['src/a.ts', 'src/a.ts'])
    expect(await readFile(path.join(workspace, 'src', 'a.ts'), 'utf8')).toBe('const alpha = 1\nconst beta = alpha\n')
  })
})

describe('list_files compatibility tool', () => {
  it('lists batches with text line counts and bounded recursive traversal', async () => {
    const tool = createListFilesTool(fsService)
    const direct = await tool.execute({ paths: ['src'], recursive: false }, exec()) as never as ListFilesResult
    expect(direct.totalPaths).toBe(1)
    expect(direct.results[0]?.entries).toEqual(expect.arrayContaining([
      { name: 'nested/', type: 'directory' },
      { name: 'a.ts', type: 'file', lineCount: 3 },
    ]))

    const recursive = await tool.execute({ paths: ['.'], recursive: true }, exec()) as never as ListFilesResult
    expect(recursive.results[0]?.entries.some(entry => entry.name === 'src/nested/b.ts')).toBe(true)
    expect(recursive.results[0]?.entries.some(entry => entry.name.includes('node_modules'))).toBe(false)
  })

  it('does not enumerate paths outside the active workspace', async () => {
    const tool = createListFilesTool(fsService)
    const result = await tool.execute({ paths: ['..'] }, exec()) as never as ListFilesResult
    expect(result.results[0]).toMatchObject({ success: false, error: 'Path must stay inside the active workspace.' })
  })
})

describe('search_in_files compatibility tool', () => {
  it('matches common glob shapes', () => {
    expect(globPatternToRegex('**/*.ts').test('a.ts')).toBe(true)
    expect(globPatternToRegex('**/*.ts').test('nested/a.ts')).toBe(true)
    expect(globPatternToRegex('*.ts').test('nested/a.ts')).toBe(false)
  })

  it('searches case-insensitively by default and reports locations', async () => {
    const tool = createSearchInFilesTool(fsService)
    const result = await tool.execute({ query: 'alpha', path: 'src', pattern: '**/*.ts' }, exec()) as never as {
      results: Array<{ file: string; line: number; column: number }>
      count: number
      truncated: boolean
    }
    expect(result.count).toBe(3)
    expect(result.truncated).toBe(false)
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'src/a.ts', line: 1, column: 7 }),
      expect.objectContaining({ file: 'src/nested/b.ts', line: 1 }),
    ]))
  })

  it('performs literal replacement without interpreting dollar tokens', async () => {
    const tool = createSearchInFilesTool(fsService)
    const result = await tool.execute({
      mode: 'replace',
      query: 'alpha $& marker',
      replace: 'kept $& literally',
      path: 'src/note.txt',
    }, exec()) as never as { filesModified: number; totalReplacements: number }
    expect(result).toMatchObject({ filesModified: 1, totalReplacements: 1 })
    expect(await readFile(path.join(workspace, 'src', 'note.txt'), 'utf8')).toBe('kept $& literally\n')
  })

  it('supports regex capture replacement and rejects dangerous expressions', async () => {
    const tool = createSearchInFilesTool(fsService)
    const replaced = await tool.execute({
      mode: 'replace',
      query: 'const (alpha) = (\\d+)',
      isRegex: true,
      replace: 'let $1 = $2',
      path: 'src/a.ts',
    }, exec()) as never as { filesModified: number }
    expect(replaced.filesModified).toBe(1)
    expect(await readFile(path.join(workspace, 'src', 'a.ts'), 'utf8')).toContain('let alpha = 1')

    await expect(tool.execute({ query: '(a+)+', isRegex: true, path: 'src' }, exec()))
      .rejects.toThrow(/Dangerous regular expression/)
  })

  it('rejects search roots outside the active workspace', async () => {
    const tool = createSearchInFilesTool(fsService)
    await expect(tool.execute({ query: 'outside', path: '..' }, exec()))
      .rejects.toThrow('Path must stay inside the active workspace.')
    expect(await readFile(outsideFile, 'utf8')).toBe('outside-original\n')
  })
})
