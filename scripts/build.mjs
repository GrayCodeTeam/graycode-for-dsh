/**
 * Build script: Host plugin (lib/index.js, ESM) + browser bundle
 * (lib/client.js, ModuleLoader handoff).
 *
 * The browser bundle mirrors the DSH client-bundle conventions: CJS output
 * wrapped in `window.__ModuleLoader__.load({ id, factory })`, platform
 * modules left external (resolved from the loader module table), CSS inlined
 * as an injected <style> tag.
 */

import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

const PACKAGE_ID = 'graycode-for-dsh'

/** Browser externals: the DSH shell's frozen module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** Inline .css imports as a style-tag injection module (mirrors dsh-tsdown). */
const cssInlinePlugin = {
  name: 'graycode-css-inline',
  setup(buildCtx) {
    buildCtx.onLoad({ filter: /\.css$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8')
      const tagId = `${PACKAGE_ID}/${basename(args.path)}`
      const contents = [
        `const css = ${JSON.stringify(source)};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        `if (typeof document !== 'undefined' && document.querySelector('style[data-gc-css="' + tagId + '"]') === null) {`,
        `  const tag = document.createElement('style');`,
        `  tag.dataset.gcCss = tagId;`,
        `  tag.textContent = css;`,
        `  document.head.appendChild(tag);`,
        `}`,
        `export default undefined;`,
      ].join('\n')
      return { contents, loader: 'js' }
    })
  },
}

async function main() {
  await build({
    entryPoints: ['src/index.ts'],
    outfile: 'lib/index.js',
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    // All package imports (cordis, schemastery, dsh-*) resolve from the
    // profile's node_modules at runtime; only our own sources are bundled.
    packages: 'external',
    logLevel: 'info',
  })

  await build({
    entryPoints: ['client/index.ts'],
    outfile: 'lib/client.js',
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    external: CLIENT_EXTERNALS,
    plugins: [cssInlinePlugin],
    banner: {
      js: [
        `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
        `var module = { exports: {} }; var exports = module.exports;`,
      ].join('\n'),
    },
    footer: { js: 'return module.exports; } });' },
    logLevel: 'info',
  })

  console.log('[graycode-for-dsh] build complete: lib/index.js + lib/client.js')
}

main().catch((error) => {
  console.error('[graycode-for-dsh] build failed:', error)
  process.exitCode = 1
})
