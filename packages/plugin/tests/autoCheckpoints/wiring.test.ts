/**
 * autoCheckpoints 宿主事件接线测试：轻量 fake ctx（inject/on/effect/get）+
 * fake CheckpointService，验证 apply() 订阅的 session/event 与 tools/pre-execute
 * 在正确时机调用 createCheckpoint（标题/notes/去重/cwd 缺失跳过/开关）。
 */
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/autoCheckpoints/index.ts'
import { DEFAULT_MAJOR_CHANGE_TOOLS } from '../../src/autoCheckpoints/index.ts'
import type { AutoCheckpointPolicyConfig } from '../../src/autoCheckpoints/policy.ts'

interface FakeSession {
  id: string
  header: { cwd?: string }
  events: Array<{ type: string; data?: Record<string, unknown> }>
}

type Listener = (...args: unknown[]) => unknown

interface World {
  createCheckpoint: ReturnType<typeof vi.fn>
  listeners: Map<string, Listener[]>
  disposers: Array<() => void>
}

const fullConfig: AutoCheckpointPolicyConfig = {
  enabled: true,
  beforeUserMessage: true,
  beforeMajorChange: true,
  majorChangeTools: [...DEFAULT_MAJOR_CHANGE_TOOLS],
}

interface FakeSctx {
  get(key: string): unknown
  on(event: string, listener: Listener): () => void
  effect(fn: () => () => void): void
  logger: { warn(message: string): void }
}

function makeWorld(config: AutoCheckpointPolicyConfig): World {
  const createCheckpoint = vi.fn().mockResolvedValue({ checkpointId: 'cp-1' })
  const service = { createCheckpoint }
  const listeners = new Map<string, Listener[]>()
  const disposers: Array<() => void> = []
  const sctx: FakeSctx = {
    get: () => service,
    on: (event: string, listener: Listener) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        listeners.set(
          event,
          list.filter(fn => fn !== listener)
        )
      }
    },
    effect: (fn: () => () => void) => disposers.push(fn()),
    logger: { warn: () => undefined },
  }
  const ctx = {
    inject: (_deps: never, callback: (sctx: FakeSctx) => void) => callback(sctx),
  }
  apply(ctx as never, config as never)
  return { createCheckpoint, listeners, disposers }
}

function sessionOf(id: string, turn = 1, cwd = 'C:/workspace'): FakeSession {
  return { id, header: { cwd }, events: [{ type: 'turn/start', data: { turn } }] }
}

function sessionWithoutCwd(id: string, turn = 1): FakeSession {
  return { id, header: {}, events: [{ type: 'turn/start', data: { turn } }] }
}

function userMessageEvent(source = 'user'): { type: string; data: Record<string, unknown> } {
  return { type: 'user/message', data: { source: { kind: source }, content: [] } }
}

function dispatchSessionEvent(world: World, session: FakeSession, event: unknown): void {
  for (const listener of world.listeners.get('session/event') ?? []) {
    listener(session, event)
  }
}

function dispatchPreExecute(world: World, exec: unknown, next: () => Promise<unknown>): Promise<unknown> {
  const listener = world.listeners.get('tools/pre-execute')?.[0]
  if (!listener) return Promise.resolve(undefined)
  return listener(exec, next) as Promise<unknown>
}

describe('autoCheckpoints 接线（用户消息前）', () => {
  it('直接用户消息 → createCheckpoint（标题/notes 带会话与 turn）', async () => {
    const world = makeWorld(fullConfig)
    dispatchSessionEvent(world, sessionOf('s1', 1), userMessageEvent())
    expect(world.createCheckpoint).toHaveBeenCalledTimes(1)
    expect(world.createCheckpoint).toHaveBeenCalledWith('C:/workspace', {
      title: 'auto: user message before',
      notes: 'session: s1, turn: 1',
    })
  })

  it('同一 turn 内去重：第二个用户消息不再建点；新 turn 恢复', async () => {
    const world = makeWorld(fullConfig)
    dispatchSessionEvent(world, sessionOf('s1', 1), userMessageEvent())
    dispatchSessionEvent(world, sessionOf('s1', 1), userMessageEvent())
    expect(world.createCheckpoint).toHaveBeenCalledTimes(1)
    dispatchSessionEvent(world, sessionOf('s1', 2), userMessageEvent())
    expect(world.createCheckpoint).toHaveBeenCalledTimes(2)
  })

  it('注入上下文（source.kind 非 user）不建点', async () => {
    const world = makeWorld(fullConfig)
    dispatchSessionEvent(world, sessionOf('s1', 1), userMessageEvent('inject'))
    expect(world.createCheckpoint).not.toHaveBeenCalled()
  })

  it('会话无 cwd 时跳过', async () => {
    const world = makeWorld(fullConfig)
    dispatchSessionEvent(world, sessionWithoutCwd('s1', 1), userMessageEvent())
    expect(world.createCheckpoint).not.toHaveBeenCalled()
  })

  it('beforeUserMessage=false 时用户消息不建点', async () => {
    const world = makeWorld({ ...fullConfig, beforeUserMessage: false })
    dispatchSessionEvent(world, sessionOf('s1', 1), userMessageEvent())
    expect(world.createCheckpoint).not.toHaveBeenCalled()
  })
})

describe('autoCheckpoints 接线（大改动前）', () => {
  it('命中 majorChangeTools 的工具 → 建点且不阻塞 next()', async () => {
    const world = makeWorld(fullConfig)
    const next = vi.fn().mockResolvedValue({ kind: 'enter', messages: [] })
    await dispatchPreExecute(world, { name: 'apply_diff', agent: { session: sessionOf('s1', 2) } }, next)
    expect(world.createCheckpoint).toHaveBeenCalledTimes(1)
    expect(world.createCheckpoint).toHaveBeenCalledWith('C:/workspace', {
      title: 'auto: tool apply_diff before',
      notes: 'session: s1, turn: 2',
    })
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('未命中清单的工具：不建点，next() 仍转发', async () => {
    const world = makeWorld(fullConfig)
    const next = vi.fn().mockResolvedValue({ kind: 'enter', messages: [] })
    await dispatchPreExecute(world, { name: 'read_file', agent: { session: sessionOf('s1', 2) } }, next)
    expect(world.createCheckpoint).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('同一 turn 内同工具去重，next() 每次都转发', async () => {
    const world = makeWorld(fullConfig)
    const next = vi.fn().mockResolvedValue({ kind: 'enter', messages: [] })
    const exec = { name: 'apply_diff', agent: { session: sessionOf('s1', 2) } }
    await dispatchPreExecute(world, exec, next)
    await dispatchPreExecute(world, exec, next)
    expect(world.createCheckpoint).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('无 agent（exec.agent 缺失）时不建点', async () => {
    const world = makeWorld(fullConfig)
    const next = vi.fn().mockResolvedValue({ kind: 'enter', messages: [] })
    await dispatchPreExecute(world, { name: 'apply_diff' }, next)
    expect(world.createCheckpoint).not.toHaveBeenCalled()
  })
})

describe('autoCheckpoints 接线（开关与生命周期）', () => {
  it('enabled=false 时不订阅任何事件', () => {
    const world = makeWorld({ ...fullConfig, enabled: false })
    expect(world.listeners.size).toBe(0)
  })

  it('effect disposer 卸载后监听器移除（HMR 不泄漏）', async () => {
    const world = makeWorld(fullConfig)
    expect(world.listeners.get('session/event')?.length).toBe(1)
    expect(world.listeners.get('tools/pre-execute')?.length).toBe(1)
    for (const dispose of world.disposers) dispose()
    expect(world.listeners.get('session/event')?.length).toBe(0)
    expect(world.listeners.get('tools/pre-execute')?.length).toBe(0)
  })

  it('createCheckpoint 失败只告警不抛（fire-and-forget）', async () => {
    const world = makeWorld(fullConfig)
    world.createCheckpoint.mockRejectedValueOnce(new Error('boom'))
    dispatchSessionEvent(world, sessionOf('s1', 1), userMessageEvent())
    await Promise.resolve()
    await Promise.resolve()
    expect(world.createCheckpoint).toHaveBeenCalledTimes(1)
  })
})
