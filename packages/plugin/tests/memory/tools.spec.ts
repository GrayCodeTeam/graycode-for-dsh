/**
 * 工具级测试：memory_wake / memory_note / memory_config / memory_forget
 * 经 service 闭包（createMemoryTools）走真实临时数据根
 *
 * 文案断言说明（F-10）：工具输出 text 字段（'Saved as #0.' / 'You are awake.' /
 * 'Removed memory #1' 等）是模型可见契约，保留断言；错误路径已优先断言结构化
 * 字段（id/removed/totalHits/config）与精确错误消息（memory 工具无结构化错误码，
 * message 即行为契约）。
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { describe, expect, test, vi } from 'vitest'
import { createMemoryTools } from '../../src/memory/tools.ts'
import { MemoryService } from '../../src/memory/service.ts'
import type { JsonValue, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

/* ------------------------------------------------------------------ *
 * 各 memory 工具的规范返回值结构化断言：ToolDefinition.execute 在类型面
 * 返回 unknown，这里按各工具的 output schema 收窄，避免 as any。        *
 * ------------------------------------------------------------------ */

/** memory_note 返回值 */
interface NoteToolResult {
  id: number
  text: string
}

/** memory_wake 返回值（workspace 仅在工作区有记忆时出现） */
interface WakeToolResult {
  text: string
  totalMemories: number
  workspace?: { cwd: string; totalMemories: number }
}

/** memory_config 返回值 */
interface ConfigToolResult {
  config: { wakeLines: number; entryChars: number; partChars: number; partLines: number }
}

/** memory_forget 返回值 */
interface ForgetToolResult {
  removed: number
  message: string
}

/** memory_recall 返回值 */
interface RecallToolResult {
  totalHits: number
  text: string
}

function fakeExec(cwd: string): ToolRunContext {
  return { agent: { session: { header: { cwd } } } } as unknown as ToolRunContext
}

/** 会话无 cwd header（无工作区上下文）的执行上下文 */
function fakeExecNoCwd(): ToolRunContext {
  return { agent: { session: { header: {} } } } as unknown as ToolRunContext
}

function makeTools(): { tools: Map<string, ToolDefinition>; service: MemoryService; dataRoot: string } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tools-'))
  const service = new MemoryService({ dataRoot })
  const tools = new Map(createMemoryTools(service).map(t => [t.name, t]))
  return { tools, service, dataRoot }
}

describe('memory 工具（经 service 闭包）', () => {
  test('memory_note → memory_wake：工作区记忆落盘并可唤醒', async () => {
    const { tools, service, dataRoot } = makeTools()
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tools-ws-'))
    try {
      const note = tools.get('memory_note')!
      const wake = tools.get('memory_wake')!

      // 预置一条全局记忆，wake 双段并存时可区分
      const globalMgr = await service.getGlobal()
      await globalMgr.note('global-tool-mem')

      const noted = (await note.execute({ text: 'workspace-tool-mem' }, fakeExec(wsDir))) as NoteToolResult
      expect(noted.id).toBe(0)
      expect(noted.text).toContain('Saved as #0.')

      const woke = (await wake.execute({}, fakeExec(wsDir))) as WakeToolResult
      expect(woke.text).toContain('--- Global memory ---')
      expect(woke.text).toContain('global-tool-mem')
      expect(woke.text).toContain('--- Workspace memory (')
      expect(woke.text).toContain('workspace-tool-mem')
      expect(woke.text).toContain('You are awake.')
      expect(woke.totalMemories).toBe(2)
      expect(woke.workspace).toEqual({ cwd: wsDir, totalMemories: 1 })

      // render 纯函数投影（woke 经结构化收窄后按 JsonValue 传入纯投影）
      const content = wake.output.render({}, woke as unknown as JsonValue)
      expect(content[0]!.type).toBe('text')
      expect((content[0] as { text: string }).text).toContain('workspace-tool-mem')

      // 数据确实落在工作区目录下（非内存态）
      const wsEntries = fs.readdirSync(path.join(dataRoot, 'memory-workspaces'))
      expect(wsEntries).toHaveLength(1)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
      fs.rmSync(wsDir, { recursive: true, force: true })
    }
  })

  test('memory_note 超长文本报错并提示 memory_config', async () => {
    const { tools, dataRoot } = makeTools()
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tools-ws2-'))
    try {
      const note = tools.get('memory_note')!
      const error = (await note.execute({ text: 'x'.repeat(300) }, fakeExec(wsDir)).catch(e => e as Error)) as Error
      expect(error.message).toContain('Too long')
      expect(error.message).toContain('memory_config')
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
      fs.rmSync(wsDir, { recursive: true, force: true })
    }
  })

  test('memory_config 更新 entryChars 后 note 长文本成功；非法值报错', async () => {
    const { tools, dataRoot } = makeTools()
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tools-ws3-'))
    try {
      const config = tools.get('memory_config')!
      const note = tools.get('memory_note')!

      // 纯读：默认配置
      const read = (await config.execute({}, fakeExec(wsDir))) as ConfigToolResult
      expect(read.config.entryChars).toBe(280)

      // 更新 entryChars
      const updated = (await config.execute({ entryChars: 500 }, fakeExec(wsDir))) as ConfigToolResult
      expect(updated.config.entryChars).toBe(500)

      // 300 字节文本现在可记录
      const noted = (await note.execute({ text: 'y'.repeat(300) }, fakeExec(wsDir))) as NoteToolResult
      expect(noted.id).toBe(0)

      // 非法值：显式传入 0 报可读错误（memory 工具无结构化错误码，文案即行为契约）
      const bad = (await config.execute({ entryChars: 0 }, fakeExec(wsDir)).catch(e => e as Error)) as Error
      expect(bad.message).toMatch(/Invalid value for memory config "entryChars"/)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
      fs.rmSync(wsDir, { recursive: true, force: true })
    }
  })

  test('memory_config 更新 wakeLines/partChars/partLines：合法值生效并持久化（F-08）', async () => {
    const { tools, service, dataRoot } = makeTools()
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tools-config-'))
    try {
      const config = tools.get('memory_config')!

      // 纯读：默认全量配置
      const read = (await config.execute({}, fakeExec(wsDir))) as ConfigToolResult
      expect(read.config).toEqual({ wakeLines: 96, entryChars: 280, partChars: 20000, partLines: 500 })

      // 一次更新三个参数面
      const updated = (await config.execute(
        { wakeLines: 120, partChars: 40000, partLines: 800 },
        fakeExec(wsDir),
      )) as ConfigToolResult
      expect(updated.config).toEqual({ wakeLines: 120, entryChars: 280, partChars: 40000, partLines: 800 })

      // 持久化到共享 config：经服务重读同一实例确认
      const wsMgr = await service.getForTool(wsDir, undefined)
      expect(wsMgr!.getConfig()).toMatchObject({ wakeLines: 120, partChars: 40000, partLines: 800 })

      // 单独更新 partLines 后其余键保持不变
      const single = (await config.execute({ partLines: 900 }, fakeExec(wsDir))) as ConfigToolResult
      expect(single.config).toEqual({ wakeLines: 120, entryChars: 280, partChars: 40000, partLines: 900 })
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
      fs.rmSync(wsDir, { recursive: true, force: true })
    }
  })

  test('memory_config 非法值：越界整数走 execute 校验，非整数被工具 schema 拒绝（F-08）', async () => {
    const { tools, dataRoot } = makeTools()
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tools-config-bad-'))
    try {
      const config = tools.get('memory_config')!
      // 整数但越界（< 1）：到达 execute 层，报配置键名错误
      for (const [key, bad] of [
        ['wakeLines', 0],
        ['entryChars', -1],
      ] as const) {
        const error = (await config.execute({ [key]: bad }, fakeExec(wsDir)).catch(e => e as Error)) as Error
        expect(error.message).toMatch(new RegExp(`Invalid value for memory config "${key}"`))
      }
      // 非整数（浮点/NaN/字符串）：被 dsh-tools 参数 schema 在 execute 前拒绝
      for (const [key, bad] of [
        ['partChars', 1.5],
        ['partLines', NaN],
        ['wakeLines', 'abc'],
      ] as const) {
        const error = (await config.execute({ [key]: bad }, fakeExec(wsDir)).catch(e => e as Error)) as Error
        expect(error.message).toMatch(new RegExp(`invalid arguments: "${key}" must be an integer`))
      }
      // 非法值不落盘：配置仍为默认
      const read = (await config.execute({}, fakeExec(wsDir))) as ConfigToolResult
      expect(read.config).toEqual({ wakeLines: 96, entryChars: 280, partChars: 20000, partLines: 500 })
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
      fs.rmSync(wsDir, { recursive: true, force: true })
    }
  })

  test('memory_forget 单条删除：消息提示重编号，剩余数据正确', async () => {
    const { tools, service, dataRoot } = makeTools()
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tools-ws4-'))
    try {
      const note = tools.get('memory_note')!
      const forget = tools.get('memory_forget')!
      await note.execute({ text: 'first' }, fakeExec(wsDir))
      await note.execute({ text: 'second' }, fakeExec(wsDir))
      await note.execute({ text: 'third' }, fakeExec(wsDir))

      const forgotten = (await forget.execute({ blockId: '1' }, fakeExec(wsDir))) as ForgetToolResult
      expect(forgotten.removed).toBe(1)
      expect(forgotten.message).toContain('Removed memory #1')
      expect(forgotten.message).toContain('renumbered')

      const wsMgr = await service.getForTool(wsDir, undefined)
      expect((await wsMgr!.listEntries()).map(e => e.text)).toEqual(['first', 'third'])
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
      fs.rmSync(wsDir, { recursive: true, force: true })
    }
  })

  test('memory_recall：合并全局与工作区命中并标注来源；无命中输出 No match.', async () => {
    const { tools, service, dataRoot } = makeTools()
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tools-ws5-'))
    try {
      const globalMgr = await service.getGlobal()
      await globalMgr.note('shared-topic-global')
      await tools.get('memory_note')!.execute({ text: 'shared-topic-workspace' }, fakeExec(wsDir))

      const recall = tools.get('memory_recall')!
      const hit = (await recall.execute({ regex: 'shared-topic' }, fakeExec(wsDir))) as RecallToolResult
      expect(hit.totalHits).toBe(2)
      expect(hit.text).toContain('--- Global memory ---')
      expect(hit.text).toContain('shared-topic-global')
      expect(hit.text).toContain('--- Workspace memory (')
      expect(hit.text).toContain('shared-topic-workspace')

      const miss = (await recall.execute({ regex: 'nothing-at-all' }, fakeExec(wsDir))) as RecallToolResult
      expect(miss.totalHits).toBe(0)
      expect(miss.text).toContain('No match.')
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
      fs.rmSync(wsDir, { recursive: true, force: true })
    }
  })

  test('memory_wake 只读：工作区无记忆时仅输出全局段，不创建目录', async () => {
    const { tools, service, dataRoot } = makeTools()
    try {
      const globalMgr = await service.getGlobal()
      await globalMgr.note('global-only')
      const wake = tools.get('memory_wake')!
      const woke = (await wake.execute({}, fakeExec('C:/workspace/never-created'))) as WakeToolResult
      expect(woke.text).toContain('global-only')
      expect(woke.text).not.toContain('Workspace memory')
      expect(woke.workspace).toBeUndefined()
      // 无磁盘副作用
      expect(fs.existsSync(path.join(dataRoot, 'memory-workspaces'))).toBe(false)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('无 cwd 上下文的 memory_note/memory_wake 走全局记忆（而非 process.cwd() 伪工作区）', async () => {
    const { tools, service, dataRoot } = makeTools()
    try {
      const note = tools.get('memory_note')!
      const wake = tools.get('memory_wake')!

      const noted = (await note.execute({ text: 'no-cwd-global' }, fakeExecNoCwd())) as NoteToolResult
      expect(noted.id).toBe(0)

      // 落在全局存储（<dataRoot>/memory），而非 memory-workspaces 下的伪工作区
      const globalMgr = await service.getGlobal()
      expect((await globalMgr.listEntries()).map(e => e.text)).toEqual(['no-cwd-global'])

      // wake 无 cwd：仅全局段、无工作区字段、无「workspace not initialized」提示
      const woke = (await wake.execute({}, fakeExecNoCwd())) as WakeToolResult
      expect(woke.text).toContain('no-cwd-global')
      expect(woke.text).not.toContain('Workspace memory')
      expect(woke.workspace).toBeUndefined()

      // 无伪工作区副作用：memory-workspaces 目录从未创建
      expect(fs.existsSync(path.join(dataRoot, 'memory-workspaces'))).toBe(false)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('不同启动目录下无 cwd 的调用落在同一全局 scope（不再依赖 process.cwd()）', async () => {
    const { tools, service, dataRoot } = makeTools()
    // 模拟两个不同宿主启动目录：修复前 cwdOf 按 process.cwd() 派生两个不同伪工作区 scope
    const cwdSpy = vi
      .spyOn(process, 'cwd')
      .mockReturnValueOnce('C:/startup-dir-a')
      .mockReturnValueOnce('C:/startup-dir-b')
      .mockReturnValue('C:/startup-dir-default')
    try {
      const note = tools.get('memory_note')!
      await note.execute({ text: 'first' }, fakeExecNoCwd())
      await note.execute({ text: 'second' }, fakeExecNoCwd())

      // 两条都写入同一全局存储（id 连续 0/1），与 process.cwd() 完全无关
      const globalMgr = await service.getGlobal()
      expect((await globalMgr.listEntries()).map(e => e.text)).toEqual(['first', 'second'])
      expect(fs.existsSync(path.join(dataRoot, 'memory-workspaces'))).toBe(false)
    } finally {
      cwdSpy.mockRestore()
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})
