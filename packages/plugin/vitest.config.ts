import { defineConfig } from 'vitest/config'

/**
 * Package-scoped vitest config.
 *
 * The root vitest.config.ts uses include patterns relative to the repo
 * root (packages/<pkg>/tests), so a package-level `vitest run` (cwd =
 * packages/plugin) finds no tests. This config keeps the same node
 * environment while scoping the include pattern to this package. It is only
 * picked up when vitest runs with this directory as its root — the root
 * `pnpm test` still uses the root config and is unaffected.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
})
