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
  MemoryAddInFlightGate,
  appendMemoryListPage,
  buildMemoryEntryView,
  buildMemoryListParams,
  buildMemoryListViewModel,
  cancelForget,
  confirmForget,
  dismissForget,
  isCurrentMemoryConfigResponse,
  isStaleMemoryCursorFailure,
  isStaleMemoryRevisionFailure,
  isWorkspaceStoreMissingFailure,
  mapMemoryFailure,
  memoryEntryCharsExceededFailure,
  memoryRequestContextKey,
  normalizeMemoryEntryChars,
  normalizeMemoryLimit,
  parseMemoryNextCursor,
  rejectForget,
  requestForget,
  resolveForget,
  startMemoryAddRequest,
  toMemoryFailure,
  type ForgetState,
  type MemoryEntryViewModel,
  type MemoryErrorView,
  type MemoryErrorTone,
  type MemoryListViewModel,
  type MemoryQueryState,
} from './logic.ts'
import { GRAY_MEMORY_SCOPES, GRAY_REMOTE_ERROR_CODES, type GrayMemoryScope } from './types.ts'
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
  /** Safe fallback while `memory/configGet` is unavailable or in flight. */
  entryChars?: number
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

const addBoxStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
}

const addTextareaStyle: CSSProperties = {
  width: '100%',
  minHeight: '3.25rem',
  padding: '0.375rem 0.5rem',
  borderRadius: '0.375rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'rgba(0, 0, 0, 0.25)',
  color: 'inherit',
  fontSize: '12px',
  fontFamily: 'inherit',
  resize: 'vertical',
  boxSizing: 'border-box',
}

const addRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  justifyContent: 'flex-end',
}

const addCharStyle: CSSProperties = {
  fontSize: '10px',
  opacity: 0.7,
  marginRight: 'auto',
}

const addCharOverflowStyle: CSSProperties = {
  ...addCharStyle,
  color: '#f85149',
  opacity: 1,
  fontWeight: 600,
}

const addNoteStyle: CSSProperties = {
  fontSize: '11px',
  color: '#3fb950',
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

/** UTF-8 byte length of a string (TextEncoder in browsers; fallback for node). */
function utf8Bytes(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length
  return text.length
}

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
  const informational = error.localeKey === 'error.workspaceNotInitialized'
  return (
    <div
      data-graycode-memory={informational ? 'info' : 'error'}
      data-code={error.code}
      role={informational ? 'status' : 'alert'}
      style={{ ...errorBannerStyle, color }}
    >
      <span>
        {informational ? t(error.localeKey) : `${t('error.title')}: ${t(error.localeKey)}`}
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
  entryChars,
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
  const [addText, setAddText] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<MemoryErrorView | null>(null)
  const [addNote, setAddNote] = useState<string | null>(null)
  const workspaceRoot = workspace?.trim() || undefined
  const fallbackEntryChars = normalizeMemoryEntryChars(entryChars)
  const configContextKey = memoryRequestContextKey({ text: '', scope, workspace: workspaceRoot })
  const [configSnapshot, setConfigSnapshot] = useState<{
    readonly transport: MemoryManageTransport
    readonly contextKey: string
    readonly entryChars: number
  } | null>(null)
  const effectiveEntryChars = configSnapshot !== null
    && configSnapshot.transport === transport
    && configSnapshot.contextKey === configContextKey
    ? configSnapshot.entryChars
    : fallbackEntryChars
  // The raw search text participates immediately, before the debounce applies
  // it, so an old write/list response cannot briefly restore the previous
  // query's rows after the user has started typing a new query.
  const viewContextKey = memoryRequestContextKey({ text: queryText, scope, workspace: workspaceRoot })
  /** Latest rendered context; updated during render to close the pre-effect race window. */
  const currentContextKeyRef = useRef(viewContextKey)
  currentContextKeyRef.current = viewContextKey
  const currentAppliedQueryRef = useRef(appliedQuery)
  currentAppliedQueryRef.current = appliedQuery
  /** Stale-response guard: only the latest request may commit state. */
  const seqRef = useRef(0)
  const loadMoreSeqRef = useRef(0)
  const addSeqRef = useRef(0)
  const editSeqRef = useRef(0)
  const forgetSeqRef = useRef(0)
  const configSeqRef = useRef(0)
  const addGateRef = useRef<MemoryAddInFlightGate>()
  if (addGateRef.current === undefined) addGateRef.current = new MemoryAddInFlightGate()
  const currentConfigContextKeyRef = useRef(configContextKey)
  currentConfigContextKeyRef.current = configContextKey
  const currentTransportRef = useRef(transport)
  currentTransportRef.current = transport
  /** Unmount guard: never commit state after the panel is gone. */
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      seqRef.current += 1
      loadMoreSeqRef.current += 1
      addSeqRef.current += 1
      editSeqRef.current += 1
      forgetSeqRef.current += 1
      configSeqRef.current += 1
    }
  }, [])

  const fetchEffectiveConfig = useCallback(async (
    targetScope: GrayMemoryScope,
    targetWorkspace: string | undefined,
  ): Promise<void> => {
    const requestTransport = transport
    const contextKey = memoryRequestContextKey({ text: '', scope: targetScope, workspace: targetWorkspace })
    const requestId = ++configSeqRef.current
    if (
      contextKey !== currentConfigContextKeyRef.current
      || requestTransport !== currentTransportRef.current
    ) return
    // Never keep a value owned by an older fetch while a new host snapshot is
    // pending. `effectiveEntryChars` immediately falls back to the prop.
    setConfigSnapshot(null)
    if (
      requestTransport?.configGet === undefined
      || (targetScope === 'workspace' && targetWorkspace === undefined)
    ) return
    try {
      const result = await requestTransport.configGet({
        scope: targetScope,
        ...(targetScope === 'workspace' && targetWorkspace !== undefined
          ? { workspace: targetWorkspace }
          : {}),
      })
      if (!isCurrentMemoryConfigResponse({
        mounted: mountedRef.current,
        requestId,
        latestRequestId: configSeqRef.current,
        requestContextKey: contextKey,
        currentContextKey: currentConfigContextKeyRef.current,
        requestTransport,
        currentTransport: currentTransportRef.current,
      })) return
      if (!result.ok) return
      const hostEntryChars = normalizeMemoryEntryChars(result.value.entryChars)
      if (hostEntryChars === undefined) return
      setConfigSnapshot({ transport: requestTransport, contextKey, entryChars: hostEntryChars })
    } catch {
      // Config is advisory for local validation. A missing/legacy/misbehaving
      // endpoint safely falls back to the native settings snapshot; writes
      // remain host-authoritative.
    }
  }, [transport])

  useEffect(() => {
    void fetchEffectiveConfig(scope, workspaceRoot)
    return () => {
      configSeqRef.current += 1
    }
  }, [fetchEffectiveConfig, scope, workspaceRoot, fallbackEntryChars])

  // Debounce the search box into the applied query (pure UI timing).
  useEffect(() => {
    const handle = setTimeout(() => setAppliedQuery(queryText), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [queryText])

  const queryState = (q: string, s: GrayMemoryScope, targetWorkspace: string | undefined, cursor?: string): MemoryQueryState => ({
    text: q,
    scope: s,
    workspace: targetWorkspace,
    ...(cursor !== undefined ? { cursor } : {}),
    limit: pageLimit,
  })

  const fetchFirstPage = useCallback(async (
    q: string,
    s: GrayMemoryScope,
    targetWorkspace = workspaceRoot,
  ) => {
    const contextKey = memoryRequestContextKey({ text: q, scope: s, workspace: targetWorkspace })
    const seq = ++seqRef.current
    loadMoreSeqRef.current += 1
    setLoadingMore(false)
    if (transport === undefined) {
      if (contextKey !== currentContextKeyRef.current) return
      setList(null)
      setError(null)
      setPhase('ready')
      return
    }
    setPhase('loading')
    setError(null)
    let result
    if (s === 'workspace' && targetWorkspace === undefined) {
      result = {
        ok: false as const,
        error: {
          code: GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
          message: 'workspace scope requires an active session workspace',
          details: { field: 'workspace' },
        },
      }
    } else {
      try {
        result = await transport.list(buildMemoryListParams(queryState(q, s, targetWorkspace)))
      } catch (err) {
        result = { ok: false as const, error: toMemoryFailure(err) }
      }
    }
    if (seq !== seqRef.current || contextKey !== currentContextKeyRef.current || !mountedRef.current) return
    if (result.ok) {
      setList(buildMemoryListViewModel(result.value, { scope: s, workspace: targetWorkspace, query: q }))
      setPhase('ready')
    } else {
      const mapped = mapMemoryFailure(result.error)
      setError(mapped)
      if (isWorkspaceStoreMissingFailure(result.error)) {
        // A never-written workspace is a normal, addable empty state rather
        // than a failed panel. Keep the informational hint visible.
        setList(buildMemoryListViewModel(
          { items: [], total: 0, revision: 'workspace-store-missing' },
          { scope: s, workspace: targetWorkspace, query: q },
        ))
        setPhase('ready')
      } else {
        setPhase('error')
      }
    }
  }, [transport, workspaceRoot, pageLimit]) // eslint-disable-line react-hooks/exhaustive-deps

  // A visible scope/workspace/search change invalidates how pending actions
  // render. It deliberately does not release the add gate: the host write is
  // not cancellable and only its own finally may permit another submission.
  useEffect(() => {
    seqRef.current += 1
    loadMoreSeqRef.current += 1
    addSeqRef.current += 1
    editSeqRef.current += 1
    forgetSeqRef.current += 1
    setList(null)
    if (transport !== undefined) setPhase('loading')
    setLoadingMore(false)
    setEditSaving(false)
    setEditTarget(null)
    setForget(IDLE_FORGET_STATE)
    setAddError(null)
    setAddNote(null)
  }, [viewContextKey])

  useEffect(() => {
    void fetchFirstPage(appliedQuery, scope)
  }, [appliedQuery, scope, fetchFirstPage])

  const loadMore = useCallback(async () => {
    if (transport === undefined || list === null || list.nextCursor === undefined || loadingMore) return
    // Capture the list generation this request belongs to; responses for a
    // superseded generation (scope/search changed meanwhile) are dropped so
    // old pages never append into a newer list.
    const seq = seqRef.current
    const requestId = ++loadMoreSeqRef.current
    const targetQuery = appliedQuery
    const targetScope = scope
    const targetWorkspace = workspaceRoot
    const contextKey = currentContextKeyRef.current
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
      result = await transport.list(buildMemoryListParams(queryState(targetQuery, targetScope, targetWorkspace, cursor)))
    } catch (err) {
      result = { ok: false as const, error: toMemoryFailure(err) }
    }
    if (
      seq !== seqRef.current
      || requestId !== loadMoreSeqRef.current
      || contextKey !== currentContextKeyRef.current
      || !mountedRef.current
    ) return
    setLoadingMore(false)
    if (result.ok) {
      const next = buildMemoryListViewModel(result.value, { scope: targetScope, workspace: targetWorkspace, query: targetQuery })
      setList(prev =>
        prev === null
          ? next
          : appendMemoryListPage(prev, next),
      )
      setError(null)
    } else if (isStaleMemoryCursorFailure(result.error)) {
      // The host binds cursors to a list snapshot. A mutation between pages
      // invalidates the token: discard accumulated rows and restart instead
      // of appending an inconsistent page or leaving a dead retry button.
      setList(null)
      await fetchFirstPage(targetQuery, targetScope, targetWorkspace)
    } else {
      // Keep the accumulated list; surface the failure as a banner.
      setError(mapMemoryFailure(result.error))
    }
  }, [transport, list, loadingMore, appliedQuery, scope, workspaceRoot, fetchFirstPage]) // eslint-disable-line react-hooks/exhaustive-deps

  const onScopeChange = (next: GrayMemoryScope) => {
    if (next === scope) return
    // Invalidate synchronously; a promise microtask may settle before React
    // commits the state update below.
    seqRef.current += 1
    loadMoreSeqRef.current += 1
    addSeqRef.current += 1
    editSeqRef.current += 1
    forgetSeqRef.current += 1
    configSeqRef.current += 1
    currentConfigContextKeyRef.current = memoryRequestContextKey({
      text: '',
      scope: next,
      workspace: workspaceRoot,
    })
    setList(null)
    setLoadingMore(false)
    setEditSaving(false)
    setEditTarget(null)
    setForget(IDLE_FORGET_STATE)
    setAddError(null)
    setAddNote(null)
    setScope(next)
  }

  const submitAdd = useCallback(async () => {
    if (transport === undefined) return
    const text = addText.trim()
    if (text.length === 0) return
    setAddError(null)
    setAddNote(null)
    setForget(current => current.phase === 'done' ? IDLE_FORGET_STATE : current)
    const textBytes = utf8Bytes(text)
    if (effectiveEntryChars !== undefined && textBytes > effectiveEntryChars) {
      setAddError(mapMemoryFailure(memoryEntryCharsExceededFailure(textBytes, effectiveEntryChars)))
      return
    }
    const addGate = addGateRef.current!
    const requestTransport = transport
    const request = startMemoryAddRequest(addGate, () => requestTransport.add({
      scope,
      workspace: workspaceRoot,
      text,
    }))
    if (!request.started) return
    const targetScope = scope
    const targetWorkspace = workspaceRoot
    const contextKey = currentContextKeyRef.current
    const requestId = ++addSeqRef.current
    setAdding(true)
    let result
    try {
      result = await request.completion
    } catch (err) {
      result = { ok: false as const, error: toMemoryFailure(err) }
    } finally {
      // The request wrapper owns the lease. This finally only reflects its
      // settled state in the mounted UI; view generations never unlock it.
      if (mountedRef.current) setAdding(addGate.isInFlight())
    }
    if (
      !mountedRef.current
      || requestId !== addSeqRef.current
      || contextKey !== currentContextKeyRef.current
      || requestTransport !== currentTransportRef.current
    ) return
    if (result.ok) {
      setAddText('')
      setAddNote(t('add.success'))
      // `memory/note` may have initialized a previously absent workspace
      // store. Refresh its effective persisted config as well as the list.
      void fetchEffectiveConfig(targetScope, targetWorkspace)
      // The debounced applied query may have advanced while the write was in
      // flight even though the raw-input view identity stayed the same. Always
      // refresh the newest applied query; never cancel it with an older one.
      await fetchFirstPage(currentAppliedQueryRef.current, targetScope, targetWorkspace)
    } else {
      setAddError(mapMemoryFailure(result.error))
    }
  }, [transport, addText, effectiveEntryChars, scope, workspaceRoot, fetchFirstPage, fetchEffectiveConfig, t]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveEdit = useCallback(async (nextText: string) => {
    if (transport === undefined || editTarget === null) return
    setAddNote(null)
    // Capture the list generation the target belongs to; a response landing
    // after a scope/search change must not write into the newer list.
    const requestId = ++editSeqRef.current
    const contextKey = currentContextKeyRef.current
    const targetQuery = appliedQuery
    setEditSaving(true)
    const target = editTarget
    let result
    try {
      result = await transport.edit({
        scope: target.scope,
        workspace: target.workspace,
        id: target.id,
        text: nextText,
        expectedRevision: target.revision,
      })
    } catch (err) {
      result = { ok: false as const, error: toMemoryFailure(err) }
    }
    if (!mountedRef.current || requestId !== editSeqRef.current || contextKey !== currentContextKeyRef.current) return
    setEditSaving(false)
    if (result.ok) {
      const updated = buildMemoryEntryView(result.value, {
        scope: target.scope,
        workspace: target.workspace,
        query: targetQuery,
      }, target.revision)
      setList(prev =>
        prev === null || !prev.items.some(item => item.id === updated.id)
          ? prev // entry no longer part of the current list — drop the write-back
          : { ...prev, items: prev.items.map(item => (item.id === updated.id ? updated : item)) },
      )
      setEditTarget(null)
      await fetchFirstPage(currentAppliedQueryRef.current, target.scope, target.workspace)
    } else {
      const mapped = mapMemoryFailure(result.error)
      if (isStaleMemoryRevisionFailure(result.error)) {
        setEditTarget(null)
        await fetchFirstPage(currentAppliedQueryRef.current, target.scope, target.workspace)
        if (
          mountedRef.current
          && requestId === editSeqRef.current
          && contextKey === currentContextKeyRef.current
        ) setError(mapped)
      } else {
        setError(mapped)
      }
    }
  }, [transport, editTarget, appliedQuery, fetchFirstPage])

  const onForgetRequest = (entry: MemoryEntryViewModel) => {
    forgetSeqRef.current += 1
    setAddNote(null)
    const current = forget.phase === 'done' ? IDLE_FORGET_STATE : forget
    setForget(requestForget(current, {
      id: entry.id,
      revision: entry.revision,
      scope: entry.scope,
      workspace: entry.workspace,
    }, entry.text))
  }

  const onForgetConfirm = useCallback(async () => {
    if (transport === undefined || forget.target === null) return
    const submitting = confirmForget(forget)
    setForget(submitting)
    const target = submitting.target!
    const requestId = ++forgetSeqRef.current
    const contextKey = currentContextKeyRef.current
    let result
    try {
      result = await transport.forget({
        scope: target.scope,
        workspace: target.workspace,
        blockId: String(target.id),
        expectedRevision: target.revision,
        confirm: true,
      })
    } catch (err) {
      result = { ok: false as const, error: toMemoryFailure(err) }
    }
    if (!mountedRef.current || requestId !== forgetSeqRef.current || contextKey !== currentContextKeyRef.current) return
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
      await fetchFirstPage(currentAppliedQueryRef.current, target.scope, target.workspace)
    } else {
      if (isStaleMemoryRevisionFailure(result.error)) {
        await fetchFirstPage(currentAppliedQueryRef.current, target.scope, target.workspace)
        if (
          mountedRef.current
          && requestId === forgetSeqRef.current
          && contextKey === currentContextKeyRef.current
        ) {
          setForget(IDLE_FORGET_STATE)
          setError(mapMemoryFailure(result.error))
        }
      } else {
        setForget(rejectForget(submitting, result.error))
      }
    }
  }, [transport, forget, fetchFirstPage])

  const onForgetCancel = useCallback(() => {
    forgetSeqRef.current += 1
    setForget(cancelForget(forget))
  }, [forget])

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
          onChange={event => {
            // Invalidate synchronously; do not wait for the debounce/effect.
            seqRef.current += 1
            loadMoreSeqRef.current += 1
            addSeqRef.current += 1
            editSeqRef.current += 1
            forgetSeqRef.current += 1
            setQueryText(event.target.value)
          }}
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

      {wired && (
        <div data-graycode-memory="add" style={addBoxStyle}>
          <textarea
            data-graycode-memory="add-input"
            rows={3}
            placeholder={t('add.placeholder')}
            value={addText}
            disabled={adding || (scope === 'workspace' && workspaceRoot === undefined)}
            style={addTextareaStyle}
            onChange={event => setAddText(event.target.value)}
            onKeyDown={event => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                void submitAdd()
              }
            }}
          />
          <div style={addRowStyle}>
            <span
              data-graycode-memory="add-bytes"
              style={effectiveEntryChars !== undefined && utf8Bytes(addText) > effectiveEntryChars ? addCharOverflowStyle : addCharStyle}
            >
              {utf8Bytes(addText)}
              {effectiveEntryChars !== undefined ? `/${effectiveEntryChars}` : ''}
            </span>
            <button
              type="button"
              data-graycode-memory="add-submit"
              style={adding || addText.trim().length === 0 || (scope === 'workspace' && workspaceRoot === undefined) ? buttonDisabledStyle : buttonStyle}
              disabled={adding || addText.trim().length === 0 || (scope === 'workspace' && workspaceRoot === undefined)}
              onClick={() => void submitAdd()}
            >
              {adding ? t('add.busy') : t('add.button')}
            </button>
          </div>
          {addError !== null && (
            <MemoryErrorBanner t={t} error={addError} onRetry={() => void submitAdd()} />
          )}
          {addNote !== null && (
            <span data-graycode-memory="add-note" style={addNoteStyle}>
              {addNote}
            </span>
          )}
        </div>
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
          onEdit={entry => {
            setAddNote(null)
            setForget(current => current.phase === 'done' ? IDLE_FORGET_STATE : current)
            setEditTarget(entry)
          }}
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
