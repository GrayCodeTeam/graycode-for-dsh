/**
 * notify 工具测试：参数校验（schema 拒绝 + body 防御校验稳定错误码）、
 * 输出形状（message 省略/透传）、投递失败不抛出（结果字段承载状态）。
 * 全部经注入 fake 后端端口（不真弹 toast）。
 */
import { describe, expect, test } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createNotifyTools } from '../../src/notifications/tools.ts'
import { NotificationService } from '../../src/notifications/service.ts'
import {
  NotificationDeliveryCode,
  NotificationError,
  NotificationErrorCode,
} from '../../src/notifications/domain/types.ts'
import type { ToastBackend, ToastOutcome } from '../../src/notifications/domain/toast.ts'

interface NotifyToolResult {
  text: string
  notification: {
    title: string
    message?: string
    level: string
    silent: boolean
    delivered: boolean
    deliveryCode: string
  }
}

function fakeBackend(outcome: ToastOutcome | 'throw' = { status: 'delivered' }): ToastBackend {
  return {
    name: 'fake-backend',
    isAvailable: () => true,
    show: async () => {
      if (outcome === 'throw') throw new Error('backend boom')
      return outcome
    },
  }
}

function makeTool(backend: ToastBackend = fakeBackend()): ToolDefinition {
  const service = new NotificationService({ backend })
  return createNotifyTools(service)[0]!
}

function fakeExec(aborted = false): ToolRunContext {
  const controller = new AbortController()
  if (aborted) controller.abort()
  return { signal: controller.signal, agent: { session: { header: {} } } } as unknown as ToolRunContext
}

describe('notify 工具执行', () => {
  test('合法参数 → delivered + GRAY_NOTIFY_DELIVERED；message 缺省时省略', async () => {
    const tool = makeTool()
    const result = (await tool.execute({ title: 'Build passed' }, fakeExec())) as NotifyToolResult
    expect(result.notification.delivered).toBe(true)
    expect(result.notification.deliveryCode).toBe(NotificationDeliveryCode.DELIVERED)
    expect(result.notification.title).toBe('Build passed')
    expect(result.notification.level).toBe('info')
    expect(result.notification.silent).toBe(false)
    expect('message' in result.notification).toBe(false)
    expect(result.text).toContain('Build passed')
  })

  test('message / level / silent 透传', async () => {
    const tool = makeTool()
    const result = (await tool.execute(
      { title: 'Careful', message: 'check the diff', level: 'warning', silent: true },
      fakeExec(),
    )) as NotifyToolResult
    expect(result.notification.message).toBe('check the diff')
    expect(result.notification.level).toBe('warning')
    expect(result.notification.silent).toBe(true)
  })

  test('title 超长（schema 无 maxLength）→ body 防御校验抛稳定错误码', async () => {
    const tool = makeTool()
    const error = (await tool.execute({ title: 't'.repeat(121) }, fakeExec()).catch((e: unknown) => e)) as Error
    expect(error).toBeInstanceOf(NotificationError)
    expect((error as NotificationError).code).toBe(NotificationErrorCode.INVALID_INPUT)
  })

  test('level 非法 → 被 schema 层拒绝（非 NotificationError）', async () => {
    const tool = makeTool()
    const error = (await tool.execute({ title: 'x', level: 'bogus' }, fakeExec()).catch((e: unknown) => e)) as Error
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(NotificationError)
  })

  test('后端 failed → delivered=false + TOAST_FAILED，execute 不抛出', async () => {
    const tool = makeTool(fakeBackend({ status: 'failed', reason: 'AUMID missing' }))
    const result = (await tool.execute({ title: 'x' }, fakeExec())) as NotifyToolResult
    expect(result.notification.delivered).toBe(false)
    expect(result.notification.deliveryCode).toBe(NotificationDeliveryCode.TOAST_FAILED)
    expect(result.text).toContain('delivery failed')
  })

  test('后端不可用（skipped）→ delivered=false + SKIPPED', async () => {
    const backend: ToastBackend = {
      name: 'fake-backend',
      isAvailable: () => false,
      show: async () => ({ status: 'delivered' }),
    }
    const tool = makeTool(backend)
    const result = (await tool.execute({ title: 'x' }, fakeExec())) as NotifyToolResult
    expect(result.notification.delivered).toBe(false)
    expect(result.notification.deliveryCode).toBe(NotificationDeliveryCode.SKIPPED)
  })

  test('exec.signal 已中止 → 工具拒绝执行', async () => {
    const tool = makeTool()
    const error = (await tool.execute({ title: 'x' }, fakeExec(true)).catch((e: unknown) => e)) as Error
    expect(error.message).toContain('aborted')
  })

  test('render 投影为 text 块', async () => {
    const tool = makeTool()
    const result = (await tool.execute({ title: 'x' }, fakeExec())) as unknown as {
      text: string
    }
    const content = tool.output.render({}, result as never)
    expect(content[0]!.type).toBe('text')
    expect((content[0] as { text: string }).text).toContain('Notification')
  })
})
