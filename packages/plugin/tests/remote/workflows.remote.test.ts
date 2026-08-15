/**
 * workflows Remote 端点契约测试（run 列表/详情、workspace 过滤、分页、路径白名单）。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createWorkflowsRemoteHandlers } from '../../src/workflows/adapters/dsh/remote.ts'
import { buildProgressDocument } from '../../src/workflows/domain/progress/documentLayout.ts'
import { GrayRemoteService } from '../../src/remote/service.ts'
import {
  GRAY_REMOTE_ERROR_CODES,
  type GrayRemoteResult,
  type GrayWorkflowRunDetail,
  type GrayWorkflowRunSummary,
} from '../../src/remote/types.ts'

const tempDirs: string[] = []

interface Env {
  workspace: string
  invoke: (ns: string, method: string, args?: Record<string, unknown>) => Promise<GrayRemoteResult<unknown>>
}

async function makeEnv(documentRoot = '.graycode'): Promise<Env> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-remote-wf-'))
  tempDirs.push(workspace)
  const ctx = new Context()
  const lfs = new LocalFileSystem(ctx, { cwd: workspace, diffBasisMaxBytes: 10 * 1024 * 1024 })
  const remote = new GrayRemoteService(ctx)
  remote.register(createWorkflowsRemoteHandlers({ fs: lfs, documentRoot }))
  return { workspace, invoke: (ns, method, args) => remote.invoke(ns, method, args) }
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function write(workspace: string, rel: string, content: string): Promise<void> {
  const full = path.join(workspace, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content, 'utf8')
}

/** 构造带元数据的合法 progress 文档（status=active / phase=implementation；updatedAt 略晚于当前）。 */
function progressDocument(): string {
  const { content } = buildProgressDocument(
    {
      projectId: 'proj-1',
      projectName: 'demo',
      status: 'active',
      phase: 'implementation',
      currentFocus: 'build remote api',
    },
    { generatedAt: new Date(Date.now() + 60_000).toISOString() }
  )
  return content
}

function expectFailure(result: GrayRemoteResult<unknown>, code: string): void {
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe(code)
}

describe('workflows/list', () => {
  it('不安全 documentRoot 不能枚举或读取 workspace 外文件', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-remote-wf-outside-'))
    tempDirs.push(outside)
    await write(outside, 'progress.md', progressDocument())
    const relativeEscape = `../${path.basename(outside)}`

    for (const documentRoot of [relativeEscape, outside]) {
      const env = await makeEnv(documentRoot)
      expectFailure(
        await env.invoke('workflows', 'list', { workspace: env.workspace }),
        GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
      )
      expectFailure(
        await env.invoke('workflows', 'get', {
          workspace: env.workspace,
          id: `${documentRoot.replace(/\\/g, '/')}/progress.md`,
        }),
        GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
      )
    }
  })

  it('列出 workspace 全部 run（progress 优先 + design/plans/review）', async () => {
    const env = await makeEnv()
    await write(env.workspace, '.graycode/progress.md', progressDocument())
    await write(env.workspace, '.graycode/design/idea.md', '# Idea')
    await write(env.workspace, '.graycode/plans/roadmap.md', '# Roadmap')
    await write(env.workspace, '.graycode/review/r1.md', '# Review')

    const result = await env.invoke('workflows', 'list', { workspace: env.workspace })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const value = result.value as { items: GrayWorkflowRunSummary[]; total: number; nextCursor?: string }
      expect(value.total).toBe(4)
      const kinds = value.items.map(item => item.kind)
      // 排序：updatedAt 降序（同级 mtime 接近）→ 种类固定序 progress 最前
      expect(kinds[0]).toBe('progress')
      expect(kinds).toEqual(expect.arrayContaining(['design', 'plan', 'review']))
      const progress = value.items.find(item => item.kind === 'progress')!
      expect(progress.id).toBe('.graycode/progress.md')
      expect(progress.status).toBe('active')
      expect(progress.phase).toBe('implementation')
      expect(progress.projectName).toBe('demo')
      expect(progress.workspace).toBe(env.workspace)
      expect(progress.sizeBytes).toBeGreaterThan(0)
    }
  })

  it('workspace 过滤：无文档 → 空列表', async () => {
    const env = await makeEnv()
    const result = await env.invoke('workflows', 'list', { workspace: env.workspace })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toMatchObject({ items: [], total: 0 })
    }
  })

  it('分页：limit + 游标', async () => {
    const env = await makeEnv()
    await write(env.workspace, '.graycode/progress.md', progressDocument())
    await write(env.workspace, '.graycode/design/a.md', '# A')
    await write(env.workspace, '.graycode/design/b.md', '# B')

    const page1 = await env.invoke('workflows', 'list', { workspace: env.workspace, limit: 2 })
    expect(page1.ok).toBe(true)
    let cursor: string | undefined
    if (page1.ok) {
      const value = page1.value as { items: GrayWorkflowRunSummary[]; total: number; nextCursor?: string }
      expect(value.items).toHaveLength(2)
      expect(value.total).toBe(3)
      expect(value.nextCursor).toBeDefined()
      cursor = value.nextCursor
    }
    const page2 = await env.invoke('workflows', 'list', { workspace: env.workspace, cursor, limit: 2 })
    if (page2.ok) {
      const value = page2.value as { items: GrayWorkflowRunSummary[]; total: number; nextCursor?: string }
      expect(value.items).toHaveLength(1)
      expect(value.nextCursor).toBeUndefined()
    }
  })

  it('workspace 非绝对路径 → GRAY_INVALID_INPUT', async () => {
    const env = await makeEnv()
    expectFailure(await env.invoke('workflows', 'list', { workspace: 'relative/path' }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })

  it('workspace 缺失或空白 → GRAY_INVALID_INPUT（不得回退宿主 cwd）', async () => {
    const env = await makeEnv()
    expectFailure(await env.invoke('workflows', 'list', {}), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
    expectFailure(await env.invoke('workflows', 'list', { workspace: '   ' }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })
})

describe('workflows/get', () => {
  it('读取 progress 详情（content + metadata）', async () => {
    const env = await makeEnv()
    await write(env.workspace, '.graycode/progress.md', progressDocument())
    const result = await env.invoke('workflows', 'get', { workspace: env.workspace, id: '.graycode/progress.md' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const detail = result.value as GrayWorkflowRunDetail
      expect(detail.kind).toBe('progress')
      expect(detail.content).toContain('demo')
      expect(detail.metadata).toMatchObject({ status: 'active', phase: 'implementation' })
      expect(detail.updatedAt).toBeGreaterThan(0)
    }
  })

  it('读取 design 详情（content 原文）', async () => {
    const env = await makeEnv()
    await write(env.workspace, '.graycode/design/a.md', '# Design A\n\nbody')
    const result = await env.invoke('workflows', 'get', { workspace: env.workspace, id: '.graycode/design/a.md' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const detail = result.value as GrayWorkflowRunDetail
      expect(detail.kind).toBe('design')
      expect(detail.content).toContain('# Design A')
    }
  })

  it('白名单外路径 → GRAY_INVALID_INPUT；不存在 → GRAY_NOT_FOUND', async () => {
    const env = await makeEnv()
    expectFailure(
      await env.invoke('workflows', 'get', { workspace: env.workspace, id: '.graycode/../secret.md' }),
      GRAY_REMOTE_ERROR_CODES.INVALID_INPUT
    )
    expectFailure(
      await env.invoke('workflows', 'get', { workspace: env.workspace, id: 'other/file.md' }),
      GRAY_REMOTE_ERROR_CODES.INVALID_INPUT
    )
    expectFailure(
      await env.invoke('workflows', 'get', { workspace: env.workspace, id: '.graycode/design/missing.md' }),
      GRAY_REMOTE_ERROR_CODES.NOT_FOUND
    )
  })

  it('缺 id → GRAY_INVALID_INPUT', async () => {
    const env = await makeEnv()
    expectFailure(await env.invoke('workflows', 'get', { workspace: env.workspace }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })

  it('workspace 缺失或空白 → GRAY_INVALID_INPUT（不得回退宿主 cwd）', async () => {
    const env = await makeEnv()
    expectFailure(
      await env.invoke('workflows', 'get', { id: '.graycode/progress.md' }),
      GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
    )
    expectFailure(
      await env.invoke('workflows', 'get', { workspace: '', id: '.graycode/progress.md' }),
      GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
    )
  })
})
