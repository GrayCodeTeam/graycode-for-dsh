/**
 * GrayCode - prompt template rendering (V2 §6.6.1 / §P3F)
 *
 * `{{$MODULE}}` placeholder substitution and template normalization, extracted
 * from gray-code-plugin's PromptManager. Pure TS, no host imports.
 *
 * Placeholder module catalog:
 * - `resolved` modules (ENVIRONMENT, WORKSPACE_FILES, PINNED_FILES, TOOLS,
 *   TODO_LIST, MEMORY) have DSH-host semantics: the injection adapter may
 *   supply values for them (e.g. ENVIRONMENT from the agent session header).
 *   When no value is provided the placeholder is preserved verbatim.
 * - `deprecated` modules (OPEN_TABS, ACTIVE_EDITOR, DIAGNOSTICS and other
 *   editor-only modules) have no DSH host equivalent (ADR-0002 §3): the
 *   renderer always substitutes a deterministic notice so templates never
 *   leak raw editor-specific tokens to the model.
 */

/** Canonical (uppercase, `$`/braces stripped) placeholder module name. */
export type PlaceholderModuleName = string

export type PlaceholderModuleStatus = 'resolved' | 'deprecated'

export interface PlaceholderModuleInfo {
  module: PlaceholderModuleName
  status: PlaceholderModuleStatus
}

/**
 * Placeholder module directory, mirroring gray-code-plugin's module list.
 * Editor-only modules are marked DEPRECATED; the rest keep host semantics.
 */
export const PLACEHOLDER_MODULES: readonly PlaceholderModuleInfo[] = [
  // DSH-host-meaningful modules: values may be supplied by the injection layer.
  { module: 'ENVIRONMENT', status: 'resolved' },
  { module: 'WORKSPACE_FILES', status: 'resolved' },
  { module: 'PINNED_FILES', status: 'resolved' },
  { module: 'TOOLS', status: 'resolved' },
  { module: 'TODO_LIST', status: 'resolved' },
  { module: 'MEMORY', status: 'resolved' },
  // Editor / host-only modules without a DSH equivalent (V2 §6.4, ADR-0002 §3).
  { module: 'MCP_TOOLS', status: 'deprecated' },
  { module: 'CONTEXT_BADGE_FORMAT', status: 'deprecated' },
  { module: 'OPEN_TABS', status: 'deprecated' },
  { module: 'ACTIVE_EDITOR', status: 'deprecated' },
  { module: 'DIAGNOSTICS', status: 'deprecated' },
]

/** Status of a module name (case/whitespace insensitive); undefined = unknown. */
export function placeholderModuleStatus(module: string): PlaceholderModuleStatus | undefined {
  const canonical = module.trim().toUpperCase()
  return PLACEHOLDER_MODULES.find(m => m.module === canonical)?.status
}

/**
 * Deterministic substitution for deprecated editor-only modules. `token` is
 * the exact placeholder text from the source (e.g. `{{$OPEN_TABS}}`) so the
 * notice stays byte-stable in golden tests.
 */
export function deprecatedPlaceholderText(token: string): string {
  return `[deprecated placeholder ${token}: editor-specific module with no DSH host equivalent; remove it from the template]`
}

/**
 * Match `{{$MODULE}}`-style placeholders, robust to case, whitespace and a
 * missing `$` (`{{ $environment }}`, `{{ENVIRONMENT}}`, `{{  $  MODULE  }}`).
 */
const PLACEHOLDER_PATTERN = /\{\{\s*\$?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/**
 * Substitute `{{$MODULE}}` placeholders.
 *
 * - Deprecated modules are always replaced by {@link deprecatedPlaceholderText}.
 * - Resolved modules are replaced when `values` has an entry (key = canonical
 *   uppercase module name); otherwise the placeholder is preserved verbatim.
 * - Unknown modules are preserved verbatim (decision: safer for custom
 *   templates written against future module names than failing the render).
 *
 * @param template - source template text.
 * @param values - module name → rendered text map (keys are canonical names).
 */
export function renderPromptTemplate(
  template: string,
  values: Readonly<Record<PlaceholderModuleName, string>> = {},
): string {
  return template.replace(PLACEHOLDER_PATTERN, (raw, name: string) => {
    const canonical = name.trim().toUpperCase()
    if (placeholderModuleStatus(canonical) === 'deprecated') return deprecatedPlaceholderText(raw)
    const value = values[canonical]
    return value !== undefined ? value : raw
  })
}

/**
 * Template normalization applied by the settings service on write:
 * CRLF/LF line endings to LF, strip trailing spaces per line, drop leading
 * and trailing blank lines. Deterministic and idempotent.
 */
export function normalizeTemplate(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+/, '')
    .replace(/\n+$/g, '')
}
