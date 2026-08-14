/**
 * GrayRemoteService 分发契约测试：信封、稳定错误码、投影记录、注册冲突。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GrayRemoteService } from '../../src/remote/service.ts'
import { GrayRemoteError } from '../../src/remote/errors.ts'
import { GRAY_REMOTE_ERROR_CODES } from '../../src/remote/types.ts'
import { StagedDiffError, StagedDiffErrorCode } from '../../src/stagedDiff/domain/types.ts'

function makeService(options: { journalPath?: string } = {}): {
  ctx: Context
  service: GrayRemoteService
} {
  const ctx = new Context()
  const service = new GrayRemoteService(ctx, { journalPath: options.journalPath })
  return { ctx, service }
}

describe('GrayRemoteService', () => {
  it('成功调用返回 { ok: true, value } 且结果进入投影日志', async () => {
    const { service } = makeService()
    service.register({
      'test/echo': args => ({ echoed: args.value }),
    })
    const result = await service.invoke('test', 'echo', { value: 42 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ echoed: 42 })

    const replay = await service.projection.replay()
    expect(replay).toHaveLength(1)
    expect(replay[0]!.kind).toBe('query:test/echo')
    expect((replay[0]!.payload as { ok: boolean }).ok).toBe(true)
  })

  it('未知端点返回 GRAY_ENDPOINT_NOT_FOUND 信封（不 reject）', async () => {
    const { service } = makeService()
    const result = await service.invoke('nope', 'missing', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(GRAY_REMOTE_ERROR_CODES.ENDPOINT_NOT_FOUND)
      expect(result.error.details).toMatchObject({ namespace: 'nope', method: 'missing' })
    }
  })

  it('GrayRemoteError 原样映射为稳定码', async () => {
    const { service } = makeService()
    service.register({
      'test/fail': () => {
        throw GrayRemoteError.approvalRequired('need approval', { token: 'x' })
      },
    })
    const result = await service.invoke('test', 'fail', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED)
      expect(result.error.details).toEqual({ token: 'x' })
    }
  })

  it('StagedDiffError 映射为稳定码（REVISION_CONFLICT → GRAY_CONFLICT，保留 causeCode）', async () => {
    const { service } = makeService()
    service.register({
      'test/cas': () => {
        throw new StagedDiffError('revision mismatch', StagedDiffErrorCode.REVISION_CONFLICT)
      },
    })
    const result = await service.invoke('test', 'cas', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(GRAY_REMOTE_ERROR_CODES.CONFLICT)
      expect(result.error.details.causeCode).toBe(StagedDiffErrorCode.REVISION_CONFLICT)
    }
  })

  it('普通错误映射为 GRAY_INTERNAL 且不透出原始 message/堆栈', async () => {
    const { service } = makeService()
    service.register({
      'test/boom': () => {
        throw new Error('secret internal detail: /home/user/.ssh/id_rsa')
      },
    })
    const result = await service.invoke('test', 'boom', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(GRAY_REMOTE_ERROR_CODES.INTERNAL)
      expect(result.error.message).not.toContain('secret internal detail')
      expect(result.error.details.causeName).toBe('Error')
    }
  })

  it('取消类错误映射为 GRAY_CANCELLED（AbortError 与 signal.aborted）', async () => {
    const { service } = makeService()
    service.register({
      'test/cancel': (_args, signal) => {
        if (signal?.aborted) {
          const err = new Error('aborted') as Error & { name: string }
          err.name = 'AbortError'
          throw err
        }
        return 'ok'
      },
    })
    const controller = new AbortController()
    controller.abort()
    const result = await service.invoke('test', 'cancel', {}, controller.signal)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(GRAY_REMOTE_ERROR_CODES.CANCELLED)
    }
  })

  it('同端点重复注册抛装配错误（不静默覆盖）', () => {
    const { service } = makeService()
    service.register({ 'test/dup': () => 1 })
    expect(() => service.register({ 'test/dup': () => 2 })).toThrow(/already registered/)
  })

  it('register 返回注销函数：注销后同 key 可重新注册，旧端点不可达（HMR 域级重载语义）', async () => {
    const { service } = makeService()
    const unregister = service.register({ 'test/lifecycle': () => 'v1' })
    expect(await service.invoke('test', 'lifecycle', {})).toEqual({ ok: true, value: 'v1' })

    // 注销：旧端点不可达（ENDPOINT_NOT_FOUND），has/listEndpoints 同步反映
    unregister()
    expect(service.has('test/lifecycle')).toBe(false)
    const missing = await service.invoke('test', 'lifecycle', {})
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.error.code).toBe(GRAY_REMOTE_ERROR_CODES.ENDPOINT_NOT_FOUND)
    }

    // 注销后同 key 重新注册成功（旧端点不悬垂）
    service.register({ 'test/lifecycle': () => 'v2' })
    expect(await service.invoke('test', 'lifecycle', {})).toEqual({ ok: true, value: 'v2' })

    // 注销函数幂等：重复调用不抛错；按 key 注销后新端点同样不可达
    unregister()
    unregister()
    expect(service.has('test/lifecycle')).toBe(false)
  })

  it('register 批内重复端点抛错并回滚本批已注册端点（批量注册原子化）', () => {
    const { service } = makeService()
    service.register({ 'a/one': () => 1 })
    expect(() => service.register({ 'b/two': () => 2, 'a/one': () => 99 })).toThrow(/already registered/)
    // 本批先注册的 b/two 一并回滚：不残留半批状态
    expect(service.has('b/two')).toBe(false)
    expect(service.has('a/one')).toBe(true)
  })

  it('handler 抛普通 Error 时投影仍记录失败事件（尽力通道）', async () => {
    const { service } = makeService()
    service.register({
      'test/fail2': () => {
        throw new Error('x')
      },
    })
    await service.invoke('test', 'fail2', {})
    const replay = await service.projection.replay()
    const entry = replay[0]!
    expect(entry.kind).toBe('query:test/fail2')
    expect((entry.payload as { ok: boolean }).ok).toBe(false)
  })

  it('has/listEndpoints 提供端点契约面', () => {
    const { service } = makeService()
    service.register({ 'a/one': () => 1, 'b/two': () => 2 })
    expect(service.has('a/one')).toBe(true)
    expect(service.has('a/two')).toBe(false)
    expect(service.listEndpoints()).toEqual(['a/one', 'b/two'])
  })
})
