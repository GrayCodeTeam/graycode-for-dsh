# Notifications surface (C4 多平台系统通知)

Browser-side half of the C4 notification flow: when the host `notify` tool runs
(`packages/plugin/src/notifications/`), the session conversation stream carries a
`tool/call` + `tool/result` pair into the client runtime. This surface folds those
events into notification intents and presents them through the browser
Notification API (including Android browsers / WebViews), with an in-app list as
the fallback (permission denied / unsupported environment / replay).

## host→client channel finding (evidence)

DSH rc.6 has **no generic host→client push channel** and no management-view slot
beyond `shell.overlay` (recorded GAP in `docs/PROGRESS.md` §Phase 4 and every
Phase 4 surface README, e.g. `activityHeatmap/README.md` GAP-client-1). The one
host→client data flow that exists is the **session conversation-event stream**
consumed by `ctx.conversationEvents.register` definitions — proven by the
workflowNode surface (`workflowNode/definition.ts`, `types.ts` readers).

So notifications ride that stream: a `notify` tool call's `tool/call` carries the
full JSON arguments (`title`/`message`/`level`/`silent`), and the correlated
`tool/result` resolves the lifecycle (completed / failed / cancelled). No push
channel, no Remote query endpoint, no host-side bridge code is required.

## Files

| File | Responsibility |
| --- | --- |
| `types.ts` | Contracts: `NotificationIntent`, `NotificationApiPort`, `NotificationEventSource`, presentation states |
| `fold.ts` | Pure window fold: session events → `NotificationIntent[]` (`notificationsFromWindow`; defensive readers) |
| `presenter.ts` | `BrowserNotificationPresenter` (Notification API, permission lifecycle, deny degrade) + pure param mapping (`notificationShowOptions`) + `createBrowserNotificationPort` |
| `source.ts` | `createNotificationBus` (subscribe/push) + `createFixtureNotificationSource` (deterministic replay) |
| `NotificationCenter.tsx` | Mountable in-app notification list (fallback when system toast unavailable) |
| `locales.ts` | `graycode.notifications` namespace (zh/en balanced + ja placeholder, GAP-1) |
| `README.md` | This file |

## Wiring (main session; `packages/client/src/client/index.ts` is owned by the
main session — this surface ships as mountable exports + contract, Phase 4 style)

```ts
// 1. Register the locale namespace (own ns).
ctx.locale.register(GRAYCODE_NOTIFICATIONS_NS, graycodeNotificationsDictionaries)
ctx.locale.register(GRAYCODE_NOTIFICATIONS_NS, 'ja', graycodeNotificationsJaPlaceholder)

// 2. Provide a notification event source where the presenter/center is mounted.
//    Live host: bridge the conversation-event stream into a bus. The exact
//    client runtime seam (a registered Definition whose fold feeds the bus, or
//    a future push channel) is a main-session decision; the pure fold is here:
//    const bus = createNotificationBus()
//    // on each session window: for (const i of notificationsFromWindow(window)) bus.push(i)
//    Unwired host / development:
//    const source = createFixtureNotificationSource([...fixture intents])

// 3. Present through the Notification API (permission-gated, degrade to in-app):
//    const presenter = new BrowserNotificationPresenter(createBrowserNotificationPort())
//    source.subscribe((intent) => { void presenter.present(intent) })

// 4. Render the in-app center wherever management views render:
// <NotificationCenter t={t} source={source} />
```

`presenter.present` never rejects: `shown` / `denied` (degrade to the in-app
list) / `unsupported` (non-browser) / `failed`. Only `completed` intents present.

## Client boundary rules

- **No host plugin imports**: wire shapes are mirrored in `fold.ts`/`types.ts`
  (bundle purity gate); readers narrow everything defensively.
- **No I/O in components**: `NotificationCenter` only subscribes to the injected
  source; `source === undefined` renders the replay-only hint.
- **Replay-safe fold**: `notificationsFromWindow` is a pure function (same input
  window → same intents); the presenter (side effect) is a separate, injectable
  layer the main session wires.
- **Stable statuses only**: lifecycle derives from session events
  (`tool/call` + `tool/result`), never from host error text.

## Known gaps

- rc.6 has no generic host→client push channel and no browser→host channel, so
  the surface ships as a contract-driven consumer + mountable components; the
  main session wires the conversation-event bridge (see above). Once DSH ships a
  push channel, `createNotificationBus().push` becomes the host-side destination
  with no client changes.
- Browser Notification permission is per-origin; `silent` maps to the
  Notification init flag only (the API has no per-notification urgency/level
  field — `level` drives the in-app badge copy).
- The in-app center is capped at `NOTIFICATION_CENTER_MAX_ENTRIES` (newest
  first).

## Testing

`packages/client/tests/notifications.spec.ts` covers the pure logic only (node
environment, no React import): fold (`notificationsFromWindow` lifecycle
mapping, defensive readers), presenter (param mapping, permission request/deny
degrade, show failure), bus/fixture source behavior, and zh/en/ja locale
alignment.
