/**
 * P0-03 cache invalidation / roster — `dsh.client` artifact consistency.
 *
 * The host's ClientModuleRegistry serves the client bundle at
 * `/plugins/@graycode/dsh-client/client.js?rev=<hash>` — the `rev` query makes
 * cache invalidation correct only if the artifact actually exists at the
 * manifest path and keeps the loader-closure shape the host executes. This spec
 * pins that roster:
 *
 * - `exports["./client"]` (the manifest entry the registry reads) must point at
 *   exactly the file tsdown.config.ts produces (`lib/client.js` from entry
 *   `lib/client/index.js`), and must never reference a missing file.
 * - When a build is present (lib/ is gitignored, so a fresh checkout has
 *   none), the manifest-referenced artifacts are checked on disk and the bundle
 *   is verified to keep the `window.__ModuleLoader__.load({ id, factory })`
 *   closure contract. The closure contract itself is additionally pinned
 *   build-independently from tsdown.config.ts (banner/intro/footer), so a
 *   fresh checkout still guards the host contract. When lib/ is absent only
 *   the on-disk checks skip; manifest ↔ config ↔ closure-shape consistency
 *   stays asserted.
 *
 * Zero network: everything here reads package-local files only.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const hasLibBuild = existsSync(join(packageRoot, 'lib/client.js'))

interface ExportConditions {
  types?: unknown
  default?: unknown
}
interface PackageJsonLike {
  exports?: Record<string, ExportConditions | string>
  files?: string[]
}

function readPackageJson(): PackageJsonLike {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as PackageJsonLike
}

describe('dsh.client manifest ↔ tsdown output consistency (cache/roster)', () => {
  it('exports["./client"] points at the tsdown bundle output', () => {
    const clientExport = readPackageJson().exports?.['./client']
    expect(clientExport).toBeTypeOf('object')
    const entry = clientExport as ExportConditions
    // The registry's clientExportOf() reads the `default`; the host serves it
    // as the classic script at /plugins/<id>/client.js.
    expect(entry.default).toBe('./lib/client.js')
    // Types ship from the tsc emit, not the bundle (dts: false in tsdown).
    expect(entry.types).toBe('./lib/client/index.d.ts')
  })

  it('the tsdown config bundles the tsc entry into exactly the manifest path', () => {
    const config = readFileSync(join(packageRoot, 'tsdown.config.ts'), 'utf8')
    // Entry + output contract (tsdown.config.ts): tsc emits lib/client/index.js,
    // tsdown bundles it to lib/client.js — the path exports["./client"] declares.
    expect(config).toContain("entry: { client: 'lib/client/index.js' }")
    expect(config).toContain("outDir: 'lib'")
    expect(config).toContain("entryFileNames: 'client.js'")
    // The bundle must stay the DSH web-platform closure shape (a plain tsc ESM
    // emit cannot be loaded by the host — see tsdown.config.ts module doc).
    expect(config).toContain("format: 'cjs'")
    expect(config).toContain("platform: 'browser'")
    expect(config).toContain('dts: false')
    expect(config).toContain('clean: false')
  })

  it('the tsdown config pins the loader-closure contract build-independently (banner/intro/footer)', () => {
    const config = readFileSync(join(packageRoot, 'tsdown.config.ts'), 'utf8')
    // The bundle contract is fully determined by tsdown config, so a fresh
    // checkout without lib/ can still pin it: the host executes the artifact as
    // a classic script, and banner+intro+footer form the closure factory
    //   window.__ModuleLoader__.load({ id: "@graycode/dsh-client", factory: (require) => { ... return module.exports; } });
    // The banner renders JSON.stringify('@graycode/dsh-client') — assert the
    // raw config expression so a package-id rename cannot silently drift the id.
    expect(config).toContain("window.__ModuleLoader__.load({ id: ${JSON.stringify('@graycode/dsh-client')}, factory: (require) => {")
    expect(config).toContain("banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('@graycode/dsh-client')}, factory: (require) => {`")
    expect(config).toContain("footer: 'return module.exports; } });'")
    expect(config).toContain("intro: 'var module = { exports: {} }; var exports = module.exports;'")
  })

  it.skipIf(!hasLibBuild)('the served bundle preserves the DSH loader-closure contract', () => {
    const bundle = readFileSync(join(packageRoot, 'lib/client.js'), 'utf8')
    // ClientModuleRegistry executes the artifact as a classic script; the
    // closure factory must register under this package id (cache-busting by
    // rev= only helps when the artifact itself is a loadable module).
    expect(bundle).toContain('window.__ModuleLoader__.load({')
    expect(bundle).toContain('id: "@graycode/dsh-client"')
    expect(bundle).toContain('var module = { exports: {} };')
    // The footer closes the factory closure: `return module.exports; } });`.
    // (The file may trail a sourceMappingURL comment, so assert the closing
    // `});` sits AFTER the last `return module.exports;` instead of at EOF.)
    const lastReturn = bundle.lastIndexOf('return module.exports;')
    expect(lastReturn).toBeGreaterThan(-1)
    const closing = bundle.indexOf('});', lastReturn)
    expect(closing).toBeGreaterThan(lastReturn)
  })

  it.skipIf(!hasLibBuild)('every manifest-referenced artifact exists once built', () => {
    // exports["./client"] default + types, plus the tsdown entry file.
    expect(existsSync(join(packageRoot, 'lib/client.js'))).toBe(true)
    expect(existsSync(join(packageRoot, 'lib/client/index.d.ts'))).toBe(true)
    expect(existsSync(join(packageRoot, 'lib/client/index.js'))).toBe(true)
    // The node half (exports["."]) still ships beside the client bundle.
    expect(existsSync(join(packageRoot, 'lib/index.js'))).toBe(true)
    expect(existsSync(join(packageRoot, 'lib/index.d.ts'))).toBe(true)
  })

  it.skipIf(!hasLibBuild)('every registered locale namespace ships a compiled dictionary artifact', () => {
    const surfaces = [
      'workflowNode',
      'workflowOverview',
      'memoryManage',
      'checkpointList',
      'restorePreview',
      'stagedDiffCard',
      'settingsContribution',
      'activityHeatmap',
      'subagentBack',
    ]
    for (const surface of surfaces) {
      expect(existsSync(join(packageRoot, 'lib/client', surface, 'locales.js')), `${surface} locales.js`).toBe(true)
      expect(existsSync(join(packageRoot, 'lib/client', surface, 'locales.d.ts')), `${surface} locales.d.ts`).toBe(true)
    }
    // Root `graycode` namespace dictionary (src/client/locales.ts).
    expect(existsSync(join(packageRoot, 'lib/client/locales.js'))).toBe(true)
    expect(existsSync(join(packageRoot, 'lib/client/locales.d.ts'))).toBe(true)
  })

  it('keeps the published files allowlist covering every manifest path (no dangling references)', () => {
    const pkg = readPackageJson()
    // The npm allowlist must include the directory every manifest path lives in.
    expect(pkg.files).toContain('lib')
    const referenced: unknown[] = []
    const rootExport = pkg.exports?.['.']
    const clientExport = pkg.exports?.['./client']
    for (const entry of [rootExport, clientExport]) {
      if (entry !== undefined && typeof entry === 'object' && entry !== null) {
        referenced.push(entry.default, entry.types)
      }
    }
    for (const path of referenced) {
      expect(typeof path, 'manifest path').toBe('string')
      if (typeof path === 'string') {
        expect(path.startsWith('./lib/'), `path ${path}`).toBe(true)
      }
    }
  })
})
