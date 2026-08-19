import { useEffect, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { GlobalStandardProps, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { monitorParentForSession, type SubagentMonitorController } from './controller.ts'

interface CatalogEntryLike {
  readonly kind: 'child' | 'diagnostic'
  readonly id: string
  readonly mode?: 'one-shot' | 'continuable'
  readonly label?: string
  readonly activity?: 'running' | 'inactive'
  readonly hasChildren?: boolean
  readonly reason?: string
}

interface SessionsStateLike {
  readonly byId: Readonly<Record<string, { origin?: string; parentId?: string } | undefined>>
  readonly subagentsByParent: Readonly<Record<string, {
    readonly entries: readonly CatalogEntryLike[]
    readonly state: 'loading' | 'ready' | 'error'
    readonly error?: { message?: string } | null
  } | undefined>>
}

export interface SubagentMonitorInjected {
  readonly controller: SubagentMonitorController
  readonly refresh: (parentSessionId: string) => void
  readonly setCatalogOpen: (parentSessionId: string, open: boolean) => void
}

export interface SubagentMonitorButtonProps extends Pick<GlobalStandardProps, 'useSessions'> {
  readonly sessionId: string
  readonly controller: SubagentMonitorController
  readonly t: TranslateNS<'graycode.subagentMonitor'>
}

const buttonStyle: CSSProperties = {
  padding: '0.125rem 0.5rem', borderRadius: '0.25rem', border: '1px solid var(--dsh-border-color, #444)',
  background: 'transparent', color: 'inherit', fontSize: '12px', cursor: 'pointer',
}

export function SubagentMonitorButton({ sessionId, useSessions, controller, t }: SubagentMonitorButtonProps): ReactNode {
  const parentSessionId = useSessions(state => monitorParentForSession((state as unknown as SessionsStateLike).byId, sessionId))
  return <button type="button" style={buttonStyle} onClick={() => controller.open(parentSessionId)}>{t('action')}</button>
}

const backdropStyle: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', padding: '2rem',
  background: 'rgba(0, 0, 0, 0.58)', pointerEvents: 'auto',
}

const pageStyle: CSSProperties = {
  width: 'min(900px, 100%)', maxHeight: 'min(760px, 100%)', overflow: 'auto', borderRadius: '0.75rem',
  border: '1px solid var(--dsh-border-color, #444)', background: 'var(--dsh-surface-color, #181818)',
  color: 'var(--dsh-text-color, #eee)', boxShadow: '0 20px 70px rgba(0,0,0,.45)', padding: '1rem',
}

const rowStyle: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', alignItems: 'center', gap: '0.75rem',
  padding: '0.75rem', border: '1px solid var(--dsh-border-color, #3a3a3a)', borderRadius: '0.5rem',
}

export interface SubagentMonitorPageProps extends SubagentMonitorInjected, Pick<GlobalStandardProps, 'useSessions'> {
  readonly t: TranslateNS<'graycode.subagentMonitor'>
}

export function SubagentMonitorPage({ controller, refresh, setCatalogOpen, useSessions, t }: SubagentMonitorPageProps): ReactNode {
  const monitor = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const catalog = useSessions(state => monitor.parentSessionId === undefined
    ? undefined
    : (state as unknown as SessionsStateLike).subagentsByParent[monitor.parentSessionId])

  useEffect(() => {
    const parent = monitor.open ? monitor.parentSessionId : undefined
    if (parent === undefined) return
    setCatalogOpen(parent, true)
    refresh(parent)
    return () => setCatalogOpen(parent, false)
  }, [monitor.open, monitor.parentSessionId, refresh, setCatalogOpen])

  if (!monitor.open || monitor.parentSessionId === undefined) return null
  const entries = catalog?.entries ?? []
  return (
    <div style={backdropStyle} role="dialog" aria-modal="true" aria-label={t('title')} onMouseDown={event => {
      if (event.target === event.currentTarget) controller.close()
    }}>
      <section style={pageStyle}>
        <header style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.875rem' }}>
          <h2 style={{ margin: 0, fontSize: '16px', flex: 1 }}>{t('title')}</h2>
          {monitor.path.length > 1 && <button type="button" style={buttonStyle} onClick={() => controller.back()}>{t('back')}</button>}
          <button type="button" style={buttonStyle} onClick={() => refresh(monitor.parentSessionId!)}>{t('refresh')}</button>
          <button type="button" style={buttonStyle} onClick={() => controller.close()}>{t('close')}</button>
        </header>
        <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: '11px', opacity: 0.65, marginBottom: '0.75rem' }}>
          {monitor.parentSessionId}
        </div>
        {catalog?.state === 'loading' && entries.length === 0 ? <p>{t('loading')}</p> : null}
        {catalog?.state === 'error' ? <p style={{ color: '#f85149' }}>{catalog.error?.message ?? t('diagnostic')}</p> : null}
        {catalog?.state !== 'loading' && entries.length === 0 ? <p style={{ opacity: 0.7 }}>{t('empty')}</p> : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {entries.map(entry => (
            <div key={`${entry.kind}:${entry.id}`} style={rowStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.label || entry.id}</div>
                <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: '11px', opacity: 0.62 }}>{entry.id}</div>
                {entry.kind === 'diagnostic' && <div style={{ color: '#f85149', fontSize: '11px' }}>{t('diagnostic')}: {entry.reason}</div>}
              </div>
              <span style={{ fontSize: '11px', opacity: 0.75 }}>
                {entry.kind === 'child' ? `${entry.mode === 'continuable' ? t('continuable') : t('oneShot')} · ${entry.activity === 'running' ? t('running') : t('inactive')}` : ''}
              </span>
              {entry.kind === 'child' && entry.hasChildren
                ? <button type="button" style={buttonStyle} onClick={() => controller.descend(entry.id)}>{t('children')}</button>
                : <span />}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
