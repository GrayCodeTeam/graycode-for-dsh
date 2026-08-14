/**
 * Migration workspace memory mapping (D-1/D-2) — target selection and
 * overrides JSON export (pure, unit-testable).
 *
 * The panel lets the user confirm or override each scope's target:
 * - `default` — keep the host suggestion (`suggestedTarget`);
 * - `global` — map the legacy scope to the global memory (`"global"`);
 * - `custom` — map to a user-provided absolute path.
 *
 * Only manually changed rows are exported: rows left on the default suggestion
 * never appear in the overrides JSON, which is the payload for the
 * `migration_apply` tool's `scopeOverridesFile` parameter.
 */

import type { ScopeMapRowView } from './viewModel.ts'

/** Value emitted for rows mapped to the global memory. */
export const SCOPE_MAP_GLOBAL_VALUE = 'global'

/** Per-row target selection (radio group state). */
export interface ScopeMapTargetSelection {
  readonly kind: 'default' | 'global' | 'custom'
  /** Custom absolute path; meaningful only when kind === 'custom'. */
  readonly customPath: string
}

/** Create the untouched per-row selection (keep the host suggestion). */
export function createDefaultScopeMapSelection(): ScopeMapTargetSelection {
  return { kind: 'default', customPath: '' }
}

/** Whether a path looks absolute (POSIX `/…` or Windows `C:\…`). */
export function isScopeMapAbsolutePath(value: string): boolean {
  if (value.length === 0) return false
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

/**
 * Normalize a user-typed custom path: trims whitespace and rejects empty or
 * non-absolute values (returns null) — a relative path cannot be a scope
 * override target.
 */
export function normalizeScopeMapCustomPath(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0 || !isScopeMapAbsolutePath(trimmed)) return null
  return trimmed
}

/**
 * Build the overrides JSON object from the rows and the current selections.
 * Only rows manually switched to `global` or to a valid absolute custom path
 * appear; default rows are omitted.
 */
export function buildScopeMapOverrides(
  rows: readonly ScopeMapRowView[],
  selections: Readonly<Record<string, ScopeMapTargetSelection>>,
): Record<string, string> {
  const overrides: Record<string, string> = {}
  for (const row of rows) {
    const selection = selections[row.hashDir] ?? createDefaultScopeMapSelection()
    if (selection.kind === 'global') {
      overrides[row.hashDir] = SCOPE_MAP_GLOBAL_VALUE
      continue
    }
    if (selection.kind === 'custom') {
      const path = normalizeScopeMapCustomPath(selection.customPath)
      if (path !== null) overrides[row.hashDir] = path
      continue
    }
    // default: keep the host suggestion — omitted from the export
  }
  return overrides
}

/** Format the overrides object as a copy-paste-ready JSON text block. */
export function formatScopeMapOverridesJson(overrides: Record<string, string>): string {
  return JSON.stringify(overrides, null, 2)
}

/** Whether any row was manually changed (drives the export hint). */
export function hasScopeMapChanges(overrides: Record<string, string>): boolean {
  return Object.keys(overrides).length > 0
}
