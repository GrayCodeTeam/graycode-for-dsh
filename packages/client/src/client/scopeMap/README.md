# Migration workspace memory mapping surface (D-1/D-2)

ScopeMapPanel — a visual confirmation panel for migrating legacy Gray Code
workspace-memory scopes. For each scope hash directory the host reports whether
it can be auto-mapped (scope.json found) or is unmapped, and the user confirms
or overrides the target. The panel then exports an overrides JSON that feeds the
`migration_apply` tool's `scopeOverridesFile` parameter.

## Data source

| Endpoint | Purpose | Host handler |
| --- | --- | --- |
| `migration/scopeMap` | Scope mapping table (`POST`, body `{ sourceDir }`) | migration domain in `packages/plugin` (registered under `ctx.grayRemote`) |

Response (structural mirror of the host contract, see `types.ts`):

```ts
{
  entries: ScopeMapEntry[]   // one per legacy scope hash directory
}
```

```ts
interface ScopeMapEntry {
  hashDir: string            // old workspace-memory scope hash dir (= legacyId)
  sourcePath?: string        // scope.json fsPath ?? cwd
  uri?: string               // scope.json uri (vscode-remote:// etc., may be absent)
  status: 'auto' | 'unmapped'// auto = automatically mappable; unmapped = scope.json missing/corrupt
  suggestedTarget: string | null // auto → sourcePath; unmapped → null
}
```

The client never trusts the wire: `wire.ts` narrows every entry and drops
malformed rows (unknown status, missing hashDir); empty `entries` is the
panel's empty state.

## Target selection & overrides export

Each table row has a radio group:

- **默认建议 (default)** — keep `suggestedTarget`;
- **全局记忆 (global)** — map to the global memory (`"global"`);
- **自定义路径 (custom)** — user-typed absolute path.

Only manually changed rows are exported (`overrides.ts`): rows left on the
default suggestion never appear in the JSON.

```json
{ "<hashDir>": "global" | "/abs/path" }
```

The text block is rendered in the panel for copy-paste; the user writes it to a
file and references it through `migration_apply`'s `scopeOverridesFile`
parameter (usage line shown in the panel). Custom paths that are empty or
relative are rejected (omitted from the export).

## Files

| File | Responsibility |
| --- | --- |
| `types.ts` | Wire contract mirrors + `ScopeMapDataSource` interface |
| `query.ts` | Wire args builder (`{ sourceDir }` body for `migration/scopeMap`) |
| `wire.ts` | Defensive envelope/entry readers (never trust the wire) |
| `errors.ts` | Stable `GRAY_*` code → locale key + retryable flag |
| `viewModel.ts` | Pure projection: entries → render-ready table rows |
| `overrides.ts` | Target selection + overrides JSON builder / formatter (default rows omitted, global → `"global"`, custom → absolute path) |
| `dataSource.ts` | `RemoteScopeMapDataSource` (contract consumer) + `MockScopeMapDataSource` (deterministic 2 auto + 1 unmapped fixture) |
| `locales.ts` | `graycode.scopeMap` namespace (zh/en balanced + ja placeholder, GAP-1) |
| `ScopeMapPanel.tsx` | Container: fetch/retry state machine, mapping table, export block |
| `README.md` | This file |

## Wiring

The main session (`packages/client/src/client/index.ts`) registers the locale
namespace and re-exports the panel; a mount recipe is not available in the rc.6
host (no management-view slot, no browser→host remote channel — GAPs recorded
per surface). Once a mount point exists:

```ts
// 1. Register the locale namespace (own ns) — done eagerly in index.ts.
ctx.locale.register(GRAYCODE_SCOPE_MAP_NS, graycodeScopeMapDictionaries)
ctx.locale.register(GRAYCODE_SCOPE_MAP_NS, 'ja', graycodeScopeMapJaPlaceholder)

// 2. Render the panel with t: ctx.locale.bind(GRAYCODE_SCOPE_MAP_NS).
//    Live host (once the browser→host remote channel exists):
<ScopeMapPanel t={t} dataSource="remote" sourceDir="/legacy/workspace" transport={(endpoint, args, signal) => /* ctx.grayRemote */} />
//    Unwired host / development:
<ScopeMapPanel t={t} dataSource="mock" />
```

## Client boundary rules

- **No host plugin imports**: wire shapes are mirrored in `types.ts` (bundle
  purity gate); `wire.ts` narrows everything defensively.
- **No I/O in components**: the panel only calls the injected data source;
  `dataSource === 'remote'` without a `transport` renders the replay-only hint
  and never fetches.
- **Stable codes only**: UI maps `GRAY_*` codes to locale keys, never English
  error text (PLAN_V2 §5.6).
- **Pure logic**: query/wire/errors/viewModel/overrides are side-effect free
  and unit-tested in the node environment (no jsdom, no testing-library).

## Known gaps

- GAP-client-1: rc.6 has no built-in browser→host remote channel (Typert is
  host-only), so the remote consumer ships with an injectable transport; the
  main session wires it once the channel exists (mock source for development).
- The export is copy-paste only (no file write from the browser bundle — client
  boundary rules); the user persists the JSON and points `migration_apply` at
  it through `scopeOverridesFile`.

## Testing

`packages/client/tests/scopeMapPanel.spec.ts` covers the pure logic only (node
environment, no React import): query building, wire readers (malformed input
defense), error hints, view-model row projection, mock source determinism (2
auto + 1 unmapped), overrides JSON generation (default rows omitted,
global/custom values, invalid custom paths rejected), the remote consumer with a
fake transport, and zh/en/ja locale alignment.
