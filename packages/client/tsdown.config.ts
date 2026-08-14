/**
 * Browser bundle build for `@graycode/dsh-client`, mirroring the DSH official
 * client-bundle preset (`packages/client/tsdown.client.ts` in deepseek-harness,
 * as consumed by `@deepseek-ai/dsh-client-ui-layout` etc.).
 *
 * Output: `lib/client.js` — a closure-factory artifact that calls
 * `window.__ModuleLoader__.load({ id, factory })` at script evaluation and
 * resolves externals through the injected synchronous `require` (the host's
 * loader module table). The host's ClientModuleRegistry serves this file at
 * `/plugins/@graycode/dsh-client/client.js?rev=<hash>` and executes it as a
 * classic script, so the bundle MUST stay in this CJS closure shape — a plain
 * tsc ESM emit cannot be loaded by DSH.
 *
 * Build order (package script `build`): `tsc -p tsconfig.json` first compiles
 * `src/` into `lib/` (including the browser entry at `lib/client/index.js`),
 * then this config bundles that entry into `lib/client.js`.
 */
import { defineConfig } from 'tsdown'

/**
 * Platform modules the web shell shares into the frozen module table
 * (single source: `packages/client/web/src/platform.ts` in deepseek-harness).
 * Specifiers here stay `require()`-external in the bundle; the module table
 * answers them at runtime. They never need to resolve at build time.
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** Documented runtime exemption: the snapshot-store engine lives in the runtime package. */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

/** Externals resolved from the loader module table. */
export const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

export default defineConfig({
  name: '@graycode/dsh-client/client',
  entry: { client: 'lib/client/index.js' },
  // The bundle lands next to the node half (single lib/ artifact dir);
  // the entryFileNames pin keeps it exactly lib/client.js. clean must stay
  // off — a default clean would wipe the tsc output emitted above.
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  // Types ship from lib (tsc); dts here would wrap the banner/footer into
  // .d.cts and break parsing.
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    // Platform modules (and the runtime/store exemption) resolve from the
    // host's frozen module table at runtime; keeping them out of the bundle
    // is what lets the injected require answer them. A require() the table
    // cannot answer is a guaranteed runtime throw, so the rule is the table
    // list itself: neverBundle for table entries, everything else inlined.
    neverBundle: [...CLIENT_EXTERNALS],
  },
  plugins: [
    {
      // Bundle purity gate (build-time mirror of the module-edge rules):
      // platform seed entries stay external; every other @deepseek-ai value
      // import is a build error — a cross-plugin value import either inlines a
      // duplicate runtime instance or requires a specifier the frozen module
      // table cannot answer. Cross-plugin collaboration goes through cordis
      // services instead. Type-only imports are erased by tsc and never reach
      // this gate.
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.includes(source)) return null // platform module: external wins
        throw new Error(
          `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) — `
          + 'cross-plugin value imports are forbidden; collaborate through cordis services '
          + '(type-only imports are erased and never reach this gate)',
        )
      },
    },
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    // The factory closure contract of the DSH client module system (see
    // ClientPluginHandoff in @deepseek-ai/dsh-client-modules/client):
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('@graycode/dsh-client')}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
