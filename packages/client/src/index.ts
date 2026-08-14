import type { Context } from '@deepseek-ai/cordis'

/**
 * GrayCode client plugin — Node half.
 *
 * DSH rc.6 registers client bundles declaratively: the host's
 * `ClientModuleRegistry` (@deepseek-ai/dsh-client-modules) scans loader
 * entries for a `dsh.client` manifest and serves each package's
 * `exports["./client"]` artifact at `/plugins/<id>/client.js`. There is no
 * Node-side "register client module" API — the manifest IS the registration
 * (see `parseDshClient`/`clientExportOf` in dsh-client-modules).
 *
 * This half therefore carries no host-side behavior in the skeleton; it
 * exists so a profile can load the entry and thereby trigger the client scan
 * (plus any future host-side settings/registration work). The browser half
 * lives in `src/client/` and is emitted as `lib/client.js` by tsdown (see
 * `tsdown.config.ts`).
 */
export const name = 'graycode-client'

/**
 * @param ctx - host context (unused today: no host-side behavior yet).
 */
export function apply(_ctx: Context): void {
  // Intentionally empty — see the module doc.
}
