/**
 * progress documentLayout 领域测试：build → validate round-trip / 归一化 / 校验
 *
 * 从源 gray-code-plugin `backend/__tests__/tools/create_progress.test.ts` 与
 * `record_progress_milestone.test.ts` 改写（领域层断言，无 vscode/jest mock）。
 */

import { describe, expect, it } from 'vitest'
import {
  buildProgressDocument,
  buildProgressValidationSummary,
  validateProgressDocument,
} from '../../src/workflows/domain/progress/documentLayout.ts'

function baseMetadata() {
  return {
    projectId: 'workspace',
    projectName: 'Workspace',
    createdAt: '2026-04-03T00:00:00.000Z',
    updatedAt: '2026-04-03T00:00:00.000Z',
    status: 'active' as const,
    phase: 'implementation' as const,
    currentFocus: '实现 Progress 文档',
    latestConclusion: 'schema 与 documentLayout 已完成',
    currentBlocker: '等待 review',
    nextAction: '开始实现进度卡片',
    activeArtifacts: {
      design: '.graycode/design/progress.md',
      plan: '.graycode/plans/progress-tools.plan.md',
    },
    todos: [
      { id: 'progress-01', content: '实现后台工具', status: 'in_progress' as const },
      { id: 'progress-02', content: '编写单元测试', status: 'pending' as const },
    ],
    milestones: [
      {
        id: 'PG1',
        title: '后台工具',
        status: 'completed' as const,
        summary: 'schema、documentLayout 与工具骨架',
        relatedTodoIds: ['progress-01'],
        relatedReviewMilestoneIds: [],
        relatedArtifacts: {},
        startedAt: '2026-04-03T00:00:00.000Z',
        completedAt: '2026-04-04T00:00:00.000Z',
        recordedAt: '2026-04-04T00:00:00.000Z',
        nextAction: null,
      },
    ],
    risks: [
      { id: 'risk-01', title: '范围蔓延', status: 'active' as const, description: '需要约束无关范围改动' },
    ],
    log: [
      { at: '2026-04-03T00:00:00.000Z', type: 'created' as const, message: '初始化项目进度' },
      { at: '2026-04-04T00:00:00.000Z', type: 'milestone_recorded' as const, refId: 'PG1', message: '记录里程碑：后台工具' },
    ],
  }
}

describe('buildProgressDocument', () => {
  it('builds a full document that round-trips through validateProgressDocument', () => {
    const { metadata, content } = buildProgressDocument(baseMetadata(), { generatedAt: '2026-04-04T00:00:00.000Z' })

    expect(content).toContain('# 项目进度')
    expect(content).toContain('## 当前摘要')
    expect(content).toContain('## 关联文档')
    expect(content).toContain('## 当前 TODO 快照')
    expect(content).toContain('## 项目里程碑')
    expect(content).toContain('## 风险与阻塞')
    expect(content).toContain('## 最近更新')
    expect(content).toContain('<!-- GRAYCODE_PROGRESS_METADATA_START -->')
    expect(content).not.toContain('\r')

    const validation = validateProgressDocument(content)
    expect(validation.success).toBe(true)
    if (validation.success) {
      expect(validation.metadata).toEqual(metadata)
      expect(validation.metadata.projectId).toBe('workspace')
      expect(validation.metadata.projectName).toBe('Workspace')
      expect(validation.metadata.status).toBe('active')
      expect(validation.metadata.phase).toBe('implementation')
      expect(validation.metadata.currentFocus).toBe('实现 Progress 文档')
      expect(validation.metadata.activeArtifacts.plan).toBe('.graycode/plans/progress-tools.plan.md')
      expect(validation.metadata.todos).toHaveLength(2)
      expect(validation.metadata.milestones).toHaveLength(1)
      expect(validation.metadata.milestones[0]?.id).toBe('PG1')
      expect(validation.metadata.risks).toHaveLength(1)
      expect(validation.metadata.log).toHaveLength(2)
      expect(validation.metadata.stats).toMatchObject({
        milestonesTotal: 1,
        milestonesCompleted: 1,
        todosTotal: 2,
        todosCompleted: 0,
        todosInProgress: 1,
        todosCancelled: 0,
        activeRisks: 1,
      })
      expect(validation.metadata.render.bodyHash).toMatch(/^sha256:/)
    }
  })

  it('renders current progress text from the latest milestone', () => {
    const { content } = buildProgressDocument(baseMetadata(), { generatedAt: '2026-04-04T00:00:00.000Z' })
    expect(content).toContain('1/1 个里程碑已完成；最新：PG1')
  })

  it('writes LF-only content even when input uses CRLF', () => {
    const input = baseMetadata()
    input.currentFocus = '第一行\r\n第二行'
    const { content } = buildProgressDocument(input, { generatedAt: '2026-04-04T00:00:00.000Z' })
    expect(content).not.toContain('\r')
    expect(validateProgressDocument(content).success).toBe(true)
  })

  it('keeps summary field internal newlines but trims leading/trailing whitespace', () => {
    const input = baseMetadata()
    input.currentBlocker = '  多行阻塞\n 说明  '
    const { metadata } = buildProgressDocument(input, { generatedAt: '2026-04-04T00:00:00.000Z' })
    expect(metadata.currentBlocker).toBe('多行阻塞\n 说明')
  })

  it('trims the log to MAX_PROGRESS_LOG_ENTRIES', () => {
    const input = baseMetadata()
    input.log = Array.from({ length: 25 }, (_, i) => ({
      at: `2026-04-0${(i % 9) + 1}T00:00:00.000Z`,
      type: 'created' as const,
      message: `log-${i}`,
    }))
    const { metadata } = buildProgressDocument(input, { generatedAt: '2026-04-04T00:00:00.000Z' })
    expect(metadata.log).toHaveLength(20)
    expect(metadata.log[0]?.message).toBe('log-5')
  })
})

describe('validateProgressDocument', () => {
  it('rejects a document missing a required section', () => {
    const { content } = buildProgressDocument(baseMetadata(), { generatedAt: '2026-04-04T00:00:00.000Z' })
    const tampered = content.replace('## 最近更新', '## 被移除的标题')
    const validation = validateProgressDocument(tampered)
    expect(validation.success).toBe(false)
    if (!validation.success) {
      expect(validation.error).toContain('Missing section heading')
    }
  })

  it('rejects a document with content after the metadata block', () => {
    const { content } = buildProgressDocument(baseMetadata(), { generatedAt: '2026-04-04T00:00:00.000Z' })
    const tampered = `${content}\n末尾多余内容`
    const validation = validateProgressDocument(tampered)
    expect(validation.success).toBe(false)
    if (!validation.success) {
      expect(validation.error).toContain('last section')
    }
  })

  it('rejects a document with duplicate milestone ids in the metadata block', () => {
    const { content } = buildProgressDocument(baseMetadata(), { generatedAt: '2026-04-04T00:00:00.000Z' })
    const start = content.indexOf('<!-- GRAYCODE_PROGRESS_METADATA_START -->') + '<!-- GRAYCODE_PROGRESS_METADATA_START -->'.length
    const end = content.indexOf('<!-- GRAYCODE_PROGRESS_METADATA_END -->')
    const metadata = JSON.parse(content.slice(start, end)) as { milestones: Array<Record<string, unknown>> }
    metadata.milestones.push({ ...metadata.milestones[0], id: 'PG1', summary: 'dup' })
    const tampered = `${content.slice(0, start)}${JSON.stringify(metadata, null, 2)}${content.slice(end)}`

    const validation = validateProgressDocument(tampered)
    expect(validation.success).toBe(false)
    if (!validation.success) {
      expect(validation.error).toContain('Duplicate milestone ids')
    }
  })

  it('rejects case-variant duplicate milestone ids in the metadata block (PG1 vs pg1)', () => {
    const { content } = buildProgressDocument(baseMetadata(), { generatedAt: '2026-04-04T00:00:00.000Z' })
    const start = content.indexOf('<!-- GRAYCODE_PROGRESS_METADATA_START -->') + '<!-- GRAYCODE_PROGRESS_METADATA_START -->'.length
    const end = content.indexOf('<!-- GRAYCODE_PROGRESS_METADATA_END -->')
    const metadata = JSON.parse(content.slice(start, end)) as { milestones: Array<Record<string, unknown>> }
    metadata.milestones.push({ ...metadata.milestones[0], id: 'pg1', summary: 'dup' })
    const tampered = `${content.slice(0, start)}${JSON.stringify(metadata, null, 2)}${content.slice(end)}`

    const validation = validateProgressDocument(tampered)
    expect(validation.success).toBe(false)
    if (!validation.success) {
      expect(validation.error).toContain('Duplicate milestone ids')
    }
  })

  it('buildProgressValidationSummary reports a single invalid-document error', () => {
    const summary = buildProgressValidationSummary('# 只有标题\n')
    expect(summary.isValid).toBe(false)
    expect(summary.formatVersion).toBeNull()
    expect(summary.errorCount).toBe(1)
    expect(summary.warningCount).toBe(0)
    expect(summary.issues[0]?.code).toBe('progress_document_invalid')
  })

  it('buildProgressValidationSummary returns metadata for a valid document', () => {
    const { content } = buildProgressDocument(baseMetadata(), { generatedAt: '2026-04-04T00:00:00.000Z' })
    const summary = buildProgressValidationSummary(content)
    expect(summary.isValid).toBe(true)
    expect(summary.formatVersion).toBe(1)
    expect(summary.metadata?.projectName).toBe('Workspace')
  })
})

describe('progress marker injection defense', () => {
  it('milestone summary / risk description containing markers and heading lines still validates', () => {
    const input = baseMetadata()
    input.milestones = [{
      id: 'PG1',
      title: '含注入摘要',
      status: 'completed' as const,
      summary: [
        '第一行',
        '<!-- GRAYCODE_PROGRESS_MILESTONES_START -->',
        '## 项目里程碑',
        '<!-- GRAYCODE_PROGRESS_RISKS_START --> 尾部',
      ].join('\n'),
      relatedTodoIds: [],
      relatedReviewMilestoneIds: [],
      relatedArtifacts: {},
      startedAt: '2026-04-03T00:00:00.000Z',
      completedAt: '2026-04-04T00:00:00.000Z',
      recordedAt: '2026-04-04T00:00:00.000Z',
      nextAction: null,
    }]
    input.risks = [{
      id: 'risk-01',
      title: '注入风险',
      status: 'active' as const,
      description: '描述含 <!-- GRAYCODE_PROGRESS_LOG_START --> 与 ## 项目里程碑',
    }]

    const { content } = buildProgressDocument(input, { generatedAt: '2026-04-04T00:00:00.000Z' })

    // 注入的 marker 文本被转义、标题行被缩进：真实 marker 各恰出现一次，校验通过
    const validation = validateProgressDocument(content)
    expect(validation.success).toBe(true)
    const markerMatches = content.match(/<!-- GRAYCODE_PROGRESS_MILESTONES_START -->/g) ?? []
    expect(markerMatches).toHaveLength(1)
    expect(content).toContain('<!-- GRAYCODE_PROGRESS_MILESTONES_START --&gt;')
  })
})
