/**
 * review reviewDocumentSection 领域测试：V4 文档 build → validate → finalize →
 * reopen 生命周期、升级与 invariants
 *
 * 从源 gray-code-plugin `backend/__tests__/tools/create_review.test.ts` /
 * `finalize_review.test.ts` / `reopen_review.test.ts` 改写（领域层断言）。
 */

import { describe, expect, it } from 'vitest'
import {
  appendReviewMilestone,
  buildInitialReviewDocument,
  detectReviewDocumentFormat,
  finalizeReviewDocument,
  reopenReviewDocument,
  summarizeReviewDocument,
  upgradeReviewDocumentToV4,
  validateReviewDocument,
} from '../../src/workflows/domain/review/reviewDocumentSection.ts'

function buildInitialDoc(): string {
  return buildInitialReviewDocument({
    title: 'Workspace Review',
    overview: 'Review the current workspace end-to-end',
    review: 'Initial review scope',
  }, 'en')
}

describe('buildInitialReviewDocument', () => {
  it('builds a valid V4 document with an embedded snapshot', () => {
    const content = buildInitialDoc()
    expect(content).toContain('# Workspace Review')
    expect(content).toContain('## Review Scope')
    expect(content).toContain('## Review Summary')
    expect(content).toContain('## Review Findings')
    expect(content).toContain('## Review Milestones')
    expect(content).toContain('## Review Final Conclusion')
    expect(content).toContain('## Review Snapshot')
    expect(content).toContain('```json')
    expect(content).toContain('"formatVersion": 4')

    expect(detectReviewDocumentFormat(content)).toBe('v4')

    const validation = validateReviewDocument(content)
    expect(validation.detectedFormat).toBe('v4')
    expect(validation.formatVersion).toBe(4)
    expect(validation.isValid).toBe(true)
    expect(validation.canAutoUpgrade).toBe(false)
    expect(validation.issues).toHaveLength(0)
    expect(validation.reviewSnapshot?.kind).toBe('graycode.review')
    expect(validation.reviewSnapshot?.status).toBe('in_progress')
    expect(validation.reviewSnapshot?.render.locale).toBe('en')
    expect(validation.reviewSnapshot?.stats.totalMilestones).toBe(0)
    expect(validation.reviewSnapshot?.stats.totalFindings).toBe(0)
  })

  it('summarizeReviewDocument returns summary fields driven by the snapshot', () => {
    const summary = summarizeReviewDocument(buildInitialDoc())
    expect(summary.title).toBe('Workspace Review')
    expect(summary.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(summary.status).toBe('in_progress')
    expect(summary.overallDecision).toBeNull()
    expect(summary.totalMilestones).toBe(0)
    expect(summary.totalFindings).toBe(0)
    expect(summary.reviewSnapshot?.reviewRunId).toMatch(/^review-/)
  })
})

describe('appendReviewMilestone', () => {
  it('appends a milestone with structured findings and links evidence', () => {
    const result = appendReviewMilestone(buildInitialDoc(), {
      milestoneTitle: 'HTML 结构审查',
      summary: '完成首页 HTML 结构检查。',
      status: 'completed',
      conclusion: '首页结构总体良好',
      evidenceFiles: ['src/index.html'],
      structuredFindings: [
        {
          severity: 'high',
          category: 'html',
          title: '缺少 main landmark',
          description: '首页缺少 <main> 语义地标。',
          evidence: [{ path: 'src/index.html', lineStart: 5 }],
        },
      ],
      reviewedModules: ['src/index.html'],
      recommendedNextAction: '补充 landmark 后复查',
    }, 'en')

    expect(result.milestoneId).toBe('M1')
    expect(result.milestoneCount).toBe(1)
    expect(result.completedMilestones).toBe(1)
    expect(result.addedFindingIds).toHaveLength(1)
    expect(result.findings[0]).toContain('缺少 main landmark')
    expect(result.reviewSnapshot?.status).toBe('in_progress')
    expect(result.reviewSnapshot?.stats.totalFindings).toBe(1)
    expect(result.reviewSnapshot?.stats.severity.high).toBe(1)
    expect(result.reviewSnapshot?.milestones[0]?.findingIds).toContain(result.addedFindingIds[0])
    expect(result.content).toContain('### M1 · HTML 结构审查')
    expect(result.content).toContain('缺少 main landmark')

    const validation = validateReviewDocument(result.content)
    expect(validation.isValid).toBe(true)
    expect(validation.issues).toHaveLength(0)
  })

  it('merges legacy finding strings into structured findings', () => {
    const result = appendReviewMilestone(buildInitialDoc(), {
      milestoneTitle: 'CSS 审查',
      summary: '样式检查。',
      findings: ['按钮颜色对比度不足'],
      evidenceFiles: ['src/style.css'],
    }, 'en')

    expect(result.addedFindingIds).toHaveLength(1)
    expect(result.findings[0]).toContain('按钮颜色对比度不足')
    expect(result.reviewSnapshot?.findings[0]?.evidence[0]?.path).toBe('src/style.css')
  })

  it('rejects a duplicate milestone id', () => {
    const first = appendReviewMilestone(buildInitialDoc(), {
      milestoneTitle: '第一次',
      summary: '摘要一',
    }, 'en')
    expect(() => appendReviewMilestone(first.content, {
      milestoneId: 'M1',
      milestoneTitle: '第二次',
      summary: '摘要二',
    }, 'en')).toThrow(/Duplicate milestone id is not allowed: M1/)
  })

  it('rejects recording a milestone for a finalized document', () => {
    const finalized = finalizeReviewDocument(buildInitialDoc(), {
      conclusion: '整体结论',
      overallDecision: 'accepted',
    }, 'en')
    expect(() => appendReviewMilestone(finalized.content, {
      milestoneTitle: '追加',
      summary: '摘要',
    }, 'en')).toThrow('Cannot record a milestone for a finalized review document.')
  })
})

describe('finalizeReviewDocument', () => {
  it('finalizes the document and stamps finalizedAt', () => {
    const withMilestone = appendReviewMilestone(buildInitialDoc(), {
      milestoneTitle: '审查里程碑',
      summary: '摘要',
    }, 'en')
    const result = finalizeReviewDocument(withMilestone.content, {
      conclusion: '整体可接受',
      overallDecision: 'conditionally_accepted',
      recommendedNextAction: '修复高危问题后合并',
      reviewedModules: ['src/'],
    }, 'en')

    expect(result.overallDecision).toBe('conditionally_accepted')
    expect(result.reviewSnapshot?.status).toBe('completed')
    expect(result.reviewSnapshot?.finalizedAt).toBeTruthy()
    expect(result.reviewSnapshot?.summary.latestConclusion).toBe('整体可接受')
    expect(result.content).toContain('- Overall decision: Conditionally Accepted')

    const validation = validateReviewDocument(result.content)
    expect(validation.isValid).toBe(true)
    expect(validation.reviewSnapshot?.status).toBe('completed')
  })
})

describe('reopenReviewDocument', () => {
  it('reopens a finalized document back to in_progress', () => {
    const finalized = finalizeReviewDocument(buildInitialDoc(), {
      conclusion: '结论',
      overallDecision: 'accepted',
    }, 'en')
    const result = reopenReviewDocument(finalized.content, 'en')

    expect(result.reviewSnapshot?.status).toBe('in_progress')
    expect(result.reviewSnapshot?.finalizedAt).toBeNull()
    expect(result.reviewSnapshot?.overallDecision).toBeNull()

    const validation = validateReviewDocument(result.content)
    expect(validation.isValid).toBe(true)
    expect(validation.reviewSnapshot?.status).toBe('in_progress')
  })

  it('rejects reopening a document that is not finalized', () => {
    expect(() => reopenReviewDocument(buildInitialDoc(), 'en')).toThrow(
      'Cannot reopen a review document that is not finalized.'
    )
  })
})

describe('upgradeReviewDocumentToV4', () => {
  it('upgrades a legacy V2 document to V4', () => {
    const v2 = [
      '# Legacy Review',
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
      '- 发现一个问题',
      '<!-- GRAYCODE_REVIEW_FINDINGS_END -->',
      '',
      '## Review Milestones',
      '<!-- GRAYCODE_REVIEW_MILESTONES_START -->',
      '### M1 · 第一轮',
      '- Status: completed',
      '<!-- GRAYCODE_REVIEW_MILESTONES_END -->',
    ].join('\n')

    expect(detectReviewDocumentFormat(v2)).toBe('v2')
    const validation = validateReviewDocument(v2)
    expect(validation.detectedFormat).toBe('v2')
    expect(validation.isValid).toBe(true)
    expect(validation.canAutoUpgrade).toBe(true)
    expect(validation.issues.some((item) => item.code === 'upgrade_required')).toBe(true)
    expect(validation.reviewSnapshot?.stats.totalFindings).toBe(1)
    expect(validation.reviewSnapshot?.stats.totalMilestones).toBe(1)

    const upgraded = upgradeReviewDocumentToV4(v2)
    expect(detectReviewDocumentFormat(upgraded)).toBe('v4')
    const upgradedValidation = validateReviewDocument(upgraded)
    expect(upgradedValidation.isValid).toBe(true)
    expect(upgradedValidation.reviewSnapshot?.findings[0]?.title).toBe('发现一个问题')
  })
})
