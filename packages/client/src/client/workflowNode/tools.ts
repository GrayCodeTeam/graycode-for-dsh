/**
 * Workflow tool registry — client half of the Design/Plan/Progress/Review workflow
 * surface (P4-01).
 *
 * The 14 Gray workflow tools are owned by the host-side workflows plugin
 * (`packages/plugin/src/workflows/`). The client never re-implements them; it
 * only needs their stable names to recognise their `tool/call` events in the
 * session log and to classify each call into a display family.
 */

/** Definition kind (and location-data key) owned by the workflow node. */
export const WORKFLOW_KIND = 'graycode.workflow'

/** The 14 Gray workflow tools (mirrors packages/plugin/src/workflows/index.ts). */
export const WORKFLOW_TOOLS = [
  'create_design',
  'update_design',
  'create_plan',
  'update_plan',
  'create_progress',
  'update_progress',
  'record_progress_milestone',
  'validate_progress_document',
  'create_review',
  'record_review_milestone',
  'finalize_review',
  'reopen_review',
  'validate_review_document',
  'compare_review_documents',
] as const

/** One Gray workflow tool name. */
export type WorkflowToolName = (typeof WORKFLOW_TOOLS)[number]

/** Display family of a workflow tool (drives the card badge and copy). */
export type WorkflowFamily = 'design' | 'plan' | 'progress' | 'review'

/** O(1) membership check (a ReadonlySet over the const tuple). */
const WORKFLOW_TOOL_SET: ReadonlySet<string> = new Set<string>(WORKFLOW_TOOLS)

/**
 * Whether a tool name belongs to the Gray workflow surface.
 * @param name - raw tool name from a `tool/call` event.
 */
export function isWorkflowToolName(name: string): boolean {
  return WORKFLOW_TOOL_SET.has(name)
}

/** Explicit family table (prefix heuristics are error-prone). */
export const WORKFLOW_TOOL_FAMILY: Readonly<Record<WorkflowToolName, WorkflowFamily>> = {
  create_design: 'design',
  update_design: 'design',
  create_plan: 'plan',
  update_plan: 'plan',
  create_progress: 'progress',
  update_progress: 'progress',
  record_progress_milestone: 'progress',
  validate_progress_document: 'progress',
  create_review: 'review',
  record_review_milestone: 'review',
  finalize_review: 'review',
  reopen_review: 'review',
  validate_review_document: 'review',
  compare_review_documents: 'review',
}

/**
 * Display family of a tool name.
 * @param name - raw tool name.
 * @returns the family, or null for non-workflow tools.
 */
export function workflowToolFamily(name: string): WorkflowFamily | null {
  return isWorkflowToolName(name) ? WORKFLOW_TOOL_FAMILY[name as WorkflowToolName] : null
}

/**
 * Locale key for a workflow tool's display label.
 * @param name - raw tool name.
 * @returns the typed `tool.<name>` dictionary key, or null for non-workflow tools.
 */
export function workflowToolLocaleKey(name: string): `tool.${WorkflowToolName}` | null {
  return isWorkflowToolName(name) ? (`tool.${name as WorkflowToolName}`) : null
}

/**
 * Host-side workflow marker projected into `tool/result.meta`.
 *
 * WIRING POINT (host half, not touched by P4-01): the workflows plugin should
 * attach `presentationMeta(args, value)` → `{ kind: 'graycode.workflow', ... }`
 * to the 12 tools so the durable log carries an explicit workflow signature.
 * The client folds results through `message.source.callId` regardless, so this
 * marker is an enhancement (document status, explicit correlation), not a
 * requirement — see `workflowNode/README.md`.
 */
export const WORKFLOW_META_KIND = 'graycode.workflow'

/** The `tool/result.meta` shape the client recognises as a workflow marker. */
export interface WorkflowResultMeta {
  readonly kind: typeof WORKFLOW_META_KIND
  /** Call correlation; falls back to `message.source.callId`. */
  readonly callId?: string
  readonly tool?: string
  readonly path?: string
  /** Document-level status ('draft' | 'active' | 'completed' | ...). */
  readonly status?: string
}

/**
 * Narrow `tool/result.meta` to the workflow marker.
 * @param value - raw `meta` payload (JSON-safe by the session contract).
 */
export function isWorkflowResultMeta(value: unknown): value is WorkflowResultMeta {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { kind?: unknown }).kind === WORKFLOW_META_KIND
  )
}
