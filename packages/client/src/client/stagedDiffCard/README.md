# Staged-diff card surface (P4-06)

The staged-diff (deferred file review, ADR-0003) card/batch UI: pending /
reviewing entry lists with accept/reject decisions, replay-consistent and
contract-driven against the host Remote API.

## Contract source (host, read-only for this task)

| Host file | What it defines |
| --- | --- |
| `packages/plugin/src/remote/types.ts` | stagedDiff endpoints, `GrayRemoteResult` envelope, stable `GRAY_*` codes |
| `packages/plugin/src/stagedDiff/domain/types.ts` | `StagedEntry`, `StagedEntryStatus`, `GRAY_STAGED_*` cause codes |
| `packages/plugin/src/stagedDiff/domain/stateMachine.ts` | transition table (`pending/reviewing → accepted/rejected`, `accepted → done`, `needs-reapply → accepted/rejected`) |
| `packages/plugin/src/stagedDiff/adapters/dsh/remote.ts` | endpoint handlers: `stagedDiff/list` (updatedAt desc, cursor pagination), `preview`, `accept`/`reject` (CAS `expectedRevision`) |

The client package must not import host plugin code (package boundary /
bundle purity gate), so `contract.ts` mirrors the wire contract field for
field; every real host response is structurally assignable to it.

## Data source (consumption point)

`dataSource.ts` defines `StagedDiffDataSource` — the client-side port over
the host endpoints:

| Client method | Host endpoint | Notes |
| --- | --- | --- |
| `list(params)` | `stagedDiff/list` | workspaceId/sessionId/statuses filters + cursor pagination |
| `preview(entryId)` | `stagedDiff/preview` | full entry (before/after/status/revision) |
| `accept(params)` | `stagedDiff/accept` | `expectedRevision` = CAS optimistic lock; writes to disk on the host |
| `reject(params)` | `stagedDiff/reject` | never writes; `GRAY_STAGED_REJECT_CONFLICT` when the target moved |

Methods return the host `GrayRemoteResult` envelope verbatim — business
failures never throw. `createStagedDiffActions(dataSource, workspace)` (actions.ts)
wraps the port into idempotent, error-mapped decision actions for the UI.

### Mock mode

`createMockStagedDiffDataSource(entries, options)` (mockDataSource.ts) is an
in-memory port with the host's observable semantics: status transitions with
the revision CAS, `accepted → done` only after the (simulated) disk write,
`applyFailures` keeps an entry `accepted` (retryable), `rejectConflict` returns
`GRAY_STAGED_REJECT_CONFLICT`, and failures come back as envelopes with the
same codes/causeCodes as the host `toGrayRemoteFailure` mapping. Use it for
standalone development, storyboards and tests while the host adapter is
unwired.

## Wiring (main session — NOT done by T14; `index.ts` is off-limits)

```ts
import { GRAYCODE_STAGED_DIFF_CARD_NS,
         graycodeStagedDiffCardDictionaries,
         graycodeStagedDiffCardJaPlaceholder } from './stagedDiffCard/locales.ts'
import { createStagedDiffActions } from './stagedDiffCard/actions.ts'
import { loadReviewBatch } from './stagedDiffCard/batch.ts'
import { StagedDiffBatchList } from './stagedDiffCard/StagedDiffBatchList.tsx'

// 1. Register the locale namespace (own ns; kept separate from `graycode`).
ctx.locale.register(GRAYCODE_STAGED_DIFF_CARD_NS, graycodeStagedDiffCardDictionaries)
ctx.locale.register(GRAYCODE_STAGED_DIFF_CARD_NS, 'ja', graycodeStagedDiffCardJaPlaceholder)

// 2. Assemble the host adapter: ctx.grayRemote.invoke('stagedDiff', method, args)
//    → StagedDiffDataSource (envelope passthrough; see README of the remote
//    service). Until that adapter exists, use createMockStagedDiffDataSource.

// 3. Load the projected batch (host list folded into the batch view) and
//    render the list with the assembled actions:
const batch = await loadReviewBatch(dataSource, { workspaceId, sessionId })
<StagedDiffBatchList t={ctx.locale.bind(GRAYCODE_STAGED_DIFF_CARD_NS)}
                     batch={batch}
                     actions={createStagedDiffActions(dataSource, workspaceRoot)}
                     onEntriesChanged={(updated) => { /* host refreshes its projection */ }} />
```

## Behaviour

- **Review batch**: same workspace+session's `pending`/`reviewing` entries
  form a batch (derived view, `batch.ts`), sorted createdAt asc then id asc —
  identical to the host `buildReviewBatch` so the rendered list matches the
  host projection.
- **Status → actions** (`status.ts`): `pending`/`reviewing`/`needs-reapply`
  are decidable (accept + reject); `accepted` is mid-flight (no actions until
  the host projects `done`); `rejected`/`done` are terminal.
- **needs-reapply**: crash-recovery residue (accepted but never written) —
  the card shows the recovery hint and offers the decision again.
- **Diff summary** (`summary.ts`): `before === null` → new file; `after === ''`
  → deleted; otherwise modified with +N −M line counts (common prefix/suffix
  stripped). Display-only, no diff engine, no workspace access.
- **Error mapping** (`errors.ts`): `GRAY_CONFLICT` is refined by
  `details.causeCode` — `GRAY_STAGED_REVISION_CONFLICT` (refresh),
  `GRAY_STAGED_REJECT_CONFLICT` (resolve file conflict),
  `GRAY_STAGED_APPLY_FAILED` (entry stays accepted, retry as-is),
  `GRAY_STAGED_ILLEGAL_TRANSITION` (refresh). The UI reads machine codes
  only, never message text (PLAN_V2 §5.6).
- **Idempotency** (`idempotency.ts`): every decision carries an operation id
  (explicit, or derived `<kind>:<entryId>`); repeating an id returns the
  recorded outcome instead of re-invoking the data source. The host's
  `revision` CAS remains the authoritative guard.

## Client boundary rules (PLAN_V2 §5.6)

- **Replay does no I/O**: the card components render the injected batch and
  only invoke injected callbacks; they never load, never write, never touch
  the workspace. With no `actions` (history replay, unwired host) buttons
  render disabled with the `replayOnly` hint.
- **Mutations carry operation ids and an explicit absolute workspace** and
  are idempotent at the UI layer; no browser request falls back to host cwd.
- **In-memory state is never a write success**: after a successful decision
  the component forwards the updated entry to `onEntriesChanged`; the host
  refreshes its projection. The badge always reflects the projected entry
  status — no optimistic flips.
- **Status display is consistent with the host projection**: same filter,
  same sort, same transition table.

## Files

| File | Role |
| --- | --- |
| `contract.ts` | Host wire-contract mirror (entries, statuses, envelope, `GRAY_*`/`GRAY_STAGED_*` codes, transition table) |
| `dataSource.ts` | `StagedDiffDataSource` port (contract-driven consumption point) |
| `batch.ts` | Review-batch aggregation + `loadReviewBatch` paged loader |
| `status.ts` | Status → badge/action mapping, tones, needs-reapply hint |
| `summary.ts` | before/after line summary (create/delete/modify) |
| `errors.ts` | Failure envelope → display error (kind/retryable/refreshRequired) |
| `idempotency.ts` | Operation-id tracker |
| `actions.ts` | `createStagedDiffActions` assembly (idempotent, error-mapped) |
| `mockDataSource.ts` | In-memory data source (mock mode) |
| `StagedDiffCard.tsx` | Entry card (path, summary, badge, accept/reject, conflict hint) |
| `StagedDiffBatchList.tsx` | Batch list + empty state |
| `locales.ts` | `graycode.stagedDiffCard` namespace (zh/en balanced + ja placeholder) |

## Verification

```sh
pnpm --filter @graycode/dsh-client typecheck
pnpm exec vitest run packages/client/tests
```

## Report to the main session

- The host stagedDiff endpoints exist (`remote.ts` handlers, registered by
  `stagedDiff/adapters/dsh/index.ts` when `ctx.grayRemote` is present) but
  are NOT wired into the client: there is no `ctx.grayRemote` → client
  transport yet, and `index.ts` is off-limits. The card surface consumes the
  contract through `StagedDiffDataSource` and ships a mock mode, so it is
  renderable today and swappable when the host adapter lands.
- Next wiring step (separate task): a host adapter exposing the four
  stagedDiff endpoints over the client transport, plus registering the
  `graycode.stagedDiffCard` locale namespace and mounting
  `StagedDiffBatchList` in the main session.
