/**
 * Workflow overview (P4-02) — list query model (pure, unit-testable).
 *
 * Models the user intent of the overview list: workspace filter, session
 * filter and paging limit. `buildWorkflowListRequest` maps the query onto the
 * wire args of the host `workflows/list` endpoint (contract:
 * `GrayWorkflowListParams` in packages/plugin/src/remote/types.ts).
 *
 * GAP-remote-1 (verified in
 * packages/plugin/src/workflows/adapters/dsh/remote.ts): rc.6 has no durable
 * session ↔ run association (documents are stored per workspace without a
 * sessionId), so the host list params carry no `session` field. This module
 * keeps the session seat in the query model for the future host upgrade,
 * exposes the capability through {@link WORKFLOW_SESSION_FILTER_AVAILABLE},
 * and {@link buildWorkflowListRequest} deliberately never emits a session
 * field — the UI renders the session filter disabled with a hint instead of
 * silently dropping the user's input.
 *
 * Cursor paging is a transient concern: the cursor lives in the page state
 * (paging.ts) and is passed to `buildWorkflowListRequest(query, cursor)` per
 * request, so changing a filter naturally starts a fresh page.
 */

/** Normalized client query for the overview list (filter intent, no cursor). */
export interface WorkflowOverviewQuery {
  /** Workspace root (absolute path); null = no request may be issued. */
  readonly workspace: string | null
  /** Session id; null = all sessions. Not forwarded on rc.6 (GAP-remote-1). */
  readonly sessionId: string | null
  /** Page size (normalized; mirrors the host default/max). */
  readonly limit: number
}

/** Mirrors `GRAY_PAGE_LIMIT_DEFAULT` (packages/plugin/src/remote/types.ts). */
export const WORKFLOW_PAGE_LIMIT_DEFAULT = 20
/** Mirrors `GRAY_PAGE_LIMIT_MAX` (packages/plugin/src/remote/types.ts). */
export const WORKFLOW_PAGE_LIMIT_MAX = 100

/** Whether the host supports session filtering (false on rc.6 — GAP-remote-1). */
export const WORKFLOW_SESSION_FILTER_AVAILABLE = false

/**
 * Normalize a page-size request the way the host does: absent/zero/negative/
 * non-finite/non-integer → default; over the max → max.
 * @param value - raw limit from user code.
 */
export function normalizeWorkflowPageLimit(value: number | undefined | null): number {
  if (value === undefined || value === null) return WORKFLOW_PAGE_LIMIT_DEFAULT
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return WORKFLOW_PAGE_LIMIT_DEFAULT
  return Math.min(value, WORKFLOW_PAGE_LIMIT_MAX)
}

/** Create a normalized query; absent fields default to null / the page default. */
export function createWorkflowOverviewQuery(partial: Partial<WorkflowOverviewQuery> = {}): WorkflowOverviewQuery {
  return {
    workspace: partial.workspace === undefined ? null : partial.workspace,
    sessionId: partial.sessionId === undefined ? null : partial.sessionId,
    limit: normalizeWorkflowPageLimit(partial.limit),
  }
}

/** Immutable update of the workspace filter. */
export function withWorkflowWorkspace(query: WorkflowOverviewQuery, workspace: string | null): WorkflowOverviewQuery {
  return { ...query, workspace }
}

/** Immutable update of the session filter (inert on rc.6, see GAP-remote-1). */
export function withWorkflowSession(query: WorkflowOverviewQuery, sessionId: string | null): WorkflowOverviewQuery {
  return { ...query, sessionId }
}

/** Wire args of the host `workflows/list` endpoint (mirror of `GrayWorkflowListParams`). */
export interface WorkflowListWireRequest {
  readonly workspace: string
  readonly cursor?: string
  readonly limit: number
}

/**
 * Map a client query (+ optional page cursor) onto the `workflows/list` wire
 * args.
 *
 * Contract honesty: `sessionId` is intentionally NOT forwarded — the rc.6
 * host endpoint has no session field (GAP-remote-1). The session seat exists
 * only in the client query model; when the host adds it, this function is the
 * single place that changes.
 * @param query - normalized client query.
 * @param cursor - page cursor (id of the last loaded run), null = first page.
 */
export function buildWorkflowListRequest(
  query: WorkflowOverviewQuery,
  cursor: string | null = null,
): WorkflowListWireRequest | null {
  const workspace = query.workspace?.trim() ?? ''
  if (workspace.length === 0) return null
  let request: WorkflowListWireRequest = { workspace, limit: query.limit }
  if (cursor !== null && cursor.length > 0) {
    request = { ...request, cursor }
  }
  return request
}
