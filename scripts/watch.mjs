/**
 * GrayCode × DSH 开发 watch：并行编译 plugin（tsc -w）与 client（tsc -w + tsdown -w）。
 *
 * 配合 web profile 的目录链接（link:./_dev-link/...）使用：
 * - client 改动 → tsdown 重建 lib/client.js → dsh-client-hmr（500ms 轮询）检测变化
 *   → 重算 rev → SSE 广播 / 刷新页面即可看到新 UI，无需重启 dsh。
 * - plugin（host）改动 → tsc 编译后需要重启 dsh web 进程才生效。
 *
 * 用法：pnpm dev:watch
 */

import { spawn } from 'node:child_process'
import process from 'node:process'

const tasks = [
  { name: 'plugin tsc -w', cwd: 'packages/plugin', cmd: 'pnpm exec tsc -p tsconfig.json -w', delayMs: 0 },
  { name: 'client tsc -w', cwd: 'packages/client', cmd: 'pnpm exec tsc -p tsconfig.json -w', delayMs: 0 },
  // tsdown 延迟启动：等 tsc 首轮全量 emit 完成，避免启动时读到 lib 中间态
  // （tsc 写文件与 tsdown 读文件竞态 → 偶发 MISSING_EXPORT，tsdown 会在文件稳定后自愈重建）
  { name: 'client tsdown -w', cwd: 'packages/client', cmd: 'pnpm exec tsdown -w', delayMs: 3000 },
]

const children = tasks.map((t) => {
  const [cmd, ...args] = t.cmd.split(' ')
  const spawnChild = () => {
    const child = spawn(cmd, args, {
      cwd: t.cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.on('exit', (code) => {
      console.error(`[watch] ${t.name} exited with code ${code}; shutting down all watchers.`)
      shutdown()
    })
    return child
  }
  if (t.delayMs > 0) {
    console.log(`[watch] ${t.name} will start in ${t.delayMs}ms (waiting for tsc first pass)`)
    setTimeout(() => children.push(spawnChild()), t.delayMs)
    return null
  }
  return spawnChild()
}).filter(Boolean)

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    try {
      child.kill()
    } catch {
      // already gone
    }
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
