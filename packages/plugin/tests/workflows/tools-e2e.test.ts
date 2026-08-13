/**
 * 工具层端到端测试：真实临时目录 + 真实 fs（@deepseek-ai/dsh-fs-local），
 * 直接调用 handlers（deps 依赖注入，不经 ctx.tools 注册管线）。
 *
 * 覆盖：create_design/update_design、progress 四工具（含 per-path 写锁路径）、
 * review 六工具（含会话门闸与生命周期）。从源 gray-code-plugin 对应工具测试
 * （create_progress / record_progress_milestone / create_review / finalize_review /
 * reopen_review / update_design）改写。
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { executeCreateDesign, executeUpdateDesign } from '../../src/workflows/tools/design.ts'
import {
  executeCreateProgress,
  executeRecordProgressMilestone,
  executeUpdateProgress,
  executeValidateProgressDocument,
} from '../../src/workflows/tools/progress.ts'
import {
  executeCompareReviewDocuments,
  executeCreateReview,
  executeFinalizeReview,
  executeRecordReviewMilestone,
  executeReopenReview,
  executeValidateReviewDocument,
} from '../../src/workflows/tools/review.ts'
import { resetReviewSessionStatesForTest } from '../../src/workflows/sessionState.ts'
import { validateProgressDocument } from '../../src/workflows/domain/progress/documentLayout.ts'
import { validateReviewDocument } from '../../src/workflows/domain/review/reviewDocumentSection.ts'
import type { ToolDeps } from '../../src/workflows/workspace.ts'

let tmpDir: string
let deps: ToolDeps

function makeDeps(sessionId: string): ToolDeps {
  const ctx = new Context()
  const fs = new LocalFileSystem(ctx, { cwd: tmpDir, diffBasisMaxBytes: 10 * 1024 * 1024 })
  return { fs, cwd: tmpDir, sessionId }
}

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'graycode-workflows-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  resetReviewSessionStatesForTest()
  await rm(path.join(tmpDir, '.graycode'), { recursive: true, force: true })
  deps = makeDeps('test-session')
})

async function readWorkspaceFile(relPath: string): Promise<string> {
  const target = await deps.fs.resolve(relPath, { cwd: tmpDir })
  return deps.fs.readText(target)
}

describe('design tools', () => {
  it('create_design writes the document immediately; a second create is rejected', async () => {
    const created = await executeCreateDesign(deps, {
      title: 'Auth Flow',
      design: '第一行\n第二行\r\nCRLF 行',
    }) as { path: string; content: string }

    expect(created.path).toBe('.graycode/design/auth-flow.md')
    expect(created.content).not.toContain('\r')

    const onDisk = await readWorkspaceFile(created.path)
    expect(onDisk).toContain('第一行')
    expect(onDisk).not.toContain('\r')

    await expect(executeCreateDesign(deps, {
      design: '覆盖尝试',
      path: created.path,
    })).rejects.toThrow(/Design document already exists at .*Use update_design/)
  })

  it('update_design rewrites an existing document and reports changeSummary', async () => {
    const created = await executeCreateDesign(deps, {
      title: 'Auth Flow',
      design: 'v1',
    }) as { path: string }

    const updated = await executeUpdateDesign(deps, {
      path: created.path,
      design: 'v2',
      changeSummary: 'updated scope',
    }) as { path: string; content: string; changeSummary?: string }

    expect(updated.content).toBe('v2')
    expect(updated.changeSummary).toBe('updated scope')
    expect(await readWorkspaceFile(created.path)).toBe('v2')
  })

  it('update_design rejects a missing document and out-of-scope paths', async () => {
    await expect(executeUpdateDesign(deps, {
      path: '.graycode/design/missing.md',
      design: 'x',
    })).rejects.toThrow('Design document does not exist')

    await expect(executeUpdateDesign(deps, {
      path: '.graycode/plans/x.md',
      design: 'x',
    })).rejects.toThrow(/Invalid design path/)
  })
})

describe('progress tools', () => {
  it('create → validate → update → record milestone round-trip', async () => {
    const created = await executeCreateProgress(deps, {
      projectName: 'Workspace',
      phase: 'plan',
      currentFocus: '实现项目进度文档',
      latestConclusion: '确认需要 Progress 能力',
      nextAction: '开始实现后台工具',
      activeArtifacts: { plan: '.graycode/plans/progress-tools.plan.md' },
      todos: [{ id: 'progress-01', content: '实现后台工具', status: 'pending' }],
      risks: [{ id: 'risk-01', title: '范围蔓延', status: 'active', description: '约束范围' }],
    }) as { path: string; projectName: string; phase: string; progressSnapshot: { path: string; projectName: string; status: string; phase: string } }

    expect(created.path).toBe('.graycode/progress.md')
    expect(created.projectName).toBe('Workspace')
    expect(created.progressSnapshot).toMatchObject({
      path: '.graycode/progress.md',
      projectName: 'Workspace',
      status: 'active',
      phase: 'plan',
    })

    const onDisk = await readWorkspaceFile('.graycode/progress.md')
    expect(onDisk).toContain('# 项目进度')
    expect(onDisk).toContain('<!-- GRAYCODE_PROGRESS_METADATA_START -->')

    const validated = await executeValidateProgressDocument(deps, { path: '.graycode/progress.md' }) as {
      isValid: boolean
      issueCount: number
      progressValidation: { metadata: { projectName?: string } }
    }
    expect(validated.isValid).toBe(true)
    expect(validated.issueCount).toBe(0)
    expect(validated.progressValidation.metadata.projectName).toBe('Workspace')

    const updated = await executeUpdateProgress(deps, {
      status: 'active',
      phase: 'implementation',
      latestConclusion: '进度文档已就绪',
      appendLog: [{ type: 'updated', message: '更新进度' }],
    }) as { status: string; phase: string; progressDelta: { type: string; changedFields: string[] } }

    expect(updated.status).toBe('active')
    expect(updated.phase).toBe('implementation')
    expect(updated.progressDelta.changedFields).toEqual(expect.arrayContaining(['header', 'summary', 'log']))

    const recorded = await executeRecordProgressMilestone(deps, {
      title: '完成后台工具',
      summary: 'schema、documentLayout 与工具骨架。',
      status: 'completed',
      relatedTodoIds: ['progress-01'],
      latestConclusion: '后台工具已完成。',
      nextAction: '开始编写测试。',
    }) as { progressSnapshot: { latestMilestone: { id: string; title: string; status: string } | undefined }; progressDelta: { milestoneId: string } }

    expect(recorded.progressSnapshot.latestMilestone).toMatchObject({
      id: 'PG1',
      title: '完成后台工具',
      status: 'completed',
    })
    expect(recorded.progressDelta.milestoneId).toBe('PG1')

    const finalDisk = await readWorkspaceFile('.graycode/progress.md')
    expect(finalDisk).toContain('PG1')
    expect(validateProgressDocument(finalDisk).success).toBe(true)
  })

  it('rejects a duplicate milestone id and auto-increments past custom ids', async () => {
    await executeCreateProgress(deps, { projectName: 'W' })

    await executeRecordProgressMilestone(deps, { milestoneId: 'PG1', title: '一', summary: 's1' })
    await expect(executeRecordProgressMilestone(deps, { milestoneId: 'PG1', title: '二', summary: 's2' }))
      .rejects.toThrow('Milestone id already exists: PG1')

    const recorded = await executeRecordProgressMilestone(deps, { title: '三', summary: 's3' }) as {
      progressSnapshot: { latestMilestone: { id: string } | undefined }
    }
    expect(recorded.progressSnapshot.latestMilestone?.id).toBe('PG2')
  })

  it('create_progress returns the existing snapshot when the document already exists and is valid', async () => {
    await executeCreateProgress(deps, { projectName: 'Workspace' })

    const second = await executeCreateProgress(deps, { projectName: 'Another' }) as { warnings?: string[]; projectName: string }

    expect(second.projectName).toBe('Workspace')
    expect(second.warnings).toEqual([
      'Progress document already exists at .graycode/progress.md. Returned the existing snapshot instead of creating a second file.',
    ])
    const onDisk = await readWorkspaceFile('.graycode/progress.md')
    expect(onDisk).toContain('Workspace')
  })

  it('rejects out-of-scope progress paths', async () => {
    await expect(executeCreateProgress(deps, { path: '.graycode/design/x.md' }))
      .rejects.toThrow(/Invalid progress path/)
  })
})

describe('review tools (lifecycle + session gate)', () => {
  it('create → record → finalize → reopen round-trip', async () => {
    const created = await executeCreateReview(deps, {
      title: 'Workspace Review',
      overview: 'Review the current workspace end-to-end',
      review: 'Initial review scope',
    }) as { path: string; content: string; reviewSnapshot: { formatVersion: number; status: string }; reviewValidation: { detectedFormat: string }; reviewDelta: { type: string }; title: string; status: string; totalMilestones: number; totalFindings: number }

    expect(created.path).toBe('.graycode/review/workspace-review.md')
    expect(created.content).toContain('# Workspace Review')
    expect(created.content).toContain('```json')
    expect(created.reviewSnapshot.formatVersion).toBe(4)
    expect(created.reviewValidation.detectedFormat).toBe('v4')
    expect(created.reviewDelta).toMatchObject({ type: 'created' })
    expect(created.title).toBe('Workspace Review')
    expect(created.status).toBe('in_progress')
    expect(created.totalMilestones).toBe(0)
    expect(created.totalFindings).toBe(0)

    const recorded = await executeRecordReviewMilestone(deps, {
      path: created.path,
      milestoneTitle: 'HTML 结构审查',
      summary: '完成首页 HTML 结构检查。',
      conclusion: '首页结构总体良好',
      evidenceFiles: ['src/index.html'],
      structuredFindings: [
        {
          severity: 'high',
          category: 'html',
          title: '缺少 main landmark',
          description: '首页缺少 <main> 语义地标。',
        },
      ],
      reviewedModules: ['src/index.html'],
    }) as { status: string; totalMilestones: number; totalFindings: number; milestoneId: string }

    expect(recorded.milestoneId).toBe('M1')
    expect(recorded.totalMilestones).toBe(1)
    expect(recorded.totalFindings).toBe(1)

    const finalized = await executeFinalizeReview(deps, {
      path: created.path,
      conclusion: '整体可接受',
      overallDecision: 'conditionally_accepted',
      recommendedNextAction: '修复高危问题后合并',
    }) as { status: string; overallDecision: string | null }

    expect(finalized.status).toBe('completed')
    expect(finalized.overallDecision).toBe('conditionally_accepted')

    const validatedAfterFinalize = await executeValidateReviewDocument(deps, { path: created.path }) as {
      isValid: boolean
      status: string
      totalMilestones: number
    }
    expect(validatedAfterFinalize.isValid).toBe(true)
    expect(validatedAfterFinalize.status).toBe('completed')
    expect(validatedAfterFinalize.totalMilestones).toBe(1)

    const reopened = await executeReopenReview(deps, { path: created.path }) as { status: string }
    expect(reopened.status).toBe('in_progress')

    const validatedAfterReopen = await executeValidateReviewDocument(deps, { path: created.path }) as { status: string }
    expect(validatedAfterReopen.status).toBe('in_progress')
  })

  it('blocks a second active review in the same session; record/finalize require a matching session', async () => {
    const created = await executeCreateReview(deps, {
      title: 'Review A',
      review: 'scope a',
    }) as { path: string }

    await expect(executeCreateReview(deps, {
      title: 'Review B',
      review: 'scope b',
    })).rejects.toThrow(/An active review session already exists for this conversation/)

    await expect(executeRecordReviewMilestone(deps, {
      path: '.graycode/review/review-b.md',
      milestoneTitle: 'x',
      summary: 'y',
    })).rejects.toThrow(/Active review session path mismatch/)

    const finalized = await executeFinalizeReview(deps, {
      path: created.path,
      conclusion: 'done',
    }) as { status: string }
    expect(finalized.status).toBe('completed')

    await expect(executeRecordReviewMilestone(deps, {
      path: created.path,
      milestoneTitle: 'after finalize',
      summary: 'y',
    })).rejects.toThrow(/already finalized for path/)

    const reopened = await executeReopenReview(deps, { path: created.path }) as { status: string }
    expect(reopened.status).toBe('in_progress')

    await expect(executeReopenReview(deps, { path: created.path }))
      .rejects.toThrow('The review session is already active for path')
  })

  it('session gates are per-session: a different session id is not blocked', async () => {
    const created = await executeCreateReview(deps, {
      title: 'Session A Review',
      review: 'scope a',
    }) as { path: string }

    const other = makeDeps('other-session')
    const otherRecorded = await executeRecordReviewMilestone(other, {
      path: created.path,
      milestoneTitle: '子代理追加',
      summary: '从另一个会话继续。',
    }) as { totalMilestones: number }

    expect(otherRecorded.totalMilestones).toBe(1)
  })

  it('create_review rejects an existing document', async () => {
    await executeCreateReview(deps, {
      title: 'Existing Review',
      review: 'scope',
    }) as { path: string }

    await expect(executeCreateReview(makeDeps('other-session'), {
      title: 'Existing Review',
      review: 'another scope',
    })).rejects.toThrow(/Review document already exists/)
  })

  it('compare_review_documents reports finding deltas between two reviews', async () => {
    const a = await executeCreateReview(deps, {
      title: 'Compare A',
      review: 'scope a',
    }) as { path: string }

    await executeRecordReviewMilestone(deps, {
      path: a.path,
      milestoneTitle: '第一轮',
      summary: '摘要',
      structuredFindings: [
        { severity: 'high', category: 'html', title: 'shared finding', description: 'd1' },
      ],
    })

    const finalized = await executeFinalizeReview(deps, {
      path: a.path,
      conclusion: 'conclusion a',
      overallDecision: 'accepted',
    }) as { status: string }
    expect(finalized.status).toBe('completed')

    const b = await executeCreateReview(makeDeps('session-b'), {
      title: 'Compare B',
      review: 'scope b',
    }) as { path: string }

    await executeRecordReviewMilestone(makeDeps('session-b'), {
      path: b.path,
      milestoneTitle: '第二轮',
      summary: '摘要二',
      structuredFindings: [
        { severity: 'high', category: 'html', title: 'shared finding', description: 'd1' },
        { severity: 'low', category: 'css', title: 'new finding', description: 'd2' },
      ],
    })

    const compare = await executeCompareReviewDocuments(deps, {
      basePath: a.path,
      targetPath: b.path,
    }) as {
      summary: { addedFindings: number; removedFindings: number; persistedFindings: number }
      base: { path: string; status: string }
      target: { path: string; status: string }
    }

    expect(compare.base.path).toBe(a.path)
    expect(compare.base.status).toBe('completed')
    expect(compare.target.path).toBe(b.path)
    expect(compare.summary.addedFindings).toBe(1)
    expect(compare.summary.removedFindings).toBe(0)
    expect(compare.summary.persistedFindings).toBe(1)
  })
})

describe('fs write helpers', () => {
  it('writeTargetText creates parent directories recursively', async () => {
    await executeCreateDesign(deps, {
      path: '.graycode/design/nested/deep/doc.md',
      design: 'content',
    })
    const info = await stat(path.join(tmpDir, '.graycode', 'design', 'nested', 'deep', 'doc.md'))
    expect(info.isFile()).toBe(true)
  })

  it('raw node fs reads confirm the written bytes are UTF-8 LF text', async () => {
    await executeCreateProgress(deps, { projectName: 'W' })
    const bytes = await readFile(path.join(tmpDir, '.graycode', 'progress.md'), 'utf-8')
    expect(bytes).toContain('# 项目进度')
    expect(bytes).not.toContain('\r')
  })
})
