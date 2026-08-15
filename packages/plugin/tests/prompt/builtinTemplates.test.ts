/**
 * 内置 5 模式模板对齐旧版 Gray Code 1.5.4（决策 D-1，审计 H1）：
 *
 * - golden：`BUILTIN_MODE_TEMPLATES` 与旧版 `backend/modules/settings/promptModes.ts`
 *   的五个内置模板逐字节一致（旧仓库为 CRLF，本仓库为 LF；JS 模板字面量的
 *   cooked 值会把 CRLF 归一化为 LF，因此两侧最终文本字节一致）。
 * - 种子 store 的模板就是对齐后的内置模板。
 * - 渲染冒烟：旧模板携带的 `{{$MODULE}}` 占位符在新渲染管道下的行为
 *   （ENVIRONMENT 由注入层提供值；TOOLS/MEMORY 未提供值时替换为确定性
 *   "not available in DSH" 说明；MCP_TOOLS / CONTEXT_BADGE_FORMAT 被确定性
 *   弃用说明替换）。B3-P2：渲染产物不含任何 {{...}} 组，DSH 装配器可安全接受。
 */
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { BUILTIN_MODE_IDS } from '../../src/prompt/domain/promptTypes.ts'
import {
  deprecatedPlaceholderText,
  normalizeTemplate,
  renderPromptTemplate,
  unavailablePlaceholderText,
} from '../../src/prompt/domain/template.ts'
import { BUILTIN_MODE_TEMPLATES, PromptSettingsService } from '../../src/prompt/service.ts'

const LEGACY_TEMPLATES = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/legacy-builtin-templates.json', import.meta.url)), 'utf8'),
) as Record<string, string>

/** 各模式模板的专属标记（旧版模板结构特征）。 */
const MODE_MARKERS: Record<string, string> = {
  code: 'GUIDELINES',
  design: 'DESIGN MODE BEHAVIOR',
  plan: 'PLAN MODE',
  ask: 'ASK MODE',
  review: 'REVIEW MODE',
}

let tmpDir: string | undefined

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true })
    tmpDir = undefined
  }
})

describe('内置 5 模式模板对齐 Gray Code 1.5.4（D-1 / H1）', () => {
  test('模板文本与旧版 promptModes.ts 逐字节一致（LF 归一化 golden）', () => {
    expect(Object.keys(LEGACY_TEMPLATES).sort()).toEqual([...BUILTIN_MODE_IDS].sort())
    for (const id of BUILTIN_MODE_IDS) {
      expect(BUILTIN_MODE_TEMPLATES[id], `mode ${id} 与 1.5.4 模板字节一致`).toBe(LEGACY_TEMPLATES[id])
    }
  })

  test('模板已归一化（无行尾空白/首尾空行；归一化幂等）', () => {
    for (const id of BUILTIN_MODE_IDS) {
      const template = BUILTIN_MODE_TEMPLATES[id]
      expect(normalizeTemplate(template)).toBe(template)
      expect(template).not.toMatch(/[ \t]+$/)
    }
  })

  test('每个模板保留旧版结构特征（占位符块 + 模式专属节）', () => {
    for (const id of BUILTIN_MODE_IDS) {
      const template = BUILTIN_MODE_TEMPLATES[id]
      expect(template.startsWith('You are a professional')).toBe(true)
      expect(template).toContain('{{$ENVIRONMENT}}')
      expect(template).toContain('{{$TOOLS}}')
      expect(template).toContain(MODE_MARKERS[id])
      // ask 是唯一不带 {{$MEMORY}} 的旧版模板
      if (id === 'ask') {
        expect(template).not.toContain('{{$MEMORY}}')
      } else {
        expect(template).toContain('{{$MEMORY}}')
      }
    }
  })

  test('种子 store 使用对齐后的内置模板', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'graycode-prompt-'))
    const service = new PromptSettingsService({ dataRoot: tmpDir })
    await service.getCurrentMode() // 触发 lazy load + seed
    const modes = await service.listModes()
    expect(modes).toHaveLength(BUILTIN_MODE_IDS.length)
    for (const mode of modes) {
      expect(mode.template).toBe(BUILTIN_MODE_TEMPLATES[mode.id as (typeof BUILTIN_MODE_IDS)[number]])
    }
  })

  test('渲染冒烟：旧占位符在新管道下的解析（B3-P2：无非法 {{...}} 残留）', () => {
    // ENVIRONMENT 由注入层提供 → 替换；TOOLS 无值 → 延迟给 DSH 渲染期变量
    // {{graycode_tools}}；MEMORY 无值 → 确定性 unavailable 说明；
    // MCP_TOOLS / CONTEXT_BADGE_FORMAT（编辑器专属）→ 确定性弃用说明。
    const code = BUILTIN_MODE_TEMPLATES.code
    const rendered = renderPromptTemplate(code, {
      ENVIRONMENT: '====\n\nENVIRONMENT\n\nCurrent Workspace: X:/ws',
    })
    expect(rendered).toContain('====\n\nENVIRONMENT\n\nCurrent Workspace: X:/ws')
    expect(rendered).toContain('GUIDELINES')
    expect(rendered).toContain('{{graycode_tools}}')
    expect(rendered).toContain(unavailablePlaceholderText('MEMORY'))
    expect(rendered).toContain(deprecatedPlaceholderText('MCP_TOOLS'))
    expect(rendered).toContain(deprecatedPlaceholderText('CONTEXT_BADGE_FORMAT'))
    // B3-P2：渲染产物不含任何非法 {{...}} 组（大写/带 $ 的占位符全部替换）；
    // 残留的 {{...}} 组只可能是 DSH 安全小写变量（如 {{graycode_tools}}）——
    // DSH 装配器不会报 malformed prompt variable reference
    expect(rendered).not.toMatch(/\{\{\$|\{\{[A-Z]/)
    for (const group of rendered.match(/\{\{[^{}]*\}\}/g) ?? []) {
      expect(group).toMatch(/^\{\{[a-z][a-z0-9_]*\}\}$/)
    }
  })
})
