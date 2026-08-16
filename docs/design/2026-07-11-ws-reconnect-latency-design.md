# WS reconnect latency — bound the post-connectivity dead-wait + measure the split — 2026-07-11

**Branch:** `perf/ws-reconnect-latency`
**Status:** design → review

## Goal

Cut the 10–20s window between a mobile screen-off/on (over WiFi + Tailscale) and
the latest thread payload arriving. This sits **on top of** the just-shipped
correctness fix (`9ab8ca8a2`, `retryTransientErrors:false` + `send abandoned`
classification) which made the reconnect _happen at all_; this item makes the
reconnect _fast_.

Success = bound the worst-case dead-wait after connectivity is restored to a few
seconds, and instrument the path so the user's next phone repro tells us
empirically which phase dominates the residual latency.

## Root-cause of the latency (verified this session against source)

The reconnect path has two serial cost centers:

1. **Dead-socket detection — 5–10s.** Effect's RPC client runs its own pinger
   (`effect@4.0.0-beta.78` `RpcClient.ts:1176`): `Effect.delay("5 seconds")` with
   a one-cycle pong check, so a dead socket surfaces 1–2 ping cycles later. Runs
   _before_ the orange "reconnecting" icon appears.
2. **Reconnect-backoff dead-time — up to the current backoff gap.**
   `DEFAULT_RECONNECT_BACKOFF` (`reconnectBackoff.ts:20`) is
   `initialDelayMs 1000 → ×2 → cap 64000`, infinite retries, **no jitter**, and
   is **not overridden anywhere** (grep-confirmed across `apps/web`,
   `apps/desktop`, `packages/client-runtime`). Effect's internal
   `Effect.retry(retryPolicy)` reopens the socket on that curve — attempts land at
   t = 0, 1, 3, 7, 15, 31s… **The worst-case dead-time equals the gap you have
   escalated to**: if the socket reopen-attempts fail while the Tailscale tunnel
   re-establishes and you reach the 8s or 16s slot, you then sit idle that long
   _after connectivity is already back_.

**Why WiFi+Tailscale makes it worse, not better:** the WiFi link never drops
(only the Tailscale tunnel does), so `navigator.onLine` never flips →
the `online` auto-reconnect trigger (`WebSocketConnectionSurface.tsx:110`) **never
fires**, so nothing resets the escalated backoff to retry-0 once the tunnel is
back. The `focus` trigger fires once on thaw (fresh session, retry-0), but if that
first attempt also predates the tunnel coming up, the backoff re-escalates with no
further reset.

**Which center dominates the user's real 10–20s is not yet verified on the live
phone** (desktop Chrome can't reproduce the mobile socket-death — it buffers
frames on freeze). This is the load-bearing premise (Hard Rule 8), so the design
splits accordingly: the shippable change is correct **regardless** of the split;
the ping-side decision is **deferred until measured**.

## Approach

Two independent, low-risk changes on one branch.

### Change 1 — Lower the reconnect backoff cap (Lever A)

Change **one knob** of `DEFAULT_RECONNECT_BACKOFF`:

| field            | before | after |
| ---------------- | ------ | ----- |
| `initialDelayMs` | 1000   | 1000  |
| `backoffFactor`  | 2      | 2     |
| `maxDelayMs`     | 64000  | 3000  |
| `maxRetries`     | null   | null  |

New curve: `1000, 2000, 3000, 3000…` — worst-case gap **3000ms**.

**Why one knob (design-review outcome):** the worst-case
idle-after-connectivity-returns equals the backoff gap you have escalated to, and
that gap is bounded **entirely by `maxDelayMs`**. Lowering only the cap gives the
identical ≤3s bound as a gentler `{500, ×1.5, 3000}` ramp would, with a two-line
diff instead of rewriting the whole expected-delay test table — and the early-ramp
shape is unmotivated by any evidence (if a snappier _first_ retry ever proves
worth it, that is a separate, measured tweak). t3code is a **single self-hosted
server** reached over LAN/Tailscale — the 64s cap exists to spare _shared_ servers
from a thundering herd, which does not apply here. Desktop (localhost) and
remote/saved environments all benefit; none wants a 64s reconnect ceiling on a
self-hosted tool.

**Shared default, not per-connection.** The change lands on the one shared default
rather than plumbing a per-connection `backoff` through `WsTransport` (which is not
currently exposed). Every consumer wants the snappier curve, so the extra plumbing
would be unused surface (YAGNI). Trade-off: remote/saved environments over the
open internet now retry every ≤3s while a server is genuinely down, vs every ≤64s
before — each attempt is a cheap WS open/close, and mobile freezes background tabs
so it does not spin while backgrounded. Acceptable.

**Jitter — considered and rejected.** Jitter's purpose is de-synchronizing _many_
clients to avoid a synchronized herd; irrelevant for a single-user self-hosted
app. It would also desync the reconnect UI: `getReconnectDelayMs` is called
_separately_ by the status atom to display `nextRetryAt`
(`wsConnectionState.ts:214`) and by the Effect schedule for the actual delay —
non-determinism would make the countdown disagree with reality. Keep the delay
deterministic.

### Change 2 — Opt-in, **stateless**, primary-scoped reconnect instrumentation

Add a reconnect logger, gated exactly like the existing wire meter
(`localStorage["t3.wsReconnect"] === "1"`, silent otherwise). New module
`apps/web/src/rpc/wsReconnectLog.ts`:

- `wsReconnectLoggingEnabled(): boolean` — mirrors `wireMeterLoggingEnabled`
  **exactly**, including the `try/catch` + optional-chaining so SSR (no
  `localStorage`) does not throw.
- `logWsReconnectEvent(event, label, detail?)` — emits a single `console.info`
  line with an **absolute** `performance.now()` timestamp (guarded), the
  connection `label`, and event detail (close code/reason, error message). The
  reader computes gaps by subtraction and de-interleaves by label. (No
  `globalConsole` pragma needed — `apps/web/tsconfig.json` disables that rule
  package-wide; the wire-meter pragma lives in `client-runtime`, where it is on.)

**Stateless + labeled (design-review outcome).** The first design tracked a
module-level "previous-event timestamp" and formatted deltas — but the shared web
`telemetryLifecycle` is written by **every** `WsTransport` (the primary _and_ any
saved/remote environment; `service.ts:1442` and `:1457`), and a mobile
Tailscale drop takes them all down at once, so shared prev-state would interleave
two connections' events and silently falsify the exact split we are trying to
measure. Logging **absolute** timestamps + a connection label removes the shared
state entirely and lets the reader separate connections — killing both the
over-built delta-helper (no delta state to test) and the interleave bug in one
move.

**Primary-scoped placement.** Wire the logger into the **primary** client's own
lifecycle handlers in `createPrimaryEnvironmentClient` (`service.ts:1442`), which
already carries the connection label — not the shared `telemetryLifecycle`. The
primary is exactly the connection the user is debugging; saved-env clients keep
their existing handlers and simply do not log. This scopes the timeline to one
connection by construction (belt-and-suspenders with the label).

**Why permanent-and-gated, not temporary-then-revert.** The user reproduces on
**their own phone, after this deploys**, on their own schedule — so the
instrumentation must ship and stay available behind the flag; a
capture-then-revert (which assumes the author reproduces) does not fit. Mobile WS
reconnect has been debugged repeatedly in this repo, so a standing opt-in timeline
earns its keep. Off by default → zero cost to normal users.

The resulting timeline answers the open question directly:

- `close` (disconnect surfaced) → gap since `open` ≈ **detection latency** (cost
  center #1).
- each `attempt` → gap since previous event ≈ **backoff gap** (cost center #2).
- `open` → gap since last `attempt` ≈ **actual connect time** (tunnel wait + probe).

If the residual is in the backoff gaps, Change 1 already handled it. If it is in
detection (the `open→close` gap), that justifies the ping-interval change (Lever
C) with its known idle-bandwidth cost — **only then**, on evidence.

**Scope of instrumentation:** connection lifecycle only for v1. The
`open→first-payload` (resubscribe + snapshot) leg lives in the shared
`WsTransport.subscribe` loop and is normally small; if the lifecycle timeline
fully accounts for the reconnect but a gap remains before the payload renders,
that leg is the follow-up to instrument. Keep v1 bounded.

## Files touched

```
packages/client-runtime/src/reconnectBackoff.ts       maxDelayMs 64000 → 3000 (one knob) + comment
packages/client-runtime/src/reconnectBackoff.test.ts  update cap assertions + default-object assertion
apps/web/src/rpc/wsReconnectLog.ts                     NEW — opt-in stateless labeled reconnect logger
apps/web/src/rpc/wsReconnectLog.test.ts                NEW — gating test (SSR-safe, off-by-default)
apps/web/src/environments/runtime/service.ts          primary client: log lifecycle events (label-scoped)
```

Note (design-review): CI runs on `main`, not the `personal` fork trunk, so a
stale `reconnectBackoff.test.ts` would not fail CI — the local full-suite gate
(Hard Rule 7) is what catches it. Updated regardless.

## Tradeoffs & known limitations

- Change 1 does not touch detection latency (#1) — deliberately deferred to
  measurement. If detection dominates, the phone-repro timeline will show it and a
  separate branch will address the ping interval (weighing the mobile-idle
  bandwidth budget).
- More frequent retries while genuinely offline (bounded, cheap, background-frozen
  on mobile) — see Change 1 rationale.
- Instrumentation is opt-in and off by default: zero cost for normal users, no PII
  (URLs already logged by the wire meter under the same gate).

## Follow-ups deferred

- Ping-interval reduction (Lever C) — **only if** measurement shows detection
  dominates; carries an idle-bandwidth cost that fights the low-bandwidth work.
- Reset the escalated backoff on `focus`/`visibilitychange`/`resume` (Lever B) —
  largely subsumed by the low cap; revisit only if repros still show re-escalation.
- Instrument the `open→first-payload` (resubscribe+snapshot) leg if the lifecycle
  timeline leaves the payload-arrival gap unexplained.
