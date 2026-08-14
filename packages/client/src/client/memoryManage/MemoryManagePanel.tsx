/**
 * Memory management panel (P4-03).
 *
 * Top-level surface: search box, scope switch (global/workspace), entry list
 * with cursor pagination, edit overlay, forget flow (two-step confirm), and
 * empty/error states. All data flows through the injected
 * {@link MemoryManageTransport} — the panel itself never performs I/O.
 *
 * CLIENT BOUNDARY RULES (PLAN_V2 §5.6):
 * - Replay/unwired mode: without a transport the panel renders read-only
 *   (`replayOnly` hint, controls disabled). With a `wired:false` (mock)
 *   transport it shows the `degraded` demo badge.
 * - Deletion/edit are explicit user actions: forget requires the two-step
 *   confirm state machine, edit requires reviewing the diff and pressing
 *   Save.
 * - Pagination is cursor-based (`nextCursor` from the host page).
 * - Errors surface via stable machine codes mapped to locale keys
 *   (`mapMemoryFailure`) — never raw host message text.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryManageTransport } from './api.ts'
import {
  IDLE_FORGET_STATE,
  appendMemoryListPage,
  buildMemoryEntryView,
  buildMemoryListParams,
  buildMemoryListViewModel,
  cancelForget,
  confirmForget,
  dismissForget,
  mapMemoryFailure,
  normalizeMemoryLimit,
  parseMemoryNextCursor,
  rejectForget,
  requestForget,
  resolveForget,
  toMemoryFailure,
  type ForgetState,
  type MemoryEntryViewModel,
  type MemoryErrorView,
  type MemoryErrorTone,
  type MemoryListViewModel,
  type MemoryQueryState,
} from './logic.ts'
import { GRAY_MEMORY_SCOPES, type GrayMemoryScope } from './types.ts'
import { MemoryEntryList } from './MemoryEntryList.tsx'
import { MemoryEditOverlay } from './MemoryEditOverlay.tsx'

/** Composed props for the memory management panel. */
export interface MemoryManagePanelProps {
  t: TranslateNS<'graycode.memoryManage'>
  /**
   * Declarative transport. Absent → read-only replay mode (no I/O at all).
   * A `wired:false` transport (mock) → demo badge. The host channel is
   * created by the wiring via `createRemoteMemoryTransport`.
   */
  transport?: MemoryManageTransport
  initialScope?: GrayMemoryScope
  /** Workspace root required for scope = 'workspace' (host contract). */
  workspace?: string
  /** Page size (normalized to the host contract; default 20, cap 100). */
  pageSize?: number
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.625rem',
  padding: '0.75rem',
  borderRadius: '0.5rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'var(--dsh-text-color, #eee)',
  fontSize: '12px',
  lineHeight: '1.45',
  minWidth: '280px',
  maxWidth: '640px',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
}

const titleStyle: CSSProperties = {
  fontWeight: 600,
  fontSize: '13px',
}

const badgeStyle: CSSProperties = {
  padding: '0.0625rem 0.4375rem',
  borderRadius: '999px',
  border: '1px solid currentColor',
  fontSize: '10px',
  whiteSpace: 'nowrap',
  color: '#d29922',
}

const toolbarStyle: CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
  flexWrap: 'wrap',
}

const searchStyle: CSSProperties = {
  flex: '1 1 180px',
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'rgba(0, 0, 0, 0.25)',
  color: 'inherit',
  fontSize: '12px',
}

const scopeGroupStyle: CSSProperties = {
  display: 'flex',
  gap: '0.25rem',
}

const scopeStyle: CSSProperties = {
  padding: '0.25rem 0.625rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'transparent',
  color: 'inherit',
  fontSize: '11px',
  cursor: 'pointer',
}

const activeScopeStyle: CSSProperties = {
  ...scopeStyle,
  borderColor: '#58a6ff',
  color: '#58a6ff',
}

const hintStyle: CSSProperties = {
  padding: '1.25rem 0.5rem',
  textAlign: 'center',
  opacity: 0.75,
  fontSize: '12px',
}

const hintSubStyle: CSSProperties = {
  marginTop: '0.25rem',
  fontSize: '11px',
  opacity: 0.6,
}

const footerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  fontSize: '11px',
}

const totalStyle: CSSProperties = {
  opacity: 0.65,
}

const buttonStyle: CSSProperties = {
  padding: '0.125rem 0.625rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'transparent',
  color: 'inherit',
  fontSize: '11px',
  cursor: 'pointer',
}

const buttonDisabledStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.45,
  cursor: 'not-allowed',
}

const doneStyle: CSSProperties = {
  color: '#3fb950',
  marginLeft: 'auto',
}

const ERROR_TONE_COLOR: Record<MemoryErrorTone, string> = {
  danger: '#f85149',
  warning: '#d29922',
  info: '#58a6ff',
  neutral: '#8b949e',
}

const errorBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.375rem 0.625rem',
  borderRadius: '0.375rem',
  border: '1px solid currentColor',
  background: 'rgba(0, 0, 0, 0.2)',
  fontSize: '11px',
}

/** Debounce for the search input (pure UI timing; no I/O involved). */
const SEARCH_DEBOUNCE_MS = 250
/** Auto-dismiss of the forget success note. */
const FORGET_NOTE_MS = 3500

function MemoryErrorBanner({
  t,
  error,
  onRetry,
}: {
  t: TranslateNS<'graycode.memoryManage'>
  error: MemoryErrorView
  onRetry: () => void
}): ReactNode {
  const color = ERROR_TONE_COLOR[error.tone]
  return (
    <div data-graycode-memory="error" data-code={error.code} style={{ ...errorBannerStyle, color }}>
      <span>
        {t('error.title')}: {t(error.localeKey)}
      </span>
      {error.retryable && (
        <button type="button" data-graycode-memory="retry" style={buttonStyle} onClick={onRetry}>
          {t('retry')}
        </button>
      )}
    </div>
  )
}

/**
 * Memory management panel. Mount it wherever the host hosts the P4-03 memory
 * surface (see memoryManage/README.md for wiring).
 */
export function MemoryManagePanel({
  t,
  transport,
  initialScope = 'global',
  workspace,
  pageSize,
}: MemoryManagePanelProps): ReactNode {
  const pageLimit = normalizeMemoryLimit(pageSize)
  const [queryText, setQueryText] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [scope, setScope] = useState<GrayMemoryScope>(initialScope)
  const [list, setList] = useState<MemoryListViewModel | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<MemoryErrorView | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [editTarget, setEditTarget] = useState<MemoryEntryViewModel | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [forget, setForget] = useState<ForgetState>(IDLE_FORGET_STATE)
  /** Stale-response guard: only the latest request may commit state. */
  const seqRef = useRef(0)
  /** Unmount guard: never commit state after the panel is gone. */
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Debounce the search box into the applied query (pure UI timing).
  useEffect(() => {
    const handle = setTimeout(() => setAppliedQuery(queryText), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [queryText])

  const queryState = (q: string, s: GrayMemoryScope, cursor?: number): MemoryQueryState => ({
    text: q,
    scope: s,
    workspace,
    ...(cursor !== undefined ? { cursor } : {}),
    limit: pageLimit,
  })

  const fetchFirstPage = useCallback(async (q: string, s: GrayMemoryScope) => {
    if (transport === undefined) {
      setList(null)
      setError(null)
      setPhase('ready')
      return
    }
    const seq = ++seqRef.current
    setPhase('loading')
    setError(null)
    let result
    try {
      result = await transport.list(buildMemoryListParams(queryState(q, s)))
    } catch (err) {
      result = { ok: false as const, error: toMemoryFailure(err) }
    }
    if (seq !== seqRef.current || !mountedRef.current) return // stale response or unmounted — drop
    if (result.ok) {
      setList(buildMemoryListViewModel(result.value, { scope: s, workspace, query: q }))
      setPhase('ready')
    } else {
      setError(mapMemoryFailure(result.error))
      setPhase('error')
    }
  }, [transport, workspace, pageLimit]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void fetchFirstPage(appliedQuery, scope)
  }, [appliedQuery, scope, fetchFirstPage])

  const loadMore = useCallback(async () => {
    if (transport === undefined || list === null || list.nextCursor === undefined || loadingMore) return
    // Capture the list generation this request belongs to; responses for a
    // superseded generation (scope/search changed meanwhile) are dropped so
    // old pages never append into a newer list.
    const seq = seqRef.current
    setLoadingMore(true)
    const cursor = parseMemoryNextCursor(list.nextCursor)
    if (cursor === null) {
      // Malformed host cursor: forwarding it would re-fetch page 1 and
      // duplicate items. Stop pagination and surface a hint — the banner
      // retry re-fetches the first page.
      setLoadingMore(false)
      setError(mapMemoryFailure(toMemoryFailure(new Error(`invalid nextCursor: ${list.nextCursor}`))))
      return
    }
    let result
    try {
      result = await transport.list(buildMemoryListParams(queryState(appliedQuery, scope, cursor)))
    } catch (err) {
      result = { ok: false as const, error: toMemoryFailure(err) }
    }
    if (seq !== seqRef.current || !mountedRef.current) {
      setLoadingMore(false)
      return // stale generation or unmounted — drop
    }
    setLoadingMore(false)
    if (result.ok) {
      const next = buildMemoryListViewModel(result.value, { scope, workspace, query: appliedQuery })
      setList(prev =>
        prev === null
          ? next
          : appendMemoryListPage(prev, next),
      )
      setError(null)
    } else {
      // Keep the accumulated list; surface the failure as a banner.
      setError(mapMemoryFailure(result.error))
    }
  }, [transport, list, loadingMore, appliedQuery, scope, workspace]) // eslint-disable-line react-hooks/exhaustive-deps

  const onScopeChange = (next: GrayMemoryScope) => {
    if (next === scope) return
    setEditTarget(null)
    setForget(IDLE_FORGET_STATE)
    setScope(next)
  }

  const saveEdit = useCallback(async (nextText: string) => {
    if (transport === undefined || editTarget === null) return
    // Capture the list generation the target belongs to; a response landing
    // after a scope/search change must not write into the newer list.
    const seq = seqRef.current
    setEditSaving(true)
    const target = editTarget
    let result
    try {
      result = await transport.edit({
        scope: target.scope,
        workspace: target.workspace,
        id: target.id,
        text: nextText,
      })
    } catch (err) {
      result = { ok: false as const, error: toMemoryFailure(err) }
    }
    if (seq !== seqRef.current || !mountedRef.current) {
      // The visible list moved to a newer generation (or the panel unmounted):
      // close the overlay but never touch the newer list.
      setEditSaving(false)
      setEditTarget(null)
      return
    }
    setEditSaving(false)
    if (result.ok) {
      const updated = buildMemoryEntryView(result.value, {
        scope: target.scope,
        workspace: target.workspace,
        query: appliedQuery,
      })
      setList(prev =>
        prev === null || !prev.items.some(item => item.id === updated.id)
          ? prev // entry no longer part of the current list — drop the write-back
          : { ...prev, items: prev.items.map(item => (item.id === updated.id ? updated : item)) },
      )
      setEditTarget(null)
    } else {
      setError(mapMemoryFailure(result.error))
    }
  }, [transport, editTarget, appliedQuery])

  const onForgetRequest = (entry: MemoryEntryViewModel) => {
    setForget(requestForget(forget, { id: entry.id, scope: entry.scope, workspace: entry.workspace }, entry.text))
  }

  const onForgetConfirm = useCallback(async () => {
    if (transport === undefined || forget.target === null) return
    const submitting = confirmForget(forget)
    setForget(submitting)
    const target = submitting.target!
    const seq = seqRef.current
    let result
    try {
      result = await transport.forget({
        scope: target.scope,
        workspace: target.workspace,
        blockId: String(target.id),
        confirm: true,
      })
    } catch (err) {
      result = { ok: false as const, error: toMemoryFailure(err) }
    }
    if (!mountedRef.current) return
    if (seq !== seqRef.current) {
      // The list moved to a newer generation: settle the machine but never
      // mutate the visible list (it no longer contains the target).
      setForget(result.ok ? resolveForget(submitting, result.value) : rejectForget(submitting, result.error))
      return
    }
    if (result.ok) {
      setList(prev =>
        prev === null
          ? prev
          : {
              ...prev,
              items: prev.items.filter(item => item.id !== target.id),
              total: Math.max(0, prev.total - 1),
            },
      )
      setForget(resolveForget(submitting, result.value))
    } else {
      setForget(rejectForget(submitting, result.error))
    }
  }, [transport, forget])

  const onForgetCancel = useCallback(() => setForget(cancelForget(forget)), [forget])

  // Auto-dismiss the forget success note (pure UI timing).
  useEffect(() => {
    if (forget.phase !== 'done') return
    const handle = setTimeout(() => setForget(dismissForget(forget)), FORGET_NOTE_MS)
    return () => clearTimeout(handle)
  }, [forget])

  const wired = transport !== undefined

  return (
    <div data-graycode-memory="panel" style={panelStyle}>
      <div style={headerStyle}>
        <span style={titleStyle}>{t('title')}</span>
        {transport !== undefined && !transport.wired && (
          <span data-graycode-memory="degraded" style={badgeStyle}>
            {t('degraded')}
          </span>
        )}
        {transport === undefined && (
          <span data-graycode-memory="replay" style={badgeStyle}>
            {t('replayOnly')}
          </span>
        )}
      </div>

      <div style={toolbarStyle}>
        <input
          data-graycode-memory="search"
          type="search"
          placeholder={t('searchPlaceholder')}
          value={queryText}
          disabled={!wired}
          style={searchStyle}
          onChange={event => setQueryText(event.target.value)}
        />
        <div style={scopeGroupStyle} role="group" aria-label={t('scope.global')}>
          {GRAY_MEMORY_SCOPES.map(s => (
            <button
              key={s}
              type="button"
              data-graycode-memory="scope"
              data-scope={s}
              disabled={!wired}
              style={s === scope ? activeScopeStyle : scopeStyle}
              onClick={() => onScopeChange(s)}
            >
              {t(`scope.${s}`)}
            </button>
          ))}
        </div>
      </div>

      {error !== null && (
        <MemoryErrorBanner t={t} error={error} onRetry={() => void fetchFirstPage(appliedQuery, scope)} />
      )}

      {phase === 'loading' && (
        <div data-graycode-memory="loading" style={hintStyle}>
          {t('loading')}
        </div>
      )}

      {phase === 'ready' && list !== null && list.items.length === 0 && (
        <div data-graycode-memory="empty" style={hintStyle}>
          <div>{t('list.empty')}</div>
          <div style={hintSubStyle}>{t('list.emptyHint')}</div>
        </div>
      )}

      {phase === 'ready' && list !== null && list.items.length > 0 && (
        <MemoryEntryList
          t={t}
          items={list.items}
          wired={wired}
          forget={forget}
          onEdit={setEditTarget}
          onForgetRequest={onForgetRequest}
          onForgetConfirm={() => void onForgetConfirm()}
          onForgetCancel={onForgetCancel}
        />
      )}

      {phase === 'ready' && list !== null && (
        <div style={footerStyle}>
          <span style={totalStyle}>
            {t('list.total')} {list.total}
          </span>
          {list.hasMore && (
            <button
              type="button"
              data-graycode-memory="load-more"
              style={wired && !loadingMore ? buttonStyle : buttonDisabledStyle}
              disabled={!wired || loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? t('loading') : t('loadMore')}
            </button>
          )}
          {!list.hasMore && list.items.length > 0 && <span style={hintSubStyle}>{t('list.end')}</span>}
          {forget.phase === 'done' && (
            <span data-graycode-memory="forget-done" style={doneStyle}>
              {t('forget.done')}
            </span>
          )}
        </div>
      )}

      {editTarget !== null && (
        <MemoryEditOverlay
          key={editTarget.id}
          t={t}
          entry={editTarget}
          saving={editSaving}
          onSave={(text: string) => void saveEdit(text)}
          onCancel={() => setEditTarget(null)}
        />
      )}
    </div>
  )
}
