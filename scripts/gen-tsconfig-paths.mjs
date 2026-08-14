/**
 * Generate `tsconfig.paths.json`: maps every `@deepseek-ai/*` package to its
 * TypeScript sources in a local DSH checkout. The dsh packages are not fully
 * published on npm (only `0.0.1-rc.1` partials), so a standalone `npm install`
 * cannot fetch them; this mapping lets `tsc` type-check this plugin against a
 * source checkout instead. esbuild does not need the mapping — both bundles
 * keep dsh packages external by design.
 *
 * Usage: DSH_PATH=path/to/deepseek-harness node scripts/gen-tsconfig-paths.mjs
 * Default checkout candidates: ../../deepseek-harness, ../../dsh-ref.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(SCRIPT_DIR, '..')

function resolveCheckout() {
  const candidates = [
    process.env.DSH_PATH,
    join(PROJECT_ROOT, '..', 'deepseek-harness'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(join(candidate, 'pnpm-workspace.yaml'))) {
      return candidate
    }
  }
  return undefined
}

function walk(directory, out) {
  let entries
  try {
    entries = readdirSync(directory)
  } catch {
    return
  }  for (const entry of entries) {
    const full = join(directory, entry)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      if (entry === 'node_modules' || entry === 'lib' || entry === 'dist' || entry === 'tests') continue
      walk(full, out)
    } else if (entry === 'package.json') {
      out.push(full)
    }
  }
}

/** Vendored libs resolved from npm types instead of checkout sources. */
const NPM_TYPED_VENDOR = new Set(['@deepseek-ai/cordis', '@deepseek-ai/cosmokit', '@deepseek-ai/schemastery'])

async function collectPackages(checkout) {
  const packageFiles = []
  walk(join(checkout, 'packages'), packageFiles)
  const packages = new Map()
  for (const packageFile of packageFiles) {
    const manifest = JSON.parse(await readFile(packageFile, 'utf8'))
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@deepseek-ai/')) continue
    packages.set(manifest.name, dirname(packageFile))
  }
  for (const entry of readdirSyncSafe(join(checkout, 'vendor'))) {
    const directory = join(checkout, 'vendor', entry)
    if (!existsSync(join(directory, 'package.json'))) continue
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (typeof manifest.name === 'string'
        && manifest.name.startsWith('@deepseek-ai/')
        && !NPM_TYPED_VENDOR.has(manifest.name)) {
        packages.set(manifest.name, directory)
      }
    } catch {
      // not a package directory
    }
  }
  return packages
}

const SOURCE_CANDIDATES = ['index.ts', 'index.tsx', 'index.d.ts']

function rel(projectRoot, target) {
  let path = relative(projectRoot, target).split('\\').join('/')
  if (!path.startsWith('.')) path = `./${path}`
  return path
}

/** Resolve the `types` condition of one exports entry (string or condition tree). */
function typesTarget(exportValue) {
  if (typeof exportValue === 'string') return exportValue
  if (typeof exportValue !== 'object' || exportValue === null) return undefined
  if (typeof exportValue.types === 'string') return exportValue.types
  const inner = exportValue.default ?? exportValue.import ?? exportValue.require
  return typesTarget(inner)
}

function resolveSource(directory, subpath) {
  if (subpath === '.' || subpath === '') {
    for (const candidate of SOURCE_CANDIDATES) {
      if (existsSync(join(directory, 'src', candidate))) return join(directory, 'src', candidate)
    }
    return undefined
  }
  const relativePath = subpath.startsWith('./') ? subpath.slice(2) : subpath
  const tries = [
    join(directory, 'src', `${relativePath}.ts`),
    join(directory, 'src', `${relativePath}.tsx`),
    join(directory, 'src', relativePath, 'index.ts'),
    join(directory, 'src', relativePath, 'index.tsx'),
  ]
  return tries.find(tryPath => existsSync(tryPath))
}

async function main() {
  const checkout = resolveCheckout()
  if (checkout === undefined) {
    console.warn(
      '[gen-tsconfig-paths] no DSH checkout found (set DSH_PATH, or place deepseek-harness next to this repo). '
      + 'Writing an empty paths map — typecheck will only cover non-dsh imports.',
    )
    await writeFile(join(PROJECT_ROOT, 'tsconfig.paths.json'), '{ "compilerOptions": { "paths": {} } }')
    return
  }
  const packages = await collectPackages(checkout)
  const paths = {}
  // Vendored libs resolve from OUR node_modules (published types, skipped by
  // skipLibCheck) so their internals are not compiled under this project's
  // compiler options; everything else maps to checkout sources.
  for (const name of NPM_TYPED_VENDOR) {
    const typesPath = join(PROJECT_ROOT, 'node_modules', ...name.split('/'), 'lib', 'types', 'index.d.ts')
    if (existsSync(typesPath)) {
      paths[name] = [rel(PROJECT_ROOT, typesPath)]
    }
  }
  for (const [name, directory] of packages) {
    let manifest
    try {
      manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const exportKeys = typeof manifest.exports === 'object' && manifest.exports !== null
      ? Object.keys(manifest.exports)
      : ['.']
    for (const exportKey of exportKeys) {
      if (!exportKey.startsWith('.')) continue
      const specifier = exportKey === '.' ? name : `${name}${exportKey.slice(1)}`
      // Prefer the built lib/types artifacts (their internals are skipped by
      // skipLibCheck); fall back to checkout sources for unbuilt packages.
      const target = typesTarget(manifest.exports[exportKey])
      if (typeof target === 'string') {
        const candidate = join(directory, target.replace(/^\.\//, ''))
        const wildcard = candidate.includes('*')
        const probe = wildcard ? dirname(candidate) : candidate
        if (existsSync(probe)) {
          paths[specifier] = [rel(PROJECT_ROOT, candidate)]
          continue
        }
      }
      const source = resolveSource(directory, exportKey)
      if (source === undefined) continue
      paths[specifier] = [rel(PROJECT_ROOT, source)]
    }
  }
  await writeFile(
    join(PROJECT_ROOT, 'tsconfig.paths.json'),
    JSON.stringify({ compilerOptions: { paths } }, null, 2) + '\n',
  )
  console.log(`[gen-tsconfig-paths] mapped ${Object.keys(paths).length} entries from ${checkout}`)
}

main().catch((error) => {
  console.error('[gen-tsconfig-paths] failed:', error)
  process.exitCode = 1
})

function readdirSyncSafe(directory) {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}
