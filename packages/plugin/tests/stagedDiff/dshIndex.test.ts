/**
 * staged-diff 子插件 cordis service 提供面测试（ADR-0003 §6 后续动作 2 接线）
 *
 * 验证 adapters/dsh/index.ts 的跨域共享契约：
 * - apply 时经 ctx.provide('graycode.stagedDiff', handle) 提供 StagedDiffServiceHandle；
 * - handle.enabled 与 Config.enabled 一致；workspaceIdOf 与 staged_diff_* 工具同口径；
 * - service 初始化（restoreFromSidecar）完成后可用；
 * - fiber 卸载后 service 从 ctx 消失（strict 读取）。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import * as stagedDiff from '../../src/stagedDiff/adapters/dsh/index.ts'

let workspace: string
let dataRoot: string

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-sd-index-ws-'))
})

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true })
})

beforeEach(async () => {
  // 每个用例独立 dataRoot：sidecar 互不污染（restoreFromSidecar 会重建上一用例的条目）
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-sd-index-data-'))
})

afterEach(async () => {
  await fs.rm(dataRoot, { recursive: true, force: true })
})

describe('staged-diff 子插件 service 提供面', () => {
  it('enabled=true：提供 handle，enabled/workspaceIdOf/service 契约成立；卸载后消失', async () => {
    const ctx = new Context()
    const mounted: Array<{ dispose(): Promise<void> }> = []
    mounted.push(await ctx.plugin(LocalFileSystem, { cwd: workspace }))
    mounted.push(await ctx.plugin(SessionStore))
    mounted.push(await ctx.plugin(AgentRegistry))
    const fiber = await ctx.plugin(stagedDiff, { dataRoot, enabled: true, agentScope: 'disabled' })
    mounted.push(fiber)

    const handle = ctx.get(stagedDiff.STAGED_DIFF_SERVICE_KEY) as stagedDiff.StagedDiffServiceHandle | undefined
    expect(handle).toBeDefined()
    expect(handle!.enabled).toBe(true)
    // workspaceId 派生与工具层同口径
    expect(handle!.workspaceIdOf(workspace)).toMatch(/^ws_[0-9a-f]{16}$/)
    // service 初始化（sidecar 恢复异步；listEntries 在 loaded 前抛错）
    await vi.waitFor(() => {
      expect(handle!.service.listEntries().length).toBe(0)
    })
    // createEntry 可用（写意图入库，不落盘）
    const entry = await handle!.service.createEntry({
      workspaceId: handle!.workspaceIdOf(workspace),
      sessionId: 's1',
      path: '.graycode/design/x.md',
      after: 'v1',
    })
    expect(entry.status).toBe('pending')

    // 卸载后 service 消失（strict 读取）
    await fiber.dispose()
    expect(ctx.get(stagedDiff.STAGED_DIFF_SERVICE_KEY)).toBeUndefined()

    for (const f of mounted.reverse()) {
      await f.dispose()
    }
  })

  it('enabled=false：handle 仍提供（service 始终初始化），enabled=false 供消费者判断不接管', async () => {
    const ctx = new Context()
    const mounted: Array<{ dispose(): Promise<void> }> = []
    mounted.push(await ctx.plugin(LocalFileSystem, { cwd: workspace }))
    mounted.push(await ctx.plugin(SessionStore))
    mounted.push(await ctx.plugin(AgentRegistry))
    mounted.push(await ctx.plugin(stagedDiff, { dataRoot, enabled: false, agentScope: 'disabled' }))

    const handle = ctx.get(stagedDiff.STAGED_DIFF_SERVICE_KEY) as stagedDiff.StagedDiffServiceHandle | undefined
    expect(handle).toBeDefined()
    expect(handle!.enabled).toBe(false)
    await vi.waitFor(() => {
      expect(handle!.service.listEntries().length).toBe(0)
    })

    for (const f of mounted.reverse()) {
      await f.dispose()
    }
  })
})
