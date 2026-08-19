/**
 * PromptSettingsService 测试：真实临时目录持久化；CRUD / 导入导出 / 内置模式
 * 不可删除 / currentModeId 持久化 / 模板归一化 / 变更事件。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { renderModeSectionText } from '../../src/prompt/domain/entries.ts'
import { PromptError, PromptErrorCode } from '../../src/prompt/domain/promptTypes.ts'
import { PromptSettingsService } from '../../src/prompt/service.ts'

let tmpDir: string | undefined

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true })
    tmpDir = undefined
  }
})

async function makeDataRoot(): Promise<string> {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'graycode-prompt-'))
  return tmpDir
}

function storePath(root: string): string {
  return path.join(root, 'prompt', 'modes.json')
}

async function serviceOf(root: string): Promise<PromptSettingsService> {
  const service = new PromptSettingsService({ dataRoot: root })
  await service.getCurrentMode() // 触发 lazy load
  return service
}

describe('内置模式种子', () => {
  test('首次运行种子化 5 个内置模式，currentModeId 默认 code；每个内置模式自带一个 chat_history 条目', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    const modes = await service.listModes()
    expect(modes.map(mode => mode.id)).toEqual(['code', 'design', 'plan', 'ask', 'review'])
    for (const mode of modes) {
      expect(mode.kind).toBe('builtin')
      expect(mode.name).toBe(mode.id)
      // 预设条目承载全部内容：模板清空，system 条目 = 原内置模板文本
      // （渲染等价：renderModeSectionText = 模板 + system 条目拼接）。
      expect(mode.template).toBe('')
      expect(mode.promptEntries.map(entry => [entry.role, entry.order, entry.name])).toEqual([
        ['system', 0, '系统提示词'],
        ['chat_history', 1, 'Chat History'],
        ['user', 2, '动态上下文'],
      ])
      expect(mode.promptEntries[0]!.content.length).toBeGreaterThan(0)
      expect(mode.promptEntries[1]).toMatchObject({ id: 'chat-history', enabled: true, content: '' })
      expect(mode.promptEntries[2]!.content).toContain('{{$TODO_LIST}}')
    }
    expect((await service.getCurrentMode()).id).toBe('code')
    // 种子已持久化
    const raw = JSON.parse(await readFile(storePath(root), 'utf8'))
    expect(raw.version).toBe(1)
    expect(raw.modes).toHaveLength(5)
  })

  test('ensureChatHistoryPromptEntry：无标记自动补（order 排末位）、多标记只留第一个、内容强制为空、order 重编号', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)

    // create：新模式自动补标记（id 固定 chat-history，order 排末位）
    const created = await service.createMode({
      name: 'No Marker',
      promptEntries: [{ id: 'u1', role: 'user', order: 0, enabled: true, content: 'a' }],
    })
    expect(created.promptEntries.map(entry => [entry.role, entry.order])).toEqual([['user', 0], ['chat_history', 1]])
    expect(created.promptEntries[1]).toMatchObject({ id: 'chat-history', name: 'Chat History', enabled: true, content: '' })

    // update：多标记只保留第一个（按条目数组顺序），marker 内容清空、恒启用
    const updated = await service.updateMode(created.id, {
      promptEntries: [
        { id: 'm1', role: 'chat_history', order: 0, enabled: false, content: 'stale', name: 'My History' },
        { id: 'u1', role: 'user', order: 1, enabled: true, content: 'a' },
        { id: 'm2', role: 'chat_history', order: 2, enabled: true, content: '' },
      ],
    })
    const markers = updated.promptEntries.filter(entry => entry.role === 'chat_history')
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({ id: 'm1', name: 'My History', enabled: true, content: '', order: 0 })
    expect(updated.promptEntries.map(entry => entry.id).includes('m2')).toBe(false)
    // order 重编号 0..n-1
    expect(updated.promptEntries.map(entry => entry.order)).toEqual([0, 1])

    // update：显式清空条目也会被补回（原项目固定条目语义）
    const emptied = await service.updateMode(created.id, { promptEntries: [] })
    expect(emptied.promptEntries).toHaveLength(1)
    expect(emptied.promptEntries[0]).toMatchObject({ id: 'chat-history', role: 'chat_history', content: '', order: 0 })
  })

  test('store load 归一化：旧版无 chat_history 条目的存量 store 读取时自动补齐', async () => {
    const root = await makeDataRoot()
    await mkdir(path.join(root, 'prompt'), { recursive: true })
    await writeFile(
      storePath(root),
      JSON.stringify({
        version: 1,
        currentModeId: 'code',
        modes: [
          {
            id: 'code',
            name: 'code',
            kind: 'builtin',
            template: 'Code tpl',
            promptEntries: [{ id: 'e1', role: 'user', order: 0, enabled: true, content: 'c' }],
          },
        ],
      }),
      'utf8',
    )
    const service = await serviceOf(root)
    const code = await service.getMode('code')
    expect(code?.promptEntries.map(entry => entry.role)).toEqual(['user', 'chat_history'])
    expect(code?.promptEntries[1]).toMatchObject({ id: 'chat-history', name: 'Chat History', enabled: true, content: '' })
  })

  test('store load 迁移空预设：补齐极简 System / Chat History / Dynamic Context 三件套', async () => {
    const root = await makeDataRoot()
    await mkdir(path.join(root, 'prompt'), { recursive: true })
    await writeFile(
      storePath(root),
      JSON.stringify({
        version: 1,
        currentModeId: 'legacy-empty',
        modes: [
          {
            id: 'legacy-empty',
            name: 'Legacy Empty',
            kind: 'custom',
            template: '',
            promptEntries: [],
          },
        ],
      }),
      'utf8',
    )

    const service = await serviceOf(root)
    const mode = await service.getCurrentMode()
    expect(mode.template).toBe('')
    expect(mode.promptEntries.map(entry => [entry.role, entry.name])).toEqual([
      ['system', '系统提示词'],
      ['chat_history', 'Chat History'],
      ['user', '动态上下文'],
    ])
    expect(mode.promptEntries[0]!.content).toContain('professional programming assistant')
    expect(mode.promptEntries[2]!.content).toContain('{{$TODO_LIST}}')
  })

  test('store load 迁移模板-only 预设：模板进入 System 条目且不重复渲染', async () => {
    const root = await makeDataRoot()
    await mkdir(path.join(root, 'prompt'), { recursive: true })
    await writeFile(
      storePath(root),
      JSON.stringify({
        version: 1,
        currentModeId: 'legacy-template',
        modes: [
          {
            id: 'legacy-template',
            name: 'Legacy Template',
            kind: 'custom',
            template: 'legacy system prompt',
            promptEntries: [{ id: 'history', role: 'chat_history', order: 0, enabled: true, content: '' }],
          },
        ],
      }),
      'utf8',
    )

    const mode = await (await serviceOf(root)).getCurrentMode()
    expect(mode.template).toBe('')
    expect(mode.promptEntries.map(entry => entry.role)).toEqual(['system', 'chat_history', 'user'])
    expect(mode.promptEntries[0]!.content).toBe('legacy system prompt')
    expect(renderModeSectionText(mode)).toContain('legacy system prompt')
    expect(renderModeSectionText(mode).match(/legacy system prompt/g)).toHaveLength(1)
  })
})

describe('模式 CRUD', () => {
  test('createMode 归一化模板并持久化；重载后仍在', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    const created = await service.createMode({
      name: 'My Mode',
      template: 'tpl\r\nline  \n\n',
      customPrefix: 'pre',
      promptEntries: [{ id: 'x', role: 'system', order: 0, enabled: true, content: 'e1\r\n' }],
    })
    expect(created.template).toBe('tpl\nline')
    expect(created.customPrefix).toBe('pre')
    expect(created.promptEntries[0]?.content).toBe('e1')

    const reloaded = await serviceOf(root)
    const mode = await reloaded.getMode(created.id)
    expect(mode?.template).toBe('tpl\nline')
    expect(mode?.name).toBe('My Mode')
  })

  test('updateMode 更新模板/条目并保留条目 id；空 customPrefix 清除', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    const created = await service.createMode({
      name: 'M',
      customPrefix: 'old',
      promptEntries: [{ id: 'keep-me', role: 'user', order: 1, enabled: true, content: 'a' }],
    })
    const updated = await service.updateMode(created.id, {
      template: 't2',
      customPrefix: '',
      promptEntries: [{ id: 'keep-me', role: 'user', order: 1, enabled: true, content: 'b' }],
    })
    expect(updated.template).toBe('t2')
    expect(updated.customPrefix).toBeUndefined()
    // 条目 id 保留（ensureChatHistoryPromptEntry 会额外补一个 chat_history 标记，
    // 因此按 id 定位而非下标）
    const kept = updated.promptEntries.find(entry => entry.id === 'keep-me')
    expect(kept?.role).toBe('user')
    expect(kept?.content).toBe('b')
  })

  test('renameMode：custom 可重命名；builtin 拒绝（BUILTIN_IMMUTABLE）', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    const created = await service.createMode({ name: 'Old' })
    const renamed = await service.renameMode(created.id, 'New Name')
    expect(renamed.name).toBe('New Name')

    await expect(service.renameMode('code', 'Coding')).rejects.toMatchObject({
      code: PromptErrorCode.BUILTIN_IMMUTABLE,
    })
  })

  test('duplicateMode：新 id、kind=custom、名称加 copy、条目新 id，原模式不受影响', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    const created = await service.createMode({
      name: 'Orig',
      promptEntries: [{ id: 'orig-entry', role: 'system', order: 0, enabled: true, content: 'x' }],
    })
    const copy = await service.duplicateMode(created.id)
    expect(copy.id).not.toBe(created.id)
    expect(copy.kind).toBe('custom')
    expect(copy.name).toBe('Orig copy')
    expect(copy.promptEntries[0]?.id).not.toBe('orig-entry')
    expect(copy.promptEntries[0]?.content).toBe('x')

    const original = await service.getMode(created.id)
    expect(original?.promptEntries[0]?.id).toBe('orig-entry')
  })

  test('deleteMode：custom 可删；builtin 拒绝；删除当前模式回退到 code', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    const created = await service.createMode({ name: 'Temp' })
    await service.setCurrentMode(created.id)

    await expect(service.deleteMode('code')).rejects.toMatchObject({ code: PromptErrorCode.BUILTIN_IMMUTABLE })

    await service.deleteMode(created.id)
    expect(await service.getMode(created.id)).toBeUndefined()
    expect((await service.getCurrentMode()).id).toBe('code')
  })

  test('setCurrentMode 未知 id 抛 MODE_NOT_FOUND；合法切换持久化', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    await expect(service.setCurrentMode('nope')).rejects.toMatchObject({
      code: PromptErrorCode.MODE_NOT_FOUND,
    })
    await service.setCurrentMode('review')
    const reloaded = await serviceOf(root)
    expect((await reloaded.getCurrentMode()).id).toBe('review')
  })
})

describe('导入 / 导出', () => {
  test('importModes 支持单对象与数组；kind 强制 custom；模板/条目归一化；无旧字段时 warnings 为空', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    const result = await service.importModes([
      { name: 'Imported A', template: 't\r\n', promptEntries: [{ role: 'assistant', order: 0, content: 'c  \r\n' }] },
      { name: 'Imported B', promptEntries: [] },
    ])
    expect(result.warnings).toEqual([])
    expect(result.modes).toHaveLength(2)
    for (const mode of result.modes) {
      expect(mode.kind).toBe('custom')
      expect(mode.id).toMatch(/^mode-/)
    }
    expect(result.modes[0]?.template).toBe('t')
    expect(result.modes[0]?.promptEntries[0]?.content).toBe('c')
    expect(result.modes[0]?.promptEntries[0]?.role).toBe('assistant')
    expect(await service.listModes()).toHaveLength(7)
  })

  test('P-H4：旧版导出 JSON 导入——type:chat_history 映射为 chat_history 角色；旧字段丢弃并列入 warnings', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    // 旧版（Gray Code 1.5.4）模式/条目形状：type 表达历史插入点，
    // name/icon/promptAssemblyMode/dynamicContextStrategy 为旧字段；
    // toolPolicy/toolPolicyCustomized 被保存；dynamicTemplate（enabled）映射为
    // user 预设条目
    const legacyPayload = {
      id: 'old-mode',
      name: 'Old Mode',
      icon: 'star',
      promptAssemblyMode: 'entries',
      dynamicTemplateEnabled: true,
      dynamicTemplate: 'dyn {{$WORKSPACE_FILES}}',
      dynamicContextStrategy: 'preserve',
      toolPolicy: ['read_file'],
      toolPolicyCustomized: true,
      template: 'tpl',
      promptEntries: [
        { id: 'chat-history', name: 'Chat History', type: 'chat_history', enabled: true, role: 'user', content: '', order: 0 },
        { id: 'e1', name: 'Prompt 1', type: 'prompt', enabled: true, role: 'assistant', content: 'body', fakeThought: 'think', order: 1 },
      ],
    }
    const result = await service.importModes(legacyPayload)
    const mode = result.modes[0]!
    expect(mode.id).toBe('old-mode')
    expect(mode.kind).toBe('custom')

    // 语义正确：chat_history 条目不再是 user 条目
    const history = mode.promptEntries.find(entry => entry.id === 'chat-history')!
    expect(history.role).toBe('chat_history')
    expect(history.content).toBe('')
    const assistant = mode.promptEntries.find(entry => entry.id === 'e1')!
    expect(assistant.role).toBe('assistant')
    expect(assistant.content).toBe('body')
    expect(assistant.fakeThought).toBe('think')
    // 条目显示名保留（对齐原插件 promptEntries.name）
    expect(assistant.name).toBe('Prompt 1')

    // D-4：toolPolicy / toolPolicyCustomized 被保存（不再丢弃）
    expect(mode.toolPolicy).toEqual(['read_file'])
    expect(mode.toolPolicyCustomized).toBe(true)

    // dynamicTemplate（enabled）→ user 预设条目：order 在首个 chat_history 标记前一位
    // （ensureChatHistoryPromptEntry 排序重编号后落在 0）
    const dyn = mode.promptEntries.find(entry => entry.role === 'user' && entry.content === 'dyn {{$WORKSPACE_FILES}}')!
    expect(dyn.enabled).toBe(true)
    expect(dyn.order).toBe(0)
    // 首个 chat_history 标记紧随其后（重编号后 order 1）
    expect(mode.promptEntries.find(entry => entry.role === 'chat_history')?.order).toBe(1)

    // 渲染层面：user/assistant 条目与 fakeThought 不进系统文本（entries-first）
    const rendered = renderModeSectionText(mode, { sendHistoryThoughts: true })
    expect(rendered).toContain('tpl')
    expect(rendered).not.toContain('[GrayCode preset entry:')
    expect(rendered).not.toContain('[thinking]')
    expect(rendered).not.toContain('body')

    // warnings 列出全部丢弃字段 + dynamicTemplate 映射 + chat_history 映射提示
    expect(result.warnings).toEqual(expect.arrayContaining([
      'mode "Old Mode": dropped legacy field(s): icon, promptAssemblyMode, dynamicContextStrategy',
      'mode "Old Mode": mapped legacy dynamicTemplate (enabled) to a user preset entry',
      'entry mapped legacy type:chat_history to role:chat_history',
    ]))
    expect(result.warnings.filter(w => w.includes('dropped legacy field(s)'))).toHaveLength(1) // 仅模式级（条目 name 现在保留）
  })


  test('旧版前端导出信封（graycode.promptModes.v1，modes 为数组）逐元素导入；无 schema 标签的同形负载也可识别', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    // 1.5.4 前端 PromptSettings.buildPromptModeExportPayload 的真实信封：
    // { schema, exportedAt, modes: PromptMode[] }；模板片段取自
    // backend/modules/settings/promptModes.ts（DEFAULT_SYSTEM_PROMPT_TEMPLATE 开头）
    const legacyMode = {
      id: 'imported-code',
      name: 'Code',
      icon: 'symbol-method',
      template: 'You are a professional programming assistant, proficient in multiple programming languages and frameworks.\n\n{{$ENVIRONMENT}}',
      promptAssemblyMode: 'entries',
      dynamicTemplateEnabled: true,
      dynamicTemplate: 'This is the current turn\'s dynamic context information you can use.\n\n{{$TODO_LIST}}',
      dynamicContextStrategy: 'single',
      promptEntries: [
        { id: 'chat-history', name: 'Chat History', type: 'chat_history', enabled: true, role: 'user', content: '', order: 0 },
        { id: 'e1', name: 'Prompt 1', type: 'prompt', enabled: true, role: 'assistant', content: 'body', fakeThought: 'think', order: 1 },
      ],
      toolPolicy: ['read_file', 'list_files'],
    }
    const envelope = {
      schema: 'graycode.promptModes.v1',
      exportedAt: '2026-01-01T00:00:00.000Z',
      modes: [legacyMode, { id: 'imported-ask', name: 'Ask', template: 'ask tpl', promptEntries: [] }],
    }
    const result = await service.importModes(envelope)
    expect(result.modes).toHaveLength(2)
    expect(result.warnings).toEqual(expect.arrayContaining([
      'imported payload is a Gray Code export envelope (graycode.promptModes.v1); importing the modes array',
      'mode "Code": dropped legacy field(s): icon, promptAssemblyMode, dynamicContextStrategy',
      'entry mapped legacy type:chat_history to role:chat_history',
    ]))
    const code = result.modes.find(mode => mode.name === 'Code')!
    expect(code.kind).toBe('custom')
    expect(code.id).toBe('imported-code')
    expect(code.template).toContain('{{$ENVIRONMENT}}')
    expect(code.toolPolicy).toEqual(['read_file', 'list_files'])
    // type:chat_history → role 映射 + dynamicTemplate → user 条目（order 在标记前一位；
    // ensureChatHistoryPromptEntry 排序重编号后为 0/1）
    expect(code.promptEntries.find(entry => entry.id === 'chat-history')?.role).toBe('chat_history')
    const dyn = code.promptEntries.find(entry => entry.role === 'user')!
    expect(dyn.order).toBe(0)
    expect(code.promptEntries.find(entry => entry.role === 'chat_history')?.order).toBe(1)
    const ask = result.modes.find(mode => mode.name === 'Ask')!
    expect(ask.template).toBe('ask tpl')
    expect((await service.listModes()).map(mode => mode.id)).toContain('imported-ask')

    // 无 schema 标签但顶层 modes 为数组（且无单模式标记）→ 同样走信封路径
    const root2 = await makeDataRoot()
    const service2 = await serviceOf(root2)
    const bare = await service2.importModes({ exportedAt: 'x', modes: [{ id: 'bare-1', name: 'Bare', promptEntries: [] }] })
    expect(bare.modes.map(mode => mode.name)).toEqual(['Bare'])
    expect(bare.warnings[0]).toBe('imported payload is a Gray Code export envelope (graycode.promptModes.v1); importing the modes array')

    // 带单模式标记的对象不误判为信封（name/promptEntries 属于模式自身字段时，
    // 顶层多余的 modes 数组被忽略，仍走单模式解析）
    const root3 = await makeDataRoot()
    const service3 = await serviceOf(root3)
    const single = await service3.importModes({ name: 'X', promptEntries: [], modes: [] })
    expect(single.modes).toHaveLength(1)
    expect(single.modes[0]?.name).toBe('X')
    // 空信封：导入 0 个模式并给出提示（不抛错）
    const empty = await service3.importModes({ schema: 'graycode.promptModes.v1', modes: [] })
    expect(empty.modes).toEqual([])
    expect(empty.warnings).toContain('export envelope carried no modes; nothing was imported')
  })

  test('D-4：toolPolicy / toolPolicyCustomized 经 createMode/updateMode 保存并在导入后保留', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)

    // createMode 保存策略字段
    const created = await service.createMode({
      name: 'Policy Mode',
      template: 'tpl',
      toolPolicy: ['read_file', 'search_in_files'],
      toolPolicyCustomized: true,
    })
    expect(created.toolPolicy).toEqual(['read_file', 'search_in_files'])
    expect(created.toolPolicyCustomized).toBe(true)

    // 重载后仍在（持久化）
    const reloaded = await serviceOf(root)
    const persisted = await reloaded.getMode(created.id)
    expect(persisted?.toolPolicy).toEqual(['read_file', 'search_in_files'])
    expect(persisted?.toolPolicyCustomized).toBe(true)

    // updateMode 可清除策略（空数组 = 显式无过滤）
    const cleared = await service.updateMode(created.id, { toolPolicy: [], toolPolicyCustomized: true })
    expect(cleared.toolPolicy).toEqual([])
    expect(cleared.toolPolicyCustomized).toBe(true)

    // export → import round-trip 保留策略字段
    const exported = await service.exportModes([created.id])
    const root2 = await makeDataRoot()
    const service2 = await serviceOf(root2)
    const imported = await service2.importModes(exported.modes)
    expect(imported.modes[0]?.toolPolicy).toEqual([])
    expect(imported.modes[0]?.toolPolicyCustomized).toBe(true)
    expect(imported.warnings).toEqual([])

    // 非法 toolPolicy 负载拒绝
    await expect(service.createMode({ name: 'Bad', toolPolicy: 'read_file' as never }))
      .rejects.toMatchObject({ code: PromptErrorCode.INVALID_PAYLOAD })
    await expect(service.createMode({ name: 'Bad2', toolPolicy: ['ok', ''] }))
      .rejects.toMatchObject({ code: PromptErrorCode.INVALID_PAYLOAD })
  })

  test('SystemPromptConfig 折叠导入：modes Record + 全局 template 回退 + 全局 dynamicTemplate 映射 + currentModeId 生效', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    const result = await service.importModes({
      currentModeId: 'custom-1',
      template: 'GLOBAL TPL',
      dynamicTemplateEnabled: true,
      dynamicTemplate: 'global dyn context',
      modes: {
        'custom-1': { id: 'custom-1', name: 'Custom One', promptEntries: [] },
        'custom-2': { id: 'custom-2', name: 'Custom Two', template: 'own tpl', promptEntries: [] },
      },
    })
    expect(result.warnings[0]).toBe('imported payload is a SystemPromptConfig; folding the global config')
    expect(result.modes).toHaveLength(2)

    const c1 = result.modes.find(mode => mode.id === 'custom-1')!
    // 无自有 template → 回退全局 template
    expect(c1.template).toBe('GLOBAL TPL')
    // 全局 dynamicTemplate（enabled）→ 映射为 user 预设条目（排在 chat_history 标记前，
    // ensureChatHistoryPromptEntry 重编号后 order 0）
    const dyn = c1.promptEntries.find(entry => entry.role === 'user' && entry.content === 'global dyn context')!
    expect(dyn.enabled).toBe(true)
    expect(dyn.order).toBe(0)
    expect(c1.promptEntries.find(entry => entry.role === 'chat_history')?.order).toBe(1)
    // 有自有 template 的模式不受全局回退影响
    const c2 = result.modes.find(mode => mode.id === 'custom-2')!
    expect(c2.template).toBe('own tpl')

    // currentModeId 生效
    expect((await service.getCurrentMode()).id).toBe('custom-1')
  })
  test('BUG-06：importModes 同一 payload 内重复 mode id 自动重命名，store 中 id 唯一', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    const result = await service.importModes([
      { id: 'dup-id', name: 'First', promptEntries: [] },
      { id: 'dup-id', name: 'Second', promptEntries: [] },
      { id: 'dup-id', name: 'Third', promptEntries: [] },
    ])
    expect(result.modes).toHaveLength(3)
    const ids = result.modes.map(mode => mode.id)
    expect(ids[0]).toBe('dup-id')
    expect(new Set(ids).size).toBe(3)
    // store 中按 id 只命中一个
    const listed = await service.listModes()
    expect(listed.filter(mode => mode.id === 'dup-id')).toHaveLength(1)
    // 与既有 id 冲突的语义仍保留
    const collide = await service.importModes({ id: 'dup-id', name: 'Collide', promptEntries: [] })
    expect(collide.modes[0]?.id).not.toBe('dup-id')
  })

  test('importModes 与既有 id 冲突时重新生成 id；无效负载抛 INVALID_PAYLOAD', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    const imported = (await service.importModes({ id: 'code', name: 'Spoof', promptEntries: [] })).modes
    expect(imported[0]?.id).not.toBe('code')

    await expect(service.importModes({ name: '', promptEntries: [] })).rejects.toMatchObject({
      code: PromptErrorCode.INVALID_PAYLOAD,
    })
    await expect(service.importModes({ name: 'X', promptEntries: [{ role: 'nope', content: 'x' }] }))
      .rejects.toMatchObject({ code: PromptErrorCode.INVALID_PAYLOAD })
    await expect(service.importModes(42)).rejects.toMatchObject({ code: PromptErrorCode.INVALID_PAYLOAD })
  })

  test('exportModes → importModes round-trip 保持语义等价', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    await service.createMode({
      name: 'Round',
      template: 'tpl',
      promptEntries: [{ id: 'e1', role: 'user', order: 0, enabled: true, content: 'body' }],
    })
    const exported = await service.exportModes()
    expect(exported.version).toBe(1)
    expect(exported.modes).toHaveLength(6)

    const root2 = await makeDataRoot()
    const service2 = await serviceOf(root2)
    const result = await service2.importModes(exported.modes)
    expect(result.modes).toHaveLength(6)
    expect(result.warnings).toEqual([])
    const round = result.modes.find(mode => mode.name === 'Round')
    expect(round?.template).toBe('tpl')
    expect(round?.promptEntries[0]?.content).toBe('body')
  })
})

describe('存储与事件', () => {
  test('损坏的 store 文件响亮报错（STORAGE_CORRUPT）', async () => {
    const root = await makeDataRoot()
    await mkdir(path.join(root, 'prompt'), { recursive: true })
    await writeFile(storePath(root), 'not json at all', 'utf8')
    const service = new PromptSettingsService({ dataRoot: root })
    await expect(service.getCurrentMode()).rejects.toMatchObject({ code: PromptErrorCode.STORAGE_CORRUPT })
    await expect(service.listModes()).rejects.toMatchObject({ code: PromptErrorCode.STORAGE_CORRUPT })
  })

  test('BUG-02：store 中 mode 缺 template → 读取抛 STORAGE_CORRUPT（而非渲染期裸 TypeError）', async () => {
    const root = await makeDataRoot()
    await mkdir(path.join(root, 'prompt'), { recursive: true })
    await writeFile(
      storePath(root),
      JSON.stringify({
        version: 1,
        currentModeId: 'code',
        modes: [{ id: 'code', name: 'code', kind: 'builtin', promptEntries: [] }],
      }),
      'utf8',
    )
    const service = new PromptSettingsService({ dataRoot: root })
    await expect(service.getCurrentMode()).rejects.toMatchObject({ code: PromptErrorCode.STORAGE_CORRUPT })
    await expect(service.listModes()).rejects.toMatchObject({ code: PromptErrorCode.STORAGE_CORRUPT })
  })

  test('BUG-02：store 中 mode 的 promptEntries:null → STORAGE_CORRUPT（而非裸 TypeError）', async () => {
    const root = await makeDataRoot()
    await mkdir(path.join(root, 'prompt'), { recursive: true })
    await writeFile(
      storePath(root),
      JSON.stringify({
        version: 1,
        currentModeId: 'code',
        modes: [{ id: 'code', name: 'code', kind: 'builtin', template: 't', promptEntries: null }],
      }),
      'utf8',
    )
    const service = new PromptSettingsService({ dataRoot: root })
    await expect(service.listModes()).rejects.toMatchObject({ code: PromptErrorCode.STORAGE_CORRUPT })
  })

  test('BUG-02：store 中条目元素损坏（null）→ STORAGE_CORRUPT', async () => {
    const root = await makeDataRoot()
    await mkdir(path.join(root, 'prompt'), { recursive: true })
    await writeFile(
      storePath(root),
      JSON.stringify({
        version: 1,
        currentModeId: 'code',
        modes: [{ id: 'code', name: 'code', kind: 'builtin', template: 't', promptEntries: [null] }],
      }),
      'utf8',
    )
    const service = new PromptSettingsService({ dataRoot: root })
    await expect(service.listModes()).rejects.toMatchObject({ code: PromptErrorCode.STORAGE_CORRUPT })
  })

  test('BUG-02：合法 store 逐 mode 归一化加载——kind 保留（builtin 仍受保护）、模板/条目归一化', async () => {
    const root = await makeDataRoot()
    await mkdir(path.join(root, 'prompt'), { recursive: true })
    await writeFile(
      storePath(root),
      JSON.stringify({
        version: 1,
        currentModeId: 'design',
        modes: [
          { id: 'code', name: 'code', kind: 'builtin', template: 'Code tpl', promptEntries: [] },
          { id: 'design', name: 'design', kind: 'builtin', template: 'Design tpl', promptEntries: [] },
          {
            id: 'm1',
            name: 'Custom',
            kind: 'custom',
            template: 't\n',
            customPrefix: 'pre',
            customSuffix: 'suf',
            promptEntries: [{ id: 'e1', role: 'user', order: 0, enabled: true, content: 'c\n' }],
          },
        ],
      }),
      'utf8',
    )
    const service = await serviceOf(root)
    // 归一化（与 parseImportedMode 共用清洗逻辑）
    expect((await service.getMode('m1'))?.template).toBe('t')
    expect((await service.getMode('m1'))?.promptEntries[0]?.content).toBe('c')
    expect((await service.getMode('m1'))?.customPrefix).toBe('pre')
    // kind 保留：builtin 仍受保护（不能被删除）
    await expect(service.deleteMode('code')).rejects.toMatchObject({ code: PromptErrorCode.BUILTIN_IMMUTABLE })
    // currentModeId 保持
    expect((await service.getCurrentMode()).id).toBe('design')
  })

  test('变更事件：setCurrentMode 发 mode-changed；create/delete 发 modes-changed', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    const events: string[] = []
    const unsubscribe = service.subscribe(event => events.push(event.type))

    await service.setCurrentMode('plan')
    const created = await service.createMode({ name: 'Eventful' })
    await service.deleteMode(created.id)
    unsubscribe()
    await service.setCurrentMode('code')

    expect(events).toEqual(['mode-changed', 'modes-changed', 'modes-changed'])
  })

  test('store 文件为原子 tmp+rename 产物（无 .tmp 残留、JSON 完整）', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    await service.createMode({ name: 'Persist' })
    await service.duplicateMode('code')
    const entries = await readdir(path.join(root, 'prompt'))
    expect(entries.filter(name => name.endsWith('.tmp'))).toEqual([])
    const parsed = JSON.parse(await readFile(storePath(root), 'utf8')) as { modes: unknown[] }
    expect(parsed.modes.length).toBe(7)
  })

  test('差距-1：setCurrentMode 写盘失败回滚内存，无 内存新/磁盘旧 分叉', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)

    // 注入故障：把 prompt 目录替换成同名文件，persist 的 mkdir 必然失败
    const promptDir = path.join(root, 'prompt')
    await rm(promptDir, { recursive: true, force: true })
    await writeFile(promptDir, 'not a directory', 'utf8')

    await expect(service.setCurrentMode('plan')).rejects.toMatchObject({
      code: PromptErrorCode.STORAGE_WRITE_FAILED,
    })
    // 内存回滚：仍是旧模式 code（与磁盘一致）
    expect((await service.getCurrentMode()).id).toBe('code')

    // 修复存储后切换正常
    await rm(promptDir, { force: true })
    await mkdir(promptDir, { recursive: true })
    await service.setCurrentMode('plan')
    expect((await service.getCurrentMode()).id).toBe('plan')
    const reloaded = await serviceOf(root)
    expect((await reloaded.getCurrentMode()).id).toBe('plan')
  })
})

describe('PromptError 契约', () => {
  test('错误携带稳定 code（UI/工具透传不解析文案）', async () => {
    const root = await makeDataRoot()
    const service = await serviceOf(root)
    try {
      await service.setCurrentMode('missing')
    } catch (error) {
      expect(error).toBeInstanceOf(PromptError)
      expect((error as PromptError).code).toBe(PromptErrorCode.MODE_NOT_FOUND)
      return
    }
    expect.unreachable('expected MODE_NOT_FOUND')
  })
})
