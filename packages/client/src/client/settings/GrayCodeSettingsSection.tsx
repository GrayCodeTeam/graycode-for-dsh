/**
 * 挂载在 DSH 原生设置页的 Gray Code 设置分区（`settings.section` 槽位，
 * id `graycode`）。渲染 6 个真实 GrayCode 功能分区 + 可滚动内容列；
 * 所有数据都走插件自己的 `/graycode` 配置通道（DSH settings scope 对第三方
 * namespace 有白名单，见本目录 README）。
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { GlobalStandardProps, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { CATEGORIES } from './pages.tsx'
import type { GcTranslate } from './fields.tsx'
import { useGrayCodeStore, type GrayCodeStore } from './store.ts'
import {
  buttonStyle,
  contentStyle,
  errorDetailStyle,
  noteStyle,
  panelDescriptionStyle,
  panelHeaderStyle,
  panelTitleStyle,
  rootStyle,
  tabActiveStyle,
  tabIconStyle,
  tabStyle,
  tabsStyle,
} from './styles.ts'
import type { GrayRemoteInvoke } from './types.ts'

/** locale 面的最小结构（结构性；locale 包可能漂移）。 */
export interface GrayCodeLocaleFace {
  subscribe(listener: () => void): () => void
  getSnapshot(): { revision: number }
}

/** `settings.section` 注册时的 inject 注入面。 */
export interface GrayCodeSettingsSectionInjected {
  t: GcTranslate
  store: GrayCodeStore
  locale: GrayCodeLocaleFace
  remote: GrayRemoteInvoke
  /** Browser connection handle (session-list API for the token section). */
  connection: ConnectionHandle
  /** Translate seat for the `graycode.activityHeatmap` namespace. */
  activityT: TranslateNS<'graycode.activityHeatmap'>
  /** Translate seat for the `graycode.memoryManage` namespace. */
  memoryT: TranslateNS<'graycode.memoryManage'>
}

/** 宿主 owner props（设置外壳）+ 注入面。 */
export interface GrayCodeSettingsSectionProps extends GrayCodeSettingsSectionInjected, Pick<GlobalStandardProps, 'useSessions'> {
  /** 关闭设置面板（外壳提供；当前未使用）。 */
  close?: () => void
}

/** Resolve the selected DSH session's workspace; the host process cwd is unrelated. */
export function selectCurrentSessionWorkspace(state: SessionListState): string | undefined {
  if (state.current === undefined) return undefined
  const cwd = state.byId[state.current]?.cwd?.trim()
  return cwd === undefined || cwd.length === 0 ? undefined : cwd
}

export function GrayCodeSettingsSection({ t, store, locale, remote, useSessions, activityT, memoryT, connection }: GrayCodeSettingsSectionProps): ReactNode {
  const state = useGrayCodeStore(store)
  const defaultWorkspace = useSessions(selectCurrentSessionWorkspace)
  useEffect(() => {
    void store.refresh()
  }, [store])
  // 活动 locale 变化时重新渲染，让文案就地刷新。
  useSyncExternalStore(
    listener => locale.subscribe(listener),
    () => locale.getSnapshot().revision,
  )
  const [activeId, setActiveId] = useState<string>(CATEGORIES[0]!.id)
  const active = CATEGORIES.find(category => category.id === activeId) ?? CATEGORIES[0]!
  // The page must render as a real component (JSX), not as a plain function
  // call: pages may call hooks (e.g. `useMemo` for transports), and a plain
  // call would register those hooks against the section itself — switching
  // between a hook-free page and a hook-using page then violates the Rules of
  // Hooks ("rendered more hooks than during the previous render") and nukes
  // the whole settings tree. Keeping the element type stable per tab gives
  // each page its own hook scope and lifecycle.
  const ActivePage = active.page

  const handleChange = useCallback((path: readonly string[], value: unknown): Promise<void> => {
    if (state.status !== 'ready') return Promise.resolve()
    return store.set(path, value)
  }, [state, store])

  const handleReset = useCallback((): void => {
    if (!window.confirm(t('actions.resetConfirm'))) return
    void store.reset().then(
      () => window.alert(t('actions.resetDone')),
      () => window.alert(t('error')),
    )
  }, [store, t])

  return (
    <div style={rootStyle}>
      <div style={panelHeaderStyle}>
        <h2 style={panelTitleStyle}>{t('title')}</h2>
        <p style={panelDescriptionStyle}>{t('description')}</p>
      </div>
      <div style={tabsStyle} role="tablist" aria-label={t('tabs.aria')}>
        {CATEGORIES.map(category => {
          const selected = category.id === active.id
          return (
            <button
              key={category.id}
              type="button"
              role="tab"
              aria-selected={selected}
              style={selected ? tabActiveStyle : tabStyle}
              onClick={() => setActiveId(category.id)}
              // Mouse clicks should not leave a persistent focus ring. Keyboard
              // navigation does not emit mouseup, so :focus-visible remains
              // available to Tab/Enter users.
              onMouseUp={event => event.currentTarget.blur()}
            >
              <span style={tabIconStyle}>{category.icon}</span>
              <span>{t(category.labelKey)}</span>
            </button>
          )
        })}
      </div>
      <div style={contentStyle} role="tabpanel">
        {state.status === 'loading' && <p style={noteStyle}>{t('loading')}</p>}
        {state.status === 'error' && (
          <div>
            <p style={noteStyle}>{t('error')}</p>
            <pre style={errorDetailStyle}>{state.message}</pre>
            <button type="button" style={buttonStyle} onClick={() => void store.refresh()}>
              {t('errorRetry')}
            </button>
          </div>
        )}
        {state.status === 'ready' && (
          <ActivePage
            t={t}
            config={state.config}
            onChange={handleChange}
            onReset={handleReset}
            remote={remote}
            defaultWorkspace={defaultWorkspace}
            activityT={activityT}
            memoryT={memoryT}
            connection={connection}
          />
        )}
      </div>
    </div>
  )
}
