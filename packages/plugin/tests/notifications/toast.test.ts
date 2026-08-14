/**
 * notifications 域 toast 后端测试（Windows 特有路径全部经注入 runner mock，
 * 不真弹 toast、不 spawn 真实进程）。
 */
import { describe, expect, test } from 'vitest'
import {
  NoopToastBackend,
  PowerShellToastBackend,
  WINDOWS_TOAST_SCRIPT,
  createToastBackend,
  type PowerShellRunRequest,
  type PowerShellRunResult,
  type PowerShellRunner,
} from '../../src/notifications/domain/toast.ts'
import type { NotifyRequest } from '../../src/notifications/domain/types.ts'

function request(overrides: Partial<NotifyRequest> = {}): NotifyRequest {
  return { title: 'Build passed', message: 'all green', level: 'success', silent: false, ...overrides }
}

function runnerOf(impl: (request: PowerShellRunRequest) => PowerShellRunResult): PowerShellRunner {
  return { run: (request) => Promise.resolve(impl(request)) }
}

describe('PowerShellToastBackend', () => {
  test('isAvailable 仅在 win32 为 true', () => {
    expect(new PowerShellToastBackend({ platform: 'win32' }).isAvailable()).toBe(true)
    expect(new PowerShellToastBackend({ platform: 'darwin' }).isAvailable()).toBe(false)
    expect(new PowerShellToastBackend({ platform: 'linux' }).isAvailable()).toBe(false)
  })

  test('非 win32 show → skipped（不调用 runner）', async () => {
    let called = false
    const backend = new PowerShellToastBackend({
      platform: 'darwin',
      runner: {
        run: async () => {
          called = true
          return { ok: true, code: 0, error: null }
        },
      },
    })
    await expect(backend.show(request())).resolves.toEqual({
      status: 'skipped',
      reason: expect.any(String),
    })
    expect(called).toBe(false)
  })

  test('win32 + runner ok → delivered；env 携带 title/message，脚本含 WinRT 调用', async () => {
    let captured: PowerShellRunRequest | undefined
    const backend = new PowerShellToastBackend({
      platform: 'win32',
      runner: {
        run: async (r) => {
          captured = r
          return { ok: true, code: 0, error: null }
        },
      },
    })
    await expect(backend.show(request({ title: 'Hi', message: 'Body' }))).resolves.toEqual({
      status: 'delivered',
    })
    expect(captured).toBeDefined()
    expect(captured!.env.GRAYCODE_NOTIFY_TITLE).toBe('Hi')
    expect(captured!.env.GRAYCODE_NOTIFY_MESSAGE).toBe('Body')
    expect(captured!.script).toContain('ToastNotificationManager')
    expect(captured!.script).toContain('ToastText02')
  })

  test('message 为 null 时 env 为空串', async () => {
    let captured: PowerShellRunRequest | undefined
    const backend = new PowerShellToastBackend({
      platform: 'win32',
      runner: {
        run: async (r) => {
          captured = r
          return { ok: true, code: 0, error: null }
        },
      },
    })
    await backend.show(request({ message: null }))
    expect(captured!.env.GRAYCODE_NOTIFY_MESSAGE).toBe('')
  })

  test('runner 返回 !ok → failed（reason 带 stderr）', async () => {
    const backend = new PowerShellToastBackend({
      platform: 'win32',
      runner: runnerOf(() => ({ ok: false, code: 1, error: 'boom' })),
    })
    await expect(backend.show(request())).resolves.toEqual({ status: 'failed', reason: 'boom' })
  })

  test('runner 无错误信息时 failed reason 兜底退出码', async () => {
    const backend = new PowerShellToastBackend({
      platform: 'win32',
      runner: runnerOf(() => ({ ok: false, code: 1, error: null })),
    })
    const outcome = await backend.show(request())
    expect(outcome).toMatchObject({ status: 'failed' })
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain('code 1')
    }
  })

  test('runner reject → failed（后端绝不抛出）', async () => {
    const backend = new PowerShellToastBackend({
      platform: 'win32',
      runner: {
        run: async () => {
          throw new Error('spawn boom')
        },
      },
    })
    await expect(backend.show(request())).resolves.toEqual({ status: 'failed', reason: 'spawn boom' })
  })
})

describe('NoopToastBackend', () => {
  test('恒可用且 show → skipped（fail-closed 兜底）', async () => {
    const backend = new NoopToastBackend()
    expect(backend.name).toBe('noop')
    expect(backend.isAvailable()).toBe(true)
    await expect(backend.show(request())).resolves.toEqual({
      status: 'skipped',
      reason: expect.any(String),
    })
  })
})

describe('createToastBackend 平台/配置选择', () => {
  test('win32 + windowsToast → PowerShell 后端（runner 透传可注入）', () => {
    const runner = runnerOf(() => ({ ok: true, code: 0, error: null }))
    const backend = createToastBackend({ windowsToast: true, platform: 'win32', runner })
    expect(backend.name).toBe('powershell-winrt')
  })

  test('windowsToast=false → noop（即使 win32）', () => {
    expect(createToastBackend({ windowsToast: false, platform: 'win32' }).name).toBe('noop')
  })

  test('非 win32 + windowsToast=true → noop（fail-closed）', () => {
    expect(createToastBackend({ windowsToast: true, platform: 'linux' }).name).toBe('noop')
    expect(createToastBackend({ windowsToast: true, platform: 'darwin' }).name).toBe('noop')
  })
})
