/**
 * autoSync 联动测试（审计项 W-M1 恢复）：design/review 文档写入后 best-effort 同步
 * `.graycode/progress.md`（创建/追加 artifact_changed 日志/更新 activeArtifacts），
 * 失败只进 warnings 不阻断主流程。
 *
 * 与旧语义对照（A:/api/Gray-Code-main/backend/tools/progress/autoSync.ts）：
 * - design 写入 → activeArtifacts.design = path、日志「同步设计文档：<path>」、
 *   progress 缺失时初始化（phase 'design'）；
 * - review 写入 → activeArtifacts.review = path、日志 eventMessage、
 *   progress 缺失时初始化（phase 'review'）；
 * - 同步失败 → 返回 warnings 数组（「Failed to auto-sync progress after ...」），
 *   主文档照常写入成功。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { executeCreateDesign, executeUpdateDesign } from '../../src/workflows/tools/design.ts'
import {
  executeCreateReview,
  executeFinalizeReview,
  executeRecordReviewMilestone,
  executeReopenReview,
} from '../../src/workflows/tools/review.ts'
import { validateProgressDocument } from '../../src/workflows/domain/progress/documentLayout.ts'
import { resetReviewSessionStatesForTest } from '../../src/workflows/sessionState.ts'
import type { ToolDeps } from '../../src/workflows/workspace.ts'

let tmpDir: string
let deps: ToolDeps

function makeDeps(sessionId: string): ToolDeps {
  const ctx = new Context()
  const fs = new LocalFileSystem(ctx, { cwd: tmpDir, diffBasisMaxBytes: 10 * 1024 * 1024 })
  return { fs, cwd: tmpDir, sessionId }
}

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'graycode-autosync-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(path.join(tmpDir, '.graycode'), { recursive: true, force: true })
  resetReviewSessionStatesForTest()
  deps = makeDeps('auto-sync-session')
})

async function readProgressText(): Promise<string> {
  const target = await deps.fs.resolve('.graycode/progress.md', { cwd: tmpDir })
  return deps.fs.readText(target)
}

describe('design 写入联动 progress.md', () => {
  it('create_design 自动创建 progress.md（phase design、activeArtifacts.design、日志）', async () => {
    const created = await executeCreateDesign(deps, {
      title: 'Auth Flow',
      design: 'v1',
    }) as { path: string; warnings?: string[] }

    expect(created.warnings).toBeUndefined()

    const progressText = await readProgressText()
    const validation = validateProgressDocument(progressText)
    expect(validation.success).toBe(true)
    if (validation.success) {
      expect(validation.metadata.phase).toBe('design')
      expect(validation.metadata.activeArtifacts.design).toBe(created.path)
      expect(validation.metadata.log.some(entry =>
        entry.type === 'artifact_changed' && entry.refId === 'design' && entry.message === `同步设计文档：${created.path}`
      )).toBe(true)
    }
  })

  it('update_design 追加 progress 日志，不覆盖既有 activeArtifacts', async () => {
    const created = await executeCreateDesign(deps, {
      title: 'Auth Flow',
      design: 'v1',
    }) as { path: string }

    await executeUpdateDesign(deps, {
      path: created.path,
      design: 'v2',
      title: 'Auth Flow V2',
    })

    const progressText = await readProgressText()
    const validation = validateProgressDocument(progressText)
    expect(validation.success).toBe(true)
    if (validation.success) {
      // 两次同步各追加一条 design 日志
      const designLogs = validation.metadata.log.filter(entry => entry.refId === 'design')
      expect(designLogs.length).toBe(2)
      expect(validation.metadata.activeArtifacts.design).toBe(created.path)
    }
  })

  it('progress.md 已存在（合法）时同步只追加不重建', async () => {
    const ctx = new Context()
    const fs = new LocalFileSystem(ctx, { cwd: tmpDir, diffBasisMaxBytes: 10 * 1024 * 1024 })
    const progressDeps: ToolDeps = { fs, cwd: tmpDir, sessionId: 'p-session' }
    // 先手工创建 progress.md（固定 projectName）
    const { executeCreateProgress } = await import('../../src/workflows/tools/progress.ts')
    await executeCreateProgress(progressDeps, { projectName: 'MyProject' })

    await executeCreateDesign(deps, { title: 'Auth Flow', design: 'v1' })

    const validation = validateProgressDocument(await readProgressText())
    expect(validation.success).toBe(true)
    if (validation.success) {
      expect(validation.metadata.projectName).toBe('MyProject')
      expect(validation.metadata.activeArtifacts.design).toBe('.graycode/design/auth-flow.md')
    }
  })

  it('progress.md 损坏/非法时同步失败只返回 warnings，design 照常写入', async () => {
    // 手工写入非法 progress.md（父目录先行创建）
    await mkdir(path.join(tmpDir, '.graycode'), { recursive: true })
    await writeFile(path.join(tmpDir, '.graycode', 'progress.md'), 'not a valid progress document', 'utf8')

    const created = await executeCreateDesign(deps, {
      title: 'Broken Sync',
      design: 'v1',
    }) as { path: string; warnings?: string[] }

    // 主文档照常落盘成功
    const target = await deps.fs.resolve(created.path, { cwd: tmpDir })
    expect(await deps.fs.readText(target)).toBe('v1')
    // 同步失败进 warnings，不阻断
    expect(created.warnings).toBeDefined()
    expect(created.warnings!.some(w => w.startsWith('Failed to auto-sync progress after design write:'))).toBe(true)
  })
})

describe('review 写入联动 progress.md', () => {
  it('create_review 自动创建 progress.md（phase review、activeArtifacts.review、日志）', async () => {
    const created = await executeCreateReview(deps, {
      title: 'Workspace Review',
      review: 'scope',
    }) as { path: string; warnings?: string[] }

    expect(created.warnings).toBeUndefined()

    const validation = validateProgressDocument(await readProgressText())
    expect(validation.success).toBe(true)
    if (validation.success) {
      expect(validation.metadata.phase).toBe('review')
      expect(validation.metadata.activeArtifacts.review).toBe(created.path)
      expect(validation.metadata.log.some(entry =>
        entry.type === 'artifact_changed' && entry.refId === 'review' && entry.message === `同步审查文档：${created.path}`
      )).toBe(true)
    }
  })

  it('record/finalize/reopen 依次追加日志（里程碑/结论/重新打开）', async () => {
    const created = await executeCreateReview(deps, {
      title: 'Workspace Review',
      review: 'scope',
    }) as { path: string }

    await executeRecordReviewMilestone(deps, {
      path: created.path,
      milestoneTitle: '第一轮',
      summary: '摘要',
      conclusion: '结论一',
      recommendedNextAction: '下一步',
    })

    const finalized = await executeFinalizeReview(deps, {
      path: created.path,
      conclusion: '整体可接受',
    }) as { status: string }
    expect(finalized.status).toBe('completed')

    await executeReopenReview(deps, { path: created.path })

    const validation = validateProgressDocument(await readProgressText())
    expect(validation.success).toBe(true)
    if (validation.success) {
      const reviewLogs = validation.metadata.log.filter(entry => entry.refId === 'review')
      expect(reviewLogs.map(entry => entry.message)).toEqual([
        `同步审查文档：${created.path}`,
        '同步审查里程碑：M1',
        `同步审查结论：${created.path}`,
        `重新打开审查：${created.path}`,
      ])
      // record 时的 latestConclusion 在 finalize 时被最终结论覆盖（旧语义一致：
      // 每次 review 写后同步取当前快照的 latestConclusion）；nextAction 保持
      // record 写入的「下一步」（finalize 未提供时回退保留旧值）
      expect(validation.metadata.latestConclusion).toBe('整体可接受')
      expect(validation.metadata.nextAction).toBe('下一步')
    }
  })

  it('progress.md 非法时 review 同步失败只进 warnings，review 文档照常写入', async () => {
    await mkdir(path.join(tmpDir, '.graycode'), { recursive: true })
    await writeFile(path.join(tmpDir, '.graycode', 'progress.md'), 'garbage', 'utf8')

    const created = await executeCreateReview(deps, {
      title: 'Broken Review Sync',
      review: 'scope',
    }) as { path: string; warnings?: string[] }

    const target = await deps.fs.resolve(created.path, { cwd: tmpDir })
    expect(await deps.fs.readText(target)).toContain('# Broken Review Sync')
    expect(created.warnings!.some(w => w.startsWith('Failed to auto-sync progress after review write:'))).toBe(true)
  })
})
