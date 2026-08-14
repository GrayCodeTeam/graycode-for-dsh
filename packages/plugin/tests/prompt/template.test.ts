/**
 * template.ts 测试：{{$MODULE}} 占位符渲染（golden 字节级断言）、占位符模块
 * 目录、模板归一化。
 */
import { describe, expect, test } from 'vitest'
import {
  PLACEHOLDER_MODULES,
  deprecatedPlaceholderText,
  normalizeTemplate,
  placeholderModuleStatus,
  renderPromptTemplate,
} from '../../src/prompt/domain/template.ts'

describe('renderPromptTemplate golden', () => {
  test('基础渲染：{{$MODULE}} 被 values 中的值按原样替换（字节级）', () => {
    const template = 'System: {{$ENVIRONMENT}} and {{$TOOLS}}'
    const values = { ENVIRONMENT: 'env', TOOLS: 'hammer' }
    expect(renderPromptTemplate(template, values)).toBe('System: env and hammer')
  })

  test('大小写与空白鲁棒：{{ $environment }} / {{ENVIRONMENT}} / {{  $  ENVIRONMENT  }} 等价', () => {
    const values = { ENVIRONMENT: 'x' }
    expect(renderPromptTemplate('a {{ $environment }} b', values)).toBe('a x b')
    expect(renderPromptTemplate('a {{ENVIRONMENT}} b', values)).toBe('a x b')
    expect(renderPromptTemplate('a {{  $  ENVIRONMENT  }} b', values)).toBe('a x b')
    expect(renderPromptTemplate('a {{$EnvIrOnMeNt}} b', values)).toBe('a x b')
  })

  test('未知占位符保留原样（不报错）', () => {
    const template = 'keep {{$FUTURE_MODULE}} and {{$UNKNOWN_123}}'
    expect(renderPromptTemplate(template, {})).toBe(template)
    expect(renderPromptTemplate('x {{future_module}} y', {})).toBe('x {{future_module}} y')
  })

  test('同一占位符多次出现全部替换', () => {
    expect(renderPromptTemplate('{{$MEMORY}}|{{$MEMORY}}', { MEMORY: 'm' })).toBe('m|m')
  })

  test('空 values / 空模板不报错', () => {
    expect(renderPromptTemplate('', {})).toBe('')
    expect(renderPromptTemplate('plain text', {})).toBe('plain text')
  })
})

describe('deprecated 编辑器专属模块', () => {
  test('OPEN_TABS/ACTIVE_EDITOR/DIAGNOSTICS/MCP_TOOLS/CONTEXT_BADGE_FORMAT 被确定性说明文本替换', () => {
    const template = '{{$OPEN_TABS}} {{$ACTIVE_EDITOR}} {{$DIAGNOSTICS}} {{$MCP_TOOLS}} {{$CONTEXT_BADGE_FORMAT}}'
    const rendered = renderPromptTemplate(template, {})
    expect(rendered).toBe(
      [
        deprecatedPlaceholderText('{{$OPEN_TABS}}'),
        deprecatedPlaceholderText('{{$ACTIVE_EDITOR}}'),
        deprecatedPlaceholderText('{{$DIAGNOSTICS}}'),
        deprecatedPlaceholderText('{{$MCP_TOOLS}}'),
        deprecatedPlaceholderText('{{$CONTEXT_BADGE_FORMAT}}'),
      ].join(' '),
    )
    // 输出中唯一的 {{...}} token 就是说明文本内嵌的 5 个原始 token（无裸占位符残留）
    expect(rendered.match(/\{\{[^}]+\}\}/g)).toEqual([
      '{{$OPEN_TABS}}',
      '{{$ACTIVE_EDITOR}}',
      '{{$DIAGNOSTICS}}',
      '{{$MCP_TOOLS}}',
      '{{$CONTEXT_BADGE_FORMAT}}',
    ])
  })

  test('deprecated 替换文本字节稳定且内嵌原始 token', () => {
    const text = deprecatedPlaceholderText('{{$OPEN_TABS}}')
    expect(text).toBe('[deprecated placeholder {{$OPEN_TABS}}: editor-specific module with no DSH host equivalent; remove it from the template]')
    // 大小写变体也命中同一 canonical 模块
    expect(renderPromptTemplate('{{$open_tabs}}', {})).toBe(deprecatedPlaceholderText('{{$open_tabs}}'))
  })

  test('deprecated 优先于 values：即使提供值也不替换', () => {
    expect(renderPromptTemplate('{{$OPEN_TABS}}', { OPEN_TABS: 'supplied' })).toBe(
      deprecatedPlaceholderText('{{$OPEN_TABS}}'),
    )
  })
})

describe('placeholder 模块目录', () => {
  test('目录含 DSH 有宿主语义的保留模块与编辑器专属 DEPRECATED 模块', () => {
    const byName = new Map(PLACEHOLDER_MODULES.map(info => [info.module, info.status]))
    for (const module of ['ENVIRONMENT', 'WORKSPACE_FILES', 'PINNED_FILES', 'TOOLS', 'TODO_LIST', 'MEMORY']) {
      expect(byName.get(module)).toBe('resolved')
    }
    for (const module of ['OPEN_TABS', 'ACTIVE_EDITOR', 'DIAGNOSTICS', 'MCP_TOOLS', 'CONTEXT_BADGE_FORMAT']) {
      expect(byName.get(module)).toBe('deprecated')
    }
  })

  test('placeholderModuleStatus 大小写/空白不敏感；未知模块返回 undefined', () => {
    expect(placeholderModuleStatus(' environment ')).toBe('resolved')
    expect(placeholderModuleStatus('Open_Tabs')).toBe('deprecated')
    expect(placeholderModuleStatus('NOT_A_MODULE')).toBeUndefined()
  })
})

describe('normalizeTemplate', () => {
  test('CRLF/CR 归一化为 LF、行尾空白剔除、末尾空行移除（字节级）', () => {
    expect(normalizeTemplate('a\r\nb  \r\nc\n\n\n')).toBe('a\nb\nc')
    expect(normalizeTemplate('a\rb\r\nc')).toBe('a\nb\nc')
    expect(normalizeTemplate('  \n\na\n\n')).toBe('a')
  })

  test('空串与纯空白输入归一化为空串；幂等', () => {
    expect(normalizeTemplate('')).toBe('')
    expect(normalizeTemplate('\n  \n')).toBe('')
    const once = normalizeTemplate('x\r\n\r\ny  \n')
    expect(normalizeTemplate(once)).toBe(once)
  })
})
