/**
 * GrayCode - prompt template rendering (V2 §6.6.1 / §P3F)
 *
 * `{{$MODULE}}` placeholder substitution and template normalization, extracted
 * from gray-code-plugin's PromptManager. Pure TS, no host imports.
 *
 * Placeholder module catalog:
 * - `resolved` modules (ENVIRONMENT, WORKSPACE_FILES, TODO_LIST, MEMORY)
 *   have DSH-host semantics: the injection adapter may supply values for them
 *   (e.g. ENVIRONMENT from the agent session header). When no value is
 *   provided the renderer substitutes a deterministic "not available in DSH"
 *   notice, so a raw `{{$MODULE}}` reference never reaches the final product.
 * - TOOLS is deferred to the DSH render-time variable `graycode_tools` (the
 *   `graycode_` prefix guards against collisions with future official
 *   variables): the system-prompt/assemble waterfall provides it
 *   unconditionally, so `{{$TOOLS}}` without an explicit value renders as
 *   `{{graycode_tools}}` instead of a notice.
 * - `deprecated` modules (PINNED_FILES, OPEN_TABS, ACTIVE_EDITOR, DIAGNOSTICS,
 *   MCP_TOOLS, CONTEXT_BADGE_FORMAT and other editor-only modules) have no
 *   DSH host equivalent (ADR-0002 §3): the renderer always substitutes a
 *   deterministic notice so templates never leak raw editor-specific tokens to
 *   the model.
 *
 * DSH-safety invariant (B3-P2): the rendered product must not contain any
 * `{{...}}` group that the DSH system-prompt assembler would reject. The
 * assembler scans every section text and only accepts `{{name}}` where name
 * matches /^[a-z][a-z0-9_]*$/ and the variable is registered
 * (dsh-system-prompt lib/index.js interpolate()); anything else throws
 * `malformed prompt variable reference` at assembly time and aborts the turn.
 * The renderer therefore substitutes a deterministic notice for every
 * reference it cannot resolve — deprecated modules, resolved modules without
 * a supplied value (TOOLS is the one exception: it defers to the DSH
 * render-time variable `graycode_tools`), unknown references with
 * non-lowercase names — and preserves only DSH-safe lowercase variable
 * references (e.g. `{{graycode_prompt_mode}}`) for the DSH layer to resolve.
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
  { module: 'TOOLS', status: 'resolved' },
  { module: 'TODO_LIST', status: 'resolved' },
  { module: 'MEMORY', status: 'resolved' },
  // Editor / host-only modules without a DSH equivalent (V2 §6.4, ADR-0002 §3).
  { module: 'PINNED_FILES', status: 'deprecated' },
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
 * Deterministic substitution for deprecated editor-only modules. `module` is
 * the module name (e.g. `OPEN_TABS`) — deliberately NOT the raw `{{$...}}`
 * token: embedding the braces would let the uppercase reference survive into
 * the rendered product and trip the DSH assembler's strict variable-name
 * validation (B3-P2 root cause). The notice stays byte-stable in golden tests.
 */
export function deprecatedPlaceholderText(module: string): string {
  const canonical = module.trim().toUpperCase()
  return `[deprecated placeholder ${canonical}: editor-specific module with no DSH host equivalent; remove it from the template]`
}

/**
 * Deterministic substitution for references the renderer cannot resolve to a
 * value: resolved DSH-host modules with no supplied value (e.g. TOOLS before
 * the injection layer provides it) and unknown references that are not
 * DSH-safe lowercase variables. Like {@link deprecatedPlaceholderText} the
 * notice never contains `{{...}}`, keeping the final product assembly-safe.
 */
export function unavailablePlaceholderText(module: string): string {
  const canonical = module.trim().toUpperCase()
  return `[placeholder ${canonical}: not available in DSH; remove it from the template]`
}

/**
 * Post-render cleanup mirroring the old Gray pipeline
 * (contextSections.cleanupEmptyLines, applied after every template render):
 * runs of 3+ newlines collapse to `\n\n`, and leading/trailing whitespace is
 * trimmed. Byte-identical to the old implementation (contextSections.ts:43-47).
 */
export function cleanupEmptyLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/** The DSH assembler's variable-name rule (dsh-system-prompt lib/index.js). */
const DSH_SAFE_VARIABLE = /^[a-z][a-z0-9_]*$/

/** Any complete `{{...}}` group; the DSH assembler scans for exactly these. */
const GROUP_PATTERN = /\{\{[^{}]*\}\}/g

/**
 * Parse the inner text of a `{{...}}` group into a placeholder module name
 * (`$` and surrounding whitespace tolerated, case preserved). Returns
 * undefined when the group is not a well-formed module reference
 * (e.g. `{{a-b}}`, `{{}}`, `{{$}}`).
 */
function parseModuleName(inner: string): string | undefined {
  const name = inner.replace(/^\s*\$?\s*/, '')
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : undefined
}

/**
 * Substitute `{{$MODULE}}` placeholders.
 *
 * Every complete `{{...}}` group in the template is handled:
 * - Deprecated modules are always replaced by {@link deprecatedPlaceholderText}.
 * - Resolved modules are replaced by `values[canonical]` when present;
 *   otherwise by {@link unavailablePlaceholderText} (never left verbatim).
 * - Unknown references that are DSH-safe lowercase variables (e.g.
 *   `{{graycode_prompt_mode}}`) are preserved for the DSH assembler to
 *   resolve; any other unknown reference is replaced by
 *   {@link unavailablePlaceholderText} so the final product contains no
 *   reference the DSH assembler would reject.
 * - Substituted values are never re-scanned (byte-verbatim, matching DSH's
 *   own "substituted values are not scanned again" behavior).
 * - The rendered text then goes through {@link cleanupEmptyLines} (old
 *   `contextSections.ts:43-47` parity): 3+ consecutive newlines collapse to
 *   `\n\n` and the result is trimmed.
 *
 * @param template - source template text.
 * @param values - module name → rendered text map (keys are canonical names).
 */
export function renderPromptTemplate(
  template: string,
  values: Readonly<Record<PlaceholderModuleName, string>> = {},
): string {
  const rendered = template.replace(GROUP_PATTERN, raw => {
    const inner = raw.slice(2, -2).trim()
    const name = parseModuleName(inner)
    if (name === undefined) {
      // Not a module-shaped reference (e.g. `{{a-b}}`, `{{}}`): neutralize.
      return unavailablePlaceholderText(inner)
    }
    const canonical = name.toUpperCase()
    const status = placeholderModuleStatus(canonical)
    if (status === 'deprecated') return deprecatedPlaceholderText(canonical)
    if (status === 'resolved') {
      const value = values[canonical]
      if (value !== undefined) return value
      // TOOLS 模块（P3F v2，entries 唯一组装）：无显式值时延迟给 DSH 渲染期变量
      // `{{graycode_tools}}`（带 graycode_ 前缀，防与未来官方变量冲突）——
      // system-prompt/assemble 瀑布无条件把 assembly.tools 的清单文本写入
      // variables.graycode_tools（见 promptInjector.ts overrideHostPrompt 接线），
      // 因此 `{{graycode_tools}}` 一定可解析；模板里写 `{{$TOOLS}}` 即获得宿主
      // 工具清单（覆盖 DSH 自带 tool-guidance section 后，工具说明改由本模板控制）。
      // 其余 resolved 模块（ENVIRONMENT/TODO_LIST/MEMORY）无值时仍用 deterministic 提示。
      if (canonical === 'TOOLS') return '{{graycode_tools}}'
      return unavailablePlaceholderText(canonical)
    }
    // Unknown module: keep only DSH-safe lowercase variable references
    // (e.g. `{{graycode_prompt_mode}}`); anything else would fail the DSH
    // assembler's strict name validation.
    if (DSH_SAFE_VARIABLE.test(inner)) return `{{${inner}}}`
    return unavailablePlaceholderText(inner)
  })
  // Old Gray applied cleanupEmptyLines after every render (PromptManager.ts:387/713);
  // keep the same post-processing so templates render byte-compatibly.
  return cleanupEmptyLines(rendered)
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
