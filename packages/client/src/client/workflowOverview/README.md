# Workflow overview (P4-02)

Independent management view over Gray workflow runs: a paged list of
`progress` / `design` / `plan` / `review` documents (one run = one document
under `.graycode/`), filterable by workspace, with per-entry status, phase,
document path, timestamps, size and declarative session-locate / open-document
entries.

## Data source

Consumes the host Remote API endpoints (contract:
`packages/plugin/src/remote/types.ts`; handlers:
`packages/plugin/src/workflows/adapters/dsh/remote.ts`, registered under
`ctx.grayRemote` by the workflows domain — verified wired at
`packages/plugin/src/workflows/index.ts`):

| Endpoint | Args (wire) | Value | Consumed by |
| --- | --- | --- | --- |
| `workflows/list` | `{ workspace?, cursor?, limit? }` | `{ items: GrayWorkflowRunSummary[], total, nextCursor? }` (envelope) | `RemoteWorkflowOverviewDataSource.list` → `wire.ts` readers → `viewModel.ts` |
| `workflows/get` | `{ workspace?, id }` | `GrayWorkflowRunDetail` (envelope) | `RemoteWorkflowOverviewDataSource.get` (detail body; not rendered by P4-02) |

Projection: `GrayWorkflowRunSummary` → `WorkflowRunSummaryLike` (structural
mirror, defensive readers) → `WorkflowRunView` (kind/status/phase locale keys,
workspace short label, normalized timestamps/sizes). Host data stays
authoritative — no re-sorting, no client-side filtering of pages.

Envelope → error translation: business errors never reject the transport;
`readWorkflowEnvelope` narrows `{ ok, value | error }` and failures become
thrown `WorkflowOverviewError` values. The UI maps only the stable `GRAY_*`
code to a locale key + retryable flag (`errors.ts`) — never the English
message (PLAN_V2 §5.6).

## Known gaps (rc.6) — reported to the main session

- **GAP-remote-1 — session filter unavailable.** The host list params carry no
  `session` field and run documents record no `sessionId`
  (`GrayWorkflowListParams`, adapter doc). The client query model keeps the
  session seat (`query.ts`), `WORKFLOW_SESSION_FILTER_AVAILABLE === false`,
  and `buildWorkflowListRequest` deliberately never emits a session field; the
  filter input renders disabled with a hint. When the host grows a session
  field, only `buildWorkflowListRequest` changes.
- **GAP-client-1 — no client→host remote transport yet.** rc.6 wires
  `ctx.grayRemote` host-side only; the browser bundle has no declared remote
  channel (and must not import plugin code — bundle purity gate). Therefore:
  - `WorkflowRemoteTransport` (one function: endpoint + args + signal →
    envelope `unknown`) is the contract-driven consumption point the main
    session wires (e.g. a cordis event bridge or a Typert `InvokeRemoteRequest`
    adapter);
  - `MockWorkflowOverviewDataSource` provides a deterministic in-memory
    fixture with host-identical cursor semantics for development and tests —
    the panel works against it today without any host transport.

## Client boundary rules (DSH_MIGRATION_PLAN.md §P4 / §5.6)

- **Replay-safe:** no component performs I/O; paths/workspaces are plain
  strings and may reference files that no longer exist (rendered as text).
  The panel fetches only in live mode with an explicit `source`; mounted
  without one (replay, unwired host) it renders a hint state and never
  initiates a request.
- **Paged, never a full pull:** every list request carries `limit`
  (normalized to the host default/max) plus an optional cursor; "load more"
  appends one page at a time; `paging.ts` refuses concurrent requests and
  dedupes cursor-boundary re-deliveries by run id.
- **Graceful degradation:** no source → replay hint; malformed wire items are
  dropped (`wire.ts`); unknown error codes → stable `error.unknown` hint;
  non-retryable failures render without a retry button; locate/open buttons
  degrade to disabled with the replay hint when no callback is wired.

## Files

| File | Role |
| --- | --- |
| `types.ts` | Structural mirrors of the host wire types (`GrayWorkflowRunSummary`, page, envelope failure) + `WorkflowOverviewDataSource` interface |
| `query.ts` | Query model (workspace/session filters, normalized limit), `buildWorkflowListRequest` (query + cursor → wire args; session seat dropped — GAP-remote-1), capability flag |
| `wire.ts` | Contract-driven envelope readers: `readWorkflowEnvelope` / `readWorkflowRunSummary` / `readWorkflowListResult` / `readWorkflowRunDetail` / `readWorkflowThrownError` |
| `errors.ts` | Stable `GRAY_*` code → locale key + retryable flag mapping |
| `viewModel.ts` | `buildWorkflowRunView` / `buildWorkflowListView`, workspace short label, kind/status/phase label keys, size/time formatters |
| `paging.ts` | Paged list state machine: replace/append with id dedupe, loading/error phases, `nextWorkflowPageRequest` (no concurrent requests) |
| `dataSource.ts` | `RemoteWorkflowOverviewDataSource` (contract-driven consumer over a transport) + `MockWorkflowOverviewDataSource` (deterministic fixture, host-identical cursor semantics) |
| `WorkflowOverviewPanel.tsx` | Container: filter state + paged fetch + states; degraded replay/unwired mode |
| `WorkflowOverviewFilters.tsx` | Workspace/session filter row (session disabled + hint on rc.6) |
| `WorkflowRunList.tsx` | List body: loading / error / empty states, entry cards, load-more, inline error |
| `WorkflowRunCard.tsx` | One run entry: kind/status/phase badges, workspace, path, time, size, locate/open entries (declarative, replay-safe) |
| `locales.ts` | `graycode.workflowOverview` namespace (zh/en balanced + ja placeholder) |

## Wiring (main session — NOT done by P4-02; `index.ts` is off-limits)

```ts
import { GRAYCODE_WORKFLOW_OVERVIEW_NS, graycodeWorkflowOverviewDictionaries, graycodeWorkflowOverviewJaPlaceholder } from './workflowOverview/locales.ts'
import { MockWorkflowOverviewDataSource, RemoteWorkflowOverviewDataSource } from './workflowOverview/dataSource.ts'

// 1. Register the locale namespace (own ns; separate from `graycode` / `graycode.workflow`).
ctx.locale.register(GRAYCODE_WORKFLOW_OVERVIEW_NS, graycodeWorkflowOverviewDictionaries)
ctx.locale.register(GRAYCODE_WORKFLOW_OVERVIEW_NS, 'ja', graycodeWorkflowOverviewJaPlaceholder)

// 2. Provide a data source where the panel is mounted.
//    Live host: wire the transport (GAP-client-1) once the browser→host
//    remote channel exists:
//    const source = new RemoteWorkflowOverviewDataSource((endpoint, args, signal) =>
//      /* invoke ctx.grayRemote through the host bridge; return the envelope */)
//    Unwired host / development:
//    const source = new MockWorkflowOverviewDataSource()

// 3. Render the panel wherever the shell mounts management views:
//    WorkflowOverviewPanel with t: ctx.locale.bind(GRAYCODE_WORKFLOW_OVERVIEW_NS),
//    the (memoized) source, and declarative onLocateSession / onOpenDocument
//    handlers. Keep the source instance stable across renders (refetch loop guard).
```

## Testing

`packages/client/tests/workflowOverview.spec.ts` — pure logic only (no React
render): query modeling + wire-request contract honesty (session never
forwarded), defensive envelope/item readers, error-code → hint mapping,
view-model construction (workspace labels incl. Windows paths, size/time
formatting), the paging state machine (replace/append dedupe, concurrency
guard, retry), the mock source (workspace filter, cursor walk, failure
injection), the remote consumer against a fake transport, and locale
alignment (zh/en balanced, ja placeholder, key coverage).
