/**
 * GrayCode - notifications 域 toast 后端（C4 Windows 原生 toast）。
 *
 * SPIKE 结论（本文件依据，详见 README）：
 * - DSH rc.6 无公开 WinRT 面（无法从插件进程直接调用 Windows Runtime toast）；
 * - 零新增依赖约束下，可用通道是 child_process → `powershell.exe`（系统自带，
 *   PowerShell 5.1 支持 WinRT interop），脚本经 `[Windows.UI.Notifications.
 *   ToastNotificationManager]` 发送原生 toast；
 * - 该路径要求宿主进程有应用标识（AUMID + 开始菜单快捷方式）才能实际弹出；
 *   无法保证时脚本抛错/退出码非 0 → 后端返回 failed 投递（fail-closed），
 *   绝不抛出影响主流程（失败隔离由 service 层兜底）。
 *
 * 端口抽象：{@link PowerShellRunner} 可注入，测试用 fake runner 模拟
 * spawn/退出/超时，不真弹 toast。
 */

import { spawn } from 'node:child_process'
import type { NotifyRequest } from './types.ts'

/** PowerShell 进程默认超时（ms）。 */
export const DEFAULT_POWER_SHELL_TIMEOUT_MS = 15_000

/** 一次投递的三种结局（backend 层与平台解耦；稳定码映射在 service 层）。 */
export type ToastOutcome =
  | { readonly status: 'delivered' }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string }

/** toast 后端端口（生产为 PowerShell/Noop；测试注入 fake）。 */
export interface ToastBackend {
  readonly name: string
  /** 当前平台/配置下是否尝试投递（false → service 直接 skipped）。 */
  isAvailable(): boolean
  /** 尝试投递。实现不得 reject（任何失败收敛为 outcome.failed/skipped）。 */
  show(request: Readonly<NotifyRequest>): Promise<ToastOutcome>
}

// ─── PowerShell runner 端口 ───────────────────────────────

export interface PowerShellRunRequest {
  readonly script: string
  readonly env: Readonly<Record<string, string>>
}

export interface PowerShellRunResult {
  readonly ok: boolean
  readonly code: number | null
  readonly error: string | null
}

export interface PowerShellRunner {
  run(request: PowerShellRunRequest): Promise<PowerShellRunResult>
}

/**
 * 默认 runner：`child_process.spawn('powershell.exe', [...])`。
 * - 参数走 argv 数组（不经过 shell），脚本经 `-Command` 字面量传入，
 *   标题/正文经环境变量注入 → 无引号注入面；
 * - 超时后 kill 并以 failed 收敛；spawn 同步异常同样收敛。
 */
export function createNodePowerShellRunner(timeoutMs = DEFAULT_POWER_SHELL_TIMEOUT_MS): PowerShellRunner {
  return {
    run(request) {
      return new Promise<PowerShellRunResult>((resolve) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const settle = (result: PowerShellRunResult): void => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          resolve(result)
        }

        let child: ReturnType<typeof spawn>
        try {
          child = spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', request.script],
            {
              env: { ...process.env, ...request.env },
              windowsHide: true,
              stdio: ['ignore', 'ignore', 'pipe'],
            },
          )
        } catch (error) {
          settle({ ok: false, code: null, error: error instanceof Error ? error.message : String(error) })
          return
        }

        timer = setTimeout(() => {
          child.kill()
          settle({ ok: false, code: null, error: `powershell toast timed out after ${timeoutMs}ms` })
        }, timeoutMs)

        let stderr = ''
        child.on('error', (error) => {
          settle({ ok: false, code: null, error: error.message })
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
        })
        child.on('close', (code) => {
          settle({
            ok: code === 0,
            code,
            error: code === 0 ? null : stderr.trim() || `powershell exited with code ${code}`,
          })
        })
      })
    },
  }
}

/**
 * Windows 原生 toast 脚本（PowerShell 5.1 WinRT interop，零第三方模块）。
 *
 * 已知限制（fail-closed 依据）：`CreateToastNotifier('GrayCode')` 在宿主没有
 * 注册 AUMID（开始菜单快捷方式 + AppUserModelID）时，`Show` 会抛错或静默
 * 失败——脚本以非零退出码收敛，投递返回 failed。README 记录该限制与
 * 「应用标识齐全后无需改动代码」的升级路径。
 */
export const WINDOWS_TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $template.GetElementsByTagName('text')
  $title = [string]$env:GRAYCODE_NOTIFY_TITLE
  $message = [string]$env:GRAYCODE_NOTIFY_MESSAGE
  $texts.Item(0).AppendChild($template.CreateTextNode($title)) | Out-Null
  if ($message.Length -gt 0) {
    $texts.Item(1).AppendChild($template.CreateTextNode($message)) | Out-Null
  }
  $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('GrayCode')
  $notifier.Show($toast)
} catch {
  Write-Error ('graycode-notify: ' + $_.Exception.Message)
  exit 1
}
`

export interface PowerShellToastBackendOptions {
  /** 平台标识（默认 process.platform；测试注入 'win32'/'darwin'/...）。 */
  readonly platform?: string
  /** spawn runner（默认 createNodePowerShellRunner；测试注入 fake）。 */
  readonly runner?: PowerShellRunner
  /** 仅用于构造默认 runner 的超时（传入 runner 时忽略）。 */
  readonly timeoutMs?: number
}

/** Windows 原生 toast 后端（child_process → powershell.exe，零新增依赖）。 */
export class PowerShellToastBackend implements ToastBackend {
  readonly name = 'powershell-winrt'

  private readonly platform: string
  private readonly runner: PowerShellRunner

  constructor(options: PowerShellToastBackendOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.runner = options.runner ?? createNodePowerShellRunner(options.timeoutMs)
  }

  isAvailable(): boolean {
    return this.platform === 'win32'
  }

  async show(request: Readonly<NotifyRequest>): Promise<ToastOutcome> {
    if (!this.isAvailable()) {
      return { status: 'skipped', reason: 'windows toast requires a win32 host' }
    }
    try {
      const result = await this.runner.run({
        script: WINDOWS_TOAST_SCRIPT,
        env: {
          GRAYCODE_NOTIFY_TITLE: request.title,
          GRAYCODE_NOTIFY_MESSAGE: request.message ?? '',
        },
      })
      if (!result.ok) {
        return {
          status: 'failed',
          reason:
            result.error ??
            (result.code !== null ? `powershell exited with code ${result.code}` : 'powershell toast failed'),
        }
      }
      return { status: 'delivered' }
    } catch (error) {
      // runner 自身异常（防御）：收敛为 failed，绝不外溢
      return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** 空后端：平台不支持 / windowsToast 关闭时使用；投递一律 skipped。 */
export class NoopToastBackend implements ToastBackend {
  readonly name = 'noop'

  isAvailable(): boolean {
    return true
  }

  async show(_request: Readonly<NotifyRequest>): Promise<ToastOutcome> {
    return { status: 'skipped', reason: 'notification backend disabled (noop)' }
  }
}

export interface ToastBackendConfig {
  /** 是否启用 Windows 原生 toast（默认 true；false → 恒 noop）。 */
  readonly windowsToast: boolean
  /** 平台标识（默认 process.platform；测试注入）。 */
  readonly platform?: string
  /** spawn runner（测试注入；win32 + windowsToast 时透传给 PowerShell 后端）。 */
  readonly runner?: PowerShellRunner
}

/** 按平台/配置选择后端：win32 + windowsToast → PowerShell；否则 noop（fail-closed）。 */
export function createToastBackend(config: ToastBackendConfig): ToastBackend {
  const platform = config.platform ?? process.platform
  if (config.windowsToast && platform === 'win32') {
    return new PowerShellToastBackend({ platform, runner: config.runner })
  }
  return new NoopToastBackend()
}
