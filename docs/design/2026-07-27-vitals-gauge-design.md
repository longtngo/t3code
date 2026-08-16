# Vitals gauge — one header affordance for the three walls an agent hits

**Date:** 2026-07-27
**Branch:** `feat/vitals-gauge`
**Status:** approved design (iterated interactively with the user), premises validated against live code.

## Goal

Solve two header problems with one redesigned affordance:

1. The context popover is missing Claude's **5-hour and 7-day usage windows** (rolling
   rate limits) — the data is produced server-side but never surfaced in the UI.
2. The inline host-metrics panel (CPU/GPU/MEM label+bar+value segments rendered directly
   into the header actions) **squishes the toolbar**.

Combine both into the single context affordance, redesigned so the state reads at a glance:
a compact split-ring gauge with a detail window on click.

## Approach (locked)

### The icon — three rings, cut down the middle

One SVG glyph, viewBox `0 0 44 44`, rendered ~20px in the composer footer (where the context
meter lives today). An **invisible straight vertical channel** splits every ring into two arcs
that do not touch, each arc end rounded (`stroke-linecap="round"`):

- **Left arcs = limits:** outer = context, middle = 5-hour, inner = 7-day.
- **Right arcs = resources:** outer = CPU, middle = GPU, inner = memory.

Each arc fills from the top down its own side; arc color = severity. Ring radii 18.5 / 13 / 7.6,
stroke width 3. The straight channel is achieved with a **fixed horizontal half-offset** `DX = 2.3`:
each ring's arc ends where its circle crosses `x = 22 ± DX`, i.e. angle `t = acos(DX/r)`, so every
radius's endpoints align to one vertical line (no V-splay). The left half is the right half mirrored
(`translate(44 0) scale(-1 1)`) so it fills top→counterclockwise.

Weight-to-the-left means a limit is filling; weight-to-the-right means the machine is working.

### The detail window (popover, on click/hover)

Three stacked blocks:

1. **Context** — big `NN%` + `used / max` tokens (e.g. `116k / 200k`, `350k / 1m`), a fill bar.
   Colored by **absolute fullness**.
2. **Usage limits (5h / 7d)** — colored by **pace**, not fullness. A projection marker shows where
   usage _would_ be if spent evenly toward 100% at reset; the fill is actual usage; a signed number
   says how far over/under that line. **No reset time is shown** (the user cannot reset the window);
   the signed pace diff replaces it.
3. **Machine** — CPU / GPU / MEM rows: label + bar + `NN%`, colored by absolute fullness. A live dot
   toggles the stream on/off (bandwidth opt-out), preserved from the old panel.

### Color rules (user-specified, exact)

- **Absolute** (context, resources): `p ≤ 50` green, `≤ 75` yellow, `≤ 90` orange, `> 90` red.
- **Pace** (usage windows), `diff = utilization − projection`: `diff < 20` green, `< 30` yellow,
  `< 40` orange, else red. (0–20 over pace stays green = "basically on pace"; red starts at +40.)
- **Projection** = fraction of the window's time elapsed = `1 − (resetsAt − now) / windowDuration`,
  clamped to [0,100]. Window durations: 5h = 5·60·60·1000 ms, 7d = 7·24·60·60·1000 ms. `resetsAt`
  is used **only** for this calc, never displayed. If `resetsAt` is null, no projection: fall back
  to coloring by absolute utilization and hide the marker.

Colors map to the app's existing Tailwind palette vars used by the old panel:
green→`--color-green-500`, yellow→`--color-yellow-500`, orange→`--color-orange-400`, red→`--color-red-500`.
Track = `color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)` (matches the context meter).

## Data sources — all validated against live code (Hard Rule 8)

| Metric      | Source                                                                                                     | Verified                                                                                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Context     | `deriveLatestContextWindowSnapshot(activities)` → `usedTokens`, `maxTokens`, `usedPercentage`              | `lib/contextWindow.ts:50`, already consumed by `ContextWindowMeter` in `ChatComposer.tsx:431`                                                                                                                                  |
| CPU/GPU/MEM | `useHostMetrics(environmentId, enabled)` → `sample.cpu.pct` / `gpu?.pct` / `mem.pct`, all 0–100            | `hooks/useHostMetrics.ts:76`, `contracts/hostMetrics.ts:37`                                                                                                                                                                    |
| 5h / 7d     | `account.usage.updated` activity → `payload.fiveHour` / `payload.sevenDay`, each `{utilization, resetsAt}` | `contracts/providerRuntime.ts:624`; built in `ProviderRuntimeIngestion.ts:855`; **activity schema is open** (`kind: TrimmedNonEmptyString`, `payload: Schema.Unknown`, `orchestration.ts:319`) so it reaches the client intact |

Key premise findings:

- The 5h/7d data **is currently unsurfaced** client-side — no consumer exists (`deriveLatestUsageSnapshot`
  is referenced in a server comment but never landed). So this ships the first client reader:
  `deriveLatestAccountUsage(activities)`, mirroring the context derivation (defensive parse of an
  unknown payload).
- `formatContextWindowTokens` already emits the design's exact token format (`92k`, `200k`, `1m`) — reuse it.
- Codex uses `codex.primary/secondary` and Cursor uses `cursor.*` instead of `fiveHour/sevenDay`;
  for those providers the 5h/7d slots are null. v1 renders the Claude 5h/7d windows and simply omits
  the limits block when both are null (see follow-ups).

## Files touched

- **new** `apps/web/src/lib/vitals.ts` — pure logic: severity + pace levels, color maps, `computeWindowPace`,
  `deriveLatestAccountUsage`, split-ring arc geometry.
- **new** `apps/web/src/lib/vitals.test.ts` — unit tests.
- **new** `apps/web/src/components/chat/VitalsGauge.tsx` — icon + detail popover + connected wrapper.
- **edit** `apps/web/src/components/chat/ChatComposer.tsx` — derive `activeAccountUsage`; thread
  `environmentId` + account usage to the footer; swap `ContextWindowMeter` → `VitalsGauge`.
- **edit** `apps/web/src/components/chat/ChatHeader.tsx` — remove `HostMetricsIndicator` mount, wrapper, imports.
- **delete** `apps/web/src/components/chat/HostMetrics.tsx` — presentational panel, now unused.

## Tradeoffs & known limitations

- The gauge lives in the **composer footer** (the context meter's home), not the top header. The header's
  inline host panel is removed — that is what fixes the squish. One affordance, one home.
- The old host-metrics popover's **richer detail** (per-core sparkline, load average, GPU name, memory
  bytes, host platform) is dropped in favor of the approved simpler Machine block. See follow-ups.
- `useHostMetrics` subscription moves from the header to the composer — same hook, same environment,
  still a single subscription; net-neutral.

## Follow-ups deferred

- Codex (`primary/secondary`) and Cursor (`auto/api/total`) usage windows in the limits block.
- Optionally restore per-core / load-average / mem-bytes detail as an expandable section of the Machine block.

(Sanitize removed the now-orphaned `lib/hostMetrics.ts` `usageLevel`/`metricLevel`/`UsageLevel`/
`METER_VALUE_SLOT` — dead once `HostMetrics.tsx` was deleted; `formatBytes` + the `HostMetricsSample`
re-export are kept.)
