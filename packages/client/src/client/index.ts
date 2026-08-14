import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only imports pull the following ambient declarations into the program
// without any runtime import (the bundle purity gate forbids cross-plugin
// value imports; the host's module table serves the platform modules):
//   - dsh-client-locale/client   → `ctx.locale` (+ the `locale/change` event)
//   - dsh-client-ui-layout/client → SlotMap['shell.overlay'] declaration
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { GrayCodeBadge } from './GrayCodeBadge.tsx'
import { GRAYCODE_NS, graycodeDictionaries, graycodeJaPlaceholder } from './locales.ts'

/** Required client services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Client plugin body (browser half of @graycode/dsh-client):
 *
 * - registers the `graycode` locale namespace (typed zh/en dictionaries plus
 *   the untyped `ja` placeholder — see `locales.ts` for GAP-1);
 * - contributes the "Gray Code loaded" marker into the additive
 *   `shell.overlay` list slot once ui-layout declares it (`ctx.slots.inject`
 *   defers the registration until the declaration exists; the returned
 *   disposer is tied to the declaration lifetime).
 *
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  ctx.locale.register(GRAYCODE_NS, graycodeDictionaries)
  ctx.locale.register(GRAYCODE_NS, 'ja', graycodeJaPlaceholder)
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'graycode.loaded', locale: GRAYCODE_NS },
      GrayCodeBadge,
    ))
}
