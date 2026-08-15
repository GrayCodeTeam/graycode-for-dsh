/**
 * Cross-platform launcher for scripts/verify-pack.ps1 (3.21-M3).
 *
 * The PowerShell script itself stays the single source of truth; this launcher
 * only finds an available PowerShell host so `pnpm verify:pack` no longer
 * hard-codes Windows PowerShell (which made the script fail on non-Windows
 * platforms). Resolution order: pwsh (PowerShell Core, cross-platform) first,
 * then powershell (Windows PowerShell) on Windows only.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const script = fileURLToPath(new URL('./verify-pack.ps1', import.meta.url))
const args = process.argv.slice(2)

const candidates = process.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh']

for (const exe of candidates) {
  const probe = spawnSync(exe, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' })
  if (probe.status === 0) {
    const result = spawnSync(
      exe,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { stdio: 'inherit' },
    )
    process.exit(result.status ?? 1)
  }
}

console.error(`verify-pack requires PowerShell (pwsh); tried: ${candidates.join(', ')}`)
process.exit(1)
