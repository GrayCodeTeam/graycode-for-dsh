# Checkpoint list (P4-04)

Renders the workspace checkpoint archive as a paginated list: checkpoint id,
created time, snapshot size (`backupBytes`), file count, parent-chain label,
verify badge (read-only), and an expandable detail row (parent chain, phase,
tool, conversation, excluded count, content hash).

## Data source (host contract — probe conclusion)

| Question | Answer | Evidence |
| --- | --- | --- |
| Host `checkpoints/*` Remote endpoints? | **YES** — list/create/verify/previewRestore/restore/delete/gc | `packages/plugin/src/checkpoints/adapters/dsh/remote.ts` (`createCheckpointsRemoteHandlers`), registered in `packages/plugin/src/checkpoints/index.ts` (`ctx.grayRemote?.register(...)`); dispatch service assembled in `packages/plugin/src/index.ts` (`new GrayRemoteService(ctx, { journalPath })` → `ctx.grayRemote`) |
| Result envelope? | `GrayRemoteResult` — `{ ok: true, value } \| { ok: false, error: { code, message, details } }`; business errors **never reject**; unknown endpoint → `GRAY_ENDPOINT_NOT_FOUND` | `packages/plugin/src/remote/types.ts` / `service.ts` |
| List item shape? | `GrayCheckpointItemView = CheckpointSummary & { verifyState: 'unknown' }` — id/conversationId/messageIndex/toolName/phase/timestamp/type/baseCheckpointId/contentHash/fileCount/backupBytes/excludedCount/manifestVersion; P4-06 adds `origin: 'auto' \| 'manual'` (absent on old data → treated as 'manual') | `packages/plugin/src/remote/types.ts` |
| Verify state? | rc.6 does **not** persist verify results → list is always `'unknown'`; UI may call `checkpoints/verify` on demand (`CheckpointVerifyResult`: ok/issues/checkedFiles/chainLength/filesRevisionPaired) | `adapters/dsh/remote.ts` + `checkpoints/service.ts` |
| Pagination? | `cursor` = id of the last listed item; `limit` clamped to 1..100 (default 20); `nextCursor` absent when no more pages | `remote/types.ts` (`GRAY_PAGE_LIMIT_*`) + `remote/validate.ts` (`normalizeLimit`/`slicePage`) |
| Error codes? | Stable GRAY_* machine codes only (INVALID_INPUT/CONFLICT/APPROVAL_REQUIRED/CANCELLED/STORAGE_CORRUPT/NOT_FOUND/ENDPOINT_NOT_FOUND/INTERNAL) | `remote/types.ts` / `errors.ts` |
| Client channel to `ctx.grayRemote`? | **YES** — the trusted `/graycode` Connection bridge exposes `remote.invoke` | `settings/remote.ts` + host `settings/rpc.ts` |

This surface remains **contract-driven**: it consumes the contract through the
injected `CheckpointListDataSource` port
(`dataSource.ts`) with one method per host endpoint, and never imports the
plugin package (bundle purity gate). All wire shapes are re-declared
structurally and narrowed defensively (`read*` helpers in `types.ts`), so a
the current `/graycode` bridge or a future Typert client can feed unchanged.

## Files

| File | Role |
| --- | --- |
| `types.ts` | Structural wire types, view models, store state, `CheckpointListDataSource` port, defensive `read*` wire readers |
| `query.ts` | Cursor pagination helpers: limit normalization (mirrors host), query building, `hasNextPage`, page merge (id dedupe) |
| `viewModel.ts` | Item view model (id/time/size/files/phase/type/verify), parent-chain resolution (`baseCheckpointId` walk, bounded), byte/time/id formatters |
| `errors.ts` | GRAY_* code → locale-keyed hint (kind + retryable), cancellation detection |
| `store.ts` | `createCheckpointListStore` — cursor pagination state machine over the injected data source |
| `dataSource.ts` | The consumer port plus `createMockCheckpointListDataSource` (deterministic, I/O-free mock) |
| `configModel.ts` | Checkpoint config section pure model (P4-06): values shape, defaults, normalization, message-slot toggles, tool-list parse/validate, path commits |
| `CheckpointConfigSection.tsx` | Checkpoint config field group (P4-06): master/auto/model-tool switches, message-trigger slots, before/after tool textareas |
| `CheckpointList.tsx` | List panel: load-more footer, empty/loading/error states, mock notice, total counter |
| `CheckpointListItem.tsx` | Item row (type chip, origin badge, id, time, size, files, parent label, verify badge) + expandable details (chain, phase, tool, conversation, hash) |
| `CheckpointVerifyBadge.tsx` | Read-only verify badge (unknown/ok/failed tones) |
| `locales.ts` | `graycode.checkpointList` namespace (zh/en balanced + ja placeholder) |

## Behaviour

### Pagination store (store.ts)

- `loadFirstPage()` fetches page 1 (also the retry entry point);
  `loadNextPage()` appends one page via `nextCursor` and is a no-op at the
  end; `reload()` clears and restarts. **One page per request — never a full
  fetch**; concurrent loads are ignored while one is in flight.
- Pages merge by id (`mergeCheckpointItems`): an overlapping/retried page
  collapses to the first occurrence, so entries never duplicate.
- `GRAY_CANCELLED` is a silent stop: state returns to the previous snapshot
  with no error surface (replay/abort friendly). Every other failure maps to
  a locale hint and keeps the previously loaded entries so a retry resumes.
- Transport throws (the port contract says business errors never throw) are
  folded into the `GRAY_INTERNAL` hint.

### Parent chains (viewModel.ts)

- An item's parent is `baseCheckpointId` (absent = full-snapshot root).
- Chains resolve against the **loaded pages only**; a parent id that is not
  loaded is marked `beyondWindow` and the resolution is `truncated` — loading
  more (older) pages may extend it. Rendering is bounded by
  `CHECKPOINT_CHAIN_MAX_LINKS` (8) and cycle-guarded; the host guards cycles
  at the domain layer, the client only bounds display.

### Verify (read-only)

The badge renders `verifyState` as read-only display (rc.6: always 'unknown').
The optional `onVerify` callback on the list/item is declarative — with no
callback (replay/unwired host) the button renders disabled with the
`verify.replayOnly` hint. The client never initiates verification itself.

### Origin badge (P4-06)

An item with `origin: 'auto'` (created by the automatic checkpoint pipeline)
renders a small badge next to the type chip (`origin.auto` label). 'manual'
and missing legacy values render no badge — the wire reader normalizes both
to `'manual'`, so old list data is untouched.

### Checkpoint config section (P4-06)

`CheckpointConfigSection` + `configModel` render the new checkpoints Config
fields (enabled / autoCheckpoint / modelToolsEnabled / messageCheckpoint
message slots / beforeTools / afterTools). The section is stateless: it
commits absolute paths (`['checkpoints', ...]`) through an injected
`onChange`, i.e. the same contract as the settings `store.set` channel — the
settings page (`CheckpointManager`) wires it with the host config snapshot;
without a save channel it degrades to an honest local-draft mode with a
notice. Copy lives in its own `graycode.checkpointConfig` namespace so the
settings half (which owns `settings.graycode`) needs no changes.

### Error mapping (errors.ts)

| Code | Hint kind | Retryable |
| --- | --- | --- |
| `GRAY_INVALID_INPUT` | invalidInput | no |
| `GRAY_CONFLICT` | conflict | yes |
| `GRAY_APPROVAL_REQUIRED` | approvalRequired | no |
| `GRAY_CANCELLED` | cancelled (silent stop in the store) | yes |
| `GRAY_STORAGE_CORRUPT` | storageCorrupt | no |
| `GRAY_NOT_FOUND` | notFound | no |
| `GRAY_ENDPOINT_NOT_FOUND` | endpointNotFound | no |
| `GRAY_INTERNAL` | internal | no |
| anything else | unknown | no |

## Wiring (main session — NOT done by P4-04; `index.ts` is off-limits)

```ts
import {
  GRAYCODE_CHECKPOINT_LIST_NS,
  graycodeCheckpointListDictionaries,
  graycodeCheckpointListJaPlaceholder,
} from './checkpointList/locales.ts'
import { createCheckpointListStore } from './checkpointList/store.ts'
import { createMockCheckpointListDataSource } from './checkpointList/dataSource.ts'

// 1. Register the locale namespace (own ns; kept separate from `graycode`).
ctx.locale.register(GRAYCODE_CHECKPOINT_LIST_NS, graycodeCheckpointListDictionaries)
ctx.locale.register(GRAYCODE_CHECKPOINT_LIST_NS, 'ja', graycodeCheckpointListJaPlaceholder)

// 2. Data source. Until a host bridge exists (see below), use the mock —
//    deterministic, I/O-free, renders the "mock data source" notice.
const dataSource = createMockCheckpointListDataSource({ total: 37 })

// 3. Store + render. workspaceId = workspace root (absolute path — the host
//    `checkpoints/list` `workspace` parameter).
const store = createCheckpointListStore({ workspaceId, dataSource, pageSize: 20 })
void store.loadFirstPage()
// subscribe to store.state (revision) and render:
//   <CheckpointList t={ctx.locale.bind(GRAYCODE_CHECKPOINT_LIST_NS)}
//     state={store.state}
//     onLoadNextPage={() => void store.loadNextPage()}
//     onRetry={() => void (store.state.entries.length === 0 ? store.loadFirstPage() : store.loadNextPage())}
//     onToggleExpand={(id) => store.toggleExpand(id)} />
```

### Host bridge (recommended direction)

The browser half needs a channel to the host's `ctx.grayRemote`. Two options
to explore with the main session (both keep this surface unchanged):

1. **Projection replay** — the host already records every remote call into the
   ProjectionJournal and emits `graycode/remote/projection` events
   (`remote/service.ts`); a bridge that replays `query:checkpoints/list`
   entries into the client session log would let a data source fold them
   through `readCheckpointListOutcome` without any new host endpoint.
2. **Typert remote client channel** — once DSH ships the client half of the
   remote surface (the same upgrade the host awaits), the data source becomes
   a thin envelope adapter around it.

## Known limits

- rc.6 `checkpoints/list` always reports `verifyState: 'unknown'`; the badge
  cannot show verified/failed until the host persists verify results.
- Chains are resolved against loaded pages only; a truncated chain (`…`) can
  be extended by loading more pages, but there is no "load ancestors" action
  (a full chain walk would require reading the archive — out of scope for a
  replay-safe surface).
- `onVerify` renders but is inert until a host bridge exists; the
  preview/restore flow is P4-05 (separate surface).
- The mock is deterministic but synthetic: sizes/ids/timestamps are generated,
  not read from any archive (no I/O by design).
