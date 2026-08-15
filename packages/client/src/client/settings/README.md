# Gray Code native settings section

The client contributes `id: graycode` to DSH's native `settings.section` slot.
It exposes six focused pages backed by the actual host child-plugin configs:
checkpoints, memory, workflows, prompts, tools/agents, and advanced data paths.
DSH-owned provider credentials, MCP configuration, theme, language, and model
channels are intentionally not duplicated here.

## Transport

DSH rc.6 does not expose third-party settings namespaces through its built-in
browser settings proxy. GrayCode therefore registers the native `graycode`
namespace for persistence, then uses one trusted-host Connection channel for
the browser boundary:

| Endpoint | Payload | Meaning |
| --- | --- | --- |
| `config.get` | `{}` | Read the redacted resolved config |
| `config.update` | `{ patch }` | Merge a top-level module patch and return the resolved config |
| `config.reset` | `{}` | Remove the user layer and inherit composition defaults |
| `remote.invoke` | `{ namespace, method, args }` | Invoke a registered Gray Remote endpoint |

There is deliberately no whole-document import/replace UI or endpoint. The
panel edits one known module at a time, and no credential values are part of
the GrayCode schema or browser document.

Checkpoint management uses the same bridge for list/create/verify,
preview-before-restore, token-bound restore, confirmed delete, and dry-run-first
garbage collection. Destructive calls are confirmed in both the UI and host
adapter.

## Files

| File | Role |
| --- | --- |
| `types.ts` | Structural mirror of real host configs and remote wire values |
| `defaults.ts` | Browser fallback matching host module defaults |
| `locales.ts` | Balanced zh/en copy plus a key-aligned ja placeholder |
| `store.ts` | Serialized `/graycode` config store and path helpers |
| `remote.ts` | Nested DSH RPC → Gray Remote envelope adapter |
| `CheckpointManager.tsx` | Complete checkpoint management workflow |
| `fields.tsx` | Native-looking form primitives |
| `pages.tsx` | Six focused page definitions |
| `GrayCodeSettingsSection.tsx` | Native settings slot root |

All styling is inline because the browser package has no CSS asset pipeline.
It uses DSH `--dsw-alias-*` tokens with neutral fallbacks.
