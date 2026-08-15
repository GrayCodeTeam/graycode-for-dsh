/**
 * staged-diff 写工具适配测试（ADR-0003 §6 后续动作 2）
 *
 * 1. 写前钩子单元面：真实 StagedDiffService + 内存假存储/假落盘端口 + 钩子注入
 *    （setStagedWriteHook），验证：
 *    - enabled=true：design 写入意图先变成 staged 条目，磁盘零写入；accept 后才落盘；
 *    - before 快照捕获（update 场景）；
 *    - staging 失败 fail-closed（3.17-M2）：拒绝写入并如实上报，绝不回退直接落盘
 *      （回退会绕过审阅门闸）；
 *    - enabled=false / 未安装钩子：直接落盘，与现状完全一致（默认关闭）。
 * 2. cordis 跨域接线面：真实挂载 workflows + stagedDiff 两个子插件（同一 ctx，
 *    与根 index.ts 相同的挂载顺序），验证 stagedDiff 经 ctx.provide 提供
 *    'graycode.stagedDiff' 后，workflows 的 ctx.inject 回调安装写前钩子，
 *    enabled 与配置一致；stagedDiff 卸载后钩子被移除。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { GrayRemoteService } from '../../src/remote/service.ts'
import { StagedDiffService } from '../../src/stagedDiff/application/service.ts'
import type { EntryStorePort } from '../../src/stagedDiff/application/ports.ts'
import { createDshFsApplyFilePort } from '../../src/stagedDiff/adapters/dsh/fsApplier.ts'
import { createStagedWorkspaceId } from '../../src/stagedDiff/adapters/dsh/tools.ts'
import type { StagedEntry } from '../../src/stagedDiff/domain/types.ts'
import * as workflowsPlugin from '../../src/workflows/index.ts'
import * as stagedDiffPlugin from '../../src/stagedDiff/adapters/dsh/index.ts'
import {
  createStagedWriteHookFromHandle,
  createStagedWriteHookManager,
  getStagedWriteHook,
  installStagedWriteHookManager,
  setStagedWriteHook,
} from '../../src/workflows/stagedWriteHook.ts'
import { executeCreateDesign, executeUpdateDesign } from '../../src/workflows/tools/design.ts'
import { executeCreateReview, executeRecordReviewMilestone } from '../../src/workflows/tools/review.ts'
import { loadReviewSessionState, resetReviewSessionStatesForTest } from '../../src/workflows/sessionState.ts'
import { executeCreateProgress } from '../../src/workflows/tools/progress.ts'
import type { ToolDeps } from '../../src/workflows/workspace.ts'

let tmpDir: string
let deps: ToolDeps

class FakeStore implements EntryStorePort {
  entries: StagedEntry[] = []
  failSave = false

  async load(): Promise<readonly StagedEntry[]> {
    return this.entries.map(e => ({ ...e }))
  }

  async save(entries: readonly StagedEntry[]): Promise<void> {
    if (this.failSave) throw new Error('disk full')
    this.entries = entries.map(e => ({ ...e }))
  }
}

function makeHook(enabled: boolean) {
  const store = new FakeStore()
  // 落盘端口用生产实现（ctx.fs.writeText + workspace-write sandboxPolicy）：
  // accept 真实写入 LocalFileSystem 磁盘，测试才能断言落盘后的真实内容
  const service = new StagedDiffService(store, createDshFsApplyFilePort(deps.fs))
  return {
    store,
    service,
    hook: createStagedWriteHookFromHandle({
      enabled,
      service,
      workspaceIdOf: createStagedWorkspaceId,
    }),
  }
}

function makeDeps(sessionId: string): ToolDeps {
  const ctx = new Context()
  const fs = new LocalFileSystem(ctx, { cwd: tmpDir, diffBasisMaxBytes: 10 * 1024 * 1024 })
  return { fs, cwd: tmpDir, sessionId }
}

async function targetExistsOnDisk(relPath: string): Promise<boolean> {
  const target = await deps.fs.resolve(relPath, { cwd: tmpDir })
  return (await deps.fs.stat(target)) !== undefined
}

async function readDisk(relPath: string): Promise<string> {
  const target = await deps.fs.resolve(relPath, { cwd: tmpDir })
  return deps.fs.readText(target)
}

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'graycode-staged-wf-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(path.join(tmpDir, '.graycode'), { recursive: true, force: true })
  deps = makeDeps('staged-session')
})

afterEach(() => {
  setStagedWriteHook(null)
  vi.restoreAllMocks()
})

describe('写前钩子（enabled=true：写入意图先 staged，接受后才落盘）', () => {
  it('create_design → staged 条目（pending），磁盘零写入；accept 后才落盘', async () => {
    const { service, hook } = makeHook(true)
    await service.initialize()
    setStagedWriteHook(hook)

    const created = await executeCreateDesign(deps, {
      title: 'Auth Flow',
      design: '第一行\n第二行',
    }) as { path: string; content: string; warnings?: string[]; staged?: { entryId: string; status: string } }

    expect(created.staged).toBeDefined()
    expect(created.staged!.status).toBe('pending')
    expect(created.warnings!.some(w => w.includes(`staged as entry ${created.staged!.entryId}`))).toBe(true)

    // 写入意图未落盘：workspace 没有任何文件
    expect(await targetExistsOnDisk(created.path)).toBe(false)

    // 条目已入 staged 库（含 autoSync 的 progress.md 条目，共 2 条）
    const entries = service.listEntries()
    const designEntry = entries.find(e => e.path === created.path)
    expect(designEntry).toBeDefined()
    expect(designEntry!.after).toBe('第一行\n第二行')
    expect(designEntry!.before).toBeNull()
    expect(designEntry!.status).toBe('pending')
    expect(designEntry!.workspaceId).toBe(createStagedWorkspaceId(tmpDir))
    expect(designEntry!.sessionId).toBe('staged-session')
    // progress.md 的同步写同样被 staged（与主文档一致）
    expect(entries.some(e => e.path === '.graycode/progress.md')).toBe(true)

    // 接受后落盘
    const accepted = await service.acceptEntry({
      entryId: created.staged!.entryId,
      workspaceRoot: tmpDir,
    })
    expect(accepted.status).toBe('done')
    expect(await readDisk(created.path)).toBe('第一行\n第二行')
  })

  it('update_design 捕获 before 快照；accept 前磁盘保持旧内容', async () => {
    const { service, hook } = makeHook(true)
    await service.initialize()
    // 先直接落盘 v1（无钩子）
    await executeCreateDesign(deps, { title: 'Base', design: 'v1' })
    // 安装钩子后 update
    setStagedWriteHook(hook)

    const updated = await executeUpdateDesign(deps, {
      path: '.graycode/design/base.md',
      design: 'v2',
    }) as { staged?: { entryId: string } }

    expect(updated.staged).toBeDefined()
    // 磁盘仍是 v1（写入意图被 staged）
    expect(await readDisk('.graycode/design/base.md')).toBe('v1')

    const entry = service.getEntry(updated.staged!.entryId)!
    expect(entry.before).toBe('v1')
    expect(entry.after).toBe('v2')

    await service.acceptEntry({ entryId: entry.id, workspaceRoot: tmpDir })
    expect(await readDisk('.graycode/design/base.md')).toBe('v2')
  })

  it('staging 失败（存储写失败）→ fail-closed：拒绝写入、磁盘零写入、不假报完成', async () => {
    const { service, store, hook } = makeHook(true)
    await service.initialize()
    store.failSave = true
    setStagedWriteHook(hook)

    // 3.17-M2：staging 失败不再回退直接落盘（fail-open 会让内容绕过审阅门闸直接
    // 进入 workspace）；工具如实拒绝并上报底层错误。
    await expect(executeCreateDesign(deps, {
      title: 'Fallback',
      design: 'v1',
    })).rejects.toThrow(/disk full/)

    // 磁盘上没有任何文件：主文档未落盘，审阅门闸未被绕过
    expect(await targetExistsOnDisk('.graycode/design/fallback.md')).toBe(false)
    expect(service.listEntries().length).toBe(0)
  })

  it('create_progress 同样走 staged 通道并返回 warnings 提示', async () => {
    const { service, hook } = makeHook(true)
    await service.initialize()
    setStagedWriteHook(hook)

    const created = await executeCreateProgress(deps, { projectName: 'W' }) as {
      warnings?: string[]
    }

    expect(created.warnings).toBeDefined()
    expect(created.warnings!.some(w => w.includes('staged as entry'))).toBe(true)
    expect(await targetExistsOnDisk('.graycode/progress.md')).toBe(false)
    expect(service.listEntries().some(e => e.path === '.graycode/progress.md')).toBe(true)
  })

  it('create_review staged 时不记录 in_progress 会话（拒绝后门闸不指向不存在的文档）', async () => {
    resetReviewSessionStatesForTest()
    const { service, hook } = makeHook(true)
    await service.initialize()
    setStagedWriteHook(hook)

    const created = await executeCreateReview(deps, {
      title: 'Staged Review',
      review: 'scope',
    }) as { path: string; staged?: { entryId: string }; warnings?: string[] }

    expect(created.staged).toBeDefined()
    expect(await targetExistsOnDisk(created.path)).toBe(false)
    // 写入意图未落盘：不得把会话门闸指向不存在的文档（修复前 saveReviewSessionState
    // 无条件执行，reject 后 create_review 被悬空门闸拦截、record 读盘失败）
    expect(loadReviewSessionState(deps.sessionId)).toBeNull()

    // 无悬空门闸：同一会话可继续创建第二个 staged review
    const second = await executeCreateReview(deps, {
      title: 'Staged Review B',
      review: 'scope b',
      path: '.graycode/review/staged-b.md',
    }) as { staged?: { entryId: string } }
    expect(second.staged).toBeDefined()

    // accept 落盘后 record 正常读取文档并继续（门闸不指向不存在的文档）
    await service.acceptEntry({ entryId: created.staged!.entryId, workspaceRoot: tmpDir })
    const recorded = await executeRecordReviewMilestone(deps, {
      path: created.path,
      milestoneTitle: '第一轮',
      summary: '摘要',
    }) as { totalMilestones: number; staged?: { entryId: string } }
    expect(recorded.totalMilestones).toBe(1)
  })
})

describe('写前钩子（enabled=false / 未安装：与现状完全一致，默认关闭）', () => {
  it('钩子存在但 enabled=false → 直接落盘，不产生 staged 条目', async () => {
    const { service, hook } = makeHook(false)
    await service.initialize()
    setStagedWriteHook(hook)

    const created = await executeCreateDesign(deps, {
      title: 'Direct',
      design: 'v1',
    }) as { path: string; staged?: unknown; warnings?: string[] }

    expect(created.staged).toBeUndefined()
    expect(created.warnings).toBeUndefined()
    expect(await readDisk(created.path)).toBe('v1')
    expect(service.listEntries().length).toBe(0)
  })

  it('未安装钩子 → 直接落盘（回归：现有工具行为不变）', async () => {
    const created = await executeCreateDesign(deps, {
      title: 'No Hook',
      design: 'v1',
    }) as { path: string; staged?: unknown; warnings?: string[] }

    expect(created.staged).toBeUndefined()
    expect(created.warnings).toBeUndefined()
    expect(await readDisk(created.path)).toBe('v1')
  })
})

describe('写前钩子管理器（插件 scope 实例化；模块级读取面原子替换）', () => {
  it('clearIfCurrent：旧实例清理不覆盖新实例已安装的钩子（原子替换，不先置 null）', () => {
    const manager = createStagedWriteHookManager()
    const hookA = makeHook(true).hook
    const hookB = makeHook(true).hook

    manager.set(hookA)
    manager.set(hookB) // 新实例原子替换（不经 null 中间态）
    manager.clearIfCurrent(hookA) // 旧实例卸载：当前钩子已是 hookB → no-op
    expect(manager.get()).toBe(hookB)

    manager.clearIfCurrent(hookB) // 新实例卸载：清理自己的钩子
    expect(manager.get()).toBeNull()
  })

  it('installStagedWriteHookManager：卸载恢复前一个读取面；模块级读取面跟随当前实例', () => {
    const managerA = createStagedWriteHookManager()
    const managerB = createStagedWriteHookManager()
    const hookA = makeHook(true).hook
    const hookB = makeHook(true).hook

    const restoreA = installStagedWriteHookManager(managerA)
    managerA.set(hookA)
    expect(getStagedWriteHook()).toBe(hookA)

    const restoreB = installStagedWriteHookManager(managerB)
    managerB.set(hookB)
    expect(getStagedWriteHook()).toBe(hookB)

    restoreB() // B 卸载 → 恢复 A
    expect(getStagedWriteHook()).toBe(hookA)
    restoreA() // A 卸载 → 无读取面
    expect(getStagedWriteHook()).toBeNull()
  })
})

describe('cordis 跨域接线（workflows ↔ staged-diff service，与根 index.ts 同序）', () => {
  let dataRoot: string

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), 'graycode-staged-wiring-'))
  })

  afterEach(async () => {
    setStagedWriteHook(null)
    await rm(dataRoot, { recursive: true, force: true })
  })

  it('stagedDiff 提供 service 后，workflows 安装写前钩子（enabled 与配置一致）；卸载后钩子移除', async () => {
    const ctx = new Context()
    // 与根 index.ts:54 装配一致：先提供 grayRemote 服务，workflows/stagedDiff 的
    // apply() 才能注册端点（cordis 对未 inject 属性访问会抛错，`?.` 无法拦截）。
    new GrayRemoteService(ctx)
    const mounted: Array<{ dispose(): Promise<void> }> = []
    mounted.push(await ctx.plugin(LocalFileSystem, { cwd: tmpDir }))
    mounted.push(await ctx.plugin(SessionStore))
    mounted.push(await ctx.plugin(AgentRegistry))
    mounted.push(await ctx.plugin(SystemPrompt))
    mounted.push(await ctx.plugin(ToolRuntime))
    mounted.push(await ctx.plugin(LlmRuntime))
    mounted.push(await ctx.plugin(AgentLoop, { agents: [] }))
    // workflows 先挂载（与根 index.ts 相同顺序），其 ctx.inject 等待 stagedDiff service
    mounted.push(await ctx.plugin(workflowsPlugin, { dataRoot, documentRoot: '.graycode', agentScope: 'disabled' }))
    // stagedDiff 后挂载并 enabled
    const stagedFiber = await ctx.plugin(stagedDiffPlugin, { dataRoot, enabled: true, agentScope: 'disabled' })
    mounted.push(stagedFiber)

    // service 可见
    const handle = ctx.get(stagedDiffPlugin.STAGED_DIFF_SERVICE_KEY) as stagedDiffPlugin.StagedDiffServiceHandle | undefined
    expect(handle).toBeDefined()
    expect(handle!.enabled).toBe(true)
    // service 初始化完成（sidecar 恢复为异步；listEntries 在 loaded 前抛错）
    await vi.waitFor(() => {
      expect(handle!.service.listEntries().length).toBe(0)
    })
    // workflows 已消费 service 并安装写前钩子
    await vi.waitFor(() => {
      expect(getStagedWriteHook()).not.toBeNull()
    })
    expect(getStagedWriteHook()!.enabled).toBe(true)

    // stagedDiff 卸载 → 钩子随 inject 纤维回收被移除
    await stagedFiber.dispose()
    // 3.20-M4：同一 fiber 二次 dispose 是幂等 no-op（清理循环会再次 dispose，锁死该契约）
    expect(() => stagedFiber.dispose()).not.toThrow()
    await vi.waitFor(() => {
      expect(getStagedWriteHook()).toBeNull()
    })
    expect(ctx.get(stagedDiffPlugin.STAGED_DIFF_SERVICE_KEY)).toBeUndefined()

    for (const fiber of mounted.reverse()) {
      await fiber.dispose()
    }
  })

  it('enabled=false 时钩子安装但不接管（enabled=false），直接落盘', async () => {
    const ctx = new Context()
    // 与根 index.ts:54 装配一致：先提供 grayRemote 服务（同上）。
    new GrayRemoteService(ctx)
    const mounted: Array<{ dispose(): Promise<void> }> = []
    mounted.push(await ctx.plugin(LocalFileSystem, { cwd: tmpDir }))
    mounted.push(await ctx.plugin(SessionStore))
    mounted.push(await ctx.plugin(AgentRegistry))
    mounted.push(await ctx.plugin(SystemPrompt))
    mounted.push(await ctx.plugin(ToolRuntime))
    mounted.push(await ctx.plugin(LlmRuntime))
    mounted.push(await ctx.plugin(AgentLoop, { agents: [] }))
    mounted.push(await ctx.plugin(workflowsPlugin, { dataRoot, documentRoot: '.graycode', agentScope: 'disabled' }))
    mounted.push(await ctx.plugin(stagedDiffPlugin, { dataRoot, enabled: false, agentScope: 'disabled' }))

    await vi.waitFor(() => {
      expect(getStagedWriteHook()).not.toBeNull()
    })
    expect(getStagedWriteHook()!.enabled).toBe(false)

    // enabled=false：工具直接落盘
    const created = await executeCreateDesign(deps, {
      title: 'Disabled Staging',
      design: 'v1',
    }) as { path: string; staged?: unknown; warnings?: string[] }
    expect(created.staged).toBeUndefined()
    expect(await readDisk(created.path)).toBe('v1')

    for (const fiber of mounted.reverse()) {
      await fiber.dispose()
    }
  })

  it('HMR 重载（重新执行插件装配）：旧 stagedDiff 卸载后新实例重新 provide，钩子仍生效', async () => {
    const ctx = new Context()
    new GrayRemoteService(ctx)
    const mounted: Array<{ dispose(): Promise<void> }> = []
    mounted.push(await ctx.plugin(LocalFileSystem, { cwd: tmpDir }))
    mounted.push(await ctx.plugin(SessionStore))
    mounted.push(await ctx.plugin(AgentRegistry))
    mounted.push(await ctx.plugin(SystemPrompt))
    mounted.push(await ctx.plugin(ToolRuntime))
    mounted.push(await ctx.plugin(LlmRuntime))
    mounted.push(await ctx.plugin(AgentLoop, { agents: [] }))
    mounted.push(await ctx.plugin(workflowsPlugin, { dataRoot, documentRoot: '.graycode', agentScope: 'disabled' }))
    // 第一个 stagedDiff 实例（HMR 前的旧实例）；cordis 同 key 只允许一个 provider，
    // 重载序列为「旧实例卸载 → 新实例挂载」（与 ctx.plugin 重载语义一致）
    const fiberA = await ctx.plugin(stagedDiffPlugin, { dataRoot, enabled: true, agentScope: 'disabled' })
    mounted.push(fiberA)
    await vi.waitFor(() => {
      expect(getStagedWriteHook()?.enabled).toBe(true)
    })

    // 旧实例卸载 → 钩子随 inject 纤维回收被移除（clearIfCurrent 清理自己的钩子）
    await fiberA.dispose()
    // 3.20-M4：同一 fiber 二次 dispose 是幂等 no-op（清理循环会再次 dispose，锁死该契约）
    expect(() => fiberA.dispose()).not.toThrow()
    await vi.waitFor(() => {
      expect(getStagedWriteHook()).toBeNull()
    })

    // 新实例挂载（模拟 HMR 重载后的新 provide）→ 钩子重新安装并生效
    const fiberB = await ctx.plugin(stagedDiffPlugin, { dataRoot, enabled: true, agentScope: 'disabled' })
    mounted.push(fiberB)
    await vi.waitFor(() => {
      expect(getStagedWriteHook()?.enabled).toBe(true)
    })

    // 钩子仍生效：写入意图被 staged（不直接落盘）
    const created = await executeCreateDesign(deps, {
      title: 'Reloaded',
      design: 'v1',
    }) as { path: string; staged?: { entryId: string }; warnings?: string[] }
    expect(created.staged).toBeDefined()
    expect(await targetExistsOnDisk(created.path)).toBe(false)

    // 新实例也卸载 → 钩子彻底移除
    await fiberB.dispose()
    expect(() => fiberB.dispose()).not.toThrow()
    await vi.waitFor(() => {
      expect(getStagedWriteHook()).toBeNull()
    })

    for (const fiber of mounted.reverse()) {
      await fiber.dispose()
    }
  })
})
