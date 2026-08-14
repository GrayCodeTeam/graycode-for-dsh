# Activity heatmap surface (C6)

Usage-time activity stats panel — a 7×24 hourly heatmap plus daily and monthly
activity bars (ported from the legacy Gray Code activity panel, adapted to DSH
event sampling: real user messages + agent steps, timestamps only).

## Data source

| Endpoint | Purpose | Host handler |
| --- | --- | --- |
| `activity/stats` | Stats query (`range`, `includeHourly`, `includeMonthly`) | `packages/plugin/src/activity/adapters/dsh/remote.ts` (registered under `ctx.grayRemote` by the activity domain) |

Query result (structural mirror of the host contract, see `types.ts`):

```ts
{
  generatedAt, today: DayActivityStats | null, currentSession: { active, startedAt, minutes },
  daily: DayActivityStats[] /* newest first */,
  hourlyHeatmap: [{ date, hours: number[24] }] /* date ascending */,
  monthly: [{ month, totalMinutes, activeDays, sessionCount }] /* newest first */
}
```

Error codes: the host maps `GRAY_ACTIVITY_*` domain codes to the standard
`GRAY_*` set (`GRAY_INVALID_INPUT` / `GRAY_STORAGE_CORRUPT`; see
`packages/plugin/src/remote/errors.ts`), so `errors.ts` handles exactly the 8
standard codes.

## Files

| File | Responsibility |
| --- | --- |
| `types.ts` | Wire contract mirrors + `ActivityStatsDataSource` interface |
| `query.ts` | Range normalization + wire args builder (`activity/stats` request) |
| `wire.ts` | Defensive envelope/result readers (never trust the wire) |
| `errors.ts` | Stable `GRAY_*` code → locale key + retryable flag |
| `viewModel.ts` | Pure projections: heatmap rows/cells (0-4 intensity), daily bars, monthly bars, summary strip |
| `dataSource.ts` | `RemoteActivityStatsDataSource` (contract consumer) + `MockActivityStatsDataSource` (deterministic fixture) |
| `locales.ts` | `graycode.activityHeatmap` namespace (zh/en balanced + ja placeholder, GAP-1) |
| `ActivityHeatmapPanel.tsx` | Container: range switcher, toggles, fetch/retry state machine |
| `ActivityHeatmapChart.tsx` | 7×24 heatmap chart (inline styles + `var(--dsh-*)` theme vars) |
| `ActivityDailyBars.tsx` | Daily activity bars |
| `ActivityMonthlyBars.tsx` | Monthly summary bars |
| `README.md` | This file |

## Wiring

The main session (`packages/client/src/client/index.ts`) registers the locale
namespace and re-exports the panel; a mount recipe is not available in the
rc.6 host (no management-view slot, no browser→host remote channel — GAPs
recorded per surface). Once a mount point exists:

```ts
// 1. Register the locale namespace (own ns).
ctx.locale.register(GRAYCODE_ACTIVITY_HEATMAP_NS, graycodeActivityHeatmapDictionaries)
ctx.locale.register(GRAYCODE_ACTIVITY_HEATMAP_NS, 'ja', graycodeActivityHeatmapJaPlaceholder)

// 2. Provide a data source where the panel is mounted.
//    Live host: wire the transport (GAP-client-1) once the browser→host remote channel exists:
//    const source = new RemoteActivityStatsDataSource((endpoint, args, signal) => ...)
//    Unwired host / development:
//    const source = new MockActivityStatsDataSource()

// 3. Render the panel with t: ctx.locale.bind(GRAYCODE_ACTIVITY_HEATMAP_NS), the (memoized) source, ...
<ActivityHeatmapPanel t={t} source={source} />
```

## Client boundary rules

- **No host plugin imports**: wire shapes are mirrored in `types.ts` (bundle
  purity gate); `wire.ts` narrows everything defensively.
- **No I/O in components**: the panel only calls the injected data source;
  `source === undefined` renders the replay-only hint and never fetches.
- **Stable codes only**: UI maps `GRAY_*` codes to locale keys, never English
  error text (PLAN_V2 §5.6).
- **Pure logic**: query/wire/errors/viewModel are side-effect free and
  unit-tested in the node environment (no jsdom, no testing-library).

## Known gaps

- GAP-client-1: rc.6 has no built-in browser→host remote channel (Typert is
  host-only), so the panel ships with an injectable transport; the main
  session wires it once the channel exists (mock source for development).
- Ranges are bounded enumerations; `365d` / `all` clamp the heatmap display to
  the last 30 rows (`ACTIVITY_HEATMAP_MAX_ROWS` in `query.ts`).
- The heatmap cell intensity buckets (≤5/≤15/≤30 min) follow the legacy Gray
  Code scale; cells render with theme-variable colors, no fixed palette.

## Testing

`packages/client/tests/activityHeatmap.spec.ts` covers the pure logic only
(node environment, no React import): query normalization, wire readers
(malformed input defense), error hints, view-model projections (heatmap rows,
daily/monthly bars, summary), mock source determinism, remote consumer with a
fake transport, and zh/en/ja locale alignment.
