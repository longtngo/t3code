# Resource Queue sidebar indicator — design

**Date:** 2026-06-21
**Branch:** `feat/resource-queue-indicator`
**Status:** Implemented; verifying

## Goal

Surface the local resource broker (`resctl`) queue in t3code's left sidebar:

1. A quick-glance item directly above **Local models** showing the queue at a glance.
2. A popover (on hover or click) listing the current holders + waiting jobs.
3. Auto-refresh: every 60s in the background, every 5s while the popover is open.

The visual design was prototyped and approved by the user (see
`2026-06-21-resource-queue-prototype.html`). This doc records the build decisions.

## Data source

`resctl status --json --no-spawn` returns, per resource pool (`gpu`/`cpu`/`ram`/`machine`):
`capacity`, `in_use`, `advisory`, `leases[]` (holders) and `queue[]` (waiting). Each
lease/queue entry carries `priority`, `reason`, `project`, `agent`, `pid`, `amount`, and a
timestamp (`granted_at` / `enqueued_at`), plus `eta_sec` (usually null). Top-level
`maintenance` flags drain mode. `--no-spawn` makes a status poll read-only — it never starts
a daemon as a side effect.

## Approach

**Unary RPC + client-side polling**, not a server push-stream.

- Server diagnostic `readResourceQueue` shells out to `resctl`, parses, and returns a
  normalized DTO. Mirrors the existing `HostMetrics`/`LlmModels` diagnostics
  (`ChildProcessSpawner` + `collectUint8StreamText`, bounded by a 2s timeout, degrading to
  `available:false` on any failure).
- Unary WS RPC `resourceQueue.get` (`AuthOrchestrationReadScope`), like `server.getConfig`.
- Client hook `useResourceQueue(environmentId, fast)` polls `get()` at 60s, or 5s when
  `fast` (popover open). Pauses while the tab is hidden; a transient failure keeps the last
  snapshot.

**Why unary over a stream:** the two required cadences (60s idle / 5s open) map cleanly onto
a client-controlled interval. A push-stream would need a re-subscribe to change interval and
adds lifecycle for no benefit here. The existing streams (host-metrics, llm-models) use a
_fixed_ interval; this feature's interval is dynamic, so unary is the better fit.

**Normalized DTO** (`ResourceQueueSnapshot`): `{ ts, available, maintenance, resources[],
running[], waiting[] }`. The server flattens leases→`running` and queue→`waiting` (adding a
1-based `pos`), and carries absolute `sinceMs` so the client can tick a live "elapsed"
between polls. Counts are `running.length` / `waiting.length`.

## UI (approved prototype)

- **Quick-glance item** above Local models: a gauge icon, "Resource Queue", and **two
  badges** — running (green) and waiting (yellow). Each badge mutes to grey at 0.
- **Popover** (in-flow, opens upward; not a portal — the sidebar footer's ancestors don't
  clip overflow): a per-pool utilization strip, then a scrollable list (~5 rows then scroll).
  Running holders first (green dot), then waiting (amber dot) by queue order.
- **Each row:** reason on line 1; resource + priority badges, project, and elapsed on line 2;
  hovering reveals a line-3 detail (pid, queue position, exact enqueue/start time, eta);
  **clicking an expanded row collapses it back to simple** (pointer-leave resets).
- **Interaction:** opens on hover and on click (click pins; outside-click / Escape close).
- **Stable across refresh:** rows are keyed by `state:resource:pid:pos`, so React reconciles
  text in place and a hovered/expanded row survives the 5s refresh (the vanilla prototype
  needed an explicit in-place update to avoid the same teardown-collapse).

## Files

- `packages/contracts/src/rpc.ts` — schemas (`ResourceQueueItem/Resource/Snapshot`), method,
  `WsGetResourceQueueRpc`, group registration.
- `packages/contracts/src/ipc.ts` — `EnvironmentApi.resourceQueue.get`.
- `apps/server/src/diagnostics/ResourceQueue.ts` (+ `.test.ts`) — probe + parser.
- `apps/server/src/ws.ts` — auth scope + handler.
- `packages/client-runtime/src/wsRpcClient.ts` — client method.
- `apps/web/src/environmentApi.ts` — passthrough.
- `apps/web/src/hooks/useResourceQueue.ts` — polling hook.
- `apps/web/src/components/sidebar/SidebarResourceQueue.tsx` — component.
- `apps/web/src/components/Sidebar.tsx` — placement above `SidebarLocalModels`.

## Load-bearing premises (validated before building, Hard Rule 8)

- `resctl status --json [--no-spawn]` shape — ran it live (twice).
- `resctl` on the server's PATH — `command -v resctl` resolves it; `T3CODE_RESCTL_CMD`
  overrides for non-PATH installs.
- `ChildProcessSpawner` available in the WS handler context — confirmed (`server.ts`
  comment + `observeRpcEffect` passes the requirement through).
- Contract types re-exported from package root — `index.ts` re-exports `rpc.ts`.
- Footer popover won't be clipped — no `overflow-hidden` on the footer's ancestors.

## Tradeoffs / limitations

- Bespoke in-flow popover rather than the shared base-ui `Popover`. base-ui 1.5's hover
  enablement is a minified/uncertain prop, and the hover-open + click-pin + dynamic-cadence
  combination is awkward to drive through base-ui's controlled API. The bespoke popover adds
  outside-click + Escape handling itself; it is small and matches the approved prototype
  exactly. (Candidate follow-up: revisit base-ui hover if it gets a stable typed prop.)
- Counts are waiting/running across **all** pools; no per-pool count in the glance (the
  popover's utilization strip covers per-pool detail).
- `eta_sec` is shown when present but is almost always null in practice.

## Follow-ups discovered

- None blocking. Possible later polish: a tiny per-pool legend, or hiding the whole item when
  `available:false` for users without the broker (currently shows `0/0` + a popover note).
