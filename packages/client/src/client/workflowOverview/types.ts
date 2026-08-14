/**
 * Workflow overview (P4-02) — client-side domain types.
 *
 * The host Remote API contract lives in `packages/plugin/src/remote/types.ts`
 * (read-only for this surface; `packages/plugin/**` is off-limits). Like the
 * P4-01 skeleton (`workflowNode/types.ts`), this module mirrors the wire
 * contract *structurally* instead of importing it: the browser bundle must
 * not pull host/plugin code (bundle purity gate), and the wire is consumed
 * through defensive readers (`wire.ts`) rather than trusted types.
 *
 * CLIENT BOUNDARY RULES (DSH_MIGRATION_PLAN.md §P4 / §5.6):
 * - Replay-safe: this module performs no I/O and never touches the workspace;
 *   every path/workspace value is a plain string carried by remote data. The
 *   referenced files may no longer exist; components render them as text.
 * - The {@link WorkflowOverviewDataSource} interface is the single
 *   consumption point. A missing source (history replay, unwired host)
 *   degrades to a hint state — the surface never initiates a fetch on its own
 *   outside an explicit live-mode mount with a wired source.
 */

/** Run kinds produced by the host `workflows/list` endpoint. */
export type WorkflowRunKind = 'progress' | 'design' | 'plan' | 'review'

/**
 * Structural mirror of `GrayWorkflowRunSummary`
 * (packages/plugin/src/remote/types.ts). One list item = one workflow run
 * document; `id` is the workspace-relative path (e.g. `.graycode/progress.md`).
 */
export interface WorkflowRunSummaryLike {
  readonly id: string
  readonly kind: WorkflowRunKind
  /** Workspace-relative path (POSIX separators). */
  readonly path: string
  /** Absolute workspace root. */
  readonly workspace: string
  /** Last update (progress metadata `updatedAt`, else file mtime) in epoch ms. */
  readonly updatedAt?: number
  /** Byte size (when stat/`listDir` provided one). */
  readonly sizeBytes?: number
  /** Progress-document status (active/blocked/completed/archived); other kinds: none. */
  readonly status?: string
  /** Progress-document phase (design/plan/implementation/review/maintenance). */
  readonly phase?: string
  readonly projectName?: string
}

/** Structural mirror of `GrayWorkflowRunDetail` (summary + full text + metadata). */
export interface WorkflowRunDetailLike extends WorkflowRunSummaryLike {
  readonly content: string
  /** Progress-document metadata (design/plan/review carry none). */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** One page of run summaries — mirror of `GrayPage<GrayWorkflowRunSummary>`. */
export interface WorkflowOverviewListResult {
  readonly items: readonly WorkflowRunSummaryLike[]
  /** Filtered total (host-authoritative). */
  readonly total: number
  /** Cursor for the next page (id of the last item); absent = no more pages. */
  readonly nextCursor?: string
}

/** Wire-style list params — mirror of `GrayWorkflowListParams`. */
export interface WorkflowOverviewWireListParams {
  /** Workspace root (absolute path); absent = host default (`process.cwd()`). */
  readonly workspace?: string
  readonly cursor?: string
  readonly limit?: number
}

/** Wire-style get params — mirror of `GrayWorkflowGetParams`. */
export interface WorkflowOverviewWireGetParams {
  readonly workspace?: string
  /** Run id (workspace-relative path, whitelisted scope). */
  readonly id: string
}

/** Stable failure mirror of `GrayRemoteFailure` — the only error the UI reads. */
export interface WorkflowOverviewError {
  /** Stable machine code (GRAY_*; UI never parses English messages). */
  readonly code: string
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
}

/**
 * Transport-agnostic data source for the overview surface.
 *
 * Implementations:
 * - {@link RemoteWorkflowOverviewDataSource} — contract-driven consumer of
 *   the host `workflows/*` endpoints over a host-supplied transport;
 * - {@link MockWorkflowOverviewDataSource} — deterministic in-memory fixture
 *   (no I/O, no workspace access) for development, tests and unwired hosts.
 *
 * `list` rejects with a {@link WorkflowOverviewError} on failure (the
 * envelope → error translation happens inside the remote implementation);
 * `get` resolves `null` for a not-found run.
 */
export interface WorkflowOverviewDataSource {
  list(params: WorkflowOverviewWireListParams, signal?: AbortSignal): Promise<WorkflowOverviewListResult>
  get(params: WorkflowOverviewWireGetParams, signal?: AbortSignal): Promise<WorkflowRunDetailLike | null>
}
