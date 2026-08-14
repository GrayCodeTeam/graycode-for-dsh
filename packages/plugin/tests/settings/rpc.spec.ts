/**
 * GrayCode settings 领域 —— /graycode 配置通道 handler 测试。
 *
 * 用 scope/ctx 桩锁定四个端点的行为：
 * - config.get / config.update / config.replace / config.reset；
 * - 载荷白名单（普通对象 + 已知顶层 key），未知端点答 bad-request；
 * - scope 抛错 → internal（通道自身不抛出）；
 * - registerGrayCodeChannel 的 connection 守卫：缺失时告警并跳过、可用时注册。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  GRAYCODE_CHANNEL,
  createGrayCodeConfigHandler,
  registerGrayCodeChannel,
  type ChannelHostContextLike,
  type ConfigScope,
  type GrayCodeConnection,
} from '../../src/settings/rpc.ts'
import { DEFAULTS } from '../../src/settings/defaults.ts'
import type { GrayCodeConfig, GrayCodePatch } from '../../src/settings/types.ts'

/** 模拟 dsh-settings 解析语义：update 合并当前值，replace 在默认文档上覆盖。 */
function makeScopeStub() {
  let current: GrayCodeConfig = { ...DEFAULTS }
  const update = vi.fn(async (patch: GrayCodePatch) => {
    current = { ...current, ...patch }
  })
  const replace = vi.fn(async (section: GrayCodePatch) => {
    current = { ...DEFAULTS, ...section }
  })
  return {
    scope: { get: () => current, update, replace } as ConfigScope,
    update,
    replace,
    getCurrent: () => current,
  }
}

function makeConnectionStub(): {
  connection: GrayCodeConnection
  handle: ReturnType<typeof vi.fn>
  captured: { handler?: (endpoint: string, payload: unknown) => Promise<unknown> }
} {
  const captured: { handler?: (endpoint: string, payload: unknown) => Promise<unknown> } = {}
  const disposer = vi.fn(async () => undefined)
  const handle = vi.fn((channel: string, handler: (endpoint: string, payload: unknown) => Promise<unknown>, options: unknown) => {
    captured.handler = handler
    return disposer
  })
  return { connection: { rpc: { handle } }, handle, captured }
}

function makeHostContext(connection: unknown): { ctx: ChannelHostContextLike; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn()
  const info = vi.fn()
  return {
    ctx: { get: () => connection, logger: { warn, info } },
    warn,
  }
}

describe('/graycode 通道 handler', () => {
  it('config.get 返回 scope 当前值', async () => {
    const { scope } = makeScopeStub()
    const handler = createGrayCodeConfigHandler(scope)
    const result = await handler('config.get', undefined)
    expect(result).toEqual({ ok: true, value: DEFAULTS })
  })

  it('config.update 合法补丁合并并返回新值', async () => {
    const { scope, update } = makeScopeStub()
    const handler = createGrayCodeConfigHandler(scope)
    const result = await handler('config.update', { activeChannelId: 'chan-1', maxToolIterations: 50 })
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ activeChannelId: 'chan-1', maxToolIterations: 50 }) })
    expect(update).toHaveBeenCalledWith({ activeChannelId: 'chan-1', maxToolIterations: 50 })
  })

  it('config.update 非法载荷（非对象/数组/未知 key）答 bad-request 且不触碰 scope', async () => {
    const { scope, update } = makeScopeStub()
    const handler = createGrayCodeConfigHandler(scope)
    for (const payload of ['x', null, 42, [], { nope: 1 }, { activeChannelId: 'a', unknownKey: 2 }]) {
      const result = await handler('config.update', payload)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('bad-request')
    }
    expect(update).not.toHaveBeenCalled()
  })

  it('config.replace 合法配置替换并返回新值', async () => {
    const { scope, replace } = makeScopeStub()
    const handler = createGrayCodeConfigHandler(scope)
    const result = await handler('config.replace', { defaultToolMode: 'xml' })
    expect(replace).toHaveBeenCalledWith({ defaultToolMode: 'xml' })
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ defaultToolMode: 'xml' }) })
  })

  it('config.replace 非法载荷答 bad-request', async () => {
    const { scope, replace } = makeScopeStub()
    const handler = createGrayCodeConfigHandler(scope)
    const result = await handler('config.replace', { bad: true })
    expect(result).toEqual({ ok: false, error: { code: 'bad-request', message: expect.stringContaining('config.replace') } })
    expect(replace).not.toHaveBeenCalled()
  })

  it('config.reset 用 replace({}) 重置回默认文档', async () => {
    const { scope, replace } = makeScopeStub()
    const handler = createGrayCodeConfigHandler(scope)
    await handler('config.update', { activeChannelId: 'chan-9' })
    const result = await handler('config.reset', undefined)
    expect(replace).toHaveBeenCalledWith({})
    expect(result).toEqual({ ok: true, value: DEFAULTS })
  })

  it('未知端点答 bad-request', async () => {
    const { scope } = makeScopeStub()
    const handler = createGrayCodeConfigHandler(scope)
    const result = await handler('config.wat', undefined)
    expect(result).toEqual({ ok: false, error: { code: 'bad-request', message: expect.stringContaining('config.wat') } })
  })

  it('scope 抛错（update 拒绝）时答 internal，通道自身不抛出', async () => {
    const { scope } = makeScopeStub()
    scope.update = vi.fn(async () => {
      throw new Error('settings-rejected')
    })
    const handler = createGrayCodeConfigHandler(scope)
    const result = await handler('config.update', { activeChannelId: 'x' })
    expect(result).toEqual({ ok: false, error: { code: 'internal', message: expect.stringContaining('settings-rejected') } })
  })

  it('scope.get 抛错时答 internal', async () => {
    const { scope } = makeScopeStub()
    scope.get = () => {
      throw new Error('boom')
    }
    const handler = createGrayCodeConfigHandler(scope)
    const result = await handler('config.get', undefined)
    expect(result).toEqual({ ok: false, error: { code: 'internal', message: expect.stringContaining('boom') } })
  })
})

describe('registerGrayCodeChannel', () => {
  it('connection 可用时注册通道并返回注销函数', async () => {
    const { connection, handle, captured } = makeConnectionStub()
    const { ctx } = makeHostContext(connection)
    const { scope } = makeScopeStub()
    const disposer = registerGrayCodeChannel(ctx, scope)
    expect(handle).toHaveBeenCalledWith(GRAYCODE_CHANNEL, expect.any(Function), { authority: 'trusted-host' })
    expect(typeof disposer).toBe('function')
    // 端到端：经已注册的 handler 走一次 config.get
    const result = await captured.handler!('config.get', undefined)
    expect(result).toEqual({ ok: true, value: DEFAULTS })
    await disposer!()
    expect(handle.mock.results[0]?.value).toBe(disposer)
  })

  it('connection 缺失时告警并返回 no-op 注销函数，不注册', () => {
    const { ctx, warn } = makeHostContext(undefined)
    const { scope } = makeScopeStub()
    const disposer = registerGrayCodeChannel(ctx, scope)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/graycode'))
    expect(disposer()).toBeUndefined()
  })

  it('connection 无 rpc 表面时同样跳过并告警', () => {
    const { ctx, warn } = makeHostContext({ rpc: undefined })
    const { scope } = makeScopeStub()
    const disposer = registerGrayCodeChannel(ctx, scope)
    expect(warn).toHaveBeenCalled()
    expect(disposer()).toBeUndefined()
  })
})
