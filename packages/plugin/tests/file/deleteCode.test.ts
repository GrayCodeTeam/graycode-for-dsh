/**
 * delete_code 工具测试（file 域，C7）：
 * - 纯函数：deleteLineRange / validateDeleteEntry（行号语义与老版逐字对齐）；
 * - 工具闭环：真实临时目录 + LocalFileSystem（@deepseek-ai/dsh-fs-local），
 *   直接调用 createDeleteCodeTool().execute（不经 ctx.tools 注册管线）；
 * - 覆盖：批量多文件、行号校验（越界/倒置/非正整数）、文件不存在、
 *   CRLF 归一化、逐文件失败不阻断、results 汇总计数。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  createDeleteCodeTool,
  deleteLineRange,
  validateDeleteEntry,
  type DeleteCodeFileResult,
  type DeleteCodeToolResultData,
} from '../../src/file/tools.ts'
import type { ToolDeps } from '../../src/workflows/workspace.ts'

let tmpDir: string
let deps: ToolDeps

function makeExec(cwd: string): ToolRunContext {
  return {
    agent: { session: { id: 'root-session', header: { cwd } } },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
}

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'graycode-delete-code-'))
  const ctx = new Context()
  const fs = new LocalFileSystem(ctx, { cwd: tmpDir, diffBasisMaxBytes: 10 * 1024 * 1024 })
  deps = { fs, cwd: tmpDir, sessionId: 'test-session' }
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(path.join(tmpDir, 'src'), { recursive: true, force: true })
  await rm(path.join(tmpDir, 'other.txt'), { force: true })
  await writeFile(path.join(tmpDir, 'src'), 'line1\nline2\nline3\nline4\n')
  await writeFile(path.join(tmpDir, 'other.txt'), 'a\nb\nc\n')
})

async function runTool(args: unknown): Promise<DeleteCodeToolResultData> {
  const tool = createDeleteCodeTool(deps.fs)
  return (await tool.execute(args as never, makeExec(tmpDir))) as never as DeleteCodeToolResultData
}

async function readWs(relPath: string): Promise<string> {
  return readFile(path.join(tmpDir, relPath), 'utf8')
}

describe('deleteLineRange（纯函数）', () => {
  it('删除中间行：两端包含', () => {
    const lines = ['a', 'b', 'c', 'd']
    expect(deleteLineRange(lines, 2, 3)).toBe('a\nd')
  })

  it('删除首行与末行', () => {
    const lines = ['a', 'b', 'c']
    expect(deleteLineRange(lines, 1, 1)).toBe('b\nc')
    expect(deleteLineRange(lines, 3, 3)).toBe('a\nb')
  })

  it('删除整文件（含尾部空行元素的行号语义：a\\nb\\n 有 3 行）', () => {
    const lines = ['a', 'b', '']
    expect(deleteLineRange(lines, 1, 3)).toBe('')
  })
})

describe('validateDeleteEntry（纯函数）', () => {
  it('合法条目通过', () => {
    const result = validateDeleteEntry({ path: 'src/a.ts', start_line: 1, end_line: 5 })
    expect(result).toEqual({ ok: true, entry: { path: 'src/a.ts', start_line: 1, end_line: 5 } })
  })

  it('path 缺失 / 非字符串', () => {
    expect(validateDeleteEntry({ start_line: 1, end_line: 2 })).toEqual({
      ok: false,
      path: '',
      error: 'path is required',
    })
    expect(validateDeleteEntry({ path: 42, start_line: 1, end_line: 2 })).toEqual({
      ok: false,
      path: '',
      error: 'path is required',
    })
  })

  it('行号非正整数（0 / 负数 / 小数 / 非数字）', () => {
    expect(validateDeleteEntry({ path: 'p', start_line: 0, end_line: 1 })).toMatchObject({
      ok: false,
      error: 'start_line must be a positive integer (1-based)',
    })
    expect(validateDeleteEntry({ path: 'p', start_line: 1, end_line: 1.5 })).toMatchObject({
      ok: false,
      error: 'end_line must be a positive integer (1-based)',
    })
    expect(validateDeleteEntry({ path: 'p', start_line: -1, end_line: 2 })).toMatchObject({
      ok: false,
    })
    expect(validateDeleteEntry({ path: 'p', start_line: '1', end_line: 2 })).toMatchObject({
      ok: false,
    })
  })

  it('start_line > end_line 拒绝', () => {
    expect(validateDeleteEntry({ path: 'p', start_line: 3, end_line: 2 })).toMatchObject({
      ok: false,
      error: 'start_line (3) must be <= end_line (2)',
    })
  })
})

describe('delete_code 工具闭环（真实 fs）', () => {
  it('files 缺失 / 空数组抛参数错误', async () => {
    // files 声明为 required: true：缺失时由 DSH schema 层在 execute 前拒绝
    await expect(runTool({})).rejects.toThrow(/files/)
    // 空数组通过 schema（数组本身存在），由 execute 内校验拒绝
    await expect(runTool({ files: [] })).rejects.toThrow('files is required and must be a non-empty array')
  })

  it('删除中间行范围并返回计数', async () => {
    const result = await runTool({ files: [{ path: 'src', start_line: 2, end_line: 3 }] })
    expect(result.successCount).toBe(1)
    expect(result.failCount).toBe(0)
    expect(result.totalCount).toBe(1)
    expect(result.results[0]).toMatchObject({
      path: 'src',
      success: true,
      start_line: 2,
      end_line: 3,
      deletedLines: 2,
      status: 'accepted',
    })
    expect(await readWs('src')).toBe('line1\nline4\n')
  })

  it('批量多文件：全部成功', async () => {
    const result = await runTool({
      files: [
        { path: 'src', start_line: 1, end_line: 1 },
        { path: 'other.txt', start_line: 2, end_line: 2 },
      ],
    })
    expect(result.successCount).toBe(2)
    expect(result.failCount).toBe(0)
    expect(await readWs('src')).toBe('line2\nline3\nline4\n')
    expect(await readWs('other.txt')).toBe('a\nc\n')
  })

  it('逐文件失败不阻断：部分成功', async () => {
    const result = await runTool({
      files: [
        { path: 'missing.txt', start_line: 1, end_line: 1 },
        { path: 'src', start_line: 1, end_line: 1 },
      ],
    })
    expect(result.successCount).toBe(1)
    expect(result.failCount).toBe(1)
    expect(result.results[0]).toMatchObject({ path: 'missing.txt', success: false })
    expect(result.results[0]!.error).toContain('File not found')
    expect(await readWs('src')).toBe('line2\nline3\nline4\n')
  })

  it('行号越界返回 per-file 错误', async () => {
    const result = await runTool({ files: [{ path: 'src', start_line: 10, end_line: 10 }] })
    expect(result.results[0]!.success).toBe(false)
    expect(result.results[0]!.error).toBe('start_line 10 is out of range. File has 5 lines.')
  })

  it('end_line 越界返回 per-file 错误', async () => {
    const result = await runTool({ files: [{ path: 'src', start_line: 1, end_line: 99 }] })
    expect(result.results[0]!.success).toBe(false)
    expect(result.results[0]!.error).toBe('end_line 99 is out of range. File has 5 lines.')
  })

  it('CRLF 输入被归一化（写回 LF，与老版 normalizeLineEndingsToLF 一致）', async () => {
    await writeFile(path.join(tmpDir, 'crlf.txt'), 'a\r\nb\r\nc\r\n')
    const result = await runTool({ files: [{ path: 'crlf.txt', start_line: 2, end_line: 2 }] })
    expect(result.results[0]!.success).toBe(true)
    const onDisk = await readWs('crlf.txt')
    expect(onDisk).toBe('a\nc\n')
    expect(onDisk).not.toContain('\r')
  })

  it('删除到仅剩空行时仍成功（文件可被删空）', async () => {
    await writeFile(path.join(tmpDir, 'single.txt'), 'only\n')
    const result = await runTool({ files: [{ path: 'single.txt', start_line: 1, end_line: 1 }] })
    expect(result.results[0]).toMatchObject({
      success: true,
      deletedLines: 1,
      status: 'accepted',
    })
    expect(await readWs('single.txt')).toBe('')
  })

  it('参数级错误（files 项缺行号）由 DSH schema 层拒绝（items required）', async () => {
    // items 内 path/start_line/end_line 均 required：缺字段在 execute 前被拒绝
    await expect(runTool({ files: [{ path: 'src', start_line: 1 }] })).rejects.toThrow(/end_line/)
    // 通过 schema 的畸形条目（start_line 缺失同被拒）之外，运行时校验由
    // validateDeleteEntry 兜底（executeDeleteCode 纯函数层覆盖，见纯函数用例）
  })

  it('超过 5MB 大小护栏的文件被拒绝（不整读不落盘）', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024 + 1)
    await writeFile(path.join(tmpDir, 'big.txt'), big)
    const result = await runTool({ files: [{ path: 'big.txt', start_line: 1, end_line: 1 }] })
    expect(result.successCount).toBe(0)
    expect(result.failCount).toBe(1)
    expect(result.results[0]!.success).toBe(false)
    expect(result.results[0]!.error).toContain('File too large to edit')
    expect(result.results[0]!.error).toContain('5242880')
    // 文件保持原样（未发生任何写入）
    expect(await readWs('big.txt')).toBe(big)
    // 恰好等于上限的文件仍可处理（边界）
    await writeFile(path.join(tmpDir, 'at-limit.txt'), 'x'.repeat(5 * 1024 * 1024))
    const ok = await runTool({ files: [{ path: 'at-limit.txt', start_line: 1, end_line: 1 }] })
    expect(ok.results[0]!.success).toBe(true)
  })
})
