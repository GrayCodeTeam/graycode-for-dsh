/**
 * Migration workspace memory mapping (D-1/D-2) — data sources.
 *
 * Two implementations of {@link ScopeMapDataSource}:
 *
 * - {@link RemoteScopeMapDataSource} — the contract-driven consumer of the
 *   host Remote API (`migration/scopeMap`; handler registered under
 *   `ctx.grayRemote` by the migration domain). It consumes the
 *   `GrayRemoteResult` envelope through the pure readers in `wire.ts` and
 *   never trusts the wire. The actual browser→host transport is NOT wired in
 *   rc.6, so the class takes a transport function the main session supplies.
 *
 * - {@link MockScopeMapDataSource} — deterministic in-memory fixture (no I/O)
 *   for development, tests and unwired hosts: 2 auto + 1 unmapped sample
 *   entries.
 *
 * Neither implementation touches the workspace or the file system (browser
 * bundle boundary rules).
 */
import { buildScopeMapRequest } from './query.ts'
import type {
  ScopeMapDataSource,
  ScopeMapEntryLike,
  ScopeMapError,
  ScopeMapResultLike,
  ScopeMapWireParams,
} from './types.ts'
import { readScopeMapEnvelope, readScopeMapResult } from './wire.ts'

/** Host endpoint consumed by this surface (contract key). */
export type ScopeMapRemoteEndpoint = 'migration/scopeMap'

/**
 * Transport from the browser half to the host `ctx.grayRemote` dispatcher.
 * Returns the raw `GrayRemoteResult` envelope (unknown on the wire). Wired by
 * the main session — rc.6 has no built-in client→host remote channel.
 */
export type ScopeMapRemoteTransport = (
  endpoint: ScopeMapRemoteEndpoint,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
) => Promise<unknown>

function toScopeMapError(code: string, message: string): ScopeMapError {
  return { code, message, details: {} }
}

/**
 * Contract-driven consumer of the host `migration/scopeMap` endpoint.
 *
 * Maps wire params onto the endpoint args, reads the `GrayRemoteResult`
 * envelope defensively (`wire.ts`), and translates failures into thrown
 * {@link ScopeMapError} values (business errors never reject the transport
 * itself — only this wrapper's promise).
 */
export class RemoteScopeMapDataSource implements ScopeMapDataSource {
  constructor(private readonly transport: ScopeMapRemoteTransport) {}

  async scopeMap(params: ScopeMapWireParams, signal?: AbortSignal): Promise<ScopeMapResultLike> {
    const request = buildScopeMapRequest(params)
    const envelope = readScopeMapEnvelope(
      await this.transport('migration/scopeMap', request as Readonly<Record<string, unknown>>, signal),
    )
    if (!envelope.ok) throw envelope.error
    const result = readScopeMapResult(envelope.value)
    if (result === null) throw toScopeMapError('GRAY_INTERNAL', 'malformed migration/scopeMap result')
    return result
  }
}

/** Options for the deterministic mock source. */
export interface MockScopeMapDataSourceOptions {
  /** Fixture entries; defaults to {@link DEFAULT_SCOPE_MAP_FIXTURE}. */
  readonly entries?: readonly ScopeMapEntryLike[]
  /** Injected failure code (stable) to throw on `scopeMap`, for tests/dev. */
  readonly failure?: string
}

/**
 * Built-in sample data (2 auto + 1 unmapped rows) mirroring the host contract:
 * auto entries carry `suggestedTarget = sourcePath`; the unmapped entry has no
 * source and `suggestedTarget: null`.
 */
export const DEFAULT_SCOPE_MAP_FIXTURE: readonly ScopeMapEntryLike[] = [
  {
    hashDir: 'a1b2c3d4e5f6',
    sourcePath: '/home/dev/project-a/.graycode/memory/scope',
    uri: 'vscode-remote://ssh-remote+legacy-box/home/dev/project-a/.graycode/memory/scope.json',
    status: 'auto',
    suggestedTarget: '/home/dev/project-a/.graycode/memory/scope',
  },
  {
    hashDir: 'b2c3d4e5f607',
    sourcePath: '/workspaces/legacy-web/.graycode/memory/scope',
    status: 'auto',
    suggestedTarget: '/workspaces/legacy-web/.graycode/memory/scope',
  },
  {
    hashDir: 'c3d4e5f60718',
    status: 'unmapped',
    suggestedTarget: null,
  },
]

/**
 * Deterministic in-memory data source (no I/O). Returns a shallow copy of the
 * fixture entries; the failure option injects a stable code for tests/dev.
 */
export class MockScopeMapDataSource implements ScopeMapDataSource {
  private readonly entries: readonly ScopeMapEntryLike[]
  private readonly failure?: string

  constructor(options: MockScopeMapDataSourceOptions = {}) {
    this.entries = options.entries ?? DEFAULT_SCOPE_MAP_FIXTURE
    this.failure = options.failure
  }

  async scopeMap(_params: ScopeMapWireParams, _signal?: AbortSignal): Promise<ScopeMapResultLike> {
    if (this.failure !== undefined) {
      throw toScopeMapError(this.failure, `mock migration/scopeMap failure: ${this.failure}`)
    }
    return { entries: this.entries.map((entry) => ({ ...entry })) }
  }
}
