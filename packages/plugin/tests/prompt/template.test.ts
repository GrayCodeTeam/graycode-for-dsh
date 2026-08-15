/**
 * template.ts 测试：{{$MODULE}} 占位符渲染（golden 字节级断言）、占位符模块
 * 目录、模板归一化。
 *
 * B3-P2：渲染产物必须不含 DSH 装配器会拒绝的 {{...}} 组（大写/带 $ 的引用
 * 全部替换为确定性说明文本；仅保留 {{lowercase_name}} 形态的 DSH 变量）。
 */
import { describe, expect, test } from 'vitest'
import {
  PLACEHOLDER_MODULES,
  cleanupEmptyLines,
  deprecatedPlaceholderText,
  normalizeTemplate,
  placeholderModuleStatus,
  renderPromptTemplate,
  unavailablePlaceholderText,
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

  test('未知小写引用（DSH 变量形态）原样保留；大写/带 $ 的未知引用被确定性中和', () => {
    // {{graycode_prompt_mode}} 是 DSH 注册变量：渲染器不得触碰
    expect(renderPromptTemplate('a {{graycode_prompt_mode}} b', {})).toBe('a {{graycode_prompt_mode}} b')
    // 空白变体归一化为规范形态（仍由 DSH 解析）
    expect(renderPromptTemplate('a {{ future_module }} b', {})).toBe('a {{future_module}} b')
    // 大写/带 $ 的未知模块若保留会触发 DSH malformed 错误 → 替换为说明文本
    const rendered = renderPromptTemplate('keep {{$FUTURE_MODULE}} and {{$UNKNOWN_123}}', {})
    expect(rendered).toBe(
      `keep ${unavailablePlaceholderText('$FUTURE_MODULE')} and ${unavailablePlaceholderText('$UNKNOWN_123')}`,
    )
    expect(rendered).not.toMatch(/\{\{/)
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
  test('OPEN_TABS/ACTIVE_EDITOR/DIAGNOSTICS/MCP_TOOLS/CONTEXT_BADGE_FORMAT/PINNED_FILES 被确定性说明文本替换', () => {
    const modules = [
      'OPEN_TABS',
      'ACTIVE_EDITOR',
      'DIAGNOSTICS',
      'MCP_TOOLS',
      'CONTEXT_BADGE_FORMAT',
      'PINNED_FILES',
    ]
    const template = modules.map(module => `{{$${module}}}`).join(' ')
    const rendered = renderPromptTemplate(template, {})
    expect(rendered).toBe(modules.map(deprecatedPlaceholderText).join(' '))
    // B3-P2：说明文本不含 {{...}}，渲染产物零残留（DSH 装配器可安全接受）
    expect(rendered).not.toMatch(/\{\{/)
  })

  test('deprecated 替换文本字节稳定且不含原始 {{...}} token（B3-P2 根因）', () => {
    const text = deprecatedPlaceholderText('OPEN_TABS')
    expect(text).toBe('[deprecated placeholder OPEN_TABS: editor-specific module with no DSH host equivalent; remove it from the template]')
    expect(text).not.toMatch(/\{\{/)
    // 大小写变体也命中同一 canonical 模块
    expect(renderPromptTemplate('{{$open_tabs}}', {})).toBe(deprecatedPlaceholderText('OPEN_TABS'))
  })

  test('deprecated 优先于 values：即使提供值也不替换', () => {
    expect(renderPromptTemplate('{{$OPEN_TABS}}', { OPEN_TABS: 'supplied' })).toBe(
      deprecatedPlaceholderText('OPEN_TABS'),
    )
  })
})

describe('resolved 模块无值时（P3F v2：TOOLS 延迟给 DSH 变量，其余 deterministic 提示）', () => {
  test('TOOLS 无显式值 → {{graycode_tools}}（延迟给 DSH 渲染期变量）；其余 resolved 模块 → unavailable 说明', () => {
    const modules = ['MEMORY', 'WORKSPACE_FILES', 'TODO_LIST']
    const rendered = renderPromptTemplate(modules.map(module => `{{$${module}}}`).join('|'), {})
    expect(rendered).toBe(modules.map(unavailablePlaceholderText).join('|'))
    expect(rendered).not.toMatch(/\{\{/)
    // TOOLS 是唯一例外：无值时渲染为 DSH 安全小写变量 {{graycode_tools}}（由
    // system-prompt/assemble 瀑布无条件提供，见 promptInjector.ts）
    expect(renderPromptTemplate('{{$TOOLS}}', {})).toBe('{{graycode_tools}}')
    expect(renderPromptTemplate('{{$TOOLS}}|{{$MEMORY}}', {})).toBe(
      `{{graycode_tools}}|${unavailablePlaceholderText('MEMORY')}`,
    )
  })

  test('提供值后仍按值替换；说明文本字节稳定', () => {
    expect(renderPromptTemplate('{{$TOOLS}}', { TOOLS: 'hammer' })).toBe('hammer')
    expect(unavailablePlaceholderText('MEMORY')).toBe(
      '[placeholder MEMORY: not available in DSH; remove it from the template]',
    )
  })
})

describe('placeholder 模块目录', () => {
  test('目录含 DSH 有宿主语义的保留模块与编辑器专属 DEPRECATED 模块', () => {
    const byName = new Map(PLACEHOLDER_MODULES.map(info => [info.module, info.status]))
    for (const module of ['ENVIRONMENT', 'WORKSPACE_FILES', 'TOOLS', 'TODO_LIST', 'MEMORY']) {
      expect(byName.get(module)).toBe('resolved')
    }
    for (const module of [
      'PINNED_FILES',
      'OPEN_TABS',
      'ACTIVE_EDITOR',
      'DIAGNOSTICS',
      'MCP_TOOLS',
      'CONTEXT_BADGE_FORMAT',
    ]) {
      expect(byName.get(module)).toBe('deprecated')
    }
  })

  test('placeholderModuleStatus 大小写/空白不敏感；未知模块返回 undefined', () => {
    expect(placeholderModuleStatus(' environment ')).toBe('resolved')
    expect(placeholderModuleStatus('Open_Tabs')).toBe('deprecated')
    expect(placeholderModuleStatus('Pinned_Files')).toBe('deprecated')
    expect(placeholderModuleStatus('NOT_A_MODULE')).toBeUndefined()
  })
})

describe('cleanupEmptyLines（渲染后处理，对齐旧 contextSections.ts:43-47）', () => {
  test('连续 3+ 换行压成 2 个、整体 trim（字节级）', () => {
    expect(cleanupEmptyLines('\n\n\nHead\n\n\n\nBody\n\n\n')).toBe('Head\n\nBody')
    expect(cleanupEmptyLines('  \nHead\n   \n\nBody  ')).toBe('Head\n   \n\nBody')
    expect(cleanupEmptyLines('')).toBe('')
  })

  test('同一模板新旧输出字节一致：含 3+ 连续换行与首尾空白输入', () => {
    // 旧实现 pipeline：先替换占位符，再 cleanupEmptyLines(result)
    const template = '\n\n\nSystem:\n\n\n\n{{$ENVIRONMENT}}\n   \n\n\n'
    const rendered = renderPromptTemplate(template, { ENVIRONMENT: 'env' })
    const legacy = cleanupEmptyLines(template.replace('{{$ENVIRONMENT}}', 'env'))
    expect(rendered).toBe(legacy)
    expect(rendered).toBe('System:\n\nenv')
  })

  test('renderPromptTemplate 的 3+ 换行折叠对替换值也生效（旧 generateFromTemplate 同路径）', () => {
    expect(renderPromptTemplate('a\n\n\n{{$MEMORY}}\n\n\n\nb', { MEMORY: 'm' })).toBe('a\n\nm\n\nb')
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
