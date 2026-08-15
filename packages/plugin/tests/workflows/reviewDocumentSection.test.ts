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

  it('rejects a case-variant duplicate milestone id (M1 vs m1)', () => {
    const first = appendReviewMilestone(buildInitialDoc(), {
      milestoneId: 'M1',
      milestoneTitle: '第一次',
      summary: '摘要一',
    }, 'en')
    expect(() => appendReviewMilestone(first.content, {
      milestoneId: 'm1',
      milestoneTitle: '第二次',
      summary: '摘要二',
    }, 'en')).toThrow(/Duplicate milestone id is not allowed: m1/)
  })

  it('auto-generated milestone ids skip case variants of existing ids', () => {
    // 文档已有小写变体 m2：indexHint 产出的候选 M2 与 m2 大小写同义，
    // 自动生成器必须跳过 M2 取 M3（大小写不敏感查重）
    const first = appendReviewMilestone(buildInitialDoc(), {
      milestoneId: 'm2',
      milestoneTitle: '第一次',
      summary: '摘要一',
    }, 'en')
    const second = appendReviewMilestone(first.content, {
      milestoneTitle: '第二次',
      summary: '摘要二',
    }, 'en')
    expect(second.milestoneId).toBe('M3')
    expect(second.reviewSnapshot?.milestones.map((m) => m.id)).toEqual(['m2', 'M3'])
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

describe('code fence pairing in review scope (BUG: unclosed fence)', () => {
  it('buildInitialReviewDocument rejects an unpaired (odd) count of line-start ``` fences', () => {
    expect(() => buildInitialReviewDocument({
      title: 'Fenced Scope',
      review: '说明\n```\ncode\n```\n```\n更多',
    }, 'en')).toThrow(/unpaired code fence/)
  })

  it('buildInitialReviewDocument accepts paired fences in the scope', () => {
    const content = buildInitialReviewDocument({
      title: 'Paired Scope',
      review: '说明\n```\ncode\n```',
    }, 'en')
    expect(detectReviewDocumentFormat(content)).toBe('v4')
    expect(validateReviewDocument(content).isValid).toBe(true)
  })

  it('a document whose visible scope has an odd fence count still locates the Review Snapshot section', () => {
    const base = buildInitialDoc()
    // 手工编辑模拟：scope 正文注入一条多余的 ```（围栏配对被破坏，奇数围栏）
    const tampered = base.replace(
      '## Review Scope\nInitial review scope',
      '## Review Scope\n```\nInitial review scope\n```\n```'
    )

    const validation = validateReviewDocument(tampered)
    expect(validation.detectedFormat).toBe('v4')
    expect(validation.isValid).toBe(true)
    expect(validation.reviewSnapshot).toBeDefined()
    expect(validation.issues.some((item) => item.code === 'snapshot_section_count')).toBe(false)

    // record 不再被误导性错误卡死：追加里程碑成功且写回内容可重新校验通过
    const recorded = appendReviewMilestone(tampered, {
      milestoneTitle: '围栏修复',
      summary: '奇数围栏不应阻断 Snapshot 定位',
    }, 'en')
    expect(recorded.milestoneId).toBe('M1')
    expect(validateReviewDocument(recorded.content).isValid).toBe(true)
  })

  it('a snapshot whose scope markdown has odd fences is rendered defensively and self-heals', () => {
    const base = buildInitialDoc()
    // 手工编辑 snapshot JSON：scope.markdown 含奇数围栏（绕过输入校验）
    const jsonStart = base.indexOf('```json') + '```json'.length
    const jsonEnd = base.lastIndexOf('```')
    const parsed = JSON.parse(base.slice(jsonStart, jsonEnd)) as { scope: { markdown: string } }
    parsed.scope.markdown = '手工围栏\n```\n未闭合'
    const tampered = `${base.slice(0, jsonStart)}${JSON.stringify(parsed, null, 2)}${base.slice(jsonEnd)}`

    const recorded = appendReviewMilestone(tampered, {
      milestoneTitle: '转义修复',
      summary: '渲染时对奇数围栏做转义保护',
    }, 'en')

    const validation = validateReviewDocument(recorded.content)
    expect(validation.isValid).toBe(true)
    expect(validation.issues).toHaveLength(0)
    // 正文 scope 不再出现行首 ```（裸围栏被转义；快照自身的一对围栏除外）
    const scopeSection = recorded.content.slice(
      recorded.content.indexOf('## Review Scope'),
      recorded.content.indexOf('## Review Summary')
    )
    expect(scopeSection.split('\n').filter((line) => /^```/.test(line))).toHaveLength(0)
  })
})

describe('mergeFindingRecords', () => {
  it('re-submitting a structured finding with the same id updates severity/category/title', () => {
    const first = appendReviewMilestone(buildInitialDoc(), {
      milestoneTitle: '第一轮',
      summary: '摘要一',
      structuredFindings: [
        { id: 'F1', severity: 'high', category: 'html', title: '缺少 landmark', description: 'd1' },
      ],
    }, 'en')
    expect(first.addedFindingIds).toEqual(['F1'])

    const second = appendReviewMilestone(first.content, {
      milestoneTitle: '第二轮',
      summary: '摘要二',
      structuredFindings: [
        { id: 'F1', severity: 'low', category: 'css', title: '缺少 landmark（已降级）', description: 'd1' },
      ],
    }, 'en')

    // 显式传入的字段必须覆盖旧值（修复前 current.severity 恒 truthy，更新永不生效）
    const updated = second.reviewSnapshot?.findings.find((item) => item.id === 'F1')
    expect(updated?.severity).toBe('low')
    expect(updated?.category).toBe('css')
    expect(updated?.title).toBe('缺少 landmark（已降级）')
    expect(second.addedFindingIds).toHaveLength(0)
    expect(second.reviewSnapshot?.stats.totalFindings).toBe(1)
    expect(second.reviewSnapshot?.stats.severity.low).toBe(1)

    const validation = validateReviewDocument(second.content)
    expect(validation.isValid).toBe(true)
  })

  it('keeps the existing value when the re-submitted finding does not provide the field', () => {
    const first = appendReviewMilestone(buildInitialDoc(), {
      milestoneTitle: '第一轮',
      summary: '摘要一',
      structuredFindings: [
        { id: 'F1', severity: 'high', category: 'html', title: '缺少 landmark', description: '短描述' },
      ],
    }, 'en')

    const second = appendReviewMilestone(first.content, {
      milestoneTitle: '第二轮',
      summary: '摘要二',
      structuredFindings: [
        {
          id: 'F1',
          severity: 'low',
          category: 'css',
          title: '缺少 landmark（已降级）',
          description: '这是一个更长的描述，用于验证保留更长描述的逻辑',
        },
      ],
    }, 'en')

    const updated = second.reviewSnapshot?.findings.find((item) => item.id === 'F1')
    expect(updated?.severity).toBe('low')
    expect(updated?.category).toBe('css')
    // description 取更长者（既有逻辑保留）
    expect(updated?.descriptionMarkdown).toBe('这是一个更长的描述，用于验证保留更长描述的逻辑')
  })
})

describe('renderReviewFindings', () => {
  it('sanitizes finding titles used as headings (<!-- / --> / leading #)', () => {
    const result = appendReviewMilestone(buildInitialDoc(), {
      milestoneTitle: '标题注入',
      summary: '摘要',
      structuredFindings: [
        { severity: 'high', category: 'html', title: '修复 <!-- 注入 --> 与 ### 子标题' },
      ],
    }, 'en')

    // 标题作为 ### heading 渲染时必须被清洗：裸 <!-- 会吞掉后续内容，行首 ### 会破坏层级
    expect(result.content).not.toContain('### 修复 <!--')
    expect(result.content).toContain('### 修复 &lt;!-- 注入 --&gt; 与 ### 子标题')
    // 快照保留原始标题（源数据不被改写），round-trip 校验仍通过
    expect(result.reviewSnapshot?.findings[0]?.title).toBe('修复 <!-- 注入 --> 与 ### 子标题')
    expect(validateReviewDocument(result.content).isValid).toBe(true)
  })
})

describe('parseStructuredFindingBlock (legacy finding lines)', () => {
  it('keeps colon-containing titles intact when upgrading legacy findings', () => {
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
      '- [high] html: 缺少 main landmark: 语义地标',
      '- [high] javascript:事件:处理',
      '<!-- GRAYCODE_REVIEW_FINDINGS_END -->',
    ].join('\n')

    const upgraded = upgradeReviewDocumentToV4(v2)
    const validation = validateReviewDocument(upgraded)
    expect(validation.isValid).toBe(true)
    const findings = validation.reviewSnapshot?.findings ?? []

    // 标题含冒号不被截断，category/severity 仍正确解析
    const first = findings.find((item) => item.title === '缺少 main landmark: 语义地标')
    expect(first?.category).toBe('html')
    expect(first?.severity).toBe('high')
    // 冒号后无空白的紧凑格式也能解析（修复前整行回退为 legacy 标题）
    const second = findings.find((item) => item.title === '事件:处理')
    expect(second?.category).toBe('javascript')
    expect(second?.severity).toBe('high')
  })
})

describe('validateReviewDocument on damaged V3 documents (H-12)', () => {
  it('returns a structured validation failure instead of throwing on corrupted metadata JSON', () => {
    const corrupted = [
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
    ].join('\n')

    expect(detectReviewDocumentFormat(corrupted)).toBe('v3')
    // 修复前：损坏的 metadata 直接抛 Error（v3 分支无 try/catch）；
    // 修复后：转换为结构化校验失败结果（与 v2/v4 分支行为一致）。
    expect(() => validateReviewDocument(corrupted)).not.toThrow()

    const validation = validateReviewDocument(corrupted)
    expect(validation.detectedFormat).toBe('v3')
    expect(validation.isValid).toBe(false)
    expect(validation.canAutoUpgrade).toBe(false)
    expect(validation.issues.some((item) => item.code === 'invalid_v3_metadata')).toBe(true)
    expect(validation.reviewSnapshot).toBeUndefined()
    expect(validation.metadata).toBeUndefined()
  })
})
