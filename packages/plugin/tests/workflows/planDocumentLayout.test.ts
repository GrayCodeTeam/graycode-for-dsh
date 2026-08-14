/**
 * plan domain 测试：文档构建（documentLayout）、TODO 区块往返（todoListSection）、
 * sourceArtifact 新鲜度（sourceArtifactSection）
 *
 * 从源 gray-code-plugin `backend/tools/plan/*` 的语义改写（纯函数断言，无 IO）。
 */

import { describe, expect, it } from 'vitest'
import {
  buildPlanDocument,
  extractPlanBodyContent,
} from '../../src/workflows/domain/plan/documentLayout.ts'
import {
  computeSourceArtifactHash,
  computePlanSourceStatus,
  extractPlanSourceArtifact,
  extractPlanSourceArtifactSection,
  getPlanSourceStatusFromContent,
  renderPlanSourceArtifactSection,
  stripPlanSourceArtifactSection,
} from '../../src/workflows/domain/plan/sourceArtifactSection.ts'
import {
  PLAN_TODO_SECTION_END,
  PLAN_TODO_SECTION_START,
  PLAN_TODO_SECTION_TITLE,
  appendPlanTodoListSection,
  extractPlanTodoListFromContent,
  normalizePlanTodoList,
  renderPlanTodoListSection,
  stripPlanTodoListSection,
} from '../../src/workflows/domain/plan/todoListSection.ts'

describe('buildPlanDocument', () => {
  it('builds source → todo → body sections in fixed order and round-trips todos', () => {
    const sourceSection = renderPlanSourceArtifactSection({
      type: 'design',
      path: '.graycode/design/auth-flow.md',
      contentHash: 'sha256:abc',
    })
    const { content, todos } = buildPlanDocument(
      '第一行\n\n## 正文\n第二行',
      [
        { id: 'plan-01', content: '实现后台工具', status: 'in_progress' },
        { id: 'plan-02', content: '编写单元测试', status: 'pending' },
      ],
      sourceSection,
    )

    expect(content).toContain('<!-- GRAYCODE_SOURCE_ARTIFACT_START -->')
    expect(content).toContain(PLAN_TODO_SECTION_TITLE)
    expect(content).toContain(PLAN_TODO_SECTION_START)
    expect(content).toContain(PLAN_TODO_SECTION_END)
    expect(content).toContain('## 正文')
    // 区块顺序：source 在 todo 之前，todo 在正文之前
    expect(content.indexOf('GRAYCODE_SOURCE_ARTIFACT_START'))
      .toBeLessThan(content.indexOf(PLAN_TODO_SECTION_START))
    expect(content.indexOf(PLAN_TODO_SECTION_START))
      .toBeLessThan(content.indexOf('## 正文'))
    expect(content).not.toContain('\r')
    expect(content.endsWith('\n')).toBe(true)

    expect(todos).toEqual([
      { id: 'plan-01', content: '实现后台工具', status: 'in_progress' },
      { id: 'plan-02', content: '编写单元测试', status: 'pending' },
    ])

    // TODO 区块往返：checkbox-only 渲染（与源一致），磁盘上只有 completed 与其余两种
    // 状态（in_progress/cancelled 落盘后提取为 pending）；内存中的完整状态由返回的
    // todos 与 progress 同步快照保留。
    expect(extractPlanTodoListFromContent(content)).toEqual([
      { id: 'plan-01', content: '实现后台工具', status: 'pending' },
      { id: 'plan-02', content: '编写单元测试', status: 'pending' },
    ])
    // 正文往返：剥离区块后得到原始正文
    expect(extractPlanBodyContent(content)).toBe('第一行\n\n## 正文\n第二行')
  })

  it('omits source section and empty body when not provided', () => {
    const { content } = buildPlanDocument('', [{ id: 't1', content: 'x', status: 'pending' }], null)
    expect(content).not.toContain('GRAYCODE_SOURCE_ARTIFACT')
    expect(content).toContain(PLAN_TODO_SECTION_START)
    expect(content).toContain('- [ ] x  `#t1`')
    expect(extractPlanBodyContent(content)).toBe('')
  })

  it('writes LF-only content even when plan input uses CRLF', () => {
    const { content } = buildPlanDocument('第一行\r\n第二行\r\n', [{ id: 't1', content: 'x', status: 'completed' }])
    expect(content).not.toContain('\r')
    expect(extractPlanBodyContent(content)).toBe('第一行\n第二行')
  })
})

describe('todoListSection', () => {
  it('renders checkbox + inline id; extraction is checkbox-lossy (non-completed → pending)', () => {
    const { content } = buildPlanDocument('', [
      { id: 't-cancel', content: '取消项', status: 'cancelled' },
      { id: 't-done', content: '完成项', status: 'completed' },
      { id: 't-progress', content: '进行中', status: 'in_progress' },
      { id: 't-pending', content: '待办项', status: 'pending' },
    ])

    expect(content).toContain('- [x] 完成项  `#t-done`')
    expect(content).toContain('- [ ] 进行中  `#t-progress`')
    expect(content).toContain('- [ ] 待办项  `#t-pending`')
    expect(content).toContain('- [ ] 取消项  `#t-cancel`')

    // 与源渲染格式一致：checkbox 只编码 completed；in_progress/cancelled 提取回 pending
    const extracted = extractPlanTodoListFromContent(content)
    expect(extracted).toEqual([
      { id: 't-cancel', content: '取消项', status: 'pending' },
      { id: 't-done', content: '完成项', status: 'completed' },
      { id: 't-pending', content: '待办项', status: 'pending' },
      { id: 't-progress', content: '进行中', status: 'pending' },
    ])
  })

  it('normalizePlanTodoList is lenient: skips invalid items, defaults status, dedupes by id, sorts numerically', () => {
    const normalized = normalizePlanTodoList([
      { id: 't-10', content: '十', status: 'bogus' },
      { id: 't-2', content: '二', status: 'completed' },
      { id: 't-1', content: '一', status: 'in_progress' },
      { id: 't-2', content: '二覆盖', status: 'pending' },
      { id: '', content: '无 id', status: 'pending' },
      { id: 't-3', content: 42, status: 'pending' },
      { content: '无 id 2', status: 'pending' },
      null,
    ])
    expect(normalized).toEqual([
      { id: 't-1', content: '一', status: 'in_progress' },
      { id: 't-2', content: '二覆盖', status: 'pending' },
      { id: 't-10', content: '十', status: 'pending' }, // 非法 status 默认 pending
      // 空 id / 非字符串 content / 缺 id 的条目被整体跳过
    ])
  })

  it('stripPlanTodoListSection removes the marked block but keeps body text', () => {
    const body = '## 正文\n保留内容'
    const { content } = buildPlanDocument(body, [{ id: 't1', content: 'x', status: 'pending' }])
    const stripped = stripPlanTodoListSection(content)
    expect(stripped).toBe(body)
  })

  it('stripPlanTodoListSection does not remove a "## TODO LIST" heading inside the body', () => {
    const body = '## TODO LIST\n这是正文里的同名标题'
    const { content } = buildPlanDocument(body, [{ id: 't1', content: 'x', status: 'pending' }])
    const stripped = stripPlanTodoListSection(content)
    expect(stripped).toBe(body)
  })

  it('appendPlanTodoListSection prepends the todo section to existing content', () => {
    const { content, todos } = appendPlanTodoListSection('## 正文\n内容', [
      { id: 't1', content: 'x', status: 'completed' },
    ])
    expect(todos).toEqual([{ id: 't1', content: 'x', status: 'completed' }])
    expect(content).toContain(PLAN_TODO_SECTION_START)
    expect(content).toContain('- [x] x  `#t1`')
    expect(content).toContain('## 正文')
    expect(extractPlanTodoListFromContent(content)).toEqual(todos)
  })

  it('extractPlanTodoListFromContent falls back to heading-based extraction for legacy docs', () => {
    const legacy = '## TODO LIST\n- [ ] 旧格式任务 #legacy-1 (in_progress)\n\n## 下一个章节'
    const extracted = extractPlanTodoListFromContent(legacy)
    // 纯文本 #id 只在行首/紧邻 checkbox 时被清理，正文中间的 #id 保留（与源一致）
    expect(extracted).toEqual([{ id: 'legacy-1', content: '旧格式任务 #legacy-1', status: 'in_progress' }])
  })
})

describe('sourceArtifactSection', () => {
  it('computeSourceArtifactHash is sha256-prefixed and normalizes LF + trims', () => {
    const a = computeSourceArtifactHash('第一行\n第二行')
    const b = computeSourceArtifactHash('第一行\r\n第二行')
    const c = computeSourceArtifactHash('  第一行\n第二行  ')
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(computeSourceArtifactHash('x')).not.toBe(computeSourceArtifactHash('y'))
  })

  it('render → extract round-trips the artifact JSON payload', () => {
    const artifact = {
      type: 'review' as const,
      path: '.graycode/review/r1.md',
      contentHash: 'sha256:abc',
    }
    const section = renderPlanSourceArtifactSection(artifact)
    expect(section).toContain('<!-- GRAYCODE_SOURCE_ARTIFACT_START -->')
    expect(section).toContain('<!-- GRAYCODE_SOURCE_ARTIFACT_END -->')
    expect(extractPlanSourceArtifactSection(section)).toBe(section)
    expect(extractPlanSourceArtifact(section)).toEqual(artifact)
  })

  it('extractPlanSourceArtifact returns null for malformed payloads', () => {
    const bad = `${'<!-- GRAYCODE_SOURCE_ARTIFACT_START -->'}\n{not json}\n${'<!-- GRAYCODE_SOURCE_ARTIFACT_END -->'}`
    expect(extractPlanSourceArtifact(bad)).toBeNull()
    expect(extractPlanSourceArtifact('没有区块')).toBeNull()
    expect(extractPlanSourceArtifactSection('没有区块')).toBeNull()
  })

  it('stripPlanSourceArtifactSection removes the block and re-joins remaining text', () => {
    const artifact = {
      type: 'design' as const,
      path: '.graycode/design/d.md',
      contentHash: 'sha256:abc',
    }
    const section = renderPlanSourceArtifactSection(artifact)
    const content = `${section}\n\n## 正文`
    expect(stripPlanSourceArtifactSection(content)).toBe('## 正文')
    expect(stripPlanSourceArtifactSection('## 正文')).toBe('## 正文')
  })

  it('computePlanSourceStatus covers all four freshness states', () => {
    const artifact = {
      type: 'design' as const,
      path: '.graycode/design/d.md',
      contentHash: computeSourceArtifactHash('v1'),
    }

    expect(computePlanSourceStatus(null, 'v1')).toEqual({ sourceStatus: 'untracked' })
    expect(computePlanSourceStatus(artifact, null)).toMatchObject({
      sourceStatus: 'missing_source',
      sourceArtifactType: 'design',
      sourcePath: '.graycode/design/d.md',
    })
    expect(computePlanSourceStatus(artifact, 'v1')).toMatchObject({
      sourceStatus: 'up_to_date',
      sourceArtifact: artifact,
    })
    expect(computePlanSourceStatus(artifact, 'v2')).toMatchObject({
      sourceStatus: 'mismatched',
      sourceArtifact: artifact,
    })
  })

  it('getPlanSourceStatusFromContent uses the injected reader', async () => {
    const artifact = {
      type: 'design' as const,
      path: '.graycode/design/d.md',
      contentHash: computeSourceArtifactHash('v1'),
    }
    const content = `${renderPlanSourceArtifactSection(artifact)}\n\n## 正文`

    expect(await getPlanSourceStatusFromContent(content, async () => 'v1')).toMatchObject({
      sourceStatus: 'up_to_date',
    })
    expect(await getPlanSourceStatusFromContent(content, async () => 'v2')).toMatchObject({
      sourceStatus: 'mismatched',
    })
    expect(await getPlanSourceStatusFromContent(content, async () => null)).toMatchObject({
      sourceStatus: 'missing_source',
    })
    expect(await getPlanSourceStatusFromContent('## 正文', async () => 'v1')).toEqual({
      sourceStatus: 'untracked',
    })
    // 区块存在但 payload 损坏 → missing_source
    const malformed = `${'<!-- GRAYCODE_SOURCE_ARTIFACT_START -->'}\nbad\n${'<!-- GRAYCODE_SOURCE_ARTIFACT_END -->'}\n\n## 正文`
    expect(await getPlanSourceStatusFromContent(malformed, async () => 'v1')).toMatchObject({
      sourceStatus: 'missing_source',
    })
  })
})
