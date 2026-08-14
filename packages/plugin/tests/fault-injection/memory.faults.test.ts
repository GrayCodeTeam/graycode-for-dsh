/**
 * 故障注入：memory 领域（规划 §9.5 的子集：LOG 追加写失败、压缩中途失败、
 * autoInject 注入失败优雅降级、重复调用）。
 *
 * 注入手段：构造损坏的存储状态（存储目录/摘要存储不可用）、vi.spyOn 服务方法、
 * 并发重复调用。全部使用临时数据根/临时目录，不污染真实 dataRoot。
 *
 * 每个用例显式声明：注入什么故障 / 期望最终状态 / 允许的部分结果。
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createMemoryTools } from '../../src/memory/tools.ts'
import { MemoryService } from '../../src/memory/service.ts'
import { MemoryManager } from '../../src/memory/domain/MemoryManager.ts'
import {
  createMemoryPreStepListener,
  type PreStepPayload,
} from '../../src/memory/autoInject.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

afterEach(() => {
  vi.restoreAllMocks()
})

function fakeExec(cwd: string): ToolRunContext {
  return { agent: { session: { header: { cwd } } } } as unknown as ToolRunContext
}

function makeTools(): { tools: Map<string, import('@deepseek-ai/dsh-tools').ToolDefinition>; service: MemoryService; dataRoot: string } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-fault-tools-'))
  const service = new MemoryService({ dataRoot })
  const tools = new Map(createMemoryTools(service).map(t => [t.name, t]))
  return { tools, service, dataRoot }
}

function makeManager(overrides?: Record<string, number>): { mm: MemoryManager; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-fault-manager-'))
  const mm = new MemoryManager(dir, overrides)
  return { mm, dir }
}

/** 捕获 Promise 拒绝并原样返回（无 any；失败值以 unknown 传递，断言处收窄） */
async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

// ─── autoInject 测试辅助（同 autoInject.spec.ts 世界） ─────────────

const WS = 'X:/synthetic/graycode-fault-project'

function makeService(): { service: MemoryService; dataRoot: string } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-fault-inject-'))
  return { service: new MemoryService({ dataRoot }), dataRoot }
}

function fakeAgent(id: string, cwd?: string): PreStepPayload['agent'] {
  return { id, session: { header: cwd ? { cwd } : {} } } as unknown as PreStepPayload['agent']
}

function userMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'fault-test' },
  })
}

function stepPayload(agent: PreStepPayload['agent'], messages = 1): PreStepPayload {
  return {
    agent,
    messages: Array.from({ length: messages }, (_, i) => userMessage(`user-msg-${i}`)),
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }
}

async function enterDecision(messages: number): Promise<PreStepDecision> {
  return { kind: 'enter', messages: Array.from({ length: messages }, (_, i) => userMessage(`inbox-${i}`)) }
}

describe('memory_note：LOG 追加写入失败', () => {
  test('存储暂时不可用 → 返回错误、无半条记录；恢复后 id 连续（无空洞）', async () => {
    const { tools, service, dataRoot } = makeTools()
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-fault-ws-'))
    try {
      const note = tools.get('memory_note')!
      const first = await note.execute({ text: 'first' }, fakeExec(wsDir)) as { id: number }
      expect(first.id).toBe(0)

      // 定位工作区记忆存储目录
      const scopeDirs = fs.readdirSync(path.join(dataRoot, 'memory-workspaces'))
      expect(scopeDirs).toHaveLength(1)
      const storeDir = path.join(dataRoot, 'memory-workspaces', scopeDirs[0]!)
      const backupDir = `${storeDir}.bak`

      // 注入故障：存储目录整体暂时不可用（等价于磁盘/挂载点写失败）
      fs.renameSync(storeDir, backupDir)
      const failed = await captureError(note.execute({ text: 'second' }, fakeExec(wsDir)))
      expect(failed).toBeInstanceOf(Error)
      expect((failed as Error).message).toMatch(/ENOENT|no such file/i)

      // 期望最终状态：无半条记录——失败后原路径没有任何新建文件
      expect(fs.existsSync(storeDir)).toBe(false)

      // 故障消除后重写：id 连续（0 → 1），无空洞、无半条记录
      fs.renameSync(backupDir, storeDir)
      const retried = await note.execute({ text: 'second' }, fakeExec(wsDir)) as { id: number }
      expect(retried.id).toBe(1)
      const wsMgr = await service.getForTool(wsDir, undefined)
      expect((await wsMgr!.listEntries()).map(e => e.text)).toEqual(['first', 'second'])

      // 允许的部分结果：无——追加失败在提交前，失败调用不产生任何记录、不消耗 id
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
      fs.rmSync(wsDir, { recursive: true, force: true })
    }
  })
})

describe('memory_compress：压缩中途失败', () => {
  test('摘要存储不可用（summaries.jsonl 被替换为目录）→ 报错、原始记录完整；修复后可重跑', async () => {
    const { mm, dir } = makeManager()
    try {
      await mm.init()
      for (const t of ['a', 'b', 'c', 'd']) {
        await mm.note(t)
      }
      // 首次 note 已就绪新格式存储（records.jsonl / summaries.jsonl / meta.json）
      expect(fs.existsSync(path.join(dir, 'summaries.jsonl'))).toBe(true)

      // 注入故障：摘要存储被外部替换为同名目录（损坏的存储状态，读写必失败）
      const summariesPath = path.join(dir, 'summaries.jsonl')
      fs.rmSync(summariesPath, { force: true })
      fs.mkdirSync(summariesPath)

      const failed = await captureError(mm.compress('0-1', 'ab'))
      expect(failed).toBeInstanceOf(Error)

      // 期望最终状态：原始记录保持完整（压缩只写摘要缓存，records 未被触碰）
      expect((await mm.listEntries()).map(e => e.text)).toEqual(['a', 'b', 'c', 'd'])

      // 可重跑：修复存储（移除损坏目录）后同一压缩成功
      fs.rmSync(summariesPath, { recursive: true, force: true })
      expect((await mm.compress('0-1', 'ab')).done).toBe(1)

      // 允许的部分结果：无——压缩失败在提交前，未产生任何残留
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('摘要已提交但后续报告失败 → 工具报错；重跑幂等不重复写', async () => {
    const { mm, dir } = makeManager()
    try {
      await mm.init()
      for (const t of ['a', 'b', 'c', 'd']) {
        await mm.note(t)
      }
      expect(await mm.pendingCount(4)).toBe(3) // size=2 两块 + size=4 一块

      // 注入故障：compress 的第二次 pending 查询（写入摘要之后）抛错
      const originalPending = mm.pending.bind(mm)
      const spy = vi.spyOn(mm, 'pending')
        .mockImplementationOnce((T, limit) => originalPending(T, limit))
        .mockImplementationOnce(async () => { throw new Error('post-write report failed') })

      const failed = await captureError(mm.compress('0-1', 'ab'))
      expect(failed).toBeInstanceOf(Error)
      expect((failed as Error).message).toContain('post-write report failed')

      // 允许的部分结果：摘要已提交（pending 数下降），但工具仍报告失败——
      // 调用方不会被假报为「已压缩完成」
      expect(await mm.pendingCount(4)).toBe(2)
      spy.mockRestore()

      // 期望最终状态：重跑幂等——块已压缩，done=0 且不再写入（pending 数不变）
      expect((await mm.compress('0-1', 'ab')).done).toBe(0)
      expect(await mm.pendingCount(4)).toBe(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('autoInject：注入失败优雅降级', () => {
  test('wake 读存储失败 → 降级不阻断普通会话（透传 + warn + revision 不污染）；恢复后注入', async () => {
    const { service, dataRoot } = makeService()
    try {
      const globalMgr = await service.getGlobal()
      await globalMgr.note('mem-fault-x')

      // 注入故障：快照构建中的 wake 读（存储层）抛错
      const wakeSpy = vi.spyOn(globalMgr, 'wake').mockRejectedValueOnce(new Error('storage read failed'))

      const warnings: string[] = []
      const listener = createMemoryPreStepListener(service, { warn: message => warnings.push(message) })
      const agent = fakeAgent('agent-fault', WS)

      // 期望最终状态：普通会话不被阻断——downstream 原样透传，未注入任何消息
      const degraded = await listener(stepPayload(agent), () => enterDecision(1))
      expect(degraded.kind).toBe('enter')
      if (degraded.kind !== 'enter') return
      expect(degraded.messages).toHaveLength(1)
      // 故障被报告（warn），不是静默吞掉
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('degraded')

      // 允许的部分结果：本轮无注入（降级），但 revision 未被污染——
      // 存储恢复后下一轮正常注入
      wakeSpy.mockRestore()
      const recovered = await listener(stepPayload(agent), () => enterDecision(1))
      expect(recovered.kind).toBe('enter')
      if (recovered.kind !== 'enter') return
      expect(recovered.messages).toHaveLength(2)
      expect((recovered.messages[1]!.content[0]! as { text: string }).text).toContain('mem-fault-x')
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('快照构建在 workspace 段失败 → 同样降级；与 buildMemorySnapshot 的读取语义一致', async () => {
    const { service, dataRoot } = makeService()
    try {
      await service.getGlobal().then(mgr => mgr.note('global-only'))
      // 注入故障：workspace 只读探测抛错（getWorkspace 存储不可用）
      service.getWorkspace = async () => { throw new Error('workspace store unavailable') }

      const warnings: string[] = []
      const listener = createMemoryPreStepListener(service, { warn: message => warnings.push(message) })
      const decision = await listener(stepPayload(fakeAgent('agent-ws-fault', WS)), () => enterDecision(1))
      expect(decision.kind).toBe('enter')
      if (decision.kind !== 'enter') return
      expect(decision.messages).toHaveLength(1)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('degraded')
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})

describe('重复调用 / 并发追加', () => {
  test('并发 note（重复触发）→ AsyncLock 串行化：两条都落盘、id 连续', async () => {
    const { mm, dir } = makeManager()
    try {
      await mm.init()
      // 注入故障：同一时刻两次追加（重复调用/并行子代理）
      const [a, b] = await Promise.all([mm.note('concurrent-a'), mm.note('concurrent-b')])
      // 期望最终状态：两条记录都落盘且 id 连续，无丢失、无重复
      expect([a.id, b.id].sort((x, y) => x - y)).toEqual([0, 1])
      expect((await mm.listEntries()).map(e => e.text).sort()).toEqual(['concurrent-a', 'concurrent-b'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('数据根被外部清空（真实 fs 故障）→ 监听器降级不阻断；恢复后正常注入', async () => {
    const { service, dataRoot } = makeService()
    try {
      await service.getGlobal().then(mgr => mgr.note('mem-x'))
      const warnings: string[] = []
      const listener = createMemoryPreStepListener(service, { warn: message => warnings.push(message) })
      const agent = fakeAgent('agent-gone', WS)

      // 注入故障：数据根在会话中途被外部清空（存储彻底不可用）
      fs.rmSync(path.join(dataRoot, 'memory'), { recursive: true, force: true })

      // 期望最终状态：普通会话不被阻断——downstream 原样透传，故障被报告（warn）
      const degraded = await listener(stepPayload(agent), () => enterDecision(1))
      expect(degraded.kind).toBe('enter')
      if (degraded.kind !== 'enter') return
      expect(degraded.messages).toHaveLength(1)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('degraded')

      // 允许的部分结果：本轮无注入（降级），revision 未被污染
      // 恢复：重建存储目录后记录可写入，下一轮正常注入
      fs.mkdirSync(path.join(dataRoot, 'memory'), { recursive: true })
      const recovered = await service.getGlobal()
      await recovered.note('mem-x')
      const decision = await listener(stepPayload(agent), () => enterDecision(1))
      expect(decision.kind).toBe('enter')
      if (decision.kind !== 'enter') return
      expect(decision.messages).toHaveLength(2)
      expect((decision.messages[1]!.content[0]! as { text: string }).text).toContain('mem-x')
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})
