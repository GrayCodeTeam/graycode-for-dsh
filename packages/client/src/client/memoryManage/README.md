# Memory management UI surface (P4-03)

Search / scope-filter / view-edit / forget-confirm surface over the GrayCode
memory store. Pure client-side module: all data flows through an injected
transport, the panel never performs I/O, and deletion/editing are explicit
user actions with confirmation.

## Data source (host Remote contract)

The surface consumes the `memory` Remote namespace
(`packages/plugin/src/remote/types.ts` §"memory（P4-03 memory 管理）",
implemented in `packages/plugin/src/memory/adapters/dsh/remote.ts`):

| Endpoint | Wire args | Result |
| --- | --- | --- |
| `memory/list` | `{ scope?, workspace?, search?, cursor?: string, limit? }` | `{ items: GrayMemoryEntryView[], total, nextCursor?, revision }` — substring search, id-desc order, opaque cursor plus full-store CAS revision |
| `memory/note` | `{ scope?, workspace?, text }` | created `GrayMemoryEntryView` — manual add, equivalent to the `memory_note` tool write path (single line + entryChars byte limit; write path creates a missing workspace store) |
| `memory/edit` | `{ scope?, workspace?, id, text, expectedRevision }` | updated `GrayMemoryEntryView` (id/date preserved) |
| `memory/forget` | `{ scope?, workspace?, blockId, expectedRevision?, confirm }` | `{ mode: 'single'\|'range'\|'summary', removed?/gone?/firstId? }` — raw deletion returns the list revision; `confirm: true` is required |
| `memory/configGet` | `{ scope?, workspace? }` | effective `MemoryConfig`; the panel uses its validated `entryChars` and safely falls back to the native settings snapshot |

Host registration: `memory/index.ts` calls
`ctx.grayRemote?.register(createMemoryRemoteHandlers(service))` — the
endpoints exist whenever the Gray Remote service is mounted. Every call is
also recorded into the host `ProjectionJournal` as `query:memory/*` events
(replayable channel; P4-03 reads live and does not replay them).

The client does **not** import the plugin package (bundle purity gate +
no dependency). `types.ts` carries a hand-synced STRUCTURAL contract snapshot
(asserted by tests) and defensive wire readers (`readMemoryListResult`, …).

## Client boundary rules (PLAN_V2 §5.6)

- **Replay-safe, no I/O in components**: every read/write goes through the
  injected `MemoryManageTransport` (`api.ts`). Without a transport the panel
  renders read-only with the `replayOnly` hint; a `wired: false` (mock)
  transport shows the `degraded` demo badge.
- **Delete/edit are explicit user actions**: forget runs the two-step confirm
  state machine (`logic.ts` — idle → confirming → submitting → done | error;
  the destructive call can only leave `confirming` via `confirmForget`);
  edit shows a live original→new diff and only saves on explicit Save.
- **List pagination**: the host `nextCursor` is opaque and returned verbatim.
  A `GRAY_CONFLICT` stale-snapshot cursor clears accumulated rows and safely
  reloads page 1 instead of mixing revisions.
- **Mutation CAS**: edit and raw delete return the list's opaque `revision`.
  The host compares it under the same store lock as the mutation; stale ids
  return `GRAY_CONFLICT` with `details.kind === 'memory-revision'`, then the
  panel refreshes instead of touching a row moved by log renumbering.
- **Error codes → hints**: stable `GRAY_*` codes map to locale keys
  (`mapMemoryFailure`); the UI never renders raw host error text.

## Files

| File | Role |
| --- | --- |
| `types.ts` | Contract snapshot (mirror of plugin remote types) + defensive wire readers |
| `api.ts` | Endpoint names, `MemoryManageTransport`, `createRemoteMemoryTransport(invoker)`, `createMockMemoryTransport(seed)` |
| `logic.ts` | Pure logic: query params, view models + highlight ranges, edit diff (token LCS), forget state machine, error-code mapping |
| `locales.ts` | `graycode.memoryManage` namespace (zh/en balanced + ja placeholder) |
| `MemoryManagePanel.tsx` | Panel orchestrator: search, scope switch, empty/error states, pagination footer |
| `MemoryEntryList.tsx` | Entry rows: content (+highlight), date, source marker, edit/forget actions |
| `MemoryEditOverlay.tsx` | Modal edit with live diff preview |
| `ForgetConfirm.tsx` | Inline two-step forget confirm bar (warning + confirm/cancel, error retry) |

## Wiring (mounted in the native settings section)

The main session (`packages/client/src/client/index.ts`) registers the
`graycode.memoryManage` locale namespace and injects its translate seat into
the Gray Code settings section. The「记忆 / Memory」category
(`packages/client/src/client/settings/pages.tsx` → `MemoryPage`) renders the
panel below the memory settings fields:

```ts
import { MemoryManagePanel } from './memoryManage/MemoryManagePanel.tsx'
import { createRemoteMemoryTransport } from './memoryManage/api.ts'

// The section's `/graycode` remote invoker is adapted once per page render:
const transport = createRemoteMemoryTransport((namespace, method, args, signal) =>
  remote(namespace, method, args, signal),
)

<MemoryManagePanel
  t={memoryT}
  transport={transport}
  workspace={defaultWorkspace}
  entryChars={config.memory.entryChars}
/>
```

The panel remains a mountable export for other hosts; an unwired host renders
it read-only (`transport` absent → replay hint; a mock transport → demo badge).
The add box loads the effective store `entryChars` through `memory/configGet`,
uses the native setting as a safe fallback, and blocks over-limit submissions
client-side with `GRAY_INVALID_INPUT` (the host remains authoritative).

## Host-side status & consumption recommendation

- The memory endpoints ARE implemented and registered on the host
  (`memory/adapters/dsh/remote.ts` + `memory/index.ts`).
- The missing piece is the browser→host channel: DSH rc.6 has no plugin-mountable
  Typert Remote client bridge (see `packages/plugin/src/remote/types.ts`
  header GAP note), so `ctx.grayRemote` is not reachable from the browser
  bundle yet. Until a bridge exists:
  - `createRemoteMemoryTransport` is the contract-driven consumption point
    that snaps onto any bridge shaped like `(namespace, method, args, signal)
    → GrayRemoteResult`;
  - an unwired/broken bridge returns `GRAY_ENDPOINT_NOT_FOUND`, which the
    panel maps to the `error.endpointNotFound` hint (read-only);
  - demos use `createMockMemoryTransport` (in-memory, `wired: false`, badge
    "demo data").
- Recommendation for the host task: expose the memory endpoints through a
  client-callable channel (e.g. a session tool bridge or the DSH-upgraded
  `@Remote` mount), reusing `createRemoteMemoryTransport` unchanged.

## Known limits

- Workspace scope requires a `workspace` root prop; without it the host
  returns `GRAY_INVALID_INPUT` (surfaced via the error banner).
- The surface only issues entry-level forget (`blockId = "<id>"`); the
  `summary`/`range` forget modes exist on the contract but are not exposed
  by this UI (the original web panel's arbitrary-set batch delete is not
  ported — the host forget contract deletes single ids or closed ranges).
- The mock transport has no summary tree (blockIds like `"16-31"` are
  rejected with `GRAY_INVALID_INPUT`).
- No debounced-server search debounce beyond the local 250 ms input timer.
