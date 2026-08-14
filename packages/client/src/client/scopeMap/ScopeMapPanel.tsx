/**
 * Migration workspace memory mapping (D-1/D-2) — the management surface
 * container (ScopeMapPanel).
 *
 * Owns the fetch state and the per-row target selections, and drives a
 * {@link ScopeMapDataSource} selected from the `dataSource` prop:
 *
 * - `dataSource === 'mock'` — built-in sample data (2 auto + 1 unmapped rows),
 *   no I/O;
 * - `dataSource === 'remote'` — consumes `migration/scopeMap` through the
 *   injected `transport`; without a transport (unwired host, replay) the panel
 *   renders the degraded hint and never fetches.
 *
 * Each row offers a radio group (default suggestion / global memory / custom
 * absolute path); the exported overrides JSON (only manually changed rows) is
 * shown as a copy-paste text block with a usage line for the host
 * `migration_apply` `scopeOverridesFile` parameter.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { readScopeMapThrownError } from './wire.ts'
import { scopeMapErrorHint } from './errors.ts'
import type { ScopeMapDataSource, ScopeMapError } from './types.ts'
import {
  MockScopeMapDataSource,
  RemoteScopeMapDataSource,
  type ScopeMapRemoteTransport,
} from './dataSource.ts'
import { buildScopeMapRows, type ScopeMapRowView } from './viewModel.ts'
import {
  buildScopeMapOverrides,
  createDefaultScopeMapSelection,
  formatScopeMapOverridesJson,
  hasScopeMapChanges,
  type ScopeMapTargetSelection,
} from './overrides.ts'

/** Composed props for the scope-map panel. */
export interface ScopeMapPanelProps {
  /** Framework-injected translate seat for the `graycode.scopeMap` namespace. */
  t: TranslateNS<'graycode.scopeMap'>
  /**
   * Data source: 'mock' = built-in sample data; 'remote' = `migration/scopeMap`
   * via `transport`. Callers must keep `transport` stable across renders
   * (memoize or hoist) to avoid refetch loops.
   */
  dataSource: 'remote' | 'mock'
  /** Legacy source directory passed to `migration/scopeMap` (absolute path). */
  sourceDir?: string
  /**
   * Browser→host transport for the remote consumer. Required when
   * `dataSource === 'remote'`; absent → degraded replay state, no fetch.
   */
  transport?: ScopeMapRemoteTransport
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  padding: '0.75rem',
  borderRadius: '0.5rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'var(--dsh-text-color, #eee)',
  fontSize: '12px',
  lineHeight: '1.45',
  minWidth: '320px',
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 600,
}

const hintStyle: CSSProperties = {
  padding: '1rem 0.75rem',
  borderRadius: '0.5rem',
  border: '1px dashed var(--dsh-border-color, #333)',
  fontSize: '12px',
  opacity: 0.8,
}

const noticeStyle: CSSProperties = {
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px dashed var(--dsh-border-color, #333)',
  fontSize: '11px',
  opacity: 0.8,
}

const buttonStyle: CSSProperties = {
  padding: '0.125rem 0.375rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'transparent',
  color: 'inherit',
  fontSize: '11px',
  cursor: 'pointer',
}

const tableStyle: CSSProperties = {
  borderCollapse: 'collapse',
  width: '100%',
  fontSize: '11px',
}

const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '0.25rem 0.375rem',
  borderBottom: '1px solid var(--dsh-border-color, #333)',
  fontWeight: 600,
  whiteSpace: 'nowrap',
}

const tdStyle: CSSProperties = {
  padding: '0.25rem 0.375rem',
  borderBottom: '1px solid var(--dsh-border-color, #333)',
  verticalAlign: 'top',
  wordBreak: 'break-all',
}

const targetGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
}

const radioStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.25rem',
  fontSize: '11px',
}

const inputStyle: CSSProperties = {
  marginTop: '0.125rem',
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.125rem 0.375rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'inherit',
  fontSize: '11px',
}

const exportStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  marginTop: '0.375rem',
}

const exportTitleStyle: CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
}

const preStyle: CSSProperties = {
  margin: 0,
  padding: '0.375rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  fontSize: '11px',
  lineHeight: '1.4',
  overflowX: 'auto',
  whiteSpace: 'pre',
}

const usageStyle: CSSProperties = {
  fontSize: '11px',
  opacity: 0.85,
}

/** Render-ready page state for the panel. */
type PanelPhase =
  | { phase: 'loading' }
  | { phase: 'error'; error: ScopeMapError }
  | { phase: 'loaded' }

/**
 * Migration workspace memory mapping panel. Mount it wherever the host renders
 * management views (see scopeMap/README.md for wiring).
 */
export function ScopeMapPanel({ t, dataSource, sourceDir, transport }: ScopeMapPanelProps): ReactNode {
  const source = useMemo<ScopeMapDataSource | undefined>(() => {
    if (dataSource === 'mock') return new MockScopeMapDataSource()
    return transport === undefined ? undefined : new RemoteScopeMapDataSource(transport)
  }, [dataSource, transport])

  const [phase, setPhase] = useState<PanelPhase>({ phase: 'loading' })
  const [rows, setRows] = useState<readonly ScopeMapRowView[]>([])
  const [selections, setSelections] = useState<Readonly<Record<string, ScopeMapTargetSelection>>>({})
  const [revision, setRevision] = useState(0)
  const disposed = useRef(false)

  useEffect(() => {
    disposed.current = false
    return () => {
      disposed.current = true
    }
  }, [])

  // Scope-map fetch: on mount and whenever the source / sourceDir change (and
  // on manual retry via revision). Aborting the controller drops stale responses.
  useEffect(() => {
    if (source === undefined) return
    const controller = new AbortController()
    setPhase({ phase: 'loading' })
    source.scopeMap({ sourceDir: sourceDir ?? '' }, controller.signal)
      .then((result) => {
        if (disposed.current || controller.signal.aborted) return
        setRows(buildScopeMapRows(result))
        setPhase({ phase: 'loaded' })
      })
      .catch((error: unknown) => {
        if (disposed.current || controller.signal.aborted) return
        setPhase({ phase: 'error', error: readScopeMapThrownError(error) })
      })
    return () => controller.abort()
  }, [source, sourceDir, revision])

  const retry = useCallback((): void => {
    setRevision((current) => current + 1)
  }, [])

  if (source === undefined) {
    return (
      <div data-graycode-scope-map="panel" data-state="replay" style={panelStyle}>
        <h2 style={titleStyle}>{t('title')}</h2>
        <div style={hintStyle}>{t('state.replayOnly')}</div>
      </div>
    )
  }

  const overrides = buildScopeMapOverrides(rows, selections)
  const overridesJson = formatScopeMapOverridesJson(overrides)
  const hasOverrides = hasScopeMapChanges(overrides)
  const errorHint = phase.phase === 'error' ? scopeMapErrorHint(phase.error.code) : null

  return (
    <div
      data-graycode-scope-map="panel"
      data-state={phase.phase}
      style={panelStyle}
    >
      <h2 style={titleStyle}>{t('title')}</h2>

      {dataSource === 'mock' && (
        <div style={noticeStyle} data-graycode-scope-map="mockNotice">
          {t('state.mock')}
        </div>
      )}

      {phase.phase === 'loading' && <div style={hintStyle}>{t('state.loading')}</div>}

      {phase.phase === 'error' && errorHint !== null && (
        <div style={hintStyle}>
          <div>{t(errorHint.key)}</div>
          {errorHint.retryable && (
            <button type="button" style={buttonStyle} onClick={retry}>
              {t('state.errorRetry')}
            </button>
          )}
        </div>
      )}

      {phase.phase === 'loaded' && rows.length === 0 && (
        <div style={hintStyle} data-graycode-scope-map="empty">
          {t('state.empty')}
        </div>
      )}

      {phase.phase === 'loaded' && rows.length > 0 && (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle} data-graycode-scope-map="table">
              <thead>
                <tr>
                  <th style={thStyle}>{t('column.hashDir')}</th>
                  <th style={thStyle}>{t('column.source')}</th>
                  <th style={thStyle}>{t('column.status')}</th>
                  <th style={thStyle}>{t('column.target')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const selection = selections[row.hashDir] ?? createDefaultScopeMapSelection()
                  return (
                    <tr key={row.hashDir} data-graycode-scope-map="row">
                      <td style={tdStyle}>{row.hashDir}</td>
                      <td style={tdStyle}>{row.sourcePath ?? row.uri ?? '—'}</td>
                      <td style={tdStyle}>{row.status === 'auto' ? t('status.auto') : t('status.unmapped')}</td>
                      <td style={tdStyle}>
                        <div style={targetGroupStyle}>
                          <label style={radioStyle}>
                            <input
                              type="radio"
                              name={`target-${row.hashDir}`}
                              checked={selection.kind === 'default'}
                              onChange={() =>
                                setSelections((current) => ({ ...current, [row.hashDir]: createDefaultScopeMapSelection() }))
                              }
                            />
                            {t('target.default')}
                            {row.suggestedTarget !== null ? ` ${row.suggestedTarget}` : ` ${t('target.noSuggestion')}`}
                          </label>
                          <label style={radioStyle}>
                            <input
                              type="radio"
                              name={`target-${row.hashDir}`}
                              checked={selection.kind === 'global'}
                              onChange={() =>
                                setSelections((current) => ({
                                  ...current,
                                  [row.hashDir]: { kind: 'global', customPath: '' },
                                }))
                              }
                            />
                            {t('target.global')}
                          </label>
                          <label style={radioStyle}>
                            <input
                              type="radio"
                              name={`target-${row.hashDir}`}
                              checked={selection.kind === 'custom'}
                              onChange={() =>
                                setSelections((current) => ({
                                  ...current,
                                  [row.hashDir]: { kind: 'custom', customPath: '' },
                                }))
                              }
                            />
                            {t('target.custom')}
                          </label>
                          {selection.kind === 'custom' && (
                            <input
                              type="text"
                              value={selection.customPath}
                              placeholder={t('custom.placeholder')}
                              data-graycode-scope-map="custom-path"
                              style={inputStyle}
                              onChange={(event) =>
                                setSelections((current) => ({
                                  ...current,
                                  [row.hashDir]: { kind: 'custom', customPath: event.target.value },
                                }))
                              }
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div style={exportStyle} data-graycode-scope-map="export">
            <div style={exportTitleStyle}>{t('export.title')}</div>
            <pre style={preStyle} data-graycode-scope-map="overrides">{overridesJson}</pre>
            {!hasOverrides && <div style={hintStyle}>{t('export.none')}</div>}
            <div style={usageStyle}>{t('export.usage')}</div>
          </div>
        </>
      )}
    </div>
  )
}
