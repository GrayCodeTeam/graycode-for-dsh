# @graycode/dsh-client

GrayCode client plugin for DeepSeek Harness (DSH): the browser half of the
GrayCode UI surface, registered through DSH's `dsh.client` manifest.

## Package layout

```text
packages/client/
├── package.json          # dsh.client manifest + exports["./client"]
├── tsconfig.json         # tsc: src → lib (node half + browser entry)
├── tsdown.config.ts      # browser bundle: lib/client/index.js → lib/client.js
└── src/
    ├── index.ts          # Node half (cordis plugin entry; no host behavior yet)
    └── client/           # Browser bundle
        ├── index.ts      # definitions/locales/overlay registration + mountable exports
        ├── locales.ts    # `graycode` locale namespace (zh/en + ja placeholder)
        ├── GrayCodeBadge.tsx  # "Gray Code loaded" marker (React)
        └── <surface>/    # workflow, memory, checkpoint, restore, staged diff,
                          # settings, activity, scope map and notifications
```

## How DSH loads this package (rc.6)

Registration is **declarative**, not an API call. The host's
`ClientModuleRegistry` (`@deepseek-ai/dsh-client-modules`) scans loader
entries for a `dsh.client` manifest and serves each qualifying package's
`exports["./client"]` artifact at `/plugins/<id>/client.js?rev=<hash>`. The
bundle is executed as a **classic script** and must register itself via

```js
window.__ModuleLoader__.load({ id, factory: (require) => { /* CJS body */ } })
```

The actual `dsh.client` manifest fields (verified against
`parseDshClient` in dsh-client-modules 0.1.0-rc.6):

| field         | type     | required | meaning                                        |
| ------------- | -------- | -------- | ---------------------------------------------- |
| `platform`    | `string` | yes      | must be `"web"` for the entry to qualify       |
| `inject`      | `string[]` | no     | package-name dependency edges (load order)     |
| `immediately` | `boolean` | no      | stage-one prefetch tier                        |

There is no `name`/`entry` field — the entry name is the package name, and
the bundle path comes from `exports["./client"]`.

## Build

```sh
pnpm --filter @graycode/dsh-client build   # tsc -p tsconfig.json && tsdown
```

- `tsc` compiles `src/` → `lib/` (both halves, `lib/client/index.js` is the
  browser entry).
- `tsdown` bundles the browser entry into `lib/client.js` in the exact CJS
  closure shape DSH requires (mirrors the official
  `packages/client/tsdown.client.ts` preset in deepseek-harness: same
  banner/footer/intro, platform-module externals, purity gate).

## What the browser half registers

- **Locale namespace `graycode`** — typed `zh`/`en` dictionaries (DSH rc.6
  ships exactly `LocaleId = 'zh' | 'en'`) plus a `ja` placeholder via the
  untyped single-locale overload (see GAP-1).
- **Slot contribution** — a "Gray Code loaded" marker registered into
  `shell.overlay` (the additive frame-wide list slot declared by
  `@deepseek-ai/dsh-client-ui-layout`), deferred via `ctx.slots.inject`
  until the slot is declared. The marker is a list entry (`id:
  graycode.loaded`), so it never shadows or replaces other entries.
- **Conversation definition** — Gray workflow tool events are projected to
  `kind: 'graycode.workflow'` nodes through `conversationEvents`.
- **Mountable surfaces** — workflow node/overview, memory management,
  checkpoint list, restore preview, staged diff, settings, activity heatmap,
  scope mapping and notification center components are exported with their
  locale namespaces and contract-driven data sources.

## GAPs and handoffs

- **GAP-1 (ja locale)**: DSH rc.6's `LocaleId` is `'zh' | 'en'` only;
  `setLocale('ja')` throws and the language selector has no `ja` entry. The
  `ja` dictionary is registered as an inert placeholder for a future DSH
  release; it cannot become selectable without an upstream change.
- **GAP-2 (host half)**: the Node half is intentionally a no-op plugin. DSH
  rc.6 has no Node-side "register client module" API — the manifest is the
  registration. Host Remote endpoints live in `@graycode/dsh-plugin`.
- **GAP-3 (runtime mounting/transport)**: the bundle already inserts
  `@graycode/dsh-client` as `id: graycode-client`, but DSH rc.6 exposes neither
  a management-view slot nor a browser→host Remote transport for these
  surfaces. They therefore ship as tested, mountable exports with mock/contract
  data sources; runtime navigation and live Remote wiring require an upstream
  host surface or a later DSH compatibility layer.
