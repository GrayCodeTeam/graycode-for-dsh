/**
 * branches Remote 端点测试（C5）：branches/list（workspace 过滤 + 游标分页）
 * 与 branches/rename（label 校验 + expectedRevision CAS + 领域错误映射）。
 * 服务由假适配器 + 真实临时 dataRoot 支撑；端点经 GrayRemoteService.invoke
 * 调用（信封 + 稳定码转换全链路）。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GrayRemoteService } from '../../src/remote/service.ts'
import { GRAY_REMOTE_ERROR_CODES } from '../../src/remote/types.ts'
import { BranchCoordinatorService, createBranchWorkspaceId } from '../../src/branches/service.ts'
import type { BranchSessionAdapter } from '../../src/branches/service.ts'
import { BranchError, BranchErrorCode } from '../../src/branches/domain/types.ts'
import { createBranchesRemoteHandlers } from '../../src/branches/adapters/dsh/remote.ts'
import type { BranchEventView } from '../../src/branches/domain/turnLocator.ts'

const ROOT_SESSION = 'root-session'

function ev(type: string, seq: number, data: Record<string, unknown> = {}): BranchEventView {
  return { type, seq, data } as unknown as BranchEventView
}

class FakeBranchSessionAdapter implements BranchSessionAdapter {
  readonly sessions = new Map<string, { events: BranchEventView[]; cwd?: string; agentPreset?: string }>()

  addSession(sessionId: string, events: BranchEventView[]): void {
    this.sessions.set(sessionId, { events })
  }

  eventsOf(sessionId: string): readonly BranchEventView[] {
    return this.sessions.get(sessionId)?.events ?? []
  }

  cwdOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd
  }

  agentPresetOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.agentPreset
  }

  async forkChild(input: {
    parent: { id: string; events: readonly BranchEventView[] }
    boundary: number | undefined
    childSessionId: string
    cwd?: string
    agentPreset?: string
  }): Promise<{ sessionId: string; agentAttached: boolean }> {
    const seed =
      input.boundary === undefined
        ? [...input.parent.events]
        : input.parent.events.filter(event => event.seq <= input.boundary!)
    this.sessions.set(input.childSessionId, { events: seed, cwd: input.cwd, agentPreset: input.agentPreset })
    return { sessionId: input.childSessionId, agentAttached: false }
  }

  async sendUserMessage(): Promise<boolean> {
    return true
  }
}

interface Env {
  tmpDir: string
  dataRoot: string
  service: BranchCoordinatorService
  remote: GrayRemoteService
}

let env: Env

beforeEach(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-branch-remote-ws-'))
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-branch-remote-data-'))
  const adapter = new FakeBranchSessionAdapter()
  adapter.addSession(ROOT_SESSION, [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, { source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] }),
    ev('turn/end', 2, { turn: 1 }),
  ])
  const service = new BranchCoordinatorService({ dataRoot }, adapter)
  await service.initialize()
  await service.ensureGroup({
    workspaceId: createBranchWorkspaceId(tmpDir),
    rootSessionId: ROOT_SESSION,
    label: 'main',
  })
  const ctx = new Context()
  const remote = new GrayRemoteService(ctx, {})
  remote.register(createBranchesRemoteHandlers(service))
  env = { tmpDir, dataRoot, service, remote }
})

afterEach(async () => {
  env.service.dispose()
  await fs.rm(env.tmpDir, { recursive: true, force: true })
  await fs.rm(env.dataRoot, { recursive: true, force: true })
})

async function invoke(method: string, args: Record<string, unknown>): Promise<
  { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }
> {
  return env.remote.invoke('branches', method, args) as never
}

describe('branches/list', () => {
  it('列出 workspace 下的分支组（含候选与 revision）', async () => {
    const result = await invoke('list', { workspace: env.tmpDir })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const value = result.value as { items: Array<{ groupId: string; candidates: unknown[]; revision: number }>; total: number }
      expect(value.total).toBe(1)
      expect(value.items[0]!.groupId).toBeTruthy()
      expect(value.items[0]!.revision).toBe(1)
      expect(value.items[0]!.candidates).toHaveLength(1)
    }
  })

  it('workspace 过滤：其它 workspace 的分支组不出现', async () => {
    const otherWs = path.join(env.tmpDir, '..', 'other-ws')
    const result = await invoke('list', { workspace: otherWs })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.value as { total: number }).total).toBe(0)
    }
  })

  it('游标分页：limit 生效并返回 nextCursor', async () => {
    // 建第二个组制造两页数据
    await env.service.ensureGroup({
      workspaceId: createBranchWorkspaceId(env.tmpDir),
      rootSessionId: `${ROOT_SESSION}-b`,
    })
    const first = await invoke('list', { workspace: env.tmpDir, limit: 1 })
    expect(first.ok).toBe(true)
    if (first.ok) {
      const value = first.value as { items: unknown[]; total: number; nextCursor?: string }
      expect(value.items).toHaveLength(1)
      expect(value.total).toBe(2)
      expect(value.nextCursor).toBeTruthy()
      const second = await invoke('list', { workspace: env.tmpDir, cursor: value.nextCursor, limit: 1 })
      expect(second.ok).toBe(true)
      if (second.ok) {
        const value2 = second.value as { items: unknown[]; nextCursor?: string }
        expect(value2.items).toHaveLength(1)
        expect(value2.nextCursor).toBeUndefined()
      }
    }
  })
})

describe('branches/rename', () => {
  it('重命名候选并返回新 revision', async () => {
    const result = await invoke('rename', { sessionId: ROOT_SESSION, label: '重命名' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const value = result.value as { groupId: string; sessionId: string; revision: number; activeSessionId: string }
      expect(value.sessionId).toBe(ROOT_SESSION)
      expect(value.revision).toBe(2)
    }
    const listed = await invoke('list', { workspace: env.tmpDir })
    if (listed.ok) {
      const items = (listed.value as { items: Array<{ candidates: Array<{ label?: string }> }> }).items
      expect(items[0]!.candidates[0]!.label).toBe('重命名')
    }
  })

  it('缺 sessionId / label → GRAY_INVALID_INPUT', async () => {
    const r1 = await invoke('rename', { label: 'x' })
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error.code).toBe(GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)

    const r2 = await invoke('rename', { sessionId: ROOT_SESSION })
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error.code).toBe(GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })

  it('label 超过 200 字符 → GRAY_INVALID_INPUT', async () => {
    const result = await invoke('rename', { sessionId: ROOT_SESSION, label: 'x'.repeat(201) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })

  it('expectedRevision 冲突 → GRAY_CONFLICT', async () => {
    const result = await invoke('rename', { sessionId: ROOT_SESSION, label: 'x', expectedRevision: 99 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(GRAY_REMOTE_ERROR_CODES.CONFLICT)
      expect(result.error.details.causeCode).toBe(BranchErrorCode.REVISION_CONFLICT)
    }
  })

  it('会话不在任何组 → GRAY_NOT_FOUND', async () => {
    const result = await invoke('rename', { sessionId: 'foreign', label: 'x' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(GRAY_REMOTE_ERROR_CODES.NOT_FOUND)
  })

  it('领域层错误（INVALID_INPUT）映射为稳定码且 causeCode 保留', async () => {
    // 直接让 handler 抛 BranchError（模拟领域层校验路径）
    env.remote.register({
      'branches/probe': () => {
        throw new BranchError('candidate label must not be empty', BranchErrorCode.INVALID_INPUT)
      },
    })
    const result = await env.remote.invoke('branches', 'probe', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
      expect(result.error.details.causeCode).toBe(BranchErrorCode.INVALID_INPUT)
    }
  })
})
