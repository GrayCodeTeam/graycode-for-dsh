/**
 * Migration workspace memory mapping (D-1/D-2) — wire contract types
 * (structural mirrors).
 *
 * The host `migration/scopeMap` endpoint returns a
 * `GrayRemoteResult<{ entries: ScopeMapEntry[] }>` envelope (see the migration
 * domain in packages/plugin). This package must NOT import host plugin code
 * (bundle purity gate), so the wire shapes are mirrored here as `*Like`
 * structures and narrowed by the pure readers in `wire.ts` — the client never
 * trusts the wire.
 *
 * The mapping table is inherently bounded (one entry per legacy scope hash
 * directory), so this surface needs no cursor pagination.
 */

/** One scope mapping entry (host `ScopeMapEntry` mirror). */
export interface ScopeMapEntryLike {
  /** Old workspace-memory scope hash directory (= legacyId). */
  readonly hashDir: string
  /** fsPath of the scope.json (`?? cwd`); may be absent. */
  readonly sourcePath?: string
  /** vscode-remote:// etc. uri of scope.json; may be absent. */
  readonly uri?: string
  /** auto = automatically mappable; unmapped = scope.json missing/corrupt. */
  readonly status: 'auto' | 'unmapped'
  /** auto → sourcePath; unmapped → null. */
  readonly suggestedTarget: string | null
}

/** Full result payload (host `{ entries: ScopeMapEntry[] }` mirror). */
export interface ScopeMapResultLike {
  readonly entries: readonly ScopeMapEntryLike[]
}

/** Wire args for the `migration/scopeMap` endpoint. */
export interface ScopeMapWireParams {
  /** Legacy source directory the migration reads scope hashes from. */
  readonly sourceDir: string
}

/** Stable error view shared by this surface (mirror of `GrayRemoteFailure`). */
export interface ScopeMapError {
  readonly code: string
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
}

/**
 * Data source consumed by the panel: one `scopeMap` call. Business failures
 * surface as rejected promises carrying a stable {@link ScopeMapError} (never
 * raw internals).
 */
export interface ScopeMapDataSource {
  scopeMap(params: ScopeMapWireParams, signal?: AbortSignal): Promise<ScopeMapResultLike>
}
