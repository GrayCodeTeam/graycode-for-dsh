/**
 * Gray Code for DSH — browser plugin.
 *
 * Registers the `graycode` entry in the native settings page navigation
 * (`settings.section` slot) and wires its panel to the Host config channel.
 * No native settings scope is bound: the api-proxy namespace allowlist has no
 * third-party extension point, so the panel carries reads/writes over the
 * plugin's own `/graycode` Connection RPC channel (see README).
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the settings slot declarations (settings.section) into
// this program. Cross-plugin collaboration goes through services.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { GrayCodeSection, type GrayCodeSectionInjected, type GrayCodeLocaleFace } from './GrayCodeSection.tsx'
import { createGrayCodeStore } from './store.ts'
import type { GcTranslate } from './fields.tsx'
import { en, zh, type GrayCodeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Gray Code settings copy owned by this plugin. */
    'settings.graycode': GrayCodeKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.graycode'

/** Nav position among the native settings sections (after General/Models/Plugins). */
const NAV_ORDER = 20

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection']

/**
 * Mount the Gray Code settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'graycode: dictionaries')
  const bound = ctx.locale.bind(NS)
  const t: GcTranslate = key => bound(key as never)
  const connection = ctx.get('connection') as ConnectionHandle
  const store = createGrayCodeStore(connection)
  const locale = ctx.locale as unknown as GrayCodeLocaleFace

  // The Host config document may change outside the panel (settings file
  // edits, another tab); the connection reset is the only lifecycle the
  // panel subscribes to — the panel refreshes on every open-render anyway.
  ctx.effect(
    () => ctx.on('connection/reset', () => { void store.refresh() }),
    'graycode: connection resets',
  )

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'graycode',
    order: NAV_ORDER,
    label: () => t('nav'),
    locale: NS,
    inject: (): GrayCodeSectionInjected => ({ t, store, locale }),
  }, GrayCodeSection))
}
