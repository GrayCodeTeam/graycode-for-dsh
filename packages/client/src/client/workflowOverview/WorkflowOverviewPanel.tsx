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
    source.list(buildWorkflowListRequest(query), controller.signal)
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
  // accumulated cursor. paging.ts guards concurrent requests.
  const loadMore = useCallback((): void => {
    if (source === undefined) return
    setPage((current) => {
      const request = nextWorkflowPageRequest(current)
      if (request === null) return current
      const loading = applyWorkflowPageLoading(current)
      source.list(buildWorkflowListRequest(query, request.cursor))
        .then((result) => {
          if (disposed.current) return
          setPage((latest) => applyWorkflowPageLoaded(latest, result, 'append'))
        })
        .catch((error: unknown) => {
          if (disposed.current) return
          setPage((latest) => applyWorkflowPageError(latest, readWorkflowThrownError(error)))
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
    setWorkspaceInput('')
    setSessionInput('')
    setQuery(createWorkflowOverviewQuery())
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
