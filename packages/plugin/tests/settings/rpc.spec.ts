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
import { GrayCodeSchema } from '../../src/settings/schema.ts'
import type { GrayCodeConfig, GrayCodePatch } from '../../src/settings/types.ts'

function makeScopeStub() {
  let current: GrayCodeConfig = structuredClone(DEFAULTS)
  const update = vi.fn(async (patch: GrayCodePatch) => { current = { ...current, ...patch } })
  const replace = vi.fn(async (section: GrayCodePatch) => { current = { ...DEFAULTS, ...section } })
  return { scope: { get: () => current, update, replace } as ConfigScope, update, replace }
}

function makeConnectionStub(): {
  connection: GrayCodeConnection
  handle: ReturnType<typeof vi.fn>
  captured: { handler?: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown> }
} {
  const captured: { handler?: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown> } = {}
  const disposer = vi.fn(async () => undefined)
  const handle = vi.fn((_channel, handler) => {
    captured.handler = handler
    return disposer
  })
  return { connection: { rpc: { handle } }, handle, captured }
}

describe('/graycode browser bridge', () => {
  it('reads the live native-settings value', async () => {
    const { scope } = makeScopeStub()
    const result = await createGrayCodeConfigHandler(scope, GrayCodeSchema)('config.get', undefined)
    expect(result).toEqual({ ok: true, value: DEFAULTS })
  })

  it('accepts the documented { patch } payload and retains direct-patch compatibility', async () => {
    const { scope, update } = makeScopeStub()
    const handler = createGrayCodeConfigHandler(scope, GrayCodeSchema)
    await handler('config.update', { patch: { memory: { ...DEFAULTS.memory, wakeLines: 42 } } })
    expect(update).toHaveBeenLastCalledWith({ memory: { ...DEFAULTS.memory, wakeLines: 42 } })
    await handler('config.update', { thoughts: { enabled: true, sendHistoryThoughts: false } })
    expect(update).toHaveBeenLastCalledWith({ thoughts: { enabled: true, sendHistoryThoughts: false } })
  })

  it('returns DSH-compatible errors with required details', async () => {
    const { scope, update } = makeScopeStub()
    const handler = createGrayCodeConfigHandler(scope, GrayCodeSchema)
    const bad = await handler('config.update', { patch: { unknown: true } })
    expect(bad).toEqual({
      ok: false,
      error: { code: 'bad-request', message: expect.any(String), details: { issues: [] } },
    })
    expect(update).not.toHaveBeenCalled()
    scope.update = vi.fn(async () => { throw new Error('settings-rejected') })
    const failed = await handler('config.update', { patch: { thoughts: DEFAULTS.thoughts } })
    expect(failed).toEqual({
      ok: false,
      error: { code: 'internal', message: expect.stringContaining('settings-rejected'), details: {} },
    })
  })

  it('resets the user layer', async () => {
    const { scope, replace } = makeScopeStub()
    const result = await createGrayCodeConfigHandler(scope, GrayCodeSchema)('config.reset', {})
    expect(replace).toHaveBeenCalledWith({})
    expect(result).toEqual({ ok: true, value: DEFAULTS })
  })

  it('bridges Gray Remote while preserving its nested result envelope', async () => {
    const { scope } = makeScopeStub()
    const remoteResult = { ok: false, error: { code: 'GRAY_CONFLICT', message: 'changed', details: {} } }
    const invoke = vi.fn(async () => remoteResult)
    const handler = createGrayCodeConfigHandler(scope, GrayCodeSchema, { invoke })
    const signal = new AbortController().signal
    const result = await handler('remote.invoke', {
      namespace: 'checkpoints',
      method: 'previewRestore',
      args: { checkpointId: 'cp-1' },
    }, signal)
    expect(invoke).toHaveBeenCalledWith('checkpoints', 'previewRestore', { checkpointId: 'cp-1' }, signal)
    expect(result).toEqual({ ok: true, value: remoteResult })
  })

  it('rejects malformed remote calls before dispatch', async () => {
    const { scope } = makeScopeStub()
    const invoke = vi.fn()
    const result = await createGrayCodeConfigHandler(scope, GrayCodeSchema, { invoke })('remote.invoke', {
      namespace: '', method: 'list', args: [],
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request', details: { issues: [] } } })
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('registerGrayCodeChannel', () => {
  it('registers the trusted-host channel and obtains both services by name', async () => {
    const { connection, handle, captured } = makeConnectionStub()
    const remote = { invoke: vi.fn() }
    const ctx: ChannelHostContextLike = {
      get: name => name === 'connection' ? connection : name === 'grayRemote' ? remote : undefined,
      logger: { warn: vi.fn(), info: vi.fn() },
    }
    const { scope } = makeScopeStub()
    const disposer = registerGrayCodeChannel(ctx, scope, GrayCodeSchema)
    expect(handle).toHaveBeenCalledWith(GRAYCODE_CHANNEL, expect.any(Function), { authority: 'trusted-host' })
    expect(await captured.handler!('config.get', {})).toEqual({ ok: true, value: DEFAULTS })
    await disposer()
  })

  it('degrades safely when connection is absent', () => {
    const warn = vi.fn()
    const ctx: ChannelHostContextLike = { get: () => undefined, logger: { warn, info: vi.fn() } }
    const { scope } = makeScopeStub()
    const disposer = registerGrayCodeChannel(ctx, scope, GrayCodeSchema)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/graycode'))
    expect(disposer()).toBeUndefined()
  })
})
