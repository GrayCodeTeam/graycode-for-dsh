/**
 * Workflow overview (P4-02) — data sources.
 *
 * Two implementations of {@link WorkflowOverviewDataSource}:
 *
 * - {@link RemoteWorkflowOverviewDataSource} — the contract-driven consumer
 *   of the host Remote API (`workflows/list`, `workflows/get`; contract in
 *   packages/plugin/src/remote/types.ts, handlers in
 *   packages/plugin/src/workflows/adapters/dsh/remote.ts, registered under
 *   `ctx.grayRemote` by the workflows domain). It consumes the
 *   `GrayRemoteResult` envelope through the pure readers in `wire.ts` and
 *   never trusts the wire. The actual browser→host transport is NOT wired in
 *   rc.6 (README GAP-client-1), so the class takes a
 *   {@link WorkflowRemoteTransport} function the main session supplies.
 *
 * - {@link MockWorkflowOverviewDataSource} — deterministic in-memory fixture
 *   (no I/O, no workspace access) for development, tests and unwired hosts.
 *   Mirrors the host's cursor semantics (`slicePage` in
 *   packages/plugin/src/remote/validate.ts: cursor = id of the last item,
 *   start after it, nextCursor = new last id while more remain).
 *
 * Neither implementation touches the workspace or the file system (browser
 * bundle boundary rules).
 */
import { WORKFLOW_PAGE_LIMIT_DEFAULT, normalizeWorkflowPageLimit } from './query.ts'
import type {
  WorkflowOverviewDataSource,
  WorkflowOverviewError,
  WorkflowOverviewListResult,
  WorkflowOverviewWireGetParams,
  WorkflowOverviewWireListParams,
  WorkflowRunDetailLike,
  WorkflowRunSummaryLike,
} from './types.ts'
import {
  readWorkflowEnvelope,
  readWorkflowListResult,
  readWorkflowRunDetail,
} from './wire.ts'

/** Host endpoints consumed by this surface (contract keys). */
export type WorkflowRemoteEndpoint = 'workflows/list' | 'workflows/get'

/**
 * Transport from the browser half to the host `ctx.grayRemote` dispatcher.
 * Returns the raw `GrayRemoteResult` envelope (unknown on the wire). Wired by
 * the main session — rc.6 has no built-in client→host remote channel
 * (README GAP-client-1).
 */
export type WorkflowRemoteTransport = (
  endpoint: WorkflowRemoteEndpoint,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
) => Promise<unknown>

function toWorkflowError(code: string, message: string): WorkflowOverviewError {
  return { code, message, details: {} }
}

function requireWorkflowWorkspace(workspace: string | undefined): string {
  const normalized = typeof workspace === 'string' ? workspace.trim() : ''
  if (normalized.length === 0) {
    throw toWorkflowError('GRAY_INVALID_INPUT', 'workspace is required')
  }
  return normalized
}

/**
 * Contract-driven consumer of the host `workflows/*` endpoints.
 *
 * Maps wire params onto the endpoint args, reads the `GrayRemoteResult`
 * envelope defensively (`wire.ts`), and translates failures into thrown
 * {@link WorkflowOverviewError} values (business errors never reject the
 * transport itself — only this wrapper's promise). `get` resolves `null` for
 * `GRAY_NOT_FOUND` so the UI can treat a missing run as an empty result.
 */
export class RemoteWorkflowOverviewDataSource implements WorkflowOverviewDataSource {
  constructor(private readonly transport: WorkflowRemoteTransport) {}

  async list(params: WorkflowOverviewWireListParams, signal?: AbortSignal): Promise<WorkflowOverviewListResult> {
    const workspace = requireWorkflowWorkspace(params.workspace)
    const args: Record<string, unknown> = { workspace, limit: normalizeWorkflowPageLimit(params.limit) }
    if (params.cursor !== undefined) args.cursor = params.cursor
    const envelope = readWorkflowEnvelope(await this.transport('workflows/list', args, signal))
    if (!envelope.ok) throw envelope.error
    const result = readWorkflowListResult(envelope.value)
    if (result === null) throw toWorkflowError('GRAY_INTERNAL', 'malformed workflows/list result')
    return result
  }

  async get(params: WorkflowOverviewWireGetParams, signal?: AbortSignal): Promise<WorkflowRunDetailLike | null> {
    const workspace = requireWorkflowWorkspace(params.workspace)
    const args: Record<string, unknown> = { id: params.id, workspace }
    const envelope = readWorkflowEnvelope(await this.transport('workflows/get', args, signal))
    if (!envelope.ok) {
      if (envelope.error.code === 'GRAY_NOT_FOUND') return null
      throw envelope.error
    }
    const detail = readWorkflowRunDetail(envelope.value)
    if (detail === null) throw toWorkflowError('GRAY_INTERNAL', 'malformed workflows/get result')
    return detail
  }
}

/** Options for the deterministic mock source. */
export interface MockWorkflowOverviewDataSourceOptions {
  /** Fixture runs; defaults to {@link createMockWorkflowRuns}. */
  readonly runs?: readonly WorkflowRunSummaryLike[]
  /** Injected failures by endpoint (stable code to throw), for tests/dev. */
  readonly failures?: { readonly list?: string; readonly get?: string }
}

/**
 * Deterministic fixture runs: two workspaces (POSIX and Windows roots),
 * all four kinds, progress documents carrying status/phase/projectName.
 * Pure in-memory data — no file system, no workspace access.
 */
export function createMockWorkflowRuns(): WorkflowRunSummaryLike[] {
  const alpha = 'C:\\dev\\alpha'
  const beta = '/home/dev/beta'
  return [
    { id: '.graycode/progress.md', kind: 'progress', path: '.graycode/progress.md', workspace: alpha, updatedAt: 1_700_000_000_000, sizeBytes: 2_048, status: 'active', phase: 'implementation', projectName: 'Alpha' },
    { id: '.graycode/design/architecture.md', kind: 'design', path: '.graycode/design/architecture.md', workspace: alpha, updatedAt: 1_699_000_000_000, sizeBytes: 4_096 },
    { id: '.graycode/design/onboarding.md', kind: 'design', path: '.graycode/design/onboarding.md', workspace: alpha, updatedAt: 1_698_000_000_000, sizeBytes: 1_024 },
    { id: '.graycode/plans/p4.md', kind: 'plan', path: '.graycode/plans/p4.md', workspace: alpha, updatedAt: 1_697_000_000_000, sizeBytes: 3_072 },
    { id: '.graycode/review/r1.md', kind: 'review', path: '.graycode/review/r1.md', workspace: alpha, updatedAt: 1_696_000_000_000, sizeBytes: 512 },
    { id: '.graycode/progress.md', kind: 'progress', path: '.graycode/progress.md', workspace: beta, updatedAt: 1_695_000_000_000, sizeBytes: 1_536, status: 'completed', phase: 'maintenance', projectName: 'Beta' },
    { id: '.graycode/design/landing.md', kind: 'design', path: '.graycode/design/landing.md', workspace: beta, updatedAt: 1_694_000_000_000, sizeBytes: 2_560 },
    { id: '.graycode/plans/p1.md', kind: 'plan', path: '.graycode/plans/p1.md', workspace: beta, updatedAt: 1_693_000_000_000, sizeBytes: 768 },
    { id: '.graycode/review/r2.md', kind: 'review', path: '.graycode/review/r2.md', workspace: beta, updatedAt: 1_692_000_000_000, sizeBytes: 1_280 },
  ]
}

/**
 * Deterministic in-memory data source. Implements the same cursor semantics
 * as the host's `slicePage` (cursor = item id, page starts after it, next
 * cursor = last item of the page while more remain; an unknown/deleted cursor
 * is exhausted rather than restarting at page 1). Filtering is exact-match
 * on the absolute workspace root — same as the host.
 */
export class MockWorkflowOverviewDataSource implements WorkflowOverviewDataSource {
  private readonly runs: readonly WorkflowRunSummaryLike[]
  private readonly failures: { readonly list?: string; readonly get?: string }

  constructor(options: MockWorkflowOverviewDataSourceOptions = {}) {
    this.runs = options.runs ?? createMockWorkflowRuns()
    this.failures = options.failures ?? {}
  }

  async list(params: WorkflowOverviewWireListParams, _signal?: AbortSignal): Promise<WorkflowOverviewListResult> {
    if (this.failures.list !== undefined) {
      throw toWorkflowError(this.failures.list, `mock workflows/list failure: ${this.failures.list}`)
    }
    const workspace = requireWorkflowWorkspace(params.workspace)
    const filtered = this.runs.filter((run) => run.workspace === workspace)
    const limit = normalizeWorkflowPageLimit(params.limit)

    let start = 0
    if (params.cursor !== undefined && params.cursor !== null) {
      const index = filtered.findIndex((run) => run.id === params.cursor)
      if (index < 0) return { items: [], total: filtered.length }
      start = index + 1
    }
    const page = filtered.slice(start, start + limit)
    const nextCursor = start + limit < filtered.length && page.length > 0
      ? page[page.length - 1]!.id
      : undefined
    let result: WorkflowOverviewListResult = { items: page, total: filtered.length }
    if (nextCursor !== undefined) result = { ...result, nextCursor }
    return result
  }

  async get(params: WorkflowOverviewWireGetParams, _signal?: AbortSignal): Promise<WorkflowRunDetailLike | null> {
    if (this.failures.get !== undefined) {
      throw toWorkflowError(this.failures.get, `mock workflows/get failure: ${this.failures.get}`)
    }
    const workspace = requireWorkflowWorkspace(params.workspace)
    const run = this.runs.find(
      (candidate) => candidate.id === params.id
        && candidate.workspace === workspace,
    )
    if (run === undefined) return null
    return { ...run, content: `# ${run.id}\n\nmock detail body` }
  }
}
