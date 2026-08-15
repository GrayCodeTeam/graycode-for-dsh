/**
 * prompt Remote 端点契约测试：浏览器设置 UI 经 /graycode Connection RPC 通道
 * （ctx.grayRemote.invoke）操作 prompt 模式。覆盖 modes.list/get/setCurrent/
 * create/update/delete/duplicate/import/export 的 happy path、MODE_NOT_FOUND
 * 错误路径（GRAY_PROMPT_* 稳定码透传）与端点注册/注销（fiber disposer）契约。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PromptSettingsService } from '../../src/prompt/service.ts'
import { createPromptRemoteHandlers } from '../../src/prompt/remote.ts'
import { GrayRemoteService } from '../../src/remote/service.ts'
import { GRAY_REMOTE_ERROR_CODES, type GrayRemoteResult } from '../../src/remote/types.ts'
import { PromptErrorCode } from '../../src/prompt/domain/promptTypes.ts'

const tempDirs: string[] = []

interface Env {
  service: PromptSettingsService
  remote: GrayRemoteService
  invoke: (method: string, args?: Record<string, unknown>) => Promise<GrayRemoteResult<unknown>>
}

async function makeEnv(): Promise<Env> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-prompt-remote-'))
  tempDirs.push(dataRoot)
  const service = new PromptSettingsService({ dataRoot })
  const remote = new GrayRemoteService(new Context())
  remote.register(createPromptRemoteHandlers(service))
  return {
    service,
    remote,
    invoke: (method, args) => remote.invoke('prompt', method, args),
  }
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

function expectFailure(result: GrayRemoteResult<unknown>, code: string): void {
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error.code).toBe(code)
    expect(result.error.message.length).toBeGreaterThan(0)
  }
}

/** 契约声明的 9 个端点（与 src/prompt/remote.ts 注册表逐字一致）。 */
const CONTRACT_ENDPOINTS = [
  'prompt/modes.list',
  'prompt/modes.get',
  'prompt/modes.setCurrent',
  'prompt/modes.create',
  'prompt/modes.update',
  'prompt/modes.delete',
  'prompt/modes.duplicate',
  'prompt/modes.import',
  'prompt/modes.export',
]

describe('端点注册契约', () => {
  it('9 个端点全部注册且名称与契约逐字一致（无多余端点）', async () => {
    const { remote } = await makeEnv()
    expect(remote.listEndpoints()).toEqual([...CONTRACT_ENDPOINTS].sort())
  })

  it('register 返回的注销函数移除全部端点（fiber disposer 契约）', async () => {
    const { service } = await makeEnv()
    const remote = new GrayRemoteService(new Context())
    const dispose = remote.register(createPromptRemoteHandlers(service))
    expect(remote.has('prompt/modes.list')).toBe(true)
    expect(remote.has('prompt/modes.export')).toBe(true)
    dispose()
    expect(remote.has('prompt/modes.list')).toBe(false)
    expect(remote.has('prompt/modes.export')).toBe(false)
    expect(remote.listEndpoints()).toEqual([])
  })
})

describe('prompt/modes.list', () => {
  it('返回 currentModeId 与全部模式（含 current 标记与完整字段）', async () => {
    const { invoke } = await makeEnv()
    const result = await invoke('modes.list')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as {
      currentModeId: string
      modes: Array<{
        id: string
        name: string
        kind: string
        template: string
        promptEntries: Array<{ id: string; role: string; order: number; enabled: boolean; content: string }>
        current: boolean
      }>
    }
    expect(value.currentModeId).toBe('code')
    expect(value.modes.map(mode => mode.id)).toEqual(['code', 'design', 'plan', 'ask', 'review'])
    for (const mode of value.modes) {
      expect(mode.kind).toBe('builtin')
      // 系统内容位于 system 条目（内置种子三件套），模板为空是预期形态。
      expect(mode.promptEntries.filter(entry => entry.role === 'system').reduce((total, entry) => total + entry.content.length, 0)).toBeGreaterThan(0)
      expect(Array.isArray(mode.promptEntries)).toBe(true)
    }
    expect(value.modes.filter(mode => mode.current)).toHaveLength(1)
    expect(value.modes.find(mode => mode.id === 'code')?.current).toBe(true)
  })

  it('create 后 list 反映新模式且 current 标记不变', async () => {
    const { invoke } = await makeEnv()
    const created = await invoke('modes.create', { name: 'Extra' })
    expect(created.ok).toBe(true)
    const result = await invoke('modes.list')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as { currentModeId: string; modes: Array<{ id: string; current: boolean }> }
    expect(value.modes).toHaveLength(6)
    expect(value.currentModeId).toBe('code')
    expect(value.modes.find(mode => mode.id === 'code')?.current).toBe(true)
  })
})

describe('prompt/modes.get', () => {
  it('按 id 返回完整模式', async () => {
    const { invoke } = await makeEnv()
    const result = await invoke('modes.get', { id: 'design' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as {
      mode: { id: string; name: string; kind: string; template: string; promptEntries: unknown[] }
    }
    expect(value.mode.id).toBe('design')
    expect(value.mode.name).toBe('design')
    expect(value.mode.kind).toBe('builtin')
    // 系统内容位于 system 条目（内置种子三件套），模板为空是预期形态。
    const entries = value.mode.promptEntries as Array<{ role?: unknown; content?: unknown }>
    expect(entries.filter(entry => entry.role === 'system').reduce((total, entry) => total + String(entry.content ?? '').length, 0)).toBeGreaterThan(0)
    expect(Array.isArray(value.mode.promptEntries)).toBe(true)
  })

  it('不存在的 id → GRAY_PROMPT_MODE_NOT_FOUND', async () => {
    const { invoke } = await makeEnv()
    const result = await invoke('modes.get', { id: 'no-such-mode' })
    expectFailure(result, PromptErrorCode.MODE_NOT_FOUND)
    if (!result.ok) expect(result.error.details).toMatchObject({ causeCode: PromptErrorCode.MODE_NOT_FOUND })
  })

  it('缺 id / id 非字符串 → GRAY_INVALID_INPUT', async () => {
    const { invoke } = await makeEnv()
    expectFailure(await invoke('modes.get', {}), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
    expectFailure(await invoke('modes.get', { id: 42 }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })
})

describe('prompt/modes.setCurrent', () => {
  it('切换当前模式并持久化到 list', async () => {
    const { invoke } = await makeEnv()
    const result = await invoke('modes.setCurrent', { id: 'plan' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.value as { mode: { id: string } }).mode.id).toBe('plan')

    const listed = await invoke('modes.list')
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    const value = listed.value as { currentModeId: string; modes: Array<{ id: string; current: boolean }> }
    expect(value.currentModeId).toBe('plan')
    expect(value.modes.find(mode => mode.id === 'plan')?.current).toBe(true)
    expect(value.modes.find(mode => mode.id === 'code')?.current).toBe(false)
  })

  it('不存在的 id → GRAY_PROMPT_MODE_NOT_FOUND', async () => {
    const { invoke } = await makeEnv()
    expectFailure(await invoke('modes.setCurrent', { id: 'ghost' }), PromptErrorCode.MODE_NOT_FOUND)
  })
})

describe('prompt/modes.create', () => {
  it('创建自定义模式（模板/前后缀/条目/toolPolicy），条目缺失 id 自动生成', async () => {
    const { invoke } = await makeEnv()
    const result = await invoke('modes.create', {
      name: 'My Mode',
      template: 'tpl',
      customPrefix: 'pre',
      customSuffix: 'suf',
      promptEntries: [
        { role: 'system', order: 0, enabled: true, content: 'sys' },
        { id: 'keep-me', role: 'user', order: 1, content: 'usr' },
      ],
      toolPolicy: ['read_file', 'search_in_files'],
      toolPolicyCustomized: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const mode = (result.value as {
      mode: {
        id: string
        name: string
        kind: string
        customPrefix: string
        customSuffix: string
        toolPolicy: string[]
        toolPolicyCustomized: boolean
        promptEntries: Array<{ id: string; role: string; order: number; enabled: boolean; content: string }>
      }
    }).mode
    expect(mode.id).toMatch(/^mode-/)
    expect(mode.name).toBe('My Mode')
    expect(mode.kind).toBe('custom')
    expect(mode.customPrefix).toBe('pre')
    expect(mode.customSuffix).toBe('suf')
    expect(mode.toolPolicy).toEqual(['read_file', 'search_in_files'])
    expect(mode.toolPolicyCustomized).toBe(true)
    // ensureChatHistoryPromptEntry 自动补 chat_history 标记（order 排末位）
    expect(mode.promptEntries).toHaveLength(3)
    expect(mode.promptEntries[0]!.id).toMatch(/^entry-/)
    expect(mode.promptEntries[0]).toMatchObject({ role: 'system', order: 0, enabled: true, content: 'sys' })
    expect(mode.promptEntries[1]).toMatchObject({ id: 'keep-me', role: 'user', order: 1, enabled: true, content: 'usr' })
    expect(mode.promptEntries[2]).toMatchObject({ id: 'chat-history', role: 'chat_history', order: 2, enabled: true, content: '' })

    // 已持久化：get 能读回
    const got = await invoke('modes.get', { id: mode.id })
    expect(got.ok).toBe(true)
    if (got.ok) expect((got.value as { mode: { name: string } }).mode.name).toBe('My Mode')
  })

  it('非法 entry role → GRAY_PROMPT_INVALID_PAYLOAD（store 不被污染）', async () => {
    const { invoke } = await makeEnv()
    expectFailure(
      await invoke('modes.create', { name: 'Bad', promptEntries: [{ role: 'bogus', content: 'x' }] }),
      PromptErrorCode.INVALID_PAYLOAD,
    )
    const listed = await invoke('modes.list')
    expect(listed.ok).toBe(true)
    if (listed.ok) expect((listed.value as { modes: unknown[] }).modes).toHaveLength(5)
  })

  it('缺 name → GRAY_INVALID_INPUT；空 name → GRAY_PROMPT_INVALID_PAYLOAD', async () => {
    const { invoke } = await makeEnv()
    expectFailure(await invoke('modes.create', {}), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
    expectFailure(await invoke('modes.create', { name: '   ' }), PromptErrorCode.INVALID_PAYLOAD)
  })

  it('非法 toolPolicy 元素 → GRAY_PROMPT_INVALID_PAYLOAD', async () => {
    const { invoke } = await makeEnv()
    expectFailure(
      await invoke('modes.create', { name: 'M', toolPolicy: ['ok', ''] }),
      PromptErrorCode.INVALID_PAYLOAD,
    )
  })
})

describe('prompt/modes.update', () => {
  it('patch 更新模板/条目并保留条目 id；空 customPrefix 清除', async () => {
    const { invoke } = await makeEnv()
    const created = await invoke('modes.create', {
      name: 'M',
      customPrefix: 'old',
      promptEntries: [{ id: 'keep-me', role: 'user', order: 1, enabled: true, content: 'a' }],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const modeId = (created.value as { mode: { id: string } }).mode.id

    const result = await invoke('modes.update', {
      id: modeId,
      patch: {
        template: 't2',
        customPrefix: '',
        promptEntries: [{ id: 'keep-me', role: 'user', order: 1, enabled: true, content: 'b' }],
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const mode = result.value as {
      mode: { template: string; customPrefix?: string; promptEntries: Array<{ id: string; role: string; content: string }> }
    }
    expect(mode.mode.template).toBe('t2')
    expect(mode.mode.customPrefix).toBeUndefined()
    // patch 的条目保留 id；ensureChatHistoryPromptEntry 额外补一个 chat_history 标记
    expect(mode.mode.promptEntries).toHaveLength(2)
    expect(mode.mode.promptEntries.find(entry => entry.id === 'keep-me')).toMatchObject({ content: 'b' })
    expect(mode.mode.promptEntries.find(entry => entry.role === 'chat_history')).toMatchObject({ id: 'chat-history', content: '' })
  })

  it('内置模式重命名 → GRAY_PROMPT_BUILTIN_IMMUTABLE', async () => {
    const { invoke } = await makeEnv()
    expectFailure(
      await invoke('modes.update', { id: 'code', patch: { name: 'Renamed' } }),
      PromptErrorCode.BUILTIN_IMMUTABLE,
    )
  })

  it('不存在的 id → GRAY_PROMPT_MODE_NOT_FOUND', async () => {
    const { invoke } = await makeEnv()
    expectFailure(
      await invoke('modes.update', { id: 'ghost', patch: { template: 'x' } }),
      PromptErrorCode.MODE_NOT_FOUND,
    )
  })

  it('patch 非对象 → GRAY_INVALID_INPUT', async () => {
    const { invoke } = await makeEnv()
    expectFailure(await invoke('modes.update', { id: 'code', patch: 'nope' }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })
})

describe('prompt/modes.delete', () => {
  it('删除自定义模式 → { ok: true }，随后 get 返回 MODE_NOT_FOUND', async () => {
    const { invoke } = await makeEnv()
    const created = await invoke('modes.create', { name: 'Doomed' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const modeId = (created.value as { mode: { id: string } }).mode.id

    const result = await invoke('modes.delete', { id: modeId })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ ok: true })

    expectFailure(await invoke('modes.get', { id: modeId }), PromptErrorCode.MODE_NOT_FOUND)
  })

  it('内置模式 → GRAY_PROMPT_BUILTIN_IMMUTABLE', async () => {
    const { invoke } = await makeEnv()
    expectFailure(await invoke('modes.delete', { id: 'code' }), PromptErrorCode.BUILTIN_IMMUTABLE)
  })

  it('不存在的 id → GRAY_PROMPT_MODE_NOT_FOUND', async () => {
    const { invoke } = await makeEnv()
    expectFailure(await invoke('modes.delete', { id: 'ghost' }), PromptErrorCode.MODE_NOT_FOUND)
  })
})

describe('prompt/modes.duplicate', () => {
  it('复制自定义模式：新 id、名称带 copy 后缀、条目换新 id', async () => {
    const { invoke } = await makeEnv()
    const created = await invoke('modes.create', {
      name: 'Original',
      promptEntries: [{ id: 'src-entry', role: 'system', order: 0, enabled: true, content: 'e' }],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const source = (created.value as { mode: { id: string; promptEntries: Array<{ id: string }> } }).mode

    const result = await invoke('modes.duplicate', { id: source.id })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const copy = (result.value as {
      mode: { id: string; name: string; kind: string; promptEntries: Array<{ id: string }> }
    }).mode
    expect(copy.id).not.toBe(source.id)
    expect(copy.name).toBe('Original copy')
    expect(copy.kind).toBe('custom')
    expect(copy.promptEntries[0]!.id).not.toBe('src-entry')
  })

  it('不存在的 id → GRAY_PROMPT_MODE_NOT_FOUND', async () => {
    const { invoke } = await makeEnv()
    expectFailure(await invoke('modes.duplicate', { id: 'ghost' }), PromptErrorCode.MODE_NOT_FOUND)
  })
})

describe('prompt/modes.import', () => {
  it('数组 payload 导入并返回 modes + warnings', async () => {
    const { invoke } = await makeEnv()
    const result = await invoke('modes.import', {
      payload: [
        { name: 'Imported A', template: 't-a' },
        { name: 'Imported B' },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as { modes: Array<{ id: string; name: string; kind: string }>; warnings: string[] }
    expect(value.modes).toHaveLength(2)
    expect(value.modes[0]).toMatchObject({ name: 'Imported A', kind: 'custom' })
    expect(value.modes[1]!.name).toBe('Imported B')
    expect(Array.isArray(value.warnings)).toBe(true)

    const listed = await invoke('modes.list')
    expect(listed.ok).toBe(true)
    if (listed.ok) expect((listed.value as { modes: unknown[] }).modes).toHaveLength(7)
  })

  it('缺 payload → GRAY_INVALID_INPUT', async () => {
    const { invoke } = await makeEnv()
    expectFailure(await invoke('modes.import', {}), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
  })
})

describe('prompt/modes.export', () => {
  it('无 ids 导出全部（version + modes）', async () => {
    const { invoke } = await makeEnv()
    const result = await invoke('modes.export')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as { version: number; modes: Array<{ id: string }> }
    expect(value.version).toBe(1)
    expect(value.modes).toHaveLength(5)
  })

  it('ids 子集导出', async () => {
    const { invoke } = await makeEnv()
    const result = await invoke('modes.export', { ids: ['code', 'design'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as { modes: Array<{ id: string }> }
    expect(value.modes.map(mode => mode.id).sort()).toEqual(['code', 'design'])
  })
})
