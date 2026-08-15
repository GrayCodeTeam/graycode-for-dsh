/**
 * stagedDiff Remote 端点契约测试（审阅批列表、preview、accept/reject CAS 冲突）。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { StagedDiffService, createStagedWorkspaceId } from '../../src/stagedDiff/application/service.ts'
import { EntrySidecarStore } from '../../src/stagedDiff/adapters/storage.ts'
import type { ApplyFilePort } from '../../src/stagedDiff/application/ports.ts'
import { createStagedDiffRemoteHandlers } from '../../src/stagedDiff/adapters/dsh/remote.ts'
import { GrayRemoteService } from '../../src/remote/service.ts'
import {
  GRAY_REMOTE_ERROR_CODES,
  type GrayRemoteResult,
  type GrayStagedDiffListResult,
} from '../../src/remote/types.ts'

const tempDirs: string[] = []

function makeApplyPort(root: string): ApplyFilePort {
  return {
    async applyFile(destination, content) {
      // destination 由 service 以 workspaceRoot 拼出（可能为绝对路径）：直接使用
      const full = path.isAbsolute(destination) ? destination : path.join(root, destination)
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, content, 'utf8')
      return { before: null }
    },
    async readFile(destination) {
      const full = path.isAbsolute(destination) ? destination : path.join(root, destination)
      try {
        return await fs.readFile(full, 'utf8')
      } catch {
        return null
      }
    },
  }
}

interface Env {
  dataRoot: string
  workspace: string
  service: StagedDiffService
  invoke: (ns: string, method: string, args?: Record<string, unknown>) => Promise<GrayRemoteResult<unknown>>
}

async function makeEnv(): Promise<Env> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-remote-sd-'))
  tempDirs.push(dataRoot)
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-remote-sd-ws-'))
  tempDirs.push(workspace)
  const service = new StagedDiffService(new EntrySidecarStore({ dataRoot }), makeApplyPort(workspace))
  await service.initialize()
  const remote = new GrayRemoteService(new Context())
  remote.register(createStagedDiffRemoteHandlers(service))
  return { dataRoot, workspace, service, invoke: (ns, method, args) => remote.invoke(ns, method, args) }
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

function expectFailure(result: GrayRemoteResult<unknown>, code: string): void {
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe(code)
}

async function stage(
  env: Env,
  overrides: Partial<{ path: string; after: string; before: string | null; entryId: string; workspaceId: string }> = {}
): Promise<string> {
  const entry = await env.service.createEntry({
    workspaceId: overrides.workspaceId ?? createStagedWorkspaceId(env.workspace),
    sessionId: 's1',
    path: overrides.path ?? 'src/a.ts',
    before: overrides.before === undefined ? null : overrides.before,
    after: overrides.after ?? 'export const a = 1',
    entryId: overrides.entryId,
  })
  return entry.id
}

describe('stagedDiff/list / preview', () => {
  it('列出条目并支持 status 过滤与分页', async () => {
    const env = await makeEnv()
    const id1 = await stage(env, { entryId: 'e1', path: 'a.ts' })
    const id2 = await stage(env, { entryId: 'e2', path: 'b.ts' })

    const all = await env.invoke('stagedDiff', 'list', {})
    expect(all.ok).toBe(true)
    if (all.ok) {
      const value = all.value as GrayStagedDiffListResult
      expect(value.total).toBe(2)
      expect(value.items.map(e => e.id).sort()).toEqual([id1, id2].sort())
    }

    const pending = await env.invoke('stagedDiff', 'list', { statuses: ['pending'] })
    if (pending.ok) {
      expect((pending.value as GrayStagedDiffListResult).total).toBe(2)
    }
    const accepted = await env.invoke('stagedDiff', 'list', { statuses: ['accepted'] })
    if (accepted.ok) {
      expect((accepted.value as GrayStagedDiffListResult).total).toBe(0)
    }

    const page = await env.invoke('stagedDiff', 'list', { limit: 1 })
    if (page.ok) {
      const value = page.value as GrayStagedDiffListResult
      expect(value.items).toHaveLength(1)
      expect(value.nextCursor).toBeDefined()
    }
  })

  it('workspaceId/sessionId 过滤', async () => {
    const env = await makeEnv()
    await stage(env, { entryId: 'e1' })
    const other = await env.service.createEntry({
      workspaceId: 'ws-other',
      sessionId: 's9',
      path: 'c.ts',
      after: 'x',
    })
    const filtered = await env.invoke('stagedDiff', 'list', {
      workspaceId: createStagedWorkspaceId(env.workspace),
      sessionId: 's1',
    })
    if (filtered.ok) {
      const value = filtered.value as GrayStagedDiffListResult
      expect(value.items.map(e => e.id)).not.toContain(other.id)
    }
  })

  it('preview 返回完整条目；未知 id → GRAY_NOT_FOUND', async () => {
    const env = await makeEnv()
    const id = await stage(env, { entryId: 'e1', path: 'a.ts', after: 'new-content' })
    const result = await env.invoke('stagedDiff', 'preview', { entryId: id })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toMatchObject({ id, path: 'a.ts', after: 'new-content', status: 'pending', revision: 1 })
    }
    expectFailure(await env.invoke('stagedDiff', 'preview', { entryId: 'nope' }), GRAY_REMOTE_ERROR_CODES.NOT_FOUND)
  })

  it('limit 非法 → GRAY_INVALID_INPUT', async () => {
    const env = await makeEnv()
    expectFailure(await env.invoke('stagedDiff', 'list', { limit: 'x' }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })
})

describe('stagedDiff/accept / reject', () => {
  it('A 条目不能用 B workspace 接受或拒绝，B 不落盘且 A 状态不变', async () => {
    const env = await makeEnv()
    const otherWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-remote-sd-other-ws-'))
    tempDirs.push(otherWorkspace)
    const acceptId = await stage(env, { entryId: 'wrong-workspace-accept', path: 'accept.txt' })
    const rejectId = await stage(env, {
      entryId: 'wrong-workspace-reject',
      path: 'reject.txt',
      before: 'original',
      after: 'replacement',
    })

    expectFailure(
      await env.invoke('stagedDiff', 'accept', {
        entryId: acceptId,
        expectedRevision: 1,
        workspace: otherWorkspace,
      }),
      GRAY_REMOTE_ERROR_CODES.CONFLICT,
    )
    expectFailure(
      await env.invoke('stagedDiff', 'reject', {
        entryId: rejectId,
        expectedRevision: 1,
        workspace: otherWorkspace,
      }),
      GRAY_REMOTE_ERROR_CODES.CONFLICT,
    )

    await expect(fs.access(path.join(otherWorkspace, 'accept.txt'))).rejects.toThrow()
    expect(env.service.previewEntry(acceptId)).toMatchObject({ status: 'pending', revision: 1 })
    expect(env.service.previewEntry(rejectId)).toMatchObject({ status: 'pending', revision: 1 })
  })

  it('workspace 缺失或空白 → GRAY_INVALID_INPUT（不得回退宿主 cwd）', async () => {
    const env = await makeEnv()
    const acceptId = await stage(env, { entryId: 'missing-workspace-accept' })
    const rejectId = await stage(env, { entryId: 'missing-workspace-reject', path: 'other.ts' })

    expectFailure(
      await env.invoke('stagedDiff', 'accept', { entryId: acceptId, expectedRevision: 1 }),
      GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
    )
    expectFailure(
      await env.invoke('stagedDiff', 'reject', { entryId: rejectId, expectedRevision: 1, workspace: '  ' }),
      GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
    )
  })

  it('accept 落盘并返回 done 条目（ADR §4：accepted → 落盘 → done）', async () => {
    const env = await makeEnv()
    const id = await stage(env, { entryId: 'e1', path: 'out.txt', after: 'written-content' })
    const result = await env.invoke('stagedDiff', 'accept', { entryId: id, expectedRevision: 1, workspace: env.workspace })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // 领域契约：写盘成功后才置 done（见 domain/service.ts acceptEntry 与 service.test.ts）；
      // adapter 原样透传领域条目，wire 类型即 StagedEntry。
      expect(result.value).toMatchObject({ id, status: 'done' })
    }
    const content = await fs.readFile(path.join(env.workspace, 'out.txt'), 'utf8')
    expect(content).toBe('written-content')
  })

  it('accept 陈旧 revision → GRAY_CONFLICT（CAS）', async () => {
    const env = await makeEnv()
    const id = await stage(env, { entryId: 'e1', path: 'out.txt' })
    // 先 reject 一次使 revision 递增
    await env.invoke('stagedDiff', 'reject', { entryId: id, expectedRevision: 1, workspace: env.workspace })
    expectFailure(
      await env.invoke('stagedDiff', 'accept', { entryId: id, expectedRevision: 1, workspace: env.workspace }),
      GRAY_REMOTE_ERROR_CODES.CONFLICT
    )
  })

  it('reject 返回 rejected 条目；目标已被外部修改 → GRAY_CONFLICT', async () => {
    const env = await makeEnv()
    const id = await stage(env, { entryId: 'e1', path: 'out.txt', before: 'original', after: 'proposed' })
    await fs.writeFile(path.join(env.workspace, 'out.txt'), 'original', 'utf8')

    // 外部修改目标（reject 冲突检测：before 与当前内容不一致）
    await fs.writeFile(path.join(env.workspace, 'out.txt'), 'external-edit', 'utf8')
    expectFailure(
      await env.invoke('stagedDiff', 'reject', { entryId: id, expectedRevision: 1, workspace: env.workspace }),
      GRAY_REMOTE_ERROR_CODES.CONFLICT
    )

    // 目标恢复一致后 reject 成功
    await fs.writeFile(path.join(env.workspace, 'out.txt'), 'original', 'utf8')
    const result = await env.invoke('stagedDiff', 'reject', { entryId: id, expectedRevision: 1, workspace: env.workspace })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toMatchObject({ id, status: 'rejected' })
    }
  })

  it('未知 entryId → GRAY_NOT_FOUND', async () => {
    const env = await makeEnv()
    expectFailure(
      await env.invoke('stagedDiff', 'accept', { entryId: 'missing', expectedRevision: 1, workspace: env.workspace }),
      GRAY_REMOTE_ERROR_CODES.NOT_FOUND
    )
    expectFailure(
      await env.invoke('stagedDiff', 'reject', { entryId: 'missing', expectedRevision: 1, workspace: env.workspace }),
      GRAY_REMOTE_ERROR_CODES.NOT_FOUND
    )
  })
})
