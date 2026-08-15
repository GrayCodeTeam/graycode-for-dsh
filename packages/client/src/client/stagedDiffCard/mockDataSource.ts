/**
 * In-memory staged-diff data source (P4-06 mock mode).
 *
 * Implements `StagedDiffDataSource` against an in-memory entry list with the
 * host's observable semantics (mirrored, not imported):
 * - `list` sorts by updatedAt desc, id asc and pages by cursor (item id),
 *   like the host `stagedDiff/list` adapter (remote.ts + slicePage);
 * - `accept` runs pending/reviewing/needs-reapply → accepted → done with the
 *   revision CAS, and — like the host service — keeps an entry `accepted`
 *   when the disk write fails (`applyFailures`) instead of faking `done`;
 * - `reject` never writes; with `rejectConflict` it returns
 *   GRAY_STAGED_REJECT_CONFLICT (target file modified since staging);
 * - failures come back as `GrayRemoteFailure` envelopes with the same
 *   codes/causeCodes as the host `toGrayRemoteFailure` mapping.
 *
 * The mock is a development/test port: when the host Remote endpoints are
 * not wired into the client, this is what the card surface renders against.
 */
import {
  GRAY_REMOTE_ERROR_CODES,
  GRAY_STAGED_CAUSE_CODES,
  transitionStagedEntry,
  type GrayRemoteFailure,
  type GrayRemoteResult,
  type StagedDiffDecisionParams,
  type StagedDiffListParams,
  type StagedDiffListResult,
  type StagedEntry,
} from './contract.ts'
import type { StagedDiffDataSource } from './dataSource.ts'

/** Mock behaviour switches (all default to the happy path). */
export interface MockStagedDiffDataSourceOptions {
  /** Artificial latency per call (ms). */
  readonly latencyMs?: number
  /** All mutations fail with this envelope (e.g. simulate an unwired host). */
  readonly failMutationsWith?: GrayRemoteFailure
  /** `reject` returns GRAY_STAGED_REJECT_CONFLICT instead of rejecting. */
  readonly rejectConflict?: boolean
  /**
   * Number of `accept` disk-write failures to inject (each attempt consumes
   * one; 0 = never). While failing, the entry stays `accepted` (retryable)
   * — the mock never fakes `done`.
   */
  readonly applyFailures?: number
}

function makeFailure(
  code: string,
  message: string,
  extra: { causeCode?: string; entry?: StagedEntry } = {},
): GrayRemoteFailure {
  return {
    code,
    message,
    details: {
      ...(extra.causeCode !== undefined ? { causeCode: extra.causeCode } : {}),
      ...(extra.entry !== undefined ? { entry: { ...extra.entry } } : {}),
    },
  }
}

function revisionConflict(entry: StagedEntry, expectedRevision: number): GrayRemoteFailure {
  return makeFailure(
    GRAY_REMOTE_ERROR_CODES.CONFLICT,
    `staged entry "${entry.id}" changed since expectedRevision ${expectedRevision} (current ${entry.revision})`,
    { causeCode: GRAY_STAGED_CAUSE_CODES.REVISION_CONFLICT, entry },
  )
}

/**
 * Client-side mirror of the host `createStagedWorkspaceId` (service.ts):
 * deterministic and synchronous (the browser has no node `crypto.createHash`)
 * and stable within the mock. Entries seeded for a decision workspace must
 * use this id for the workspace-conflict guard to pass (3.8-M4).
 */
export function mockWorkspaceIdOf(cwd: string): string {
  const normalized = cwd.trim().replace(/\\/g, '/').replace(/\/+$/g, '')
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < normalized.length; i += 1) {
    const c = normalized.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0
  }
  const hex = `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
  return `ws_${hex}`
}

function workspaceConflict(entry: StagedEntry, workspace: string): GrayRemoteFailure {
  return makeFailure(
    GRAY_REMOTE_ERROR_CODES.CONFLICT,
    `staged entry "${entry.id}" belongs to workspace ${entry.workspaceId}, not ${mockWorkspaceIdOf(workspace)}`,
    { causeCode: GRAY_STAGED_CAUSE_CODES.WORKSPACE_CONFLICT, entry },
  )
}

/** Create an in-memory staged-diff data source seeded with entries. */
export function createMockStagedDiffDataSource(
  entries: readonly StagedEntry[],
  options: MockStagedDiffDataSourceOptions = {},
): StagedDiffDataSource {
  const state: StagedEntry[] = entries.map(entry => ({ ...entry }))
  const latency = options.latencyMs ?? 0
  let remainingApplyFailures = options.applyFailures ?? 0

  const delay = <T>(value: T): Promise<T> =>
    latency > 0 ? new Promise(resolve => setTimeout(() => resolve(value), latency)) : Promise.resolve(value)

  const findEntry = (entryId: string): StagedEntry | undefined =>
    state.find(entry => entry.id === entryId)

  const withEntry = (next: StagedEntry): void => {
    const index = state.findIndex(entry => entry.id === next.id)
    if (index >= 0) state[index] = { ...next }
  }

  return {
    async list(params: StagedDiffListParams): Promise<GrayRemoteResult<StagedDiffListResult>> {
      const filtered = state
        .filter(
          entry =>
            (params.workspaceId === undefined || entry.workspaceId === params.workspaceId)
            && (params.sessionId === undefined || entry.sessionId === params.sessionId)
            && (params.statuses === undefined || params.statuses.includes(entry.status)),
        )
        .map(entry => ({ ...entry }))
        .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const limit = Math.min(Math.max(params.limit ?? 20, 1), 100)
      let start = 0
      if (params.cursor !== undefined && params.cursor !== null) {
        const index = filtered.findIndex(entry => entry.id === params.cursor)
        if (index >= 0) start = index + 1
      }
      const page = filtered.slice(start, start + limit)
      const nextCursor =
        start + limit < filtered.length && page.length > 0 ? page[page.length - 1]!.id : undefined
      return delay({ ok: true, value: { items: page, total: filtered.length, nextCursor } })
    },

    async preview(entryId: string): Promise<GrayRemoteResult<StagedEntry>> {
      const entry = findEntry(entryId)
      if (entry === undefined) {
        return delay({
          ok: false,
          error: makeFailure(
            GRAY_REMOTE_ERROR_CODES.NOT_FOUND,
            `staged entry "${entryId}" not found`,
            { causeCode: GRAY_STAGED_CAUSE_CODES.ENTRY_NOT_FOUND },
          ),
        })
      }
      return delay({ ok: true, value: { ...entry } })
    },

    async accept(params: StagedDiffDecisionParams): Promise<GrayRemoteResult<StagedEntry>> {
      if (options.failMutationsWith !== undefined) {
        return delay({ ok: false, error: options.failMutationsWith })
      }
      const entry = findEntry(params.entryId)
      if (entry === undefined) {
        return delay({
          ok: false,
          error: makeFailure(
            GRAY_REMOTE_ERROR_CODES.NOT_FOUND,
            `staged entry "${params.entryId}" not found`,
            { causeCode: GRAY_STAGED_CAUSE_CODES.ENTRY_NOT_FOUND },
          ),
        })
      }
      // 3.8-M4: the host refuses decisions against a different workspace
      // (service.ts `assertWorkspace`) — mirror it before the CAS check.
      if (entry.workspaceId !== mockWorkspaceIdOf(params.workspace)) {
        return delay({ ok: false, error: workspaceConflict(entry, params.workspace) })
      }
      if (entry.revision !== params.expectedRevision) {
        return delay({ ok: false, error: revisionConflict(entry, params.expectedRevision) })
      }
      if (entry.status === 'done') return delay({ ok: true, value: { ...entry } })
      if (entry.status === 'rejected') {
        return delay({
          ok: false,
          error: makeFailure(
            GRAY_REMOTE_ERROR_CODES.CONFLICT,
            `cannot accept rejected entry "${params.entryId}"`,
            { causeCode: GRAY_STAGED_CAUSE_CODES.ILLEGAL_TRANSITION, entry },
          ),
        })
      }
      const now = Date.now()
      let current = entry
      if (current.status !== 'accepted') {
        current = transitionStagedEntry(current, 'accepted', now)
        withEntry(current)
      }
      if (options.applyFailures !== undefined && remainingApplyFailures > 0) {
        remainingApplyFailures -= 1
        return delay({
          ok: false,
          error: makeFailure(
            GRAY_REMOTE_ERROR_CODES.CONFLICT,
            `apply failed for staged entry "${params.entryId}"`,
            { causeCode: GRAY_STAGED_CAUSE_CODES.APPLY_FAILED, entry: current },
          ),
        })
      }
      const done = transitionStagedEntry(current, 'done', now)
      withEntry(done)
      return delay({ ok: true, value: { ...done } })
    },

    async reject(params: StagedDiffDecisionParams): Promise<GrayRemoteResult<StagedEntry>> {
      if (options.failMutationsWith !== undefined) {
        return delay({ ok: false, error: options.failMutationsWith })
      }
      const entry = findEntry(params.entryId)
      if (entry === undefined) {
        return delay({
          ok: false,
          error: makeFailure(
            GRAY_REMOTE_ERROR_CODES.NOT_FOUND,
            `staged entry "${params.entryId}" not found`,
            { causeCode: GRAY_STAGED_CAUSE_CODES.ENTRY_NOT_FOUND },
          ),
        })
      }
      // 3.8-M4: mirror the host `assertWorkspace` before the CAS check.
      if (entry.workspaceId !== mockWorkspaceIdOf(params.workspace)) {
        return delay({ ok: false, error: workspaceConflict(entry, params.workspace) })
      }
      if (entry.revision !== params.expectedRevision) {
        return delay({ ok: false, error: revisionConflict(entry, params.expectedRevision) })
      }
      if (entry.status === 'rejected') return delay({ ok: true, value: { ...entry } })
      if (entry.status === 'accepted') {
        // 4.8-L2: rejecting an accepted entry is an illegal transition —
        // return the envelope instead of letting `transitionStagedEntry`
        // throw a raw Error (the never-throw envelope contract).
        return delay({
          ok: false,
          error: makeFailure(
            GRAY_REMOTE_ERROR_CODES.CONFLICT,
            `cannot reject accepted entry "${params.entryId}"`,
            { causeCode: GRAY_STAGED_CAUSE_CODES.ILLEGAL_TRANSITION, entry },
          ),
        })
      }
      if (entry.status === 'done') {
        return delay({
          ok: false,
          error: makeFailure(
            GRAY_REMOTE_ERROR_CODES.CONFLICT,
            `cannot reject done entry "${params.entryId}"`,
            { causeCode: GRAY_STAGED_CAUSE_CODES.ILLEGAL_TRANSITION, entry },
          ),
        })
      }
      if (options.rejectConflict && entry.before !== null) {
        return delay({
          ok: false,
          error: makeFailure(
            GRAY_REMOTE_ERROR_CODES.CONFLICT,
            `target file "${entry.path}" was modified after staging`,
            { causeCode: GRAY_STAGED_CAUSE_CODES.REJECT_CONFLICT, entry },
          ),
        })
      }
      const rejected = transitionStagedEntry(entry, 'rejected', Date.now())
      withEntry(rejected)
      return delay({ ok: true, value: { ...rejected } })
    },
  }
}
