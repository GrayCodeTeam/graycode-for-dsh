/**
 * The Gray Code settings section mounted in the DSH native settings page
 * (`settings.section` slot, id `graycode`). Renders the 17 Gray-Code
 * categories as a tab rail above a scrollable content column; all data flows
 * through the plugin's `/graycode` config channel.
 */

import { useCallback, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { GrayCodeConfig } from '../shared/config.ts'
import { CATEGORIES } from './pages.tsx'
import type { GcTranslate } from './fields.tsx'
import { setAtPath, useGrayCodeStore, type GrayCodeStore } from './store.ts'
import './graycode.css'

/** Minimal locale-face surface (structural; the locale package may drift). */
export interface GrayCodeLocaleFace {
  subscribe(listener: () => void): () => void
  getSnapshot(): { revision: number }
}

/** Props injected by the slot registration in client/index.ts. */
export interface GrayCodeSectionInjected {
  t: GcTranslate
  store: GrayCodeStore
  locale: GrayCodeLocaleFace
}

/** Owner props from the settings shell + injected props. */
export interface GrayCodeSectionProps extends GrayCodeSectionInjected {
  /** Close the settings panel (shell affordance; unused today). */
  close?: () => void
}

function isPlausibleConfig(value: unknown): value is GrayCodeConfig {
  if (typeof value !== 'object' || value === null) return false
  const config = value as Record<string, unknown>
  return typeof config.channels === 'object'
    && typeof config.toolsEnabled === 'object'
    && typeof config.subagents === 'object'
    && typeof config.general === 'object'
}

export function GrayCodeSection({ t, store, locale }: GrayCodeSectionProps): ReactNode {
  const state = useGrayCodeStore(store)
  // Re-render when the active locale changes so labels refresh in place.
  useSyncExternalStore(
    listener => locale.subscribe(listener),
    () => locale.getSnapshot().revision,
  )
  const [activeId, setActiveId] = useState<string>(CATEGORIES[0]!.id)
  const active = CATEGORIES.find(category => category.id === activeId) ?? CATEGORIES[0]!

  const handleChange = useCallback((path: readonly string[], value: unknown): void => {
    if (state.status !== 'ready') return
    const { patch } = setAtPath(state.config, path, value)
    void store.patch(patch).catch(() => undefined)
  }, [state, store])

  const handleImport = useCallback((value: unknown): void => {
    if (!isPlausibleConfig(value)) {
      window.alert(t('actions.importError'))
      return
    }
    void store.replace(value).then(
      () => window.alert(t('actions.importSuccess')),
      () => window.alert(t('actions.importError')),
    )
  }, [store, t])

  const handleReset = useCallback((): void => {
    if (!window.confirm(t('actions.resetConfirm'))) return
    void store.reset().then(
      () => window.alert(t('actions.resetDone')),
      () => window.alert(t('actions.importError')),
    )
  }, [store, t])

  return (
    <div className="gc-root">
      <div className="gc-panel-header">
        <h2 className="gc-panel-title">{t('title')}</h2>
        <p className="gc-panel-description">{t('description')}</p>
      </div>
      <div className="gc-tabs" role="tablist" aria-label={t('tabs.aria')}>
        {CATEGORIES.map(category => {
          const selected = category.id === active.id
          return (
            <button
              key={category.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={selected ? 'gc-tab gc-tab-active' : 'gc-tab'}
              onClick={() => setActiveId(category.id)}
            >
              <span className="gc-tab-icon">{category.icon}</span>
              <span className="gc-tab-label">{t(category.labelKey)}</span>
            </button>
          )
        })}
      </div>
      <div className="gc-content" role="tabpanel">
        {state.status === 'loading' && <p className="gc-note">{t('loading')}</p>}
        {state.status === 'error' && (
          <div className="gc-error">
            <p className="gc-note">{t('error')}</p>
            <pre className="gc-error-detail">{state.message}</pre>
            <button type="button" className="gc-button" onClick={() => void store.refresh()}>
              {t('errorRetry')}
            </button>
          </div>
        )}
        {state.status === 'ready' && active.page({
          t,
          config: state.config,
          onChange: handleChange,
          onImport: handleImport,
          onReset: handleReset,
        })}
      </div>
    </div>
  )
}
