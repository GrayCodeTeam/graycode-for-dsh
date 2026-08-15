# Restore preview surface (P4-05)

Renders the checkpoint **restore preview** flow for `@graycode/dsh-client`:
preview a checkpoint's restore plan, review the file classification
(restore / delete / untracked / unbacked / conflict), explicitly confirm the
destructive operation (approval token + double confirmation), watch the
progress and inspect per-file failures with a retry entry.

## Data source (host contract — read-only for this task)

The surface consumes the host-side `checkpoints` Remote endpoints
(`packages/plugin/src/remote/types.ts` +
`packages/plugin/src/checkpoints/adapters/dsh/remote.ts`):

| Endpoint | Args | Returns | Failure codes |
| --- | --- | --- | --- |
| `checkpoints/previewRestore` | `workspace?`, `checkpointId`, `deleteUntrackedFiles?` | `{ preview, previewToken?, baselineDigest? }` | `GRAY_NOT_FOUND`, `GRAY_STORAGE_CORRUPT`, `GRAY_INVALID_INPUT` |
| `checkpoints/restore` | `workspace?`, `checkpointId`, `previewToken`, `deleteUntrackedFiles?` | `{ success, restored, deleted, skipped, failures?, ... }` | `GRAY_APPROVAL_REQUIRED` (token missing/expired), `GRAY_CONFLICT` (workspace drift / manifest changed since preview), `GRAY_CANCELLED` |

Envelope: `{ ok: true, value } | { ok: false, error: { code, message, details } }`
— errors are stable machine codes (`GRAY_*`), the UI never parses English text
(`errors.ts` is the single mapping point, PLAN_V2 §5.6).

**Approval semantics**: `previewToken` IS the `previewId` (sha256 of
checkpointId + workspace fingerprint). It binds the manifest hash and a
baseline digest of the workspace captured at preview time; restore must echo
it verbatim, and any tracked-file change after preview invalidates it
(`GRAY_APPROVAL_REQUIRED` / `GRAY_CONFLICT`). The token is consumed on
successful restore only — a failed restore may retry with the same token.

## Files

| File | Role |
| --- | --- |
| `types.ts` | Wire contract (structural mirror of the host types), defensive readers, domain view model (`PreviewClassification`, `RestoreSession`, `RestoreStep`, `RestoreProgress`) |
| `model.ts` | File classification (grouped buckets), conflict judgement, summary, untracked-deletion ack gate |
| `stateMachine.ts` | Confirmation state machine `idle → preview → confirm → running → done \| failed` with binding/ack guards |
| `progress.ts` | Progress merge (cumulative patches), final-result fold, percent, failure grouping |
| `errors.ts` | Stable code → user hint (severity / retryable / rePreviewRequired / locale key) |
| `locales.ts` | `graycode.restorePreview` namespace (zh/en balanced + ja placeholder) |
| `labels.ts` | Failure reason → locale key helper |
| `gateway.ts` | Contract-driven consumption point (`createRestoreGateway`, per-call invoke timeout 60s → `GRAY_RESTORE_TIMEOUT`) + scripted mock (`createMockRestoreGateway`) |
| `RestorePreviewPanel.tsx` | Panel orchestrator: approval area, token paste, running cancel, armed back, retry/re-preview/reset entries |
| `RestorePreviewList.tsx` | Grouped classification list with conflict highlight + safety notes |
| `RestoreProgressView.tsx` | Progress bar, counters, per-file failure list |

## Behaviour

- **Classification** (`model.ts`): `restore` (count only — the wire carries no
  per-file list for added/modified), `delete` (count follows the
  `deleteUntrackedFiles` flag; `deletablePaths` list), `untracked` (kept
  unless deletion is acknowledged), `unbacked` (protected — never deleted),
  `conflict` (preflight failures + missing backup dirs — **blocking**).
- **State machine** (`stateMachine.ts`):
  - `PREVIEW_STARTED` (idle/failed/done) → `preview`
  - `PREVIEW_OK` → `preview` with session (`previewId` = token) + classification
  - `CONFIRM` (preview, no blocking conflicts, token present; untracked ack
    required when untracked deletion is on) → `confirm` — first confirmation
  - `RESTORE_STARTED` (`confirm`, **previewId must equal session.previewId**) → `running` — second confirmation
  - `PROGRESS` → merge; `RESTORE_OK` (success) → `done`
  - `RESTORE_OK` (success:false) → `failed` + `GRAY_RESTORE_PARTIAL`,
    result kept (per-item failures visible), retryable
  - `RESTORE_FAILED` → `failed` with hint-driven retry/re-preview flags
  - `RE_PREVIEW` / `RESET` → `idle`
  - Every rejected transition is an immutable no-op; `canPreview` /
    `canConfirm` / `canRestoreWith` / `confirmRequiresUntrackedAck` expose the
    guards to the UI.
- **Progress** (`progress.ts`): cumulative max-merge of host patches
  (including `failedItems`, deduped by path); final result is authoritative;
  percent clamps 0..100; the host progress `phase` string is localized
  through `labels.ts` (`phaseProgress.*`).
- **Errors** (`errors.ts`): `GRAY_APPROVAL_REQUIRED` /
  `GRAY_CONFLICT` → warning, re-preview required (stale token);
  `GRAY_CANCELLED` → info, retryable; `GRAY_NOT_FOUND` /
  `GRAY_STORAGE_CORRUPT` → error, re-preview; `GRAY_ENDPOINT_NOT_FOUND` →
  host not wired (mock hint); client-local `GRAY_PREVIEW_FAILED` /
  `GRAY_RESTORE_PARTIAL` / `GRAY_MALFORMED_RESPONSE` /
  `GRAY_RESTORE_TIMEOUT` cover defensive paths.

## Client boundary rules (enforced)

1. **Destructive restore requires explicit double confirmation** — the
   confirm checkbox arms the step, then "Restore now" runs it; both are gated
   by the machine.
2. **Preview and restore are bound to the same previewId** — the panel always
   passes `session.previewId` (= the approval token) to `onRestore`; the
   machine rejects any other id; the mock enforces the same binding.
3. **Never treat cache as write success** — progress/final counters come from
   host data only; local state never claims files were written.
4. **Per-item failures stay visible** — a `success:false` restore keeps the
   result and renders the failure list with reasons.

## Wiring (main session — NOT done by P4-05; `index.ts` is off-limits)

```ts
import { createRestoreGateway, createMockRestoreGateway, type RestoreRemoteInvoke } from './restorePreview/gateway.ts'
import {
  GRAYCODE_RESTORE_PREVIEW_NS,
  graycodeRestorePreviewDictionaries,
  graycodeRestorePreviewJaPlaceholder,
} from './restorePreview/locales.ts'
import { RestorePreviewPanel } from './restorePreview/RestorePreviewPanel.tsx'

// 1. Locale namespace (own ns; independent of `graycode` / `graycode.workflow`).
ctx.locale.register(GRAYCODE_RESTORE_PREVIEW_NS, graycodeRestorePreviewDictionaries)
ctx.locale.register(GRAYCODE_RESTORE_PREVIEW_NS, 'ja', graycodeRestorePreviewJaPlaceholder)

// 2. Gateway: remote when a host invoke bridge exists (message bridge /
//    future Typert client API), otherwise the scripted mock.
const invoke: RestoreRemoteInvoke = /* main-session wiring point */ async (ns, method, args) => { ... }
const gateway = createRestoreGateway(invoke)          // or createMockRestoreGateway()
const hostAvailable = gateway.kind === 'remote'

// 3. Mount the panel with a machine snapshot + declarative callbacks:
//    onPreview → dispatch PREVIEW_STARTED, call gateway.preview, dispatch
//    PREVIEW_OK / PREVIEW_FAILED; onConfirm → CONFIRM; onRestore →
//    RESTORE_STARTED (previewId = session.previewId) + gateway.restore +
//    PROGRESS/RESTORE_OK/RESTORE_FAILED; onRePreview → RE_PREVIEW;
//    onReset → RESET. Render RestorePreviewPanel with `t:
//    ctx.locale.bind(GRAYCODE_RESTORE_PREVIEW_NS)`.
```

## Host endpoint status (probe, rc.6)

The host endpoints ARE implemented (`packages/plugin/src/checkpoints/adapters/
dsh/remote.ts`, covered by `packages/plugin/tests/remote/checkpoints.remote.
test.ts`). The client-side GAP is the invoke bridge: DSH rc.6 does not expose
a third-party client API to call `/remote` endpoints (the Typert extension
surface is host-only and client assembly is owned by `dsh-api-remotes`). Until
a bridge exists, `createMockRestoreGateway()` runs the full surface offline —
the mock enforces the same preview/restore binding and token-consumption
semantics as the host, and the panel shows a mock-mode banner when
`hostAvailable` is false.

## Known limits

- The wire preview carries no per-file list for added/modified files, so the
  `restore` group renders a count only.
- Legacy archives (`legacy: true`) cannot give exact lists — the UI notes
  that the restore result is authoritative.
- Cancellation of an in-flight restore is local-only: the running phase
  exposes a cancel/reset exit (RESET back to idle) because the wire has no
  client cancel endpoint. A hung host additionally exits `running` via the
  gateway invoke timeout (`GRAY_RESTORE_TIMEOUT` → failed state, re-preview
  required); `GRAY_CANCELLED` from the host is mapped and shown.
