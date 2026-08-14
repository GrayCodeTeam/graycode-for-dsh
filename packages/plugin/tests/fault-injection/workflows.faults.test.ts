/**
 * 故障注入：workflows 领域（规划 §9.5 的子集：storageDomain 写入前/写入中/提交后抛错、
 * 重复点击、并发写锁冲突）。
 *
 * 注入手段：mock FileSystem.writeText（vi.spyOn）、真实取消信号（aborted signal）、
 * 并发重复调用。真实临时目录 + 真实 dsh-fs-local，不污染真实 dataRoot。
 *
 * 每个用例显式声明：注入什么故障 / 期望最终状态 / 允许的部分结果。
 *
 * 说明：
 * - workflows 工具没有错误码枚举（与 prompt/memory 不同），"稳定错误"契约 = 稳定错误消息
 *   且工具 promise 拒绝（绝不 resolve 成假成功）。
 * - "文档落盘成功但 domain 状态写入失败"（P3A）在这里表现为：真实写入已提交，但 fs 层
 *   在提交后报告失败（ack 丢失）。工具不向 UI 假报完成；下一次调用与磁盘真相 reconcile
 *   （create 重试报 already exists、update 可继续收敛）。
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { executeCreateDesign, executeUpdateDesign } from '../../src/workflows/tools/design.ts'
import {
  executeCreateProgress,
  executeRecordProgressMilestone,
  executeUpdateProgress,
  executeValidateProgressDocument,
} from '../../src/workflows/tools/progress.ts'
import { getProgressWriteQueueSize } from '../../src/workflows/domain/progress/progressWriteLock.ts'
import { validateProgressDocument } from '../../src/workflows/domain/progress/documentLayout.ts'
import type { ProgressToolStructuredResultV1 } from '../../src/workflows/domain/progress/schema.ts'
import type { ToolDeps } from '../../src/workflows/workspace.ts'

let tmpDir: string
let deps: ToolDeps

function makeDeps(sessionId: string): ToolDeps {
  const ctx = new Context()
  const fileSystem = new LocalFileSystem(ctx, { cwd: tmpDir, diffBasisMaxBytes: 10 * 1024 * 1024 })
  return { fs: fileSystem, cwd: tmpDir, sessionId }
}

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'graycode-fault-wf-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(path.join(tmpDir, '.graycode'), { recursive: true, force: true })
  deps = makeDeps('fault-session')
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function readWorkspaceFile(relPath: string): Promise<string> {
  const target = await deps.fs.resolve(relPath, { cwd: tmpDir })
  return deps.fs.readText(target)
}

/** 提交后失败：真实写盘成功后，fs 层再抛错（ack 丢失 / 提交报告失败）。 */
function armPostCommitWriteFailure(message: string): void {
  const originalWriteText = deps.fs.writeText.bind(deps.fs)
  vi.spyOn(deps.fs, 'writeText').mockImplementation(async (...args: Parameters<typeof originalWriteText>) => {
    await originalWriteText(...args)
    throw new Error(message)
  })
}

describe('文档写入失败（storageDomain 写入前/写入中）', () => {
  it('写入前抛错（mock writeText 拒绝）→ 工具拒绝、不假报完成、无文件无残留；恢复后可重试', async () => {
    // 注入故障：fs.writeText 在写入前抛错（磁盘满）
    vi.spyOn(deps.fs, 'writeText').mockRejectedValueOnce(new Error('disk full: cannot stage design document'))

    // 期望最终状态：create_design 拒绝，绝不 resolve 成 {path, content} 假成功
    await expect(executeCreateDesign(deps, { title: 'Fault', design: 'v1' }))
      .rejects.toThrow('disk full: cannot stage design document')

    // 磁盘上没有目标文件
    const target = await deps.fs.resolve('.graycode/design/fault.md', { cwd: tmpDir })
    expect(await deps.fs.stat(target)).toBeUndefined()
    // 无临时残留（dsh-fs-local 原子写入的 staging 目录未产生）
    const designDir = path.join(tmpDir, '.graycode', 'design')
    const entries = fs.existsSync(designDir) ? await readdir(designDir) : []
    expect(entries.filter(entry => entry.includes('.tmpdir'))).toEqual([])

    // 允许的部分结果：无——写失败在提交前，磁盘与工具视角一致（都没写）
    // 故障消除后可重试成功（可恢复）
    const retried = await executeCreateDesign(deps, { title: 'Fault', design: 'v1' }) as { path: string }
    expect(retried.path).toBe('.graycode/design/fault.md')
    expect(await readWorkspaceFile(retried.path)).toBe('v1')
  })

  it('取消信号（aborted）→ 稳定 FS_ABORTED 错误码、无文件', async () => {
    // 注入故障：调用方取消信号在写入前触发（resolve 阶段即检查 abort）
    const controller = new AbortController()
    controller.abort()
    const abortedDeps: ToolDeps = { ...deps, signal: controller.signal }

    // 期望最终状态：稳定错误码 FS_ABORTED（工具不吞错、不假报完成）
    const error = await executeCreateDesign(abortedDeps, { title: 'Aborted', design: 'x' }).catch(e => e)
    expect(error).toBeInstanceOf(FsError)
    expect((error as FsError).code).toBe('FS_ABORTED')

    // 磁盘无文件（允许的部分结果：无——取消发生在提交前）
    const target = await deps.fs.resolve('.graycode/design/aborted.md', { cwd: tmpDir })
    expect(await deps.fs.stat(target)).toBeUndefined()
  })
})

describe('文档落盘成功但状态报告失败（P3A：不向 UI 假报完成）', () => {
  it('create_design 提交后失败 → 拒绝不假报；重试与磁盘真相 reconcile；update 可收敛', async () => {
    // 注入故障：真实字节已提交到磁盘，但 fs 层在提交后抛错（ack 丢失）
    armPostCommitWriteFailure('commit ack lost after disk write')

    await expect(executeCreateDesign(deps, { title: 'Reconcile', design: 'v2' }))
      .rejects.toThrow('commit ack lost after disk write')

    // 允许的部分结果：文档已落盘（写提交了，但调用方收到的是失败）
    expect(await readWorkspaceFile('.graycode/design/reconcile.md')).toBe('v2')

    // reconcile 语义：重试 create 不再假报成功，而是报告磁盘真相（已存在）
    await expect(executeCreateDesign(deps, { title: 'Reconcile', design: 'v2' }))
      .rejects.toThrow(/Design document already exists at .*Use update_design/)

    // 故障消除后，update 可在既有文档上继续收敛
    vi.restoreAllMocks()
    const updated = await executeUpdateDesign(deps, {
      path: '.graycode/design/reconcile.md',
      design: 'v3',
    }) as { content: string }
    expect(updated.content).toBe('v3')
    expect(await readWorkspaceFile('.graycode/design/reconcile.md')).toBe('v3')
  })

  it('create_progress 提交后失败 → 拒绝不假报；重试返回既有 snapshot（reconcile）', async () => {
    // 注入故障：progress.md 真实落盘后报告失败
    armPostCommitWriteFailure('progress commit ack lost')

    await expect(executeCreateProgress(deps, { projectName: 'Faulty' }))
      .rejects.toThrow('progress commit ack lost')

    // 允许的部分结果：progress.md 已落盘且结构有效（校验可通过）
    expect(validateProgressDocument(await readWorkspaceFile('.graycode/progress.md')).success).toBe(true)

    // reconcile 语义：重试 create 不再创建第二个文件，返回既有 snapshot + warning
    vi.restoreAllMocks()
    const retried = await executeCreateProgress(deps, { projectName: 'Faulty' }) as {
      progressDelta: { type: string }
      warnings?: string[]
      projectName: string
    }
    expect(retried.projectName).toBe('Faulty')
    expect(retried.progressDelta.type).toBe('updated')
    expect(retried.warnings?.[0]).toMatch(/already exists/)
  })
})

describe('并发写锁（progressWriteLock）', () => {
  it('同 milestoneId 并发 → 一个成功，第二个写入者得到明确冲突错误', async () => {
    await executeCreateProgress(deps, { projectName: 'Lock' })

    // 注入故障：两个写入者并发提交同一 milestoneId（重复调用/并行子代理）
    const results = await Promise.allSettled([
      executeRecordProgressMilestone(deps, { milestoneId: 'PG1', title: '一', summary: 's1' }),
      executeRecordProgressMilestone(deps, { milestoneId: 'PG1', title: '二', summary: 's2' }),
    ])
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<ProgressToolStructuredResultV1> => r.status === 'fulfilled')
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

    // 期望最终状态：恰好一个成功；第二个在写锁内重新读取盘面后得到明确冲突错误
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toBeInstanceOf(Error)
    expect((rejected[0]!.reason as Error).message).toBe('Milestone id already exists: PG1')

    // 磁盘最终只有一条 PG1（冲突者未写入任何半成品）
    const validated = await executeValidateProgressDocument(deps, { path: '.graycode/progress.md' }) as {
      isValid: boolean
      progressValidation: { metadata: { stats: { milestonesTotal: number } } | undefined }
    }
    expect(validated.isValid).toBe(true)
    expect(validated.progressValidation.metadata?.stats.milestonesTotal).toBe(1)

    // 允许的部分结果：无——冲突被完整拒绝，无部分写入
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getProgressWriteQueueSize()).toBe(0)
  })

  it('并发 update 不同字段 → 写锁串行化，后写者基于最新盘面合并，无丢失更新', async () => {
    await executeCreateProgress(deps, { projectName: 'Merge' })

    // 注入故障：两个写入者并发更新不同字段（模拟并行子代理同时写 progress.md）
    const results = await Promise.allSettled([
      executeUpdateProgress(deps, { phase: 'implementation' }),
      executeUpdateProgress(deps, { latestConclusion: 'merged conclusion' }),
    ])
    for (const result of results) {
      expect(result.status).toBe('fulfilled')
    }

    // 期望最终状态：两个字段都出现在最终盘面（无丢失更新——写锁把「读→改→写」串行化）
    const disk = await readWorkspaceFile('.graycode/progress.md')
    expect(disk).toContain('implementation')
    expect(disk).toContain('merged conclusion')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getProgressWriteQueueSize()).toBe(0)
  })

  it('写锁内第一个写者失败 → 第二个写者不受影响正常完成，队列不中毒', async () => {
    await executeCreateProgress(deps, { projectName: 'LockFault' })

    // 注入故障：第一个写者的 fs.writeText 抛错（磁盘满），第二个写者紧随其后
    vi.spyOn(deps.fs, 'writeText').mockRejectedValueOnce(new Error('disk full'))
    await expect(executeUpdateProgress(deps, { phase: 'implementation' }))
      .rejects.toThrow('disk full')

    // 期望最终状态：第二个写者仍然成功，且只包含它自己的变更
    const second = await executeUpdateProgress(deps, { latestConclusion: 'after fault' }) as { latestConclusion: string | null }
    expect(second.latestConclusion).toBe('after fault')
    const disk = await readWorkspaceFile('.graycode/progress.md')
    expect(disk).toContain('after fault')
    expect(disk).not.toContain('implementation') // 第一个写者未产生部分写入

    // 允许的部分结果：第一个写者失败无残留；锁队列继续服务后续写者
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getProgressWriteQueueSize()).toBe(0)
  })

  it('并发 create_progress（重复点击）→ 幂等：单文件 + 既有 snapshot', async () => {
    // 注入故障：同一请求被重复触发两次（用户/前端重复点击）
    const results = await Promise.allSettled([
      executeCreateProgress(deps, { projectName: 'DoubleClick' }),
      executeCreateProgress(deps, { projectName: 'DoubleClick' }),
    ])
    for (const result of results) {
      expect(result.status).toBe('fulfilled')
    }
    const values = results as PromiseFulfilledResult<ProgressToolStructuredResultV1>[]
    const creators = values.filter(result => result.value.progressDelta?.type === 'created')
    const reusers = values.filter(result =>
      result.value.progressDelta?.type === 'updated' &&
      (result.value.warnings ?? []).some(warning => warning.includes('already exists')),
    )

    // 期望最终状态：恰好一个创建、一个复用既有 snapshot（不产生第二个文件）
    expect(creators).toHaveLength(1)
    expect(reusers).toHaveLength(1)
    expect(await readWorkspaceFile('.graycode/progress.md')).toContain('DoubleClick')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getProgressWriteQueueSize()).toBe(0)
  })
})
