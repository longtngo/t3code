# Host system-metrics meter — design (2026-06-08)

**Status:** Design + prototype, awaiting go-ahead to implement.
**Branch (proposed):** `feat/host-metrics-meter`

## Goal

Surface live host-machine resource utilization — **CPU**, **GPU**, **memory** — in the
branch toolbar next to the existing account `UsageMeter`. Refresh every ~1.5 s. A
**toggle** disables the live stream to save bandwidth (and CPU). Hover/click reveals a
detail popover styled exactly like the existing "Usage limits" popover.

"Host machine" = **wherever `apps/server` is running** for the active environment. That is
the machine doing the agent's work — it may be the user's laptop (desktop-spawned local
server) or a **remote SSH/relay host**. Sampling therefore must happen server-side, not in
the renderer, so the numbers reflect the real execution environment.

## Approach (chosen)

A server-side sampler + a **streaming subscription RPC** the client subscribes to only while
the meter is enabled and visible. Subscription lifetime _is_ the bandwidth toggle: off →
unsubscribe → server stops sampling and sends nothing.

### Data flow

```
[host OS]
  os.cpus() delta ──┐
  os.totalmem/free ─┤  HostMetricsSampler (Effect fiber, Schedule.spaced 1.5s)
  ioreg GPU util ───┘            │  ref-counted: runs only while ≥1 subscriber
                                 ▼
   WS subscription  subscribeHostMetrics  ──push every 1.5s──►  client
                                 ▼
   web: useHostMetrics() hook ──► HostMetrics component (sibling of UsageMeter in BranchToolbar)
```

### Server side — `apps/server/src/diagnostics/HostMetricsMonitor.ts` (new)

Mirrors the existing `ProcessResourceMonitor` (5 s process-tree sampler) and the
`Effect.repeat(Schedule.spaced(...))` fiber pattern used by the account-usage poller and the
watchdogs.

- **CPU:** snapshot `os.cpus()` times, diff against the previous snapshot → aggregate busy %.
  Also keep per-core busy % for the popover. Cross-platform, no subprocess.
- **Memory:** `os.totalmem()` / `os.freemem()` → used bytes + %. Cross-platform.
  (Optionally refine "used" via `vm_stat`/`/proc/meminfo` later; `free` is close enough for v1.)
- **GPU:** platform strategy with graceful `null`:
  - macOS Apple Silicon/Intel: `ioreg -r -c IOAccelerator -d 1`, parse `"Device Utilization %"`.
    Measured ~17 ms, no sudo. Also yields GPU name + VRAM-in-use.
  - Linux + NVIDIA: `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total …` (follow-up).
  - Otherwise: `gpu: null` → the UI hides the GPU segment.
- **Ref-counted lifecycle:** first subscriber forks the sampler fiber; last unsubscribe
  interrupts it. No subscribers → zero cost. GPU subprocess is spawned with a short timeout
  and its failure degrades to `null` without killing the CPU/mem stream.

Payload (compact, ~120 bytes/tick):

```ts
HostMetricsSample = {
  ts: number,
  cpu: { pct: number, perCore: number[], loadAvg: [number, number, number] },
  mem: { usedBytes: number, totalBytes: number, pct: number },
  gpu: { pct: number, name?: string, vramUsedBytes?: number } | null,
  host: { platform: string, arch: string, cores: number },  // sent once on subscribe, then omitted
}
```

### Contract — `packages/contracts/src/rpc.ts`

Add a streaming RPC alongside the other `subscribe*` RPCs:

```
subscribeHostMetrics: "host.metrics.subscribe"   // stream: true, payload { intervalMs?: number }
```

Reuse the existing streaming-subscription machinery (`subscribeServerConfig`,
`subscribeVcsStatus`, …) — no new transport primitive.

### Client side

- `apps/web/src/environmentApi.ts`: expose `hostMetrics.subscribe()` on the env API.
- `apps/web/src/lib/hostMetrics.ts` (new): types + formatters (`formatBytes`, `metricLevel`)
  mirroring `lib/usage.ts` (`usageLevel` thresholds reused: ≥90 red, ≥70 orange, ≥50 yellow).
- `apps/web/src/hooks/useHostMetrics.ts` (new): subscribes when enabled, tears down on
  disable/unmount, exposes the latest sample + connection state.
- `apps/web/src/components/chat/HostMetrics.tsx` (new): compact inline readout +
  hover/click popover. **Reuses `UsageBar`, `Popover`, `PopoverPopup`, `PopoverRow`** from
  `UsageMeter.tsx` (extract the shared bits into `usageMeterPrimitives.tsx` so both consume them).
- `apps/web/src/components/BranchToolbar.tsx`: render `<HostMetrics/>` next to `<UsageMeter/>`.

Compact form (desktop): `cpu ▮▮ 41%   gpu ▮▮▮ 97%   mem ▮▮ 37%` with a small toggle dot.
Mobile: pills, same as `UsageMeter`.

Popover detail (mirrors "Usage limits"):

- **CPU** — overall % + per-core mini-bars + 1/5/15 m load average.
- **GPU** — name, utilization %, VRAM in use.
- **Memory** — used / total in GB + %.
- Header shows host `platform · arch · N cores` and a **live/paused** toggle (the bandwidth switch).

### Bandwidth toggle + persistence

- A single boolean `hostMetricsEnabled`, persisted in **client settings**
  (`packages/contracts/src/settings.ts` `ClientSettingsSchema`, same path the other UI prefs use),
  so it survives reloads and is per-client.
- Default **on** for local environments, default **off** for remote SSH/relay (bandwidth-sensitive).
  _(Open call — see Tradeoffs. Easy to flip.)_
- Toggling off unsubscribes immediately; the compact readout collapses to a single dimmed
  "metrics paused" affordance that re-enables on click. Also auto-pause when the toolbar/tab is
  not visible (`document.hidden`) so a backgrounded window costs nothing.

## Alternatives considered

| Option                                                    | Why rejected                                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sample in the desktop/renderer (`os` in main process)** | Only sees the _local_ machine, wrong for remote SSH/relay environments where the agent actually runs. Server-side is the single correct vantage point and already has the env abstraction.                                                                 |
| **Unary RPC polled by the client every 1.5 s**            | Works, but every tick pays request/response overhead and the server samples on a clock even when nobody's looking. Subscription gives free start/stop = the bandwidth toggle for free, and lets the server skip sampling when there are no subscribers.    |
| **Piggyback on `account.usage.updated` activity stream**  | That stream is persisted into the orchestration thread; a 1.5 s firehose would bloat thread history and storage. Host metrics are ephemeral telemetry, not thread activity — a dedicated subscription keeps them out of persistence.                       |
| **`systeminformation` npm dep**                           | Pulls a large dependency for what is ~30 lines of `os` + one `ioreg`/`nvidia-smi` call. GPU utilization support in the lib is spotty on Apple Silicon anyway (our `ioreg` path is verified working). Reconsider only if Windows/Intel coverage demands it. |
| **`powermetrics` for GPU**                                | Requires `sudo`; non-starter. `ioreg` `Device Utilization %` needs no privileges and is ~17 ms.                                                                                                                                                            |

## Experiments / feasibility (measured on this host — Darwin arm64, 18 cores, 137 GB)

- CPU busy-delta via `os.cpus()` over a 1 s window: **8.1%**, computed in-process, no subprocess.
- Memory via `os`: total 137.4 GB, free 86.6 GB — instant.
- GPU via `ioreg -r -c IOAccelerator -d 1`: `"Device Utilization %"=97`, **~17 ms**, no sudo,
  stable across repeated samples. Also exposes alloc/in-use system memory + renderer name.

All three are cheap enough to sample at 1.5 s with negligible overhead.

## Files touched (estimate)

- `apps/server/src/diagnostics/HostMetricsMonitor.ts` — new (~150 LOC).
- `apps/server/src/ws.ts` — register subscription handler (~20 LOC).
- `packages/contracts/src/rpc.ts` — new streaming RPC (~10 LOC).
- `packages/contracts/src/settings.ts` — `hostMetricsEnabled` flag (~3 LOC).
- `packages/client-runtime/src/wsRpcClient.ts` — `hostMetrics.subscribe` (~10 LOC).
- `apps/web/src/environmentApi.ts` — wire it (~4 LOC).
- `apps/web/src/lib/hostMetrics.ts` — new (~60 LOC).
- `apps/web/src/hooks/useHostMetrics.ts` — new (~50 LOC).
- `apps/web/src/components/chat/HostMetrics.tsx` — new (~180 LOC).
- `apps/web/src/components/chat/usageMeterPrimitives.tsx` — extract shared `UsageBar`/`PopoverRow` (~refactor).
- `apps/web/src/components/BranchToolbar.tsx` — render the component (~6 LOC).

~530 LOC net, mostly the new component + sampler. Touches no persistence-critical path.

## Tradeoffs & known limitations

- **GPU is macOS-only in v1.** Linux/NVIDIA via `nvidia-smi` and Windows are explicit follow-ups;
  until then `gpu: null` cleanly hides the segment. No crash on unsupported hosts.
- **Memory "used"** from `freemem` counts file cache as used-ish on some platforms; fine for a
  utilization gauge, refine later if a user finds it misleading.
- **Default-on vs default-off for remote** is a judgment call; defaulting remote to off respects
  bandwidth, at the cost of the user having to opt in. Trivially reversible.
- **No history/sparklines in v1** — instantaneous values only. A rolling 60 s sparkline in the
  popover is a natural follow-up (the `ProcessResourceMonitor` ring-buffer pattern fits).

## Follow-ups deferred

1. Linux/NVIDIA + Windows GPU backends.
2. 60 s sparkline history in the popover.
3. Per-process attribution (tie into existing `ProcessResourceMonitor` so you can see the
   agent's own share of host CPU/mem).
4. Configurable interval (1 s vs 2 s) if the fixed 1.5 s proves wrong.
