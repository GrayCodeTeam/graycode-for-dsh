/**
 * memory 自动注入（V2 P3B）测试：首次合格 pre-step 注入有界记忆快照、
 * revision 去重（记忆无变化不重复注入）、失败优雅降级不阻断会话。
 * 数据根用 os.tmpdir；工作区路径用 X:/synthetic 风格（无磁盘副作用，
 * 只读路径不会创建工作区存储）。
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { describe, expect, test } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { MemoryService } from '../../src/memory/service.ts'
import { buildMemorySnapshot, createMemoryPreStepListener, type PreStepPayload } from '../../src/memory/autoInject.ts'

const WS = 'X:/synthetic/graycode-project'

function makeService(): { service: MemoryService; dataRoot: string } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-inject-'))
  return { service: new MemoryService({ dataRoot }), dataRoot }
}

function fakeAgent(id: string, cwd?: string): PreStepPayload['agent'] {
  return { id, session: { header: cwd ? { cwd } : {} } } as unknown as PreStepPayload['agent']
}

function userMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
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

describe('buildMemorySnapshot', () => {
  test('global + workspace 两段；总记忆为 0 时返回 null', async () => {
    const { service, dataRoot } = makeService()
    try {
      const empty = await buildMemorySnapshot(service, WS)
      expect(empty).toBeNull()

      await service.getGlobal().then(mgr => mgr.note('global-auto-mem'))
      const globalOnly = await buildMemorySnapshot(service, undefined)
      expect(globalOnly).not.toBeNull()
      const globalText = (globalOnly!.message.content[0]! as { text: string }).text
      expect(globalText).toContain('--- Global memory ---')
      expect(globalText).toContain('global-auto-mem')
      expect(globalText).not.toContain('Workspace memory')

      const wsMgr = await service.getWorkspace(WS, true)
      await wsMgr!.note('ws-auto-mem')
      const both = await buildMemorySnapshot(service, WS)
      expect(both).not.toBeNull()
      const bothText = (both!.message.content[0]! as { text: string }).text
      expect(bothText).toContain('--- Global memory ---')
      expect(bothText).toContain('--- Workspace memory (graycode-project) ---')
      expect(bothText).toContain('ws-auto-mem')
      expect(bothText).toContain('global-auto-mem')
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})

describe('createMemoryPreStepListener', () => {
  test('首次合格 pre-step 注入；相同 revision 不重复注入；note 后重新注入', async () => {
    const { service, dataRoot } = makeService()
    try {
      const globalMgr = await service.getGlobal()
      await globalMgr.note('mem-one')
      const listener = createMemoryPreStepListener(service)
      const agent = fakeAgent('agent-1', WS)

      const first = await listener(stepPayload(agent), () => enterDecision(1))
      expect(first.kind).toBe('enter')
      if (first.kind !== 'enter') return
      expect(first.messages).toHaveLength(2)
      expect((first.messages[1]!.content[0]! as { text: string }).text).toContain('mem-one')

      const second = await listener(stepPayload(agent), () => enterDecision(1))
      expect(second.kind).toBe('enter')
      if (second.kind !== 'enter') return
      expect(second.messages).toHaveLength(1)

      await globalMgr.note('mem-two')
      const third = await listener(stepPayload(agent), () => enterDecision(1))
      expect(third.kind).toBe('enter')
      if (third.kind !== 'enter') return
      expect(third.messages).toHaveLength(2)
      expect((third.messages[1]!.content[0]! as { text: string }).text).toContain('mem-two')
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('不同 agent 独立去重（WeakMap 按 agent 分键）', async () => {
    const { service, dataRoot } = makeService()
    try {
      await service.getGlobal().then(mgr => mgr.note('shared-mem'))
      const listener = createMemoryPreStepListener(service)

      const agentA = fakeAgent('agent-a', WS)
      const agentB = fakeAgent('agent-b', WS)
      const a1 = await listener(stepPayload(agentA), () => enterDecision(1))
      expect(a1.kind === 'enter' && a1.messages).toHaveLength(2)
      const b1 = await listener(stepPayload(agentB), () => enterDecision(1))
      expect(b1.kind === 'enter' && b1.messages).toHaveLength(2)
      const a2 = await listener(stepPayload(agentA), () => enterDecision(1))
      expect(a2.kind === 'enter' && a2.messages).toHaveLength(1)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('空消息步骤（无模型调用）不注入；reject 决策透传', async () => {
    const { service, dataRoot } = makeService()
    try {
      await service.getGlobal().then(mgr => mgr.note('mem-x'))
      const listener = createMemoryPreStepListener(service)
      const agent = fakeAgent('agent-1', WS)

      const empty = await listener(stepPayload(agent, 0), () => enterDecision(0))
      expect(empty.kind === 'enter' && empty.messages).toHaveLength(0)

      const rejected = await listener(stepPayload(agent), async () => ({ kind: 'reject' }))
      expect(rejected).toEqual({ kind: 'reject' })
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('signal aborted 时跳过注入', async () => {
    const { service, dataRoot } = makeService()
    try {
      await service.getGlobal().then(mgr => mgr.note('mem-x'))
      const listener = createMemoryPreStepListener(service)
      const controller = new AbortController()
      controller.abort()
      const decision = await listener(
        { ...stepPayload(fakeAgent('agent-1', WS)), signal: controller.signal },
        () => enterDecision(1),
      )
      expect(decision.kind === 'enter' && decision.messages).toHaveLength(1)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('记忆为空时不注入且不污染去重状态', async () => {
    const { service, dataRoot } = makeService()
    try {
      const listener = createMemoryPreStepListener(service)
      const agent = fakeAgent('agent-1', WS)
      const first = await listener(stepPayload(agent), () => enterDecision(1))
      expect(first.kind === 'enter' && first.messages).toHaveLength(1)

      await service.getGlobal().then(mgr => mgr.note('now-there-is-mem'))
      const second = await listener(stepPayload(agent), () => enterDecision(1))
      expect(second.kind === 'enter' && second.messages).toHaveLength(2)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('快照生成失败优雅降级：原样透传并记录 warn', async () => {
    const { service, dataRoot } = makeService()
    try {
      const broken = new MemoryService({ dataRoot })
      broken.getGlobal = async () => {
        throw new Error('storage boom')
      }
      const warnings: string[] = []
      const listener = createMemoryPreStepListener(broken, { warn: message => warnings.push(message) })
      const decision = await listener(stepPayload(fakeAgent('agent-1', WS)), () => enterDecision(1))
      expect(decision.kind === 'enter' && decision.messages).toHaveLength(1)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('degraded')
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})
