/**
 * Workflow overview (P4-02) — view-model construction (pure, unit-testable).
 *
 * Projects one `workflows/list` page (structural `GrayWorkflowRunSummary`
 * mirrors) into render-ready views: display labels resolve to locale keys of
 * the `graycode.workflowOverview` namespace (components translate them — no
 * English in logic), workspace roots collapse to short labels, sizes format
 * to human units, timestamps normalize.
 *
 * Host data stays authoritative: no re-sorting, no filtering, no workspace
 * access — every value is a plain string/number carried by remote data.
 */
import type {
  WorkflowOverviewListResult,
  WorkflowRunKind,
  WorkflowRunSummaryLike,
} from './types.ts'

/** Locale keys for run kinds (subset of the `graycode.workflowOverview` dictionary). */
export type WorkflowKindLabelKey = 'kind.progress' | 'kind.design' | 'kind.plan' | 'kind.review'
/** Locale keys for progress-document status values. */
export type WorkflowRunStatusLabelKey =
  | 'runStatus.active'
  | 'runStatus.blocked'
  | 'runStatus.completed'
  | 'runStatus.archived'
/** Locale keys for progress-document phase values. */
export type WorkflowPhaseLabelKey =
  | 'phase.design'
  | 'phase.plan'
  | 'phase.implementation'
  | 'phase.review'
  | 'phase.maintenance'
/** Locale keys for byte-size units. */
export type WorkflowSizeUnitKey = 'size.bytes' | 'size.kb' | 'size.mb' | 'size.gb'

/** Render-ready view of one workflow run (list item). */
export interface WorkflowRunView {
  readonly id: string
  readonly kind: WorkflowRunKind
  readonly path: string
  readonly workspace: string
  /** Short display label of the workspace root (last path segment). */
  readonly workspaceLabel: string
  /** Epoch ms; null when the wire carried none (rendered as '—'). */
  readonly updatedAt: number | null
  readonly sizeBytes: number | null
  readonly status: string | null
  readonly phase: string | null
  readonly projectName: string | null
  readonly kindLabelKey: WorkflowKindLabelKey | null
  readonly statusLabelKey: WorkflowRunStatusLabelKey | null
  readonly phaseLabelKey: WorkflowPhaseLabelKey | null
}

/** Render-ready view of one `workflows/list` page. */
export interface WorkflowOverviewListView {
  readonly entries: readonly WorkflowRunView[]
  readonly total: number
  readonly hasMore: boolean
  readonly nextCursor: string | null
}

/** Human-readable size of one run (value + unit locale key). */
export interface WorkflowRunSizeView {
  readonly value: string
  readonly unitKey: WorkflowSizeUnitKey
}

const KIND_LABEL_KEYS: Readonly<Record<WorkflowRunKind, WorkflowKindLabelKey>> = {
  progress: 'kind.progress',
  design: 'kind.design',
  plan: 'kind.plan',
  review: 'kind.review',
}

const STATUS_LABEL_KEYS: Readonly<Record<string, WorkflowRunStatusLabelKey>> = {
  active: 'runStatus.active',
  blocked: 'runStatus.blocked',
  completed: 'runStatus.completed',
  archived: 'runStatus.archived',
}

const PHASE_LABEL_KEYS: Readonly<Record<string, WorkflowPhaseLabelKey>> = {
  design: 'phase.design',
  plan: 'phase.plan',
  implementation: 'phase.implementation',
  review: 'phase.review',
  maintenance: 'phase.maintenance',
}

function labelKeyOf<T extends string>(
  table: Readonly<Record<string, T>>,
  value: string | undefined | null,
): T | null {
  if (value === undefined || value === null) return null
  return table[value] ?? null
}

/** Locale key for a run kind, or null for unknown kinds (defensive). */
export function workflowKindLabelKey(kind: string): WorkflowKindLabelKey | null {
  if (kind === 'progress' || kind === 'design' || kind === 'plan' || kind === 'review') {
    return KIND_LABEL_KEYS[kind]
  }
  return null
}

/** Locale key for a progress status, or null for unknown/absent values. */
export function workflowStatusLabelKey(status: string | undefined | null): WorkflowRunStatusLabelKey | null {
  return labelKeyOf(STATUS_LABEL_KEYS, status)
}

/** Locale key for a progress phase, or null for unknown/absent values. */
export function workflowPhaseLabelKey(phase: string | undefined | null): WorkflowPhaseLabelKey | null {
  return labelKeyOf(PHASE_LABEL_KEYS, phase)
}

/**
 * Short display label of a workspace root (last path segment; POSIX and
 * Windows separators). Falls back to the input when there is no segment: a
 * bare drive letter `C:` labels itself, and the root paths `/` / `\\` render
 * their own marker instead of an empty string (audit L1). An empty input
 * stays empty — there is nothing to label.
 * @param workspace - absolute workspace root from the wire.
 */
export function workspaceLabelOf(workspace: string): string {
  const trimmed = workspace.replace(/[\\/]+$/, '')
  const segments = trimmed.split(/[\\/]/).filter((segment) => segment.length > 0)
  if (segments.length > 0) return segments.at(-1) ?? workspace
  return workspace.length > 0 ? workspace : ''
}

/**
 * Stable identity of one run view. Run ids are workspace-relative paths that
 * repeat across workspaces, so dedupe and React keys are workspace-scoped
 * (audit M6).
 */
export function workflowRunKey(run: Pick<WorkflowRunView, 'workspace' | 'id'>): string {
  return `${run.workspace}\u0000${run.id}`
}

/** Normalize one wire summary into a render-ready view. */
export function buildWorkflowRunView(summary: WorkflowRunSummaryLike): WorkflowRunView {
  return {
    id: summary.id,
    kind: summary.kind,
    path: summary.path,
    workspace: summary.workspace,
    workspaceLabel: workspaceLabelOf(summary.workspace),
    updatedAt: typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt)
      ? summary.updatedAt
      : null,
    sizeBytes: typeof summary.sizeBytes === 'number' && Number.isFinite(summary.sizeBytes)
      ? summary.sizeBytes
      : null,
    status: summary.status ?? null,
    phase: summary.phase ?? null,
    projectName: summary.projectName ?? null,
    kindLabelKey: workflowKindLabelKey(summary.kind),
    statusLabelKey: workflowStatusLabelKey(summary.status),
    phaseLabelKey: workflowPhaseLabelKey(summary.phase),
  }
}

/**
 * Build the render view of one page. `hasMore` follows the host cursor
 * contract: a next cursor with at least one item means more pages.
 */
export function buildWorkflowListView(result: WorkflowOverviewListResult): WorkflowOverviewListView {
  const entries = result.items.map(buildWorkflowRunView)
  const nextCursor = result.nextCursor ?? null
  return {
    entries,
    total: result.total,
    hasMore: nextCursor !== null && entries.length > 0,
    nextCursor,
  }
}

/**
 * Format a byte count into a short human unit (B / KB / MB / GB). Pure: no
 * I/O, no workspace access; unit labels stay locale keys for translation.
 * @param sizeBytes - byte count from the wire (or absent).
 * @returns the value/unit pair, or null when absent/unusable.
 */
export function formatWorkflowRunSize(sizeBytes: number | null | undefined): WorkflowRunSizeView | null {
  if (sizeBytes === null || sizeBytes === undefined || !Number.isFinite(sizeBytes)) return null
  if (sizeBytes < 1024) return { value: String(Math.floor(sizeBytes)), unitKey: 'size.bytes' }
  const units: readonly WorkflowSizeUnitKey[] = ['size.kb', 'size.mb', 'size.gb']
  let value = sizeBytes
  let unitIndex = -1
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  const text = value >= 100 ? Math.round(value).toString() : value.toFixed(1)
  return { value: text, unitKey: units[unitIndex]! }
}

/** Epoch ms → a valid Date, or null when absent/unrepresentable. */
function workflowDateOf(time: number | null | undefined): Date | null {
  if (time === null || time === undefined || !Number.isFinite(time)) return null
  const date = new Date(time)
  // Finite but out-of-range epoch values (beyond the ±8.64e15 ms Date range)
  // yield an Invalid Date whose Intl formatting throws a RangeError — degrade
  // to a neutral placeholder instead of crashing the render (audit M3).
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Short timestamp for a run (`Intl` short date+time; neutral '—' for absent
 * or unrepresentable values). Browser/native Intl only — replay-safe, no I/O.
 * @param time - epoch ms from the wire (or absent).
 */
export function formatWorkflowRunTime(time: number | null | undefined): string {
  const date = workflowDateOf(time)
  if (date === null) return '—'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

/**
 * Epoch ms → ISO string for the `<time dateTime>` attribute; null when absent
 * or unrepresentable (a malformed value must not throw from `toISOString()`).
 * @param time - epoch ms from the wire (or absent).
 */
export function workflowRunTimeIso(time: number | null | undefined): string | null {
  const date = workflowDateOf(time)
  return date === null ? null : date.toISOString()
}
