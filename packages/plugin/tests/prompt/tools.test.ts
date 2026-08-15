/**
 * prompt 工具层测试（F-02 补强）：prompt_mode_list / prompt_mode_set /
 * prompt_mode_preview 三工具经 PromptSettingsService 闭包（真实临时 dataRoot）。
 *
 * 覆盖：list 的 current 标记与内建模式清单、set 的未知 modeId 稳定错误码
 * （F-10：错误码优先，文案仅补充）、preview 两态（当前模式/显式 modeId）、
 * preview render 投影（成功态 'mode <id>' 前缀 / 失败态 JSON）、
 * preview entries-first 语义（正文只含系统部分；user/assistant 条目与
 * fakeThought 不以文本出现；requestLayer=true 时追加真实消息说明）。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import type { JsonValue, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createPromptTools } from '../../src/prompt/tools.ts'
import { PromptSettingsService } from '../../src/prompt/service.ts'
import { PromptErrorCode } from '../../src/prompt/domain/promptTypes.ts'

function makeExec(): ToolRunContext {
  return {
    agent: { session: { id: 'root', header: {} } },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
}

async function setup(): Promise<{ dataRoot: string; service: PromptSettingsService; tools: Map<string, ToolDefinition> }> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-tools-'))
  const service = new PromptSettingsService({ dataRoot })
  const tools = new Map(createPromptTools(service, () => false).map(tool => [tool.name, tool]))
  return { dataRoot, service, tools }
}

interface ListResult {
  success: boolean
  currentModeId: string
  modes: Array<{ id: string; name: string; kind: string; current: boolean; templateLength: number; entryCount: number }>
  error?: string
  code?: string
}

interface SetResult {
  success: boolean
  modeId?: string
  modeName?: string
  error?: string
  code?: string
}

interface PreviewResult {
  success: boolean
  modeId?: string
  text?: string
  error?: string
  code?: string
}

describe('prompt 工具层', () => {
  test('prompt_mode_list：5 个内建模式、currentModeId=code、恰一个 current 标记', async () => {
    const { dataRoot, tools } = await setup()
    try {
      const result = (await tools.get('prompt_mode_list')!.execute({}, makeExec())) as ListResult
      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.currentModeId).toBe('code')
      expect(result.modes.map(mode => mode.id)).toEqual(['code', 'design', 'plan', 'ask', 'review'])
      expect(result.modes.every(mode => mode.kind === 'builtin')).toBe(true)
      expect(result.modes.filter(mode => mode.current)).toHaveLength(1)
      expect(result.modes.filter(mode => mode.current)[0]!.id).toBe('code')
      expect(result.modes[0]!.templateLength).toBeGreaterThan(0)
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true })
    }
  })

  test('prompt_mode_set：未知 modeId 返回稳定错误码（GRAY_PROMPT_MODE_NOT_FOUND）；合法切换成功并持久化', async () => {
    const { dataRoot, service, tools } = await setup()
    try {
      const set = tools.get('prompt_mode_set')!

      // 错误码优先：文案仅作补充
      const missing = (await set.execute({ modeId: 'no-such-mode' }, makeExec())) as SetResult
      expect(missing.success).toBe(false)
      expect(missing.code).toBe(PromptErrorCode.MODE_NOT_FOUND)
      expect(missing.error).toBeTruthy()

      const ok = (await set.execute({ modeId: 'design' }, makeExec())) as SetResult
      expect(ok.success).toBe(true)
      expect(ok.modeId).toBe('design')
      expect(ok.modeName).toBe('design')

      // 持久化：新实例读取同一 store 得到 design
      const service2 = new PromptSettingsService({ dataRoot })
      expect((await service2.getCurrentMode()).id).toBe('design')
      // 服务实例间也生效（service 为同一 dataRoot 的另一实例）
      expect((await service.getCurrentMode()).id).toBe('design')
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true })
    }
  })

  test('prompt_mode_preview：缺省预览当前模式；显式 modeId；未知 modeId 返回错误码', async () => {
    const { dataRoot, service, tools } = await setup()
    try {
      const preview = tools.get('prompt_mode_preview')!

      const current = (await preview.execute({}, makeExec())) as PreviewResult
      expect(current.success).toBe(true)
      expect(current.modeId).toBe('code')
      // 结构断言：预览文本包含系统内容首行（模板或 system 条目，不绑定具体内容）
      const currentMode = await service.getCurrentMode()
      const systemText = currentMode.template
        + currentMode.promptEntries.filter(entry => entry.role === 'system').map(entry => entry.content).join('\n\n')
      const templateFirstLine = systemText.split('\n').find(line => line.trim().length > 0)!
      expect(current.text).toContain(templateFirstLine.trim())

      const explicit = (await preview.execute({ modeId: 'ask' }, makeExec())) as PreviewResult
      expect(explicit.success).toBe(true)
      expect(explicit.modeId).toBe('ask')
      expect(explicit.text).toBeTruthy()

      const missing = (await preview.execute({ modeId: 'ghost' }, makeExec())) as PreviewResult
      expect(missing.success).toBe(false)
      expect(missing.code).toBe(PromptErrorCode.MODE_NOT_FOUND)
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true })
    }
  })

  test("prompt_mode_preview render：成功态 'mode <id>' 前缀；失败态 JSON 文本", async () => {
    const { dataRoot, tools } = await setup()
    try {
      const preview = tools.get('prompt_mode_preview')!

      const ok = (await preview.execute({ modeId: 'code' }, makeExec())) as PreviewResult
      const content = preview.output.render({}, ok as unknown as JsonValue)
      expect(content[0]!.type).toBe('text')
      // 结构断言：成功态渲染以 'mode <id>' 开头且包含预览正文（不绑定具体模板内容）
      expect((content[0] as { text: string }).text.startsWith('mode code\n')).toBe(true)
      expect((content[0] as { text: string }).text.length).toBeGreaterThan('mode code\n'.length)

      const bad = (await preview.execute({ modeId: 'ghost' }, makeExec())) as PreviewResult
      const badContent = preview.output.render({}, bad as unknown as JsonValue)
      expect((badContent[0] as { text: string }).text).toContain('"success": false')
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true })
    }
  })

  test('preview 只含系统正文：user/assistant 条目与 fakeThought 不以文本出现（entries-first）', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-tools-'))
    try {
      const service = new PromptSettingsService({ dataRoot })
      let sendHistoryThoughts = false
      let requestLayer = false
      const tools = new Map(
        createPromptTools(service, () => sendHistoryThoughts, () => requestLayer).map(tool => [tool.name, tool]),
      )

      // 自定义模式带一条 user 与一条 assistant 假思考条目
      await service.createMode({
        name: 'with-entries',
        template: 'template-body',
        promptEntries: [
          { id: 'u1', role: 'user', order: 0, enabled: true, content: 'user preset text' },
          { id: 'e1', role: 'assistant', order: 1, enabled: true, content: 'hello from assistant', fakeThought: 'inner hmm' },
        ],
      })
      const mode = (await service.listModes()).find(candidate => candidate.name === 'with-entries')!
      const preview = tools.get('prompt_mode_preview')!

      // requestLayer=false：旧式 preview 形态——正文只含系统部分，无说明
      requestLayer = false
      const plain = (await preview.execute({ modeId: mode.id }, makeExec())) as PreviewResult
      expect(plain.success).toBe(true)
      expect(plain.text).toBe('template-body')
      expect(plain.text).not.toContain('user preset text')
      expect(plain.text).not.toContain('hello from assistant')
      expect(plain.text).not.toContain('inner hmm')
      expect(plain.text).not.toContain('[thinking]')

      // requestLayer=true：正文仍只含系统部分，末尾追加真实消息说明
      requestLayer = true
      const layered = (await preview.execute({ modeId: mode.id }, makeExec())) as PreviewResult
      expect(layered.success).toBe(true)
      expect(layered.text).toBe(
        'template-body\n\nNote: user/assistant preset entries will be injected as real messages at the request layer (llm/stream) and are not included in this system-text preview.',
      )
      expect(layered.text).not.toContain('user preset text')
      expect(layered.text).not.toContain('hello from assistant')
      expect(layered.text).not.toContain('inner hmm')
      expect(layered.text).not.toContain('[thinking]')

      // sendHistoryThoughts 开关对 preview 无影响（deprecated no-op）
      sendHistoryThoughts = true
      const on = (await preview.execute({ modeId: mode.id }, makeExec())) as PreviewResult
      expect(on.success).toBe(true)
      expect(on.text).not.toContain('[thinking]')
      expect(on.text).not.toContain('inner hmm')
    } finally {
      await fs.rm(dataRoot, { recursive: true, force: true })
    }
  })
})
