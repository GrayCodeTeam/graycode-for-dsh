/**
 * Migration workspace memory mapping (D-1/D-2) — view-model construction
 * (pure, unit-testable).
 *
 * Projects the `migration/scopeMap` result into render-ready table rows for
 * the panel. Host data stays authoritative: no re-sorting, no filtering.
 */

import type { ScopeMapResultLike } from './types.ts'

/** Render-ready row of the mapping table. */
export interface ScopeMapRowView {
  /** Old workspace-memory scope hash directory (= legacyId). */
  readonly hashDir: string
  /** fsPath of the scope.json; null when the host sent none. */
  readonly sourcePath: string | null
  /** vscode-remote:// etc. uri of scope.json; null when the host sent none. */
  readonly uri: string | null
  /** auto = automatically mappable; unmapped = scope.json missing/corrupt. */
  readonly status: 'auto' | 'unmapped'
  /** auto → sourcePath; unmapped → null. */
  readonly suggestedTarget: string | null
}

/** Build the table rows view from the full result (host order preserved). */
export function buildScopeMapRows(result: ScopeMapResultLike): readonly ScopeMapRowView[] {
  return result.entries.map((entry) => ({
    hashDir: entry.hashDir,
    sourcePath: entry.sourcePath ?? null,
    uri: entry.uri ?? null,
    status: entry.status,
    suggestedTarget: entry.suggestedTarget,
  }))
}
