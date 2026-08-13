/**
 * 工具级测试：memory_wake / memory_note / memory_config / memory_forget
 * 经 service 闭包（createMemoryTools）走真实临时数据根
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { describe, expect, test } from 'vitest'
import { createMemoryTools } from '../../src/memory/tools.ts'
import { MemoryService } from '../../src/memory/service.ts'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

function fakeExec(cwd: string): ToolRunContext {
  return { agent: { session: { header: { cwd } } } } as unknown as ToolRunContext
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

      const noted = await note.execute({ text: 'workspace-tool-mem' }, fakeExec(wsDir))
      expect(noted.id).toBe(0)
      expect(noted.text).toContain('Saved as #0.')

      const woke = await wake.execute({}, fakeExec(wsDir))
      expect(woke.text).toContain('--- Global memory ---')
      expect(woke.text).toContain('global-tool-mem')
      expect(woke.text).toContain('--- Workspace memory (')
      expect(woke.text).toContain('workspace-tool-mem')
      expect(woke.text).toContain('You are awake.')
      expect(woke.totalMemories).toBe(2)
      expect(woke.workspace).toEqual({ cwd: wsDir, totalMemories: 1 })

      // render 纯函数投影
      const content = wake.output.render({}, woke)
      expect(content[0].type).toBe('text')
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
      const error = await note.execute({ text: 'x'.repeat(300) }, fakeExec(wsDir)).catch(e => e as Error)
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
      const read = await config.execute({}, fakeExec(wsDir))
      expect(read.config.entryChars).toBe(280)

      // 更新 entryChars
      const updated = await config.execute({ entryChars: 500 }, fakeExec(wsDir))
      expect(updated.config.entryChars).toBe(500)

      // 300 字节文本现在可记录
      const noted = await note.execute({ text: 'y'.repeat(300) }, fakeExec(wsDir))
      expect(noted.id).toBe(0)

      // 非法值：显式传入 0 报可读错误
      const bad = await config.execute({ entryChars: 0 }, fakeExec(wsDir)).catch(e => e as Error)
      expect(bad.message).toMatch(/Invalid value for memory config "entryChars"/)
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

      const forgotten = await forget.execute({ blockId: '1' }, fakeExec(wsDir))
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
      const hit = await recall.execute({ regex: 'shared-topic' }, fakeExec(wsDir))
      expect(hit.totalHits).toBe(2)
      expect(hit.text).toContain('--- Global memory ---')
      expect(hit.text).toContain('shared-topic-global')
      expect(hit.text).toContain('--- Workspace memory (')
      expect(hit.text).toContain('shared-topic-workspace')

      const miss = await recall.execute({ regex: 'nothing-at-all' }, fakeExec(wsDir))
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
      const woke = await wake.execute({}, fakeExec('C:/workspace/never-created'))
      expect(woke.text).toContain('global-only')
      expect(woke.text).not.toContain('Workspace memory')
      expect(woke.workspace).toBeUndefined()
      // 无磁盘副作用
      expect(fs.existsSync(path.join(dataRoot, 'memory-workspaces'))).toBe(false)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})
