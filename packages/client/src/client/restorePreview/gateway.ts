/**
 * Restore preview gateway — contract-driven consumption point + mock mode (P4-05).
 *
 * PROBE STATUS (DSH rc.6): the client bundle cannot mount or invoke the
 * host's `/remote` endpoints directly — the Typert Remote extension surface
 * (`ctx.typert` / `ctx.typertGateway` / `ctx.remote.$mount`) exists on the
 * host but the required packages are not linked into this plugin and client
 * assembly is performed by DSH's official `dsh-api-remotes` build (see
 * `packages/plugin/src/remote/types.ts` header). The host-side endpoints
 * themselves (`checkpoints/previewRestore`, `checkpoints/restore`) ARE
 * implemented in `packages/plugin/src/checkpoints/adapters/dsh/remote.ts`.
 *
 * This module is therefore the client-side consumption contract: it defines
 * the structural invoke bridge the main session must wire (message bridge /
 * future Typert client API) and ships a scripted mock so the surface works
 * end-to-end without a host. `kind` tells the UI which mode is live.
 *
 * MOCK BINDING SEMANTICS (mirrors the host): the mock issues a deterministic
 * previewId per checkpoint and validates restore against it — a forged or
 * stale token is denied with GRAY_APPROVAL_REQUIRED, and a successful restore
 * consumes the token (retry after success is denied; retry after failure is
 * allowed, exactly like the host's `previewTokens.delete` on success).
 */
import {
  GRAY_RESTORE_REMOTE_CODES,
  RESTORE_CLIENT_ERROR_CODES,
  readPreviewOutcome,
  readRestoreResult,
  type RestoreRemoteEnvelope,
  type RestoreRemoteFailure,
  type RestorePreviewOutcomeWire,
  type RestoreResultWire,
} from './types.ts'

/** Endpoint namespace/methods of the host contract. */
export const RESTORE_REMOTE_NS = 'checkpoints'
export const RESTORE_PREVIEW_METHOD = 'previewRestore'
export const RESTORE_METHOD = 'restore'

/**
 * Structural invoke bridge (main-session wiring point): dispatches
 * `ns/method` with named args and resolves to a uniform envelope.
 */
export type RestoreRemoteInvoke = (
  namespace: string,
  method: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<RestoreRemoteEnvelope<unknown>>

/** Restore surface gateway. */
export interface RestoreGateway {
  readonly kind: 'remote' | 'mock'
  preview(params: RestorePreviewParams): Promise<RestoreRemoteEnvelope<RestorePreviewOutcomeWire>>
  restore(params: RestoreRestoreParams): Promise<RestoreRemoteEnvelope<RestoreResultWire>>
}

/** `checkpoints/previewRestore` args. */
export interface RestorePreviewParams extends Readonly<Record<string, unknown>> {
  readonly workspace?: string
  readonly checkpointId: string
  readonly deleteUntrackedFiles?: boolean
}

/** `checkpoints/restore` args (previewToken MUST echo the preview's token). */
export interface RestoreRestoreParams extends Readonly<Record<string, unknown>> {
  readonly workspace?: string
  readonly checkpointId: string
  readonly previewToken: string
  readonly deleteUntrackedFiles?: boolean
}

/**
 * Wrap a host invoke bridge into the typed restore gateway.
 * Responses are validated against the wire contract; an unreadable payload
 * maps to the client-local `GRAY_MALFORMED_RESPONSE` failure.
 */
export function createRestoreGateway(invoke: RestoreRemoteInvoke): RestoreGateway {
  return {
    kind: 'remote',
    async preview(params) {
      const envelope = await invoke(RESTORE_REMOTE_NS, RESTORE_PREVIEW_METHOD, params)
      if (!envelope.ok) return envelope
      const outcome = readPreviewOutcome(envelope.value)
      if (outcome === null) return malformed('previewRestore')
      return { ok: true, value: outcome }
    },
    async restore(params) {
      const envelope = await invoke(RESTORE_REMOTE_NS, RESTORE_METHOD, params)
      if (!envelope.ok) return envelope
      const result = readRestoreResult(envelope.value)
      if (result === null) return malformed('restore')
      return { ok: true, value: result }
    },
  }
}

function malformed(method: string): RestoreRemoteEnvelope<never> {
  return {
    ok: false,
    error: {
      code: RESTORE_CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
      message: `${RESTORE_REMOTE_NS}/${method} returned an unreadable payload`,
      details: {},
    },
  }
}

// ==================== mock mode ====================

/** Scripted mock behaviour. */
export interface MockRestoreGatewayOptions {
  /** Canned or computed preview outcome (previewToken is overridden by the mock binding). */
  preview?: RestorePreviewOutcomeWire | ((params: RestorePreviewParams) => RestorePreviewOutcomeWire)
  /** Canned or computed restore result (returned verbatim, including success:false partials). */
  restore?: RestoreResultWire | ((params: RestoreRestoreParams) => RestoreResultWire)
  /** Simulated preview envelope failure (takes precedence over `preview`). */
  previewError?: RestoreRemoteFailure
  /** Simulated restore envelope failure (takes precedence over `restore`). */
  restoreError?: RestoreRemoteFailure
  /** Artificial latency in ms (default 0). */
  delayMs?: number
}

const DEFAULT_PREVIEW: RestorePreviewOutcomeWire = {
  preview: {
    success: true,
    restored: 2,
    deleted: 1,
    deletedIfUnconfirmed: 0,
    skipped: 5,
    deletablePaths: ['src/legacy.ts'],
    untrackedPaths: ['notes/tmp.md', 'scratch/out.txt'],
    unbackedPaths: [],
    failures: [],
    missingBackupDirs: [],
  },
  previewToken: undefined,
  baselineDigest: 'mock-baseline-digest',
}

const DEFAULT_RESTORE: RestoreResultWire = {
  success: true,
  restored: 2,
  deleted: 1,
  skipped: 5,
  failures: [],
  unbackedPaths: [],
}

function mockPreviewId(checkpointId: string): string {
  return `mock-preview-${checkpointId}`
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
}

/**
 * Create the scripted mock gateway. It enforces the preview/restore binding:
 * restore without a preview, with a forged token, or after a successful
 * restore → GRAY_APPROVAL_REQUIRED. Nothing is written anywhere.
 */
export function createMockRestoreGateway(options: MockRestoreGatewayOptions = {}): RestoreGateway {
  const delayMs = options.delayMs ?? 0
  let issuedToken: string | null = null
  let consumed = false

  return {
    kind: 'mock',
    async preview(params) {
      await sleep(delayMs)
      if (options.previewError !== undefined) return { ok: false, error: options.previewError }
      const base = typeof options.preview === 'function'
        ? options.preview(params)
        : options.preview ?? DEFAULT_PREVIEW
      issuedToken = mockPreviewId(params.checkpointId)
      consumed = false
      return {
        ok: true,
        value: { ...base, previewToken: issuedToken },
      }
    },
    async restore(params) {
      await sleep(delayMs)
      const expected = mockPreviewId(params.checkpointId)
      if (issuedToken === null || params.previewToken !== expected || consumed) {
        return {
          ok: false,
          error: {
            code: GRAY_RESTORE_REMOTE_CODES.APPROVAL_REQUIRED,
            message: 'mock: invalid or missing previewToken (run preview first and pass its token unchanged)',
            details: {},
          },
        }
      }
      if (options.restoreError !== undefined) return { ok: false, error: options.restoreError }
      const result = typeof options.restore === 'function'
        ? options.restore(params)
        : options.restore ?? DEFAULT_RESTORE
      if (result.success) consumed = true // host semantics: token consumed on success only
      return { ok: true, value: result }
    },
  }
}
