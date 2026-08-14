import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { apply, name } from '../src/index.ts'

const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')

interface GraycodeClientPackageJson {
  dsh?: {
    client?: {
      platform?: unknown
      inject?: unknown
      immediately?: unknown
    }
  }
  exports?: Record<string, unknown>
}

describe('@graycode/dsh-client node half', () => {
  it('exports a cordis plugin entry', () => {
    expect(name).toBe('graycode-client')
    expect(typeof apply).toBe('function')
  })

  it('declares a dsh.client manifest matching the dsh-client-modules scanner contract', () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as GraycodeClientPackageJson
    // parseDshClient (dsh-client-modules): platform must be a string; the
    // entry qualifies only when platform === 'web'.
    expect(pkg.dsh?.client?.platform).toBe('web')
    // inject must be a string array when present.
    expect(Array.isArray(pkg.dsh?.client?.inject)).toBe(true)
    for (const id of (pkg.dsh?.client?.inject as string[] | undefined) ?? []) {
      expect(typeof id).toBe('string')
    }
    // immediately must be a boolean when present.
    if (pkg.dsh?.client?.immediately !== undefined) {
      expect(typeof pkg.dsh?.client?.immediately).toBe('boolean')
    }
  })

  it('exports a ./client bundle the host can serve', () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as GraycodeClientPackageJson
    // clientExportOf (dsh-client-modules): exports['./client'] must be a
    // string or an object with a string default.
    const clientExport = pkg.exports?.['./client']
    expect(clientExport).toBeTypeOf('object')
    const fallback = (clientExport as { default?: unknown } | undefined)?.default
    expect(typeof fallback).toBe('string')
    expect(fallback).toBe('./lib/client.js')
  })
})
