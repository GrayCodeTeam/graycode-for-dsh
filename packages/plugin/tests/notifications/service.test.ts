/**
 * notifications 域服务测试：失败隔离（后端不可用/failed/异常绝不外溢）、
 * 参数校验稳定错误码、观察者事件发射（含观察者异常被吞掉）。
 * 全部经注入 fake 后端端口（不真弹 toast）。
 */
import { describe, expect, test } from 'vitest'
import { NotificationService, NOTIFY_EVENT } from '../../src/notifications/service.ts'
import type { ToastBackend, ToastOutcome } from '../../src/notifications/domain/toast.ts'
import {
  NotificationDeliveryCode,
  NotificationError,
  NotificationErrorCode,
} from '../../src/notifications/domain/types.ts'

interface FakeBackendOptions {
  readonly available?: boolean
  readonly outcome?: ToastOutcome | 'throw'
}

function fakeBackend(options: FakeBackendOptions = {}): ToastBackend {
  const outcome: ToastOutcome | 'throw' = options.outcome ?? { status: 'delivered' }
  return {
    name: 'fake-backend',
    isAvailable: () => options.available ?? true,
    show: async () => {
      if (outcome === 'throw') throw new Error('backend boom')
      return outcome
    },
  }
}

describe('NotificationService.notify 参数校验', () => {
  test('参数非法 → 抛 NotificationError（稳定码），不进入后端', async () => {
    const backend = fakeBackend()
    const service = new NotificationService({ backend })
    let caught: unknown
    try {
      await service.notify({ title: '' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(NotificationError)
    expect((caught as NotificationError).code).toBe(NotificationErrorCode.INVALID_INPUT)
  })
})

describe('NotificationService.notify 投递', () => {
  test('后端可用 + delivered → delivery 收敛为 DELIVERED（绝不 reject）', async () => {
    const service = new NotificationService({ backend: fakeBackend() })
    const result = await service.notify({ title: 'Build passed', message: 'all green' })
    expect(result.request).toEqual({ title: 'Build passed', message: 'all green', level: 'info', silent: false })
    expect(result.delivery).toEqual({
      status: 'delivered',
      code: NotificationDeliveryCode.DELIVERED,
      message: 'notification delivered',
      backend: 'fake-backend',
    })
    expect(result.notifiedAt).toBeGreaterThan(0)
  })

  test('后端不可用 → skipped + GRAY_NOTIFY_SKIPPED（不调用 show）', async () => {
    const service = new NotificationService({ backend: fakeBackend({ available: false }) })
    const result = await service.notify({ title: 'x' })
    expect(result.delivery.status).toBe('skipped')
    expect(result.delivery.code).toBe(NotificationDeliveryCode.SKIPPED)
  })

  test('后端 show 返回 failed → 收敛为 failed + GRAY_NOTIFY_TOAST_FAILED', async () => {
    const service = new NotificationService({
      backend: fakeBackend({ outcome: { status: 'failed', reason: 'AUMID missing' } }),
    })
    const result = await service.notify({ title: 'x' })
    expect(result.delivery.status).toBe('failed')
    expect(result.delivery.code).toBe(NotificationDeliveryCode.TOAST_FAILED)
    expect(result.delivery.message).toContain('AUMID missing')
  })

  test('后端 show 返回 skipped → 收敛为 skipped', async () => {
    const service = new NotificationService({
      backend: fakeBackend({ outcome: { status: 'skipped', reason: 'noop' } }),
    })
    const result = await service.notify({ title: 'x' })
    expect(result.delivery.status).toBe('skipped')
    expect(result.delivery.code).toBe(NotificationDeliveryCode.SKIPPED)
  })

  test('后端 show 抛异常 → failed（失败隔离，绝不 reject）', async () => {
    const service = new NotificationService({ backend: fakeBackend({ outcome: 'throw' }) })
    const result = await service.notify({ title: 'x' })
    expect(result.delivery.status).toBe('failed')
    expect(result.delivery.code).toBe(NotificationDeliveryCode.TOAST_FAILED)
    expect(result.delivery.message).toContain('backend boom')
  })
})

describe('NotificationService 观察者事件', () => {
  test('投递完成后发射 graycode/notifications/notify + 结果', async () => {
    const emitted: Array<{ kind: string; payload: unknown }> = []
    const service = new NotificationService({
      backend: fakeBackend(),
      emit: (kind, payload) => emitted.push({ kind, payload }),
    })
    await service.notify({ title: 'x' })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.kind).toBe(NOTIFY_EVENT)
    const payload = emitted[0]!.payload as { delivery: { status: string } }
    expect(payload.delivery.status).toBe('delivered')
  })

  test('观察者抛异常 → notify 仍 resolve（不影响主流程）', async () => {
    const service = new NotificationService({
      backend: fakeBackend(),
      emit: () => {
        throw new Error('observer boom')
      },
    })
    const result = await service.notify({ title: 'x' })
    expect(result.delivery.status).toBe('delivered')
  })

  test('未配置 emit 时默认 noop（不抛）', async () => {
    const service = new NotificationService({ backend: fakeBackend() })
    await expect(service.notify({ title: 'x' })).resolves.toMatchObject({
      delivery: { status: 'delivered' },
    })
  })
})

describe('NotificationService 辅助', () => {
  test('backendName 暴露当前后端名', () => {
    expect(new NotificationService({ backend: fakeBackend() }).backendName).toBe('fake-backend')
  })
})
