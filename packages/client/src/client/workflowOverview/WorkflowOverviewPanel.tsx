/**
 * Workflow overview panel (P4-02) — the management surface container.
 *
 * Owns the filter inputs and the paged list state (query.ts / paging.ts) and
 * drives a {@link WorkflowOverviewDataSource}:
 *
 * - Mounted WITHOUT a source (history replay, unwired host): renders a
 *   degraded hint state — no fetch is ever initiated (client boundary rules,
 *   DSH_MIGRATION_PLAN.md §P4).
 * - Mounted WITH a source (live management view): fetches the first page on
 *   mount and whenever the applied filter changes; "load more" appends the
 *   next cursor page (paging.ts refuses concurrent requests); a failure
 *   surfaces the error state with a retry entry for retryable codes.
 *
 * The panel itself performs no other I/O: locate-session / open-document are
 * declarative callbacks wired by the host, and every card button degrades to
 * disabled in their absence.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { readWorkflowThrownError } from './wire.ts'
import { WorkflowOverviewFilters } from './WorkflowOverviewFilters.tsx'
import { WorkflowRunList } from './WorkflowRunList.tsx'
import {
  WORKFLOW_SESSION_FILTER_AVAILABLE,
  buildWorkflowListRequest,
  createWorkflowOverviewQuery,
  withWorkflowSession,
  withWorkflowWorkspace,
  type WorkflowOverviewQuery,
} from './query.ts'
import {
  applyWorkflowPageError,
  applyWorkflowPageLoaded,
  applyWorkflowPageLoading,
  createWorkflowOverviewPageState,
  isWorkflowAppendCurrent,
  nextWorkflowPageRequest,
  type WorkflowOverviewPageState,
} from './paging.ts'
import type { WorkflowOverviewDataSource, WorkflowOverviewError } from './types.ts'
import type { WorkflowRunView } from './viewModel.ts'

/** Composed props for the overview panel. */
export interface WorkflowOverviewPanelProps {
  /** Framework-injected translate seat for the `graycode.workflowOverview` namespace. */
  t: TranslateNS<'graycode.workflowOverview'>
  /**
   * Data source. Absent during replay / unwired hosts → degraded hint state,
   * no fetch. Callers must keep the instance stable across renders (memoize
   * or hoist) to avoid refetch loops.
   */
  source?: WorkflowOverviewDataSource
  /** Initial workspace filter (absolute path). */
  initialWorkspace?: string
  /** Declarative locate-session entry (forwarded to each card). */
  onLocateSession?: (run: WorkflowRunView) => void
  /** Declarative open-document entry (forwarded to each card). */
  onOpenDocument?: (run: WorkflowRunView) => void
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
  minWidth: '300px',
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

const WORKSPACE_REQUIRED_ERROR: WorkflowOverviewError = {
  code: 'GRAY_INVALID_INPUT',
  message: 'workspace is required',
  details: { field: 'workspace' },
}

/**
 * Workflow overview panel. Mount it wherever the host renders management
 * views (see workflowOverview/README.md for wiring).
 */
export function WorkflowOverviewPanel({
  t,
  source,
  initialWorkspace,
  onLocateSession,
  onOpenDocument,
}: WorkflowOverviewPanelProps): ReactNode {
  const [workspaceInput, setWorkspaceInput] = useState(initialWorkspace ?? '')
  const [sessionInput, setSessionInput] = useState('')
  const [query, setQuery] = useState<WorkflowOverviewQuery>(() =>
    createWorkflowOverviewQuery({ workspace: initialWorkspace ?? null }),
  )
  const [page, setPage] = useState<WorkflowOverviewPageState>(createWorkflowOverviewPageState)
  const disposed = useRef(false)

  useEffect(() => {
    disposed.current = false
    return () => {
      disposed.current = true
    }
  }, [])

  // First page: on mount and whenever the applied filter changes (replace
  // mode, cursor null). Aborting the controller drops stale responses.
  useEffect(() => {
    if (source === undefined) return
    const controller = new AbortController()
    setPage(applyWorkflowPageLoading(createWorkflowOverviewPageState()))
    const request = buildWorkflowListRequest(query)
    if (request === null) {
      setPage(applyWorkflowPageError(createWorkflowOverviewPageState(), WORKSPACE_REQUIRED_ERROR))
      return () => controller.abort()
    }
    source.list(request, controller.signal)
      .then((result) => {
        if (disposed.current || controller.signal.aborted) return
        setPage((current) => applyWorkflowPageLoaded(current, result, 'replace'))
      })
      .catch((error: unknown) => {
        if (disposed.current || controller.signal.aborted) return
        setPage((current) => applyWorkflowPageError(current, readWorkflowThrownError(error)))
      })
    return () => controller.abort()
  }, [source, query])

  // Next page (load more) and retry after an error: append mode with the
  // accumulated cursor. paging.ts guards concurrent requests, and the page
  // revision captured at request time guards stale responses: once the
  // applied filter changed (the first-page effect replaced the list), an
  // in-flight append is dropped instead of mixing into the newer list.
  const loadMore = useCallback((): void => {
    if (source === undefined) return
    setPage((current) => {
      const request = nextWorkflowPageRequest(current)
      if (request === null) return current
      const wireRequest = buildWorkflowListRequest(query, request.cursor)
      if (wireRequest === null) return applyWorkflowPageError(current, WORKSPACE_REQUIRED_ERROR)
      const loading = applyWorkflowPageLoading(current)
      const issuedRevision = loading.revision
      source.list(wireRequest)
        .then((result) => {
          if (disposed.current) return
          setPage((latest) =>
            isWorkflowAppendCurrent(latest, issuedRevision)
              ? applyWorkflowPageLoaded(latest, result, 'append')
              : latest,
          )
        })
        .catch((error: unknown) => {
          if (disposed.current) return
          setPage((latest) =>
            isWorkflowAppendCurrent(latest, issuedRevision)
              ? applyWorkflowPageError(latest, readWorkflowThrownError(error))
              : latest,
          )
        })
      return loading
    })
  }, [source, query])

  const applyFilters = (): void => {
    const workspace = workspaceInput.trim()
    const sessionId = sessionInput.trim()
    setQuery((current) =>
      withWorkflowSession(
        withWorkflowWorkspace(current, workspace.length > 0 ? workspace : null),
        sessionId.length > 0 ? sessionId : null,
      ),
    )
  }

  const resetFilters = (): void => {
    const workspace = initialWorkspace?.trim() ?? ''
    setWorkspaceInput(workspace)
    setSessionInput('')
    setQuery(createWorkflowOverviewQuery({ workspace: workspace.length > 0 ? workspace : null }))
  }

  if (source === undefined) {
    return (
      <div data-graycode-workflow-overview="panel" data-state="replay" style={panelStyle}>
        <h2 style={titleStyle}>{t('title')}</h2>
        <div style={hintStyle}>{t('state.replayOnly')}</div>
      </div>
    )
  }

  return (
    <div data-graycode-workflow-overview="panel" data-state={page.phase} style={panelStyle}>
      <h2 style={titleStyle}>{t('title')}</h2>
      <WorkflowOverviewFilters
        t={t}
        workspace={workspaceInput}
        sessionId={sessionInput}
        sessionFilterAvailable={WORKFLOW_SESSION_FILTER_AVAILABLE}
        onWorkspaceChange={setWorkspaceInput}
        onSessionChange={setSessionInput}
        onApply={applyFilters}
        onReset={resetFilters}
      />
      <WorkflowRunList
        t={t}
        page={page}
        onLoadMore={loadMore}
        onLocateSession={onLocateSession}
        onOpenDocument={onOpenDocument}
      />
    </div>
  )
}
