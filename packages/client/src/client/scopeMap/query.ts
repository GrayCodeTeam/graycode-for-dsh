/**
 * Migration workspace memory mapping (D-1/D-2) — query model (pure).
 *
 * The `migration/scopeMap` endpoint takes exactly one body field (`sourceDir`).
 * No pagination is needed: the whole mapping table is returned in one call.
 */

import type { ScopeMapWireParams } from './types.ts'

/**
 * Build the wire args for the `migration/scopeMap` endpoint: the body always
 * carries a trimmed `sourceDir` (honest request — the host validates it).
 */
export function buildScopeMapRequest(params: ScopeMapWireParams): Readonly<Record<string, unknown>> {
  return { sourceDir: params.sourceDir.trim() }
}
