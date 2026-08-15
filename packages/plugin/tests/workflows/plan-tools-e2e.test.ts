/**
 * plan 工具端到端测试：真实临时目录 + 真实 fs（@deepseek-ai/dsh-fs-local），
 * 直接调用 handlers（deps 依赖注入，不经 ctx.tools 注册管线）。
 *
 * 覆盖：create_plan/update_plan 双模式、路径白名单、拒绝覆盖/缺失、per-path 写锁并发、
 * sourceArtifact 绑定与新鲜度（含 2MB 护栏）、staged 写前钩子交互、autoSync 联动。
 * 参考 tools-e2e.test.ts（design/progress/review）与 stagedWrite.test.ts 的组织方式。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { StagedDiffService } from '../../src/stagedDiff/application/service.ts'
import type { EntryStorePort } from '../../src/stagedDiff/application/ports.ts'
import { createDshFsApplyFilePort } from '../../src/stagedDiff/adapters/dsh/fsApplier.ts'
import { createStagedWorkspaceId } from '../../src/stagedDiff/adapters/dsh/tools.ts'
import type { StagedEntry } from '../../src/stagedDiff/domain/types.ts'
import {
  createStagedWriteHookFromHandle,
  setStagedWriteHook,
} from '../../src/workflows/stagedWriteHook.ts'
import { executeCreatePlan, executeUpdatePlan, type PlanToolResultData } from '../../src/workflows/tools/plan.ts'
import { executeCreateDesign, executeUpdateDesign } from '../../src/workflows/tools/design.ts'
import { executeCreateProgress } from '../../src/workflows/tools/progress.ts'
import { validateProgressDocument } from '../../src/workflows/domain/progress/documentLayout.ts'
import { extractPlanTodoListFromContent } from '../../src/workflows/domain/plan/todoListSection.ts'
import {
  extractPlanSourceArtifact,
  extractPlanSourceArtifactSection,
} from '../../src/workflows/domain/plan/sourceArtifactSection.ts'
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

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'graycode-plan-tools-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(path.join(tmpDir, '.graycode'), { recursive: true, force: true })
  deps = makeDeps('plan-session')
})

afterEach(() => {
  setStagedWriteHook(null)
  vi.restoreAllMocks()
})

async function readWorkspaceFile(relPath: string): Promise<string> {
  const target = await deps.fs.resolve(relPath, { cwd: tmpDir })
  return deps.fs.readText(target)
}

async function targetExistsOnDisk(relPath: string): Promise<boolean> {
  const target = await deps.fs.resolve(relPath, { cwd: tmpDir })
  return (await deps.fs.stat(target)) !== undefined
}

/** lossless-JSON 契约回归（H-1）：递归断言值中不存在 undefined（dsh-tools 快照失败条件） */
function expectLosslessJson(value: unknown, keyPath = 'root'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => expectLosslessJson(item, `${keyPath}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      expect(item, `${keyPath}.${key} must not be undefined`).not.toBeUndefined()
      expectLosslessJson(item, `${keyPath}.${key}`)
    }
    return
  }
  expect(value, `${keyPath} must not be undefined`).not.toBeUndefined()
}

describe('create_plan', () => {
  it('writes the document with default .plan.md slug path and TODO/source markers; a second create is rejected', async () => {
    const created = await executeCreatePlan(deps, {
      title: 'Auth Flow',
      plan: '第一行\n第二行\r\nCRLF 行',
      todos: [
        { id: 'plan-01', content: '实现后台工具', status: 'in_progress' },
        { id: 'plan-02', content: '编写测试', status: 'pending' },
      ],
    }) as { path: string; content: string; todos: unknown[]; updateMode: string }

    expect(created.path).toBe('.graycode/plans/auth-flow.plan.md')
    expect(created.updateMode).toBe('revision')
    expect(created.todos).toEqual([
      { id: 'plan-01', content: '实现后台工具', status: 'in_progress' },
      { id: 'plan-02', content: '编写测试', status: 'pending' },
    ])
    expect(created.content).not.toContain('\r')

    const onDisk = await readWorkspaceFile(created.path)
    expect(onDisk).toContain('## TODO LIST')
    expect(onDisk).toContain('<!-- GRAYCODE_TODO_LIST_START -->')
    expect(onDisk).toContain('- [ ] 实现后台工具  `#plan-01`')
    expect(onDisk).toContain('第一行')
    expect(onDisk).not.toContain('\r')
    // checkbox-only 渲染（与源一致）：磁盘上 in_progress 提取为 pending；
    // 完整状态由返回的 todos 与 progress 同步快照保留
    expect(extractPlanTodoListFromContent(onDisk)).toEqual([
      { id: 'plan-01', content: '实现后台工具', status: 'pending' },
      { id: 'plan-02', content: '编写测试', status: 'pending' },
    ])

    await expect(executeCreatePlan(deps, {
      plan: '覆盖尝试',
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
      path: created.path,
    })).rejects.toThrow(/Plan document already exists at .*Use update_plan/)
  })

  it('uses an explicit path and rejects out-of-scope paths', async () => {
    const created = await executeCreatePlan(deps, {
      plan: 'v1',
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
      path: '.graycode/plans/sub/deep.plan.md',
    }) as { path: string }
    expect(created.path).toBe('.graycode/plans/sub/deep.plan.md')
    expect(await readWorkspaceFile(created.path)).toContain('v1')

    await expect(executeCreatePlan(deps, {
      plan: 'x',
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
      path: '.graycode/design/x.md',
    })).rejects.toThrow(/Invalid plan path/)
  })

  it('rejects missing plan text and non-array todos', async () => {
    await expect(executeCreatePlan(deps, { plan: '  ', todos: [] }))
      .rejects.toThrow('plan is required and must be a non-empty string')
    await expect(executeCreatePlan(deps, { plan: 'x', todos: 'not-array' }))
      .rejects.toThrow('todos must be an array')
  })

  it('prefixes Windows-reserved default filenames (title CON)', async () => {
    const created = await executeCreatePlan(deps, {
      title: 'CON',
      plan: 'reserved',
      todos: [],
    }) as { path: string }
    expect(created.path).toBe('.graycode/plans/_con.plan.md')
    expect(await readWorkspaceFile(created.path)).toContain('reserved')
  })

  it('concurrent create_plan on the same path is serialized: exactly one wins, the loser is rejected', async () => {
    const results = await Promise.allSettled([
      executeCreatePlan(deps, {
        title: 'Race',
        plan: 'v1',
        todos: [{ id: 't1', content: 'x', status: 'pending' }],
        path: '.graycode/plans/race.plan.md',
      }),
      executeCreatePlan(deps, {
        title: 'Race',
        plan: 'v2',
        todos: [{ id: 't2', content: 'y', status: 'pending' }],
        path: '.graycode/plans/race.plan.md',
      }),
    ])
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<PlanToolResultData> => r.status === 'fulfilled',
    )
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0]!.reason as Error).message).toMatch(/Plan document already exists at .*Use update_plan/)

    // 磁盘上是胜者的内容，未被败者回滚式覆盖
    expect(await readWorkspaceFile('.graycode/plans/race.plan.md')).toBe(fulfilled[0]!.value.content)
  })

  it('autoSync: create_plan initializes progress.md with phase plan + activeArtifacts.plan + log', async () => {
    const created = await executeCreatePlan(deps, {
      title: 'Sync Plan',
      plan: 'v1',
      todos: [{ id: 't1', content: 'x', status: 'completed' }],
    }) as { path: string; warnings?: string[] }

    expect(created.warnings).toBeUndefined()

    const progressText = await readWorkspaceFile('.graycode/progress.md')
    const validation = validateProgressDocument(progressText)
    expect(validation.success).toBe(true)
    if (validation.success) {
      expect(validation.metadata.phase).toBe('plan')
      expect(validation.metadata.activeArtifacts.plan).toBe(created.path)
      expect(validation.metadata.todos).toEqual([{ id: 't1', content: 'x', status: 'completed' }])
      expect(validation.metadata.log.some(entry =>
        entry.type === 'artifact_changed' && entry.refId === 'plan' && entry.message === `同步计划文档：${created.path}`
      )).toBe(true)
    }
  })
})

describe('sourceArtifact 绑定与新鲜度', () => {
  it('create_plan binds a design source artifact with sha256 contentHash (up_to_date)', async () => {
    const design = await executeCreateDesign(deps, {
      title: 'Auth Flow',
      design: '设计 v1',
    }) as { path: string }

    const created = await executeCreatePlan(deps, {
      title: 'Plan From Design',
      plan: '计划正文',
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
      sourceArtifact: { type: 'design', path: design.path },
    }) as {
      sourceArtifact: { type: string; path: string; contentHash: string }
      sourceStatus: { sourceStatus: string }
      content: string
    }

    expect(created.sourceArtifact).toMatchObject({ type: 'design', path: design.path })
    expect(created.sourceArtifact.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(created.sourceStatus.sourceStatus).toBe('up_to_date')

    const onDisk = await readWorkspaceFile('.graycode/plans/plan-from-design.plan.md')
    expect(onDisk).toContain('<!-- GRAYCODE_SOURCE_ARTIFACT_START -->')
    expect(extractPlanSourceArtifact(onDisk)).toEqual(created.sourceArtifact)
  })

  it('update_plan reports mismatched when the bound source changed, and missing_source when removed', async () => {
    const design = await executeCreateDesign(deps, {
      title: 'Freshness',
      design: '设计 v1',
    }) as { path: string }

    const plan = await executeCreatePlan(deps, {
      title: 'Freshness Plan',
      plan: '计划正文',
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
      sourceArtifact: { type: 'design', path: design.path },
    }) as { path: string }

    // 源文档内容变化 → mismatched
    await executeUpdateDesign(deps, { path: design.path, design: '设计 v2' })
    const updated = await executeUpdatePlan(deps, {
      path: plan.path,
      todos: [{ id: 't1', content: 'x', status: 'completed' }],
      updateMode: 'progress_sync',
    }) as { sourceStatus: { sourceStatus: string } }
    expect(updated.sourceStatus.sourceStatus).toBe('mismatched')

    // 源文档被删除 → missing_source
    await rm(path.join(tmpDir, design.path))
    const afterRemove = await executeUpdatePlan(deps, {
      path: plan.path,
      todos: [{ id: 't1', content: 'x', status: 'completed' }],
      updateMode: 'progress_sync',
    }) as { sourceStatus: { sourceStatus: string } }
    expect(afterRemove.sourceStatus.sourceStatus).toBe('missing_source')
  })

  it('rejects sourceArtifact with an invalid path scope or a missing file', async () => {
    await expect(executeCreatePlan(deps, {
      plan: 'x',
      todos: [],
      sourceArtifact: { type: 'design', path: '.graycode/plans/x.plan.md' },
    })).rejects.toThrow(/Invalid sourceArtifact path for type "design"/)

    await expect(executeCreatePlan(deps, {
      plan: 'x',
      todos: [],
      sourceArtifact: { type: 'review', path: '.graycode/review/missing.md' },
    })).rejects.toThrow(/sourceArtifact file does not exist/)
  })

  it('enforces the 2MB source artifact size guard', async () => {
    // 直接写一个超过 2MB 的源文档
    await mkdir(path.join(tmpDir, '.graycode', 'design'), { recursive: true })
    await writeFile(
      path.join(tmpDir, '.graycode', 'design', 'big.md'),
      'x'.repeat(2 * 1024 * 1024 + 1),
      'utf-8',
    )

    await expect(executeCreatePlan(deps, {
      plan: 'x',
      todos: [],
      sourceArtifact: { type: 'design', path: '.graycode/design/big.md' },
    })).rejects.toThrow(/sourceArtifact file is too large/)
  })
})

describe('update_plan 双模式', () => {
  it('revision mode rewrites the plan body and reports changeSummary', async () => {
    const created = await executeCreatePlan(deps, {
      title: 'Rev Plan',
      plan: 'v1 正文',
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
    }) as { path: string }

    const updated = await executeUpdatePlan(deps, {
      path: created.path,
      plan: 'v2 正文',
      todos: [{ id: 't1', content: 'x', status: 'in_progress' }],
      changeSummary: 'scope updated',
    }) as { content: string; updateMode: string; changeSummary: string; todos: unknown[] }

    expect(updated.updateMode).toBe('revision')
    expect(updated.changeSummary).toBe('scope updated')
    expect(updated.content).toContain('v2 正文')
    expect(updated.content).not.toContain('v1 正文')
    expect(updated.todos).toEqual([{ id: 't1', content: 'x', status: 'in_progress' }])
    expect(await readWorkspaceFile(created.path)).toBe(updated.content)
  })

  it('progress_sync mode keeps the plan body untouched and only updates the TODO snapshot', async () => {
    const created = await executeCreatePlan(deps, {
      title: 'Sync Mode',
      plan: '## 步骤\n原有正文内容',
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
    }) as { path: string }

    const updated = await executeUpdatePlan(deps, {
      path: created.path,
      todos: [{ id: 't1', content: 'x', status: 'completed' }, { id: 't2', content: '新增', status: 'in_progress' }],
      updateMode: 'progress_sync',
    }) as { content: string; updateMode: string; todos: unknown[]; warnings?: string[] }

    expect(updated.updateMode).toBe('progress_sync')
    expect(updated.content).toContain('## 步骤\n原有正文内容')
    expect(updated.todos).toEqual([
      { id: 't1', content: 'x', status: 'completed' },
      { id: 't2', content: '新增', status: 'in_progress' },
    ])
    expect(updated.warnings).toBeUndefined()

    const onDisk = await readWorkspaceFile(created.path)
    expect(onDisk).toContain('## 步骤\n原有正文内容')
    // checkbox-only 渲染：t2 in_progress 落盘后提取为 pending
    expect(extractPlanTodoListFromContent(onDisk)).toEqual([
      { id: 't1', content: 'x', status: 'completed' },
      { id: 't2', content: '新增', status: 'pending' },
    ])

    // progress_sync 联动 progress.md：TODO 快照更新 + 专用日志文案
    const progressText = await readWorkspaceFile('.graycode/progress.md')
    const validation = validateProgressDocument(progressText)
    expect(validation.success).toBe(true)
    if (validation.success) {
      expect(validation.metadata.todos).toEqual(updated.todos)
      expect(validation.metadata.log.some(entry =>
        entry.type === 'artifact_changed' && entry.message === `同步计划 TODO 快照：${created.path}`
      )).toBe(true)
    }
  })

  it('progress_sync ignores sourceArtifact with a warning', async () => {
    const created = await executeCreatePlan(deps, {
      title: 'Ignore SA',
      plan: 'v1',
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
    }) as { path: string }

    const updated = await executeUpdatePlan(deps, {
      path: created.path,
      todos: [{ id: 't1', content: 'x', status: 'completed' }],
      updateMode: 'progress_sync',
      sourceArtifact: { type: 'design', path: '.graycode/design/whatever.md' },
    }) as { warnings?: string[]; content: string }

    expect(updated.warnings).toEqual([
      'sourceArtifact was provided in progress_sync mode and has been ignored. Use updateMode: \'revision\' if you need to change the plan source.',
    ])
    // 未被忽略路径的读取所影响（whatever.md 不存在也不报错）
    expect(updated.content).toContain('v1')
    expect(extractPlanSourceArtifactSection(updated.content)).toBeNull()
  })

  it('rejects a missing document, missing plan in revision, and unexpected fields', async () => {
    await expect(executeUpdatePlan(deps, {
      path: '.graycode/plans/missing.plan.md',
      plan: 'x',
      todos: [],
    })).rejects.toThrow('Plan document does not exist')

    await expect(executeUpdatePlan(deps, {
      path: '.graycode/plans/x.plan.md',
      plan: '  ',
      todos: [],
    })).rejects.toThrow('plan is required and must be a non-empty string in revision mode')

    // progress_sync 不需要 plan
    await executeCreatePlan(deps, {
      title: 'No Plan Field',
      plan: 'v1',
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
      path: '.graycode/plans/no-plan-field.plan.md',
    })
    const synced = await executeUpdatePlan(deps, {
      path: '.graycode/plans/no-plan-field.plan.md',
      todos: [{ id: 't1', content: 'x', status: 'completed' }],
      updateMode: 'progress_sync',
    }) as { content: string }
    expect(synced.content).toContain('v1')

    await expect(executeUpdatePlan(deps, {
      path: '.graycode/plans/no-plan-field.plan.md',
      plan: 'x',
      todos: [],
      continuationPrompt: 'carry-over',
    })).rejects.toThrow('Unexpected update_plan fields: continuationPrompt')

    await expect(executeUpdatePlan(deps, {
      path: '.graycode/design/x.md',
      plan: 'x',
      todos: [],
    })).rejects.toThrow(/Invalid plan path/)
  })
})

describe('staged 写前钩子交互（enabled=true）', () => {
  it('create_plan → staged 条目（pending），磁盘零写入；accept 后才落盘', async () => {
    const { service, hook } = makeHook(true)
    await service.initialize()
    setStagedWriteHook(hook)

    const created = await executeCreatePlan(deps, {
      title: 'Staged Plan',
      plan: '第一行\n第二行',
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
    }) as { path: string; content: string; warnings?: string[]; staged?: { entryId: string; status: string } }

    expect(created.staged).toBeDefined()
    expect(created.staged!.status).toBe('pending')
    expect(created.warnings!.some(w => w.includes(`staged as entry ${created.staged!.entryId}`))).toBe(true)

    // 写入意图未落盘：workspace 没有任何 plan 文件
    expect(await targetExistsOnDisk(created.path)).toBe(false)

    // 条目已入 staged 库（含 autoSync 的 progress.md 条目，共 2 条）
    const entries = service.listEntries()
    const planEntry = entries.find(e => e.path === created.path)
    expect(planEntry).toBeDefined()
    expect(planEntry!.after).toContain('第一行')
    expect(planEntry!.before).toBeNull()
    expect(planEntry!.status).toBe('pending')
    expect(planEntry!.workspaceId).toBe(createStagedWorkspaceId(tmpDir))
    expect(planEntry!.sessionId).toBe('plan-session')
    expect(entries.some(e => e.path === '.graycode/progress.md')).toBe(true)

    // 接受后落盘
    const accepted = await service.acceptEntry({
      entryId: created.staged!.entryId,
      workspaceRoot: tmpDir,
    })
    expect(accepted.status).toBe('done')
    expect(await readWorkspaceFile(created.path)).toContain('第一行')
  })

  it('update_plan 捕获 before 快照；accept 前磁盘保持旧内容', async () => {
    const { service, hook } = makeHook(true)
    await service.initialize()
    // 先直接落盘 v1（无钩子）
    await executeCreatePlan(deps, {
      title: 'Staged Base',
      plan: 'v1',
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
    })
    // 安装钩子后 update
    setStagedWriteHook(hook)

    const updated = await executeUpdatePlan(deps, {
      path: '.graycode/plans/staged-base.plan.md',
      plan: 'v2',
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
    }) as { staged?: { entryId: string } }

    expect(updated.staged).toBeDefined()
    // 磁盘仍是 v1（写入意图被 staged）
    expect(await readWorkspaceFile('.graycode/plans/staged-base.plan.md')).toContain('v1')

    const entry = service.getEntry(updated.staged!.entryId)!
    expect(entry.before).toContain('v1')
    expect(entry.after).toContain('v2')

    await service.acceptEntry({ entryId: entry.id, workspaceRoot: tmpDir })
    expect(await readWorkspaceFile('.graycode/plans/staged-base.plan.md')).toContain('v2')
  })

  it('staging 失败（存储写失败）→ fail-closed：拒绝写入、磁盘零写入（3.17-M2）', async () => {
    const { service, store, hook } = makeHook(true)
    await service.initialize()
    store.failSave = true
    setStagedWriteHook(hook)

    await expect(executeCreatePlan(deps, {
      title: 'Staged Fallback',
      plan: 'v1',
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
    })).rejects.toThrow(/disk full/)

    // 审阅门闸未被绕过：主文档未落盘
    expect(await targetExistsOnDisk('.graycode/plans/staged-fallback.plan.md')).toBe(false)
    expect(service.listEntries().length).toBe(0)
  })
})

describe('plan 与 progress 阶段联动', () => {
  it('create_plan on an existing implementation-phase progress keeps its phase', async () => {
    await executeCreateProgress(deps, {
      projectName: 'W',
      phase: 'implementation',
      currentFocus: '实现中',
    })

    await executeCreatePlan(deps, {
      title: 'Phase Plan',
      plan: 'v1',
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
    })

    const validation = validateProgressDocument(await readWorkspaceFile('.graycode/progress.md'))
    expect(validation.success).toBe(true)
    if (validation.success) {
      // revision 同步不把 implementation 回退到 plan
      expect(validation.metadata.phase).toBe('implementation')
      expect(validation.metadata.activeArtifacts.plan).toBe('.graycode/plans/phase-plan.plan.md')
      expect(validation.metadata.currentFocus).toBe('实现中')
    }
  })

  it('progress_sync on a missing progress.md initializes it with phase implementation', async () => {
    const created = await executeCreatePlan(deps, {
      title: 'Init Sync',
      plan: 'v1',
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
      path: '.graycode/plans/init-sync.plan.md',
    }) as { path: string }
    // 清掉 create 时初始化的 progress.md，模拟只有 plan 的情况
    await rm(path.join(tmpDir, '.graycode', 'progress.md'))

    await executeUpdatePlan(deps, {
      path: created.path,
      todos: [{ id: 't1', content: 'x', status: 'completed' }],
      updateMode: 'progress_sync',
    })

    const validation = validateProgressDocument(await readWorkspaceFile('.graycode/progress.md'))
    expect(validation.success).toBe(true)
    if (validation.success) {
      expect(validation.metadata.phase).toBe('implementation')
      expect(validation.metadata.activeArtifacts.plan).toBe(created.path)
      expect(validation.metadata.todos).toEqual([{ id: 't1', content: 'x', status: 'completed' }])
    }
  })
})

describe('lossless-JSON output contract (H-1)', () => {
  it('create_plan / update_plan results never contain undefined values', async () => {
    const created = await executeCreatePlan(deps, {
      title: 'Json Plan',
      plan: 'v1',
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
    })
    expectLosslessJson(created)

    const updated = await executeUpdatePlan(deps, {
      path: created.path,
      plan: 'v2',
      todos: [{ id: 't1', content: 'x', status: 'completed' }],
      updateMode: 'revision',
      changeSummary: 'scope updated',
    })
    expectLosslessJson(updated)

    // progress_sync 模式无 changeSummary 等可选字段时同样满足契约
    const synced = await executeUpdatePlan(deps, {
      path: created.path,
      todos: [{ id: 't1', content: 'x', status: 'pending' }],
      updateMode: 'progress_sync',
    })
    expectLosslessJson(synced)
  })
})
