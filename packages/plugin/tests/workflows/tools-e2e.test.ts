/**
 * 工具层端到端测试：真实临时目录 + 真实 fs（@deepseek-ai/dsh-fs-local），
 * 直接调用 handlers（deps 依赖注入，不经 ctx.tools 注册管线）。
 *
 * 覆盖：create_design/update_design、progress 四工具（含 per-path 写锁路径）、
 * review 六工具（含会话门闸与生命周期）。从源 gray-code-plugin 对应工具测试
 * （create_progress / record_progress_milestone / create_review / finalize_review /
 * reopen_review / update_design）改写。
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
import type { ReviewToolStructuredResultV4 } from '../../src/workflows/domain/review/schema.ts'
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

  it('concurrent create_design on the same path is serialized: exactly one wins, the loser is rejected', async () => {
    // 两个并行子代理同时对同一路径 create_design：per-path 写锁把「存在性检查+写入」
    // 串行化，后到者在锁内重查存在性后明确拒绝，不会静默覆盖先写者的文档
    const results = await Promise.allSettled([
      executeCreateDesign(deps, { title: 'Race', design: 'v1', path: '.graycode/design/race.md' }),
      executeCreateDesign(deps, { title: 'Race', design: 'v2', path: '.graycode/design/race.md' }),
    ])
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ path: string; content: string }> => r.status === 'fulfilled',
    )
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0]!.reason as Error).message).toMatch(/Design document already exists at .*Use update_design/)

    // 磁盘上是胜者的内容，未被败者回滚式覆盖
    expect(await readWorkspaceFile('.graycode/design/race.md')).toBe(fulfilled[0]!.value.content)
  })

  it('create_design prefixes Windows-reserved default filenames (title CON)', async () => {
    // Windows 保留设备名 con/aux/nul/prn/com1-9/lpt1-9 不能作为文件名：slug 加 `_` 前缀
    const created = await executeCreateDesign(deps, { title: 'CON', design: 'reserved' }) as { path: string }
    expect(created.path).toBe('.graycode/design/_con.md')
    expect(await readWorkspaceFile(created.path)).toBe('reserved')
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

  it('record_progress_milestone defaults to completed with completedAt when status is omitted', async () => {
    await executeCreateProgress(deps, { projectName: 'W' })

    const recorded = await executeRecordProgressMilestone(deps, {
      title: '默认完成里程碑',
      summary: '不传 status 时按源语义默认 completed。',
    }) as { progressSnapshot: { latestMilestone: { id: string; status: string } | undefined } }

    expect(recorded.progressSnapshot.latestMilestone).toMatchObject({
      id: 'PG1',
      status: 'completed',
    })

    // 产物必须带 completedAt（缺省为当前时间）
    const validation = validateProgressDocument(await readWorkspaceFile('.graycode/progress.md'))
    expect(validation.success).toBe(true)
    if (validation.success) {
      expect(validation.metadata.milestones[0]?.status).toBe('completed')
      expect(validation.metadata.milestones[0]?.completedAt).toBeTruthy()
    }
  })

  it('milestone id duplicate check is case-insensitive (PG1 vs pg1)', async () => {
    await executeCreateProgress(deps, { projectName: 'W' })

    await executeRecordProgressMilestone(deps, { milestoneId: 'PG1', title: '一', summary: 's1' })
    await expect(executeRecordProgressMilestone(deps, { milestoneId: 'pg1', title: '二', summary: 's2' }))
      .rejects.toThrow('Milestone id already exists: pg1')
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
      // record_review_milestone 经 extra 合并注入 milestoneId（V4 基类型未声明该字段）。
    }) as ReviewToolStructuredResultV4 & { milestoneId: string }

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

  it('validate_review_document on a corrupted V3 document returns a structured failure (H-12)', async () => {
    await mkdir(path.join(tmpDir, '.graycode', 'review'), { recursive: true })
    await writeFile(path.join(tmpDir, '.graycode', 'review', 'corrupted.md'), [
      '# Corrupted Review',
      '- Date: 2026-04-03',
      '- Status: in_progress',
      '',
      '## Review Scope',
      '审查范围说明',
      '',
      '## Review Summary',
      '<!-- GRAYCODE_REVIEW_SUMMARY_START -->',
      '- 当前状态：进行中',
      '<!-- GRAYCODE_REVIEW_SUMMARY_END -->',
      '',
      '## Review Findings',
      '<!-- GRAYCODE_REVIEW_FINDINGS_START -->',
      '- [high] html: 缺少 landmark',
      '<!-- GRAYCODE_REVIEW_FINDINGS_END -->',
      '',
      '## Review Milestones',
      '<!-- GRAYCODE_REVIEW_MILESTONES_START -->',
      '<!-- GRAYCODE_REVIEW_MILESTONES_END -->',
      '',
      '<!-- GRAYCODE_REVIEW_METADATA_START -->',
      '{ "formatVersion": 3, "reviewRunId": "review-',
      '<!-- GRAYCODE_REVIEW_METADATA_END -->',
    ].join('\n'), 'utf-8')

    // 修复前：损坏 metadata 直接抛 Error；修复后：结构化校验失败结果（v2/v4 分支同口径）
    const validated = await executeValidateReviewDocument(deps, { path: '.graycode/review/corrupted.md' })
    expect(validated.isValid).toBe(false)
    expect(validated.detectedFormat).toBe('v3')
    expect(validated.issues?.some((item) => item.code === 'invalid_v3_metadata')).toBe(true)
    expectLosslessJson(validated)
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

  it('concurrent create_review in the same session with different paths: exactly one wins, the other is rejected', async () => {
    // 会话门闸检查在临界区内（per-path 写锁 + per-session 锁）重查：同一会话并发
    // 创建两个不同路径的 review 时，后到者被门闸拦截，不会覆盖先建者的会话状态
    // 而产生孤儿 review 文档
    const results = await Promise.allSettled([
      executeCreateReview(deps, { title: 'Concurrent A', review: 'scope a', path: '.graycode/review/concurrent-a.md' }),
      executeCreateReview(deps, { title: 'Concurrent B', review: 'scope b', path: '.graycode/review/concurrent-b.md' }),
    ])
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ path: string }> => r.status === 'fulfilled')
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0]!.reason as Error).message)
      .toMatch(/An active review session already exists for this conversation/)

    // 败者在写盘前被门闸拦截：磁盘上恰好只有一个 review 文档（无孤儿文件）
    const aExists = await deps.fs.stat(await deps.fs.resolve('.graycode/review/concurrent-a.md', { cwd: tmpDir }))
    const bExists = await deps.fs.stat(await deps.fs.resolve('.graycode/review/concurrent-b.md', { cwd: tmpDir }))
    expect([aExists !== undefined, bExists !== undefined].filter(Boolean)).toHaveLength(1)
  })

  it('review milestone duplicate check is case-insensitive (M1 vs m1)', async () => {
    const created = await executeCreateReview(deps, { title: 'Dup Review', review: 'scope' }) as { path: string }

    await executeRecordReviewMilestone(deps, { path: created.path, milestoneId: 'M1', milestoneTitle: '一', summary: 's1' })
    await expect(executeRecordReviewMilestone(deps, { path: created.path, milestoneId: 'm1', milestoneTitle: '二', summary: 's2' }))
      .rejects.toThrow('Duplicate milestone id is not allowed: m1')
  })

  it('compare_review_documents treats description/evidence edits as finding identity changes', async () => {
    const a = await executeCreateReview(deps, { title: 'Compare Edit A', review: 'scope a' }) as { path: string }

    await executeRecordReviewMilestone(deps, {
      path: a.path,
      milestoneTitle: '第一轮',
      summary: '摘要',
      structuredFindings: [
        {
          severity: 'high',
          category: 'html',
          title: 'editable finding',
          description: 'd1',
          evidence: [{ path: 'src/a.ts', lineStart: 1 }],
        },
      ],
    })

    const b = await executeCreateReview(makeDeps('session-edit-b'), { title: 'Compare Edit B', review: 'scope b' }) as { path: string }

    // 原项目比较协议把 description 与 evidence 纳入稳定键：改写正文会形成新 finding。
    await executeRecordReviewMilestone(makeDeps('session-edit-b'), {
      path: b.path,
      milestoneTitle: '第二轮',
      summary: '摘要二',
      structuredFindings: [
        {
          severity: 'high',
          category: 'html',
          title: 'editable finding',
          description: 'D1 已重写',
          evidence: [{ path: 'src/a.ts', lineStart: 1 }],
        },
      ],
    })

    const compareDesc = await executeCompareReviewDocuments(deps, { basePath: a.path, targetPath: b.path }) as {
      summary: { addedFindings: number; removedFindings: number; persistedFindings: number; evidenceChanged: number }
      findings: { added: unknown[]; removed: unknown[]; persisted: Array<{ changes: string[] }> }
    }
    expect(compareDesc.summary.addedFindings).toBe(1)
    expect(compareDesc.summary.removedFindings).toBe(1)
    expect(compareDesc.summary.persistedFindings).toBe(0)
    expect(compareDesc.findings.persisted).toHaveLength(0)
    expect(compareDesc.summary.evidenceChanged).toBe(0)

    const c = await executeCreateReview(makeDeps('session-edit-c'), { title: 'Compare Edit C', review: 'scope c' }) as { path: string }

    // 证据也参与稳定键，换证据同样是删除旧 finding 并新增一条。
    await executeRecordReviewMilestone(makeDeps('session-edit-c'), {
      path: c.path,
      milestoneTitle: '第三轮',
      summary: '摘要三',
      structuredFindings: [
        {
          severity: 'high',
          category: 'html',
          title: 'editable finding',
          description: 'd1',
          evidence: [{ path: 'src/b.ts', lineStart: 5 }],
        },
      ],
    })

    const compareEvidence = await executeCompareReviewDocuments(deps, { basePath: a.path, targetPath: c.path }) as {
      summary: { addedFindings: number; removedFindings: number; persistedFindings: number; evidenceChanged: number }
      findings: { persisted: Array<{ changes: string[] }> }
    }
    expect(compareEvidence.summary.addedFindings).toBe(1)
    expect(compareEvidence.summary.removedFindings).toBe(1)
    expect(compareEvidence.summary.persistedFindings).toBe(0)
    expect(compareEvidence.findings.persisted).toHaveLength(0)
    expect(compareEvidence.summary.evidenceChanged).toBe(0)
  })

  it('create_review prefixes Windows-reserved default filenames (title NUL)', async () => {
    const created = await executeCreateReview(deps, { title: 'NUL', review: 'scope' }) as { path: string }
    expect(created.path).toBe('.graycode/review/_nul.md')
  })

  it('compare_review_documents reports severity edits as persisted changes', async () => {
    const a = await executeCreateReview(deps, { title: 'Compare Sev A', review: 'scope a' }) as { path: string }

    await executeRecordReviewMilestone(deps, {
      path: a.path,
      milestoneTitle: '第一轮',
      summary: '摘要',
      structuredFindings: [
        { severity: 'low', category: 'html', title: 'same finding', description: 'same description' },
      ],
    })

    const b = await executeCreateReview(makeDeps('session-sev-b'), { title: 'Compare Sev B', review: 'scope b' }) as { path: string }
    // 严重级别不属于 finding 身份，因此 low → high 应保留同一 finding 并报告变化。
    await executeRecordReviewMilestone(makeDeps('session-sev-b'), {
      path: b.path,
      milestoneTitle: '第二轮',
      summary: '摘要二',
      structuredFindings: [
        { severity: 'high', category: 'html', title: 'same finding', description: 'same description' },
      ],
    })

    const compare = await executeCompareReviewDocuments(deps, {
      basePath: a.path,
      targetPath: b.path,
      includeUnchanged: true,
    }) as {
      summary: { addedFindings: number; removedFindings: number; persistedFindings: number; severityChanged: number }
      findings: { persisted: Array<{ changes: string[] }> }
    }

    expect(compare.summary.addedFindings).toBe(0)
    expect(compare.summary.removedFindings).toBe(0)
    expect(compare.summary.persistedFindings).toBe(1)
    expect(compare.summary.severityChanged).toBe(1)
    expect(compare.findings.persisted[0]?.changes).toContain('severity')
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

describe('lossless-JSON output contract (H-1)', () => {
  it('tool results never contain undefined values, including nested optional fields', async () => {
    // design：无可选字段，基线
    const design = await executeCreateDesign(deps, { title: 'Json', design: 'content' })
    expectLosslessJson(design)

    // progress：create 无里程碑时 progressSnapshot.latestMilestone 必须省略键
    const progress = await executeCreateProgress(deps, { projectName: 'Json' })
    expectLosslessJson(progress)
    expect(progress.progressSnapshot?.latestMilestone).toBeUndefined()

    const validated = await executeValidateProgressDocument(deps, { path: '.graycode/progress.md' })
    expectLosslessJson(validated)

    // 有里程碑后 metadata.milestones 的可选字段（startedAt/completedAt）与
    // log 的 refId 不得以 undefined 值键出现在 validate 结果里
    await executeRecordProgressMilestone(deps, { title: '里程碑', summary: '摘要' })
    const recordedProgress = await executeValidateProgressDocument(deps, { path: '.graycode/progress.md' })
    expectLosslessJson(recordedProgress)

    // review：create 后 reviewSnapshot/结构字段齐全
    const review = await executeCreateReview(deps, { title: 'Json Review', review: 'scope' })
    expectLosslessJson(review)

    // record：不传 description/recommendation、evidence 只给 path 时，
    // 快照内 finding/evidence 的可选字段必须省略而非携带 undefined
    const recordedReview = await executeRecordReviewMilestone(deps, {
      path: review.path,
      milestoneTitle: '第一轮',
      summary: '摘要',
      structuredFindings: [
        { severity: 'high', category: 'html', title: '缺少 landmark', evidence: [{ path: 'src/index.html' }] },
      ],
    })
    expectLosslessJson(recordedReview)

    const reviewValidation = await executeValidateReviewDocument(deps, { path: review.path })
    expectLosslessJson(reviewValidation)
  })
})
