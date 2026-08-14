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
| `memory/list` | `{ scope?, workspace?, search?, cursor?, limit? }` | `{ items: GrayMemoryEntryView[], total, nextCursor? }` — substring search (case-insensitive), id-desc order, cursor pagination |
| `memory/edit` | `{ scope?, workspace?, id, text }` | updated `GrayMemoryEntryView` (id/date preserved) |
| `memory/forget` | `{ scope?, workspace?, blockId, confirm }` | `{ mode: 'single'\|'range'\|'summary', removed?/gone?/firstId? }` — `confirm: true` required, else `GRAY_APPROVAL_REQUIRED` |

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
- **List pagination**: cursor-based via the host `nextCursor` ("load more"
  appends the next page; `total` reflects the filtered count).
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

## Wiring (main session — NOT done by P4-03; `index.ts` is off-limits)

```ts
import { MemoryManagePanel } from './memoryManage/MemoryManagePanel.tsx'
import { createRemoteMemoryTransport, createMockMemoryTransport } from './memoryManage/api.ts'
import {
  GRAYCODE_MEMORY_MANAGE_NS,
  graycodeMemoryManageDictionaries,
  graycodeMemoryManageJaPlaceholder,
} from './memoryManage/locales.ts'

// 1. Register the locale namespace (own ns; kept separate from `graycode`).
ctx.locale.register(GRAYCODE_MEMORY_MANAGE_NS, graycodeMemoryManageDictionaries)
ctx.locale.register(GRAYCODE_MEMORY_MANAGE_NS, 'ja', graycodeMemoryManageJaPlaceholder)

// 2. Build the transport.
//    Real host channel (single consumption point): wrap the host
//    GrayRemoteService.invoke once a browser→host bridge exists.
const transport = createRemoteMemoryTransport(
  (namespace, method, args, signal) => ctx.grayRemote.invoke(namespace, method, args, signal),
)
//    Demo / unwired host: in-memory mock (no I/O, wired: false).
// const transport = createMockMemoryTransport([{ id: 1, date: '2025-01-01', text: '…' }])

// 3. Mount the panel wherever the shell hosts the memory surface, with
//    `t: ctx.locale.bind(GRAYCODE_MEMORY_MANAGE_NS)` and the transport.
//    Pass `workspace` (workspace root) when scope = 'workspace' is offered.
```

## Host-side status & consumption recommendation

- The three memory endpoints ARE implemented and registered on the host
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
  by this UI.
- The mock transport has no summary tree (blockIds like `"16-31"` are
  rejected with `GRAY_INVALID_INPUT`).
- No debounced-server search debounce beyond the local 250 ms input timer.
