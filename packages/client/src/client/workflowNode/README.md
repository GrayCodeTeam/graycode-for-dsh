# Workflow conversation node (P4-01)

Renders Gray workflow tool calls (`create_design` / `update_design` /
`create_progress` / `update_progress` / `record_progress_milestone` /
`validate_progress_document` / `create_review` / `record_review_milestone` /
`finalize_review` / `reopen_review` / `validate_review_document` /
`compare_review_documents` — 12 tools) as dedicated cards in the DSH
conversation flow: status, document path, timestamps, error and retry entry.

## Probe conclusion (DSH rc.6) — the node extension surface EXISTS

| Question | Answer | Evidence |
| --- | --- | --- |
| Public `ConversationNodeDefinition` (match/start/update/buildLocationData/buildViewNode)? | **YES** | `@deepseek-ai/dsh-client-runtime/client` exports the interface and the registries |
| Public registration entry? | **YES** | `ctx.conversationEvents.register(definition)` (augmented onto `Context`) + `ctx.conversationViews.register(viewDefinition)` |
| Stream updates replace/prepend/append? | **YES** (engine-owned) | `ConversationNodeAssembler.replaceWindow / append / prepend`; `ConversationViewBuilder.replace / apply` |
| Tool presentation (`presentCall/presentResult/presentationMeta`)? | Host-side only | `dsh-tools` presentation hooks project into `tool/result.meta`; client sees `ToolEventView`/`ToolResultView` on the wire view and `meta` on the event |
| Location data publishing? | **YES** | `buildLocationData` + declaration-merged `ConversationStepDataMap` (engine enforces `key === kind`, `kind === scope`) |

Key contract details verified in `dsh-client-runtime` rc.6 sources:

- `ConversationEventRegistry.register(definition)` returns an idempotent
  disposer; the assembler evaluates every Definition once per appended event
  and updates only matched Contexts (no full-window scans).
- `match()` returns `{ id, role: 'start' | 'update' }` per event; the engine
  correlates Contexts by id. A `tool/result` whose `tool/call` is outside the
  loaded window becomes a start-less Context (no State → `buildViewNode`
  returns null → no node) and is replayed when an older page supplies the
  call (prepend path).
- `ConversationViewBuilder` is per-target and `'chat'` is already owned by
  `ui-conversation` — a plugin must NOT register a second `'chat'` builder.
  The web shell renders `target: 'chat'` nodes produced by registered
  Definitions; a custom `kind` degrades to the shell's generic row when the
  shell has no renderer for it (this card is the renderer for
  `kind: 'graycode.workflow'` wherever the shell mounts custom node views).
- `@deepseek-ai/dsh-session` is NOT resolvable from this package (transitive
  dep of the runtime, not a peer) — `definition.ts` uses a structural
  `WorkflowEventLike` that every real `SessionEvent` satisfies (see
  `types.ts`).

## Files

| File | Role |
| --- | --- |
| `tools.ts` | Workflow tool registry: the 12 names, family table, workflow meta marker |
| `types.ts` | Structural event/context types, defensive readers, `WorkflowNodeState`/`WorkflowNodeData`, `ConversationStepDataMap` augmentation |
| `definition.ts` | `matchWorkflowEvent` / `startWorkflowNode` / `updateWorkflowNode` / `buildWorkflowLocationData` / `buildWorkflowViewNode` + `createWorkflowNodeDefinition()` |
| `stream.ts` | `replace/prepend/append` three-state window merge with seq dedupe |
| `WorkflowNodeCard.tsx` | Card component (replay-safe; declarative open/retry) |
| `renderer.tsx` | Pluggable renderer surface (B7): `createWorkflowNodeRenderer` / `isWorkflowChatNode`, re-exported from `@graycode/dsh-client/client` |
| `locales.ts` | `graycode.workflow` namespace (zh/en balanced + ja placeholder) |

## Behaviour

Status machine (derived from session events only — replay-safe):

- `tool/call` (workflow tool) → `active` (running)
- `tool/result` with `error.code === 'GRAY_CANCELLED'` → `cancelled`
- `tool/result` with any other error → `failed` (error name/code/message)
- `tool/result` success + document status `draft` → `draft`
- `tool/result` success → `completed`

Document path: `args.path` at start, replaced by the result payload `path`
(design/progress/review results all carry one) when it arrives. Summary:
args `title`/`projectName`/`currentFocus`, then result `currentFocus`/`title`.
`retryable` = `failed || cancelled`.

## Wiring (B7 — done in `src/client/index.ts`)

Steps 1–2 are wired by B7 in `src/client/index.ts` (the browser half):

1. **Definition registration** — `ctx.conversationEvents.register(createWorkflowNodeDefinition())`, with the disposer tied to the fiber via `ctx.effect` (fiber unload runs it). `conversationEvents` was added to the plugin's `inject` list (a runtime-provided service, like `slots`).
2. **Locale namespace** — `ctx.locale.register(GRAYCODE_WORKFLOW_NS, graycodeWorkflowDictionaries)` plus `register(GRAYCODE_WORKFLOW_NS, 'ja', graycodeWorkflowJaPlaceholder)`. Own namespace, kept separate from `graycode` (neither `locales.ts` file changed).

### Render point (3) — no rc.6 mount exists; pluggable export instead

DSH rc.6 gives this package **no programmatic conversation-node render mount**:

- the `'chat'` view target is owned by the host's `ui-conversation` — a second
  `'chat'` `ConversationViewDefinition` would collide (never registered);
- the SlotMap this package compiles against declares no node-renderer slot
  (only `shell.overlay`), and the host shell renders `target: 'chat'` nodes
  itself, degrading an unknown `kind` to its generic row.

So the card ships as a **pluggable renderer**, re-exported from the client
bundle entry (`@graycode/dsh-client/client`):

```tsx
import {
  createWorkflowNodeRenderer,
  isWorkflowChatNode,
  GRAYCODE_WORKFLOW_NS,
} from '@graycode/dsh-client/client' // or the package-internal modules

// Host mount recipe — wherever the shell dispatches chat view nodes:
const renderWorkflowNode = createWorkflowNodeRenderer({
  t: ctx.locale.bind(GRAYCODE_WORKFLOW_NS), // or the framework-injected seat
  onOpenDocument: (path) => host.openDocument(path),
  onRetry: (node) => host.retryWorkflowCall(node.callId),
})

function renderChatNode(node: unknown) {
  if (isWorkflowChatNode(node)) return renderWorkflowNode(node.data)
  return <GenericRow node={node} /> // the shell's default row
}
```

The Definition still materializes `kind: 'graycode.workflow'` nodes into the
engine's `'chat'` view snapshot on its own (step 1) — only the visual card
needs a mount. Until a host mounts the renderer, nodes degrade to the shell's
generic row; nothing is broken and no conflicting target is registered.

`ctx.conversationEvents` / `ctx.conversationViews` are typed on the runtime's
`Context` augmentation (inject `'@deepseek-ai/dsh-client-runtime'` — already
in `package.json` `dsh.client.inject`).

## Host-side recommendation (packages/plugin — separate task)

The 12 workflow tools should attach `presentationMeta` (dsh-tools) projecting
`{ kind: 'graycode.workflow', callId, tool, path, status }` into
`tool/result.meta`. The client folds results through
`message.source.callId` regardless (so the card works today), but the marker:

- gives the durable log an explicit workflow signature (ADR-0002-friendly),
- surfaces document-level `status` (e.g. `draft`) without parsing payloads,
- lets a future window-cut result-only match carry the tool name.

## Known limits

- A `tool/result` whose call is outside the window shows no node until the
  older page (prepend) supplies the call — by design (start-less Contexts).
- Non-workflow `tool/result` events also match by call id and create inert
  start-less Contexts (window-bounded; no nodes, no State) — the price of
  correlating results without host meta.
- `draft` is a document-level state surfaced only when the host meta or the
  result payload reports `status: 'draft'` (no current plugin schema emits it).
- The card formats timestamps with the browser `Intl`; no I/O, no workspace
  access, path is text only.
