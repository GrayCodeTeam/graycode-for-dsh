/**
 * Manual conversation summary — mountable install.
 *
 * Self-contained registration (locale namespaces + the
 * `conversation.session.header.actions` slot entry), designed to be called
 * from the client entry's apply() by the integration workstream:
 *
 *     import { installSummarize } from './summarize/install.ts'
 *     // in apply(ctx):
 *     installSummarize(ctx)
 *
 * The install is inert-safe: without the `connection` service the locale
 * namespaces still register (they are harmless on their own) but the header
 * action is skipped with a console.warn. Locale disposers are tied to the
 * fiber via ctx.effect; the slot injection follows the declaration lifetime
 * (ctx.slots.inject defers until the declaration exists).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only imports pull the ambient declarations (locale service, slot map,
// connection service) into the program without runtime imports — the bundle
// purity gate forbids cross-plugin value imports.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  GRAYCODE_SUMMARIZE_NS,
  graycodeSummarizeDictionaries,
  graycodeSummarizeJaPlaceholder,
} from './locales.ts'
import { createSummarizeRemote } from './remote.ts'
import { SummarizeButton, type SummarizeInjected } from './SummarizeButton.tsx'

/**
 * Install the manual summary surface: `graycode.summarize` locale namespace +
 * the `graycode.summarize` header action (order 30, above the subagent
 * back-to-main action). Returns a cleanup function (idempotent).
 */
export function installSummarize(ctx: ClientContext): () => void {
  const disposeLocale = ctx.locale.register(GRAYCODE_SUMMARIZE_NS, graycodeSummarizeDictionaries)
  ctx.effect(() => disposeLocale)
  const disposeLocaleJa = ctx.locale.register(GRAYCODE_SUMMARIZE_NS, 'ja', graycodeSummarizeJaPlaceholder)
  ctx.effect(() => disposeLocaleJa)

  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) {
    console.warn('[graycode.summarize] connection service unavailable; the summarize action was not registered')
    return () => {
      disposeLocale()
      disposeLocaleJa()
    }
  }
  const remote = createSummarizeRemote(connection)
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'graycode.summarize',
        order: 30,
        locale: GRAYCODE_SUMMARIZE_NS,
        inject: (): SummarizeInjected => ({ remote }),
      },
      SummarizeButton,
    ))

  return () => {
    disposeLocale()
    disposeLocaleJa()
  }
}
